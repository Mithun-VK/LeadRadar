/**
 * Google Places API (New) adapter.
 *
 * Cost discipline is structural here, not advisory:
 *
 *   - Text Search only. Place Details is never used for bulk field acquisition,
 *     because Text Search is billed per REQUEST and returns up to 20 places
 *     (~$0.00175/business) while Place Details is billed per PLACE ($0.020) —
 *     roughly 11x more for the same fields.
 *   - The field mask is fixed and validated against the SKU tier table, so a
 *     casual edit cannot silently promote every request to a costlier SKU.
 *   - Pagination is explicit. Each page is a separate billable request, so
 *     fetching another one is a spending decision the caller makes, not
 *     something this adapter does behind their back.
 *   - `refreshPlaceIds` uses the free IDs-only SKU. That is what the free SKU is
 *     for: confirming a place still exists, never acquiring data.
 */
import { GOOGLE_SKUS } from '@/config/pricing';
import { AppError } from '@/lib/errors';
import { env } from '@/lib/env';
import { providerLogger } from '@/lib/logger';
import { err, ok, type Result } from '@/lib/result';
import {
  parseJson,
  parseRetryAfter,
  requestWithRetry,
  statusToErrorCode,
} from '@/modules/providers/http';
import { PROVIDER_LIMITS, acquireBlocking } from '@/modules/providers/rate-limit';
import type {
  BusinessDiscoveryProvider,
  DiscoveryPage,
  DiscoveryRequest,
  UsageRecord,
  WithUsage,
} from '@/modules/providers/contracts';

import { DISCOVERY_MASK, DISCOVERY_SKU, REFRESH_MASK } from './field-masks';
import { normalizePlaces } from './normalizer';
import { googleErrorSchema, placeDetailsResponseSchema, textSearchResponseSchema } from './schemas';

const BASE_URL = 'https://places.googleapis.com/v1';

/** Provider ceilings, documented: 20 results per page, 60 across all pages. */
const MAX_PAGE_SIZE = 20;
const MAX_TOTAL_RESULTS = 60;

/** Google accepts minRating in 0.5 steps only. */
function quantiseMinRating(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  const clamped = Math.max(0, Math.min(5, value));
  // Round DOWN to the nearest supported step. Rounding up would make the
  // provider drop businesses the user asked for; the exact threshold is
  // re-applied in deterministic filtering, which costs nothing.
  return Math.floor(clamped * 2) / 2;
}

function costMicrosForRequests(skuKey: keyof typeof GOOGLE_SKUS, requests: number): number {
  return Math.round((GOOGLE_SKUS[skuKey].per1000Micros / 1000) * requests);
}

function usageFor(
  operation: string,
  skuKey: keyof typeof GOOGLE_SKUS,
  requests: number,
  durationMs: number,
): UsageRecord {
  return {
    provider: 'google-places',
    operation,
    units: requests,
    unitKind: skuKey,
    estimatedCostMicros: costMicrosForRequests(skuKey, requests),
    durationMs,
    mocked: false,
  };
}

export class GooglePlacesProvider implements BusinessDiscoveryProvider {
  readonly name = 'google-places';
  readonly isMock = false;

  constructor(private readonly apiKey: string) {}

  async search(request: DiscoveryRequest): Promise<Result<WithUsage<DiscoveryPage>>> {
    const log = providerLogger(this.name, 'text-search');

    // Pace ourselves before spending, so we are never the reason the account
    // gets throttled.
    const permitted = await acquireBlocking({
      key: this.name,
      ...PROVIDER_LIMITS['google-places']!,
    });
    if (!permitted) {
      return err(
        new AppError({
          code: 'PROVIDER_RATE_LIMITED',
          message: 'Local rate limiter did not release a Google Places token in time',
          retryability: 'after-delay',
          retryAfterSeconds: 5,
        }),
      );
    }

    const body: Record<string, unknown> = {
      textQuery: request.textQuery,
      pageSize: Math.min(request.pageSize ?? MAX_PAGE_SIZE, MAX_PAGE_SIZE),
      languageCode: request.languageCode ?? 'en',
      regionCode: request.regionCode ?? 'IN',
    };

    if (request.pageToken) body.pageToken = request.pageToken;
    if (request.includedType) {
      body.includedType = request.includedType;
      // Strict filtering keeps a 'dental clinic' search from returning a
      // pharmacy, which would otherwise pass filters and waste enrichment spend.
      body.strictTypeFiltering = request.strictTypeFiltering ?? true;
    }

    const minRating = quantiseMinRating(request.minRating);
    if (minRating !== undefined && minRating > 0) body.minRating = minRating;

    // Restriction over bias wherever possible: a hard boundary makes cells
    // disjoint, which is what keeps cross-cell duplicates (and their wasted
    // requests) down.
    if (request.locationRestriction) {
      const b = request.locationRestriction;
      body.locationRestriction = {
        rectangle: {
          low: { latitude: b.south, longitude: b.west },
          high: { latitude: b.north, longitude: b.east },
        },
      };
    } else if (request.locationBias) {
      const b = request.locationBias;
      body.locationBias = {
        rectangle: {
          low: { latitude: b.south, longitude: b.west },
          high: { latitude: b.north, longitude: b.east },
        },
      };
    }

    const response = await requestWithRetry({
      url: `${BASE_URL}/places:searchText`,
      method: 'POST',
      headers: {
        'X-Goog-Api-Key': this.apiKey,
        // Explicit mask, never '*'. This header determines the SKU billed.
        'X-Goog-FieldMask': DISCOVERY_MASK,
      },
      body,
      provider: this.name,
      operation: 'text-search',
      timeoutMs: 15_000,
    });

    if (!response.ok) return err(response.error);

    const { status, text, durationMs, headers } = response.value;
    // A failed request is still often a billed request; report usage either way
    // so cost reporting is honest.
    const usage = [usageFor('text-search', DISCOVERY_SKU, 1, durationMs)];

    if (status !== 200) {
      return err(this.mapErrorResponse(status, text, headers, 'text-search'));
    }

    const json = parseJson(text, { provider: this.name, operation: 'text-search' });
    if (!json.ok) return err(json.error);

    const parsed = textSearchResponseSchema.safeParse(json.value);
    if (!parsed.success) {
      return err(
        new AppError({
          code: 'PROVIDER_BAD_RESPONSE',
          message: `Google Places returned an unexpected shape: ${parsed.error.message}`,
          context: { operation: 'text-search' },
        }),
      );
    }

    const places = parsed.data.places ?? [];
    const { businesses, skipped } = normalizePlaces(places, {
      observedAt: new Date(),
    });

    if (skipped > 0) {
      log.debug({ skipped, returned: places.length }, 'Dropped places without a usable identity');
    }

    return ok({
      data: {
        businesses,
        nextPageToken: parsed.data.nextPageToken ?? null,
        // A full page plus a token means the area may hold more than the 60-result
        // ceiling can express, which is the signal to subdivide the cell.
        saturated: places.length >= MAX_PAGE_SIZE && parsed.data.nextPageToken !== undefined,
        attributions: ['Powered by Google'],
      },
      usage,
    });
  }

  /**
   * Confirms Place IDs still resolve, using the free IDs-only SKU.
   *
   * Sequential rather than parallel: this is background maintenance with no user
   * waiting, and it must never crowd out paid discovery traffic on the shared
   * rate limiter.
   */
  async refreshPlaceIds(
    placeIds: readonly string[],
  ): Promise<Result<WithUsage<Record<string, boolean>>>> {
    const results: Record<string, boolean> = {};
    const usage: UsageRecord[] = [];

    for (const placeId of placeIds) {
      await acquireBlocking({ key: this.name, ...PROVIDER_LIMITS['google-places']! });

      const response = await requestWithRetry(
        {
          url: `${BASE_URL}/places/${encodeURIComponent(placeId)}`,
          headers: {
            'X-Goog-Api-Key': this.apiKey,
            'X-Goog-FieldMask': REFRESH_MASK,
          },
          provider: this.name,
          operation: 'refresh-place-ids',
          timeoutMs: 10_000,
        },
        { attempts: 2 },
      );

      usage.push(usageFor('refresh-place-ids', 'text-search:essentials-ids-only', 1, 0));

      if (!response.ok) {
        // Unknown, not dead: a transport failure must not invalidate an id.
        results[placeId] = true;
        continue;
      }

      if (response.value.status === 404) {
        results[placeId] = false;
        continue;
      }
      if (response.value.status !== 200) {
        results[placeId] = true;
        continue;
      }

      const json = parseJson(response.value.text, {
        provider: this.name,
        operation: 'refresh-place-ids',
      });
      results[placeId] = json.ok && placeDetailsResponseSchema.safeParse(json.value).success;
    }

    return ok({ data: results, usage });
  }

  /**
   * Maps a Google error body onto the taxonomy.
   *
   * The body is never interpolated into the message unredacted: Google echoes
   * the request, and the request carries the API key.
   */
  private mapErrorResponse(
    status: number,
    text: string,
    headers: Headers,
    operation: string,
  ): AppError {
    const code = statusToErrorCode(status);
    let detail = '';

    const json = parseJson(text, { provider: this.name, operation });
    if (json.ok) {
      const parsed = googleErrorSchema.safeParse(json.value);
      if (parsed.success) {
        detail = parsed.data.error.status ?? parsed.data.error.message ?? '';
      }
    }

    // Google reports quota exhaustion as 429 with RESOURCE_EXHAUSTED; treat that
    // as a quota problem rather than ordinary throttling, because the correct
    // response is to pause rather than retry in a few seconds.
    const isQuota = detail.includes('RESOURCE_EXHAUSTED') || detail.includes('quota');
    const finalCode = status === 429 && isQuota ? 'PROVIDER_QUOTA_EXCEEDED' : code;

    return new AppError({
      code: finalCode,
      message: `Google Places ${operation} failed with HTTP ${status}${detail ? ` (${detail})` : ''}`,
      retryAfterSeconds: parseRetryAfter(headers),
      context: { provider: this.name, operation, httpStatus: status, providerStatus: detail },
    });
  }
}

/** Factory used by the provider registry. */
export function createProvider(): BusinessDiscoveryProvider {
  const key = env().GOOGLE_MAPS_API_KEY;
  if (!key) {
    throw new AppError({
      code: 'CONFIG_INVALID',
      message: 'GOOGLE_MAPS_API_KEY is required to construct the live Places provider',
    });
  }
  return new GooglePlacesProvider(key);
}

export { MAX_PAGE_SIZE, MAX_TOTAL_RESULTS };
