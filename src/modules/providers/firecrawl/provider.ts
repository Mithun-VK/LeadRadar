/**
 * Firecrawl adapter — web search and single-page scraping.
 *
 * There is deliberately no crawl method on this adapter, even though the API
 * offers one. Crawling a whole site to answer "does this domain belong to this
 * business?" is the single most expensive mistake available in this pipeline:
 * at 1 credit per page, a 15-page crawl costs 15x a homepage scrape and answers
 * the same question. Ownership is established by a homepage and, at most, one
 * contact/about page.
 *
 * Every URL handed to this adapter is validated by the SSRF guard first. Both
 * inputs are third-party controlled — search results and Google's `websiteUri` —
 * so neither is trustworthy.
 */
import { DEFAULT_PRICING, FIRECRAWL_OPERATIONS, firecrawlCreditMicros } from '@/config/pricing';
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
import { validateExternalUrl } from '@/modules/security/url-guard';
import type {
  FetchedPage,
  PageFetchRequest,
  UsageRecord,
  WebDiscoveryProvider,
  WebSearchRequest,
  WebSearchResult,
  WithUsage,
} from '@/modules/providers/contracts';

import { scrapeResponseSchema, searchResponseSchema } from './schemas';

const BASE_URL = 'https://api.firecrawl.dev/v2';

/**
 * Page-content ceiling. A business homepage that needs more than this to prove
 * its identity is not going to prove it at all, and unbounded page text is both
 * a memory risk and a prompt-injection surface.
 */
const MAX_CONTENT_CHARS = 40_000;
/**
 * Raw HTML ceiling. Higher than the markdown cap because markup is verbose and
 * the analyzer needs `<head>`, but still bounded: a document larger than this is
 * not going to yield different structural facts, and unbounded markup is a
 * memory risk on a worker running many jobs concurrently.
 */
const MAX_HTML_CHARS = 400_000;
const MAX_RESPONSE_BYTES = 3 * 1024 * 1024;

function creditUsage(operation: 'search' | 'scrape', durationMs: number): UsageRecord {
  const credits = FIRECRAWL_OPERATIONS[operation].creditsPerUnit;
  return {
    provider: 'firecrawl',
    operation,
    units: credits,
    unitKind: 'credits',
    estimatedCostMicros: Math.round(credits * firecrawlCreditMicros(DEFAULT_PRICING.firecrawlPlan)),
    durationMs,
    mocked: false,
  };
}

export class FirecrawlProvider implements WebDiscoveryProvider {
  readonly name = 'firecrawl';
  readonly isMock = false;

  constructor(private readonly apiKey: string) {}

  async search(request: WebSearchRequest): Promise<Result<WithUsage<readonly WebSearchResult[]>>> {
    await acquireBlocking({ key: this.name, ...PROVIDER_LIMITS.firecrawl! });

    const response = await requestWithRetry({
      url: `${BASE_URL}/search`,
      method: 'POST',
      headers: { authorization: `Bearer ${this.apiKey}` },
      body: {
        query: request.query,
        // Search bills 2 credits per 10 results; asking for more than we will
        // examine is pure waste. Verification only ever considers the top few.
        limit: Math.min(request.limit ?? 5, 10),
        ...(request.country && { location: request.country }),
        // Content is NOT requested here. Hydrating search results would bill a
        // scrape for every candidate, including the ones we are about to reject
        // on domain and title alone.
        scrapeOptions: undefined,
      },
      provider: this.name,
      operation: 'search',
      timeoutMs: 30_000,
      maxBytes: MAX_RESPONSE_BYTES,
    });

    if (!response.ok) return err(response.error);
    const usage = [creditUsage('search', response.value.durationMs)];

    if (response.value.status !== 200) {
      return err(
        this.mapError(response.value.status, response.value.text, response.value.headers, 'search'),
      );
    }

    const json = parseJson(response.value.text, { provider: this.name, operation: 'search' });
    if (!json.ok) return err(json.error);

    const parsed = searchResponseSchema.safeParse(json.value);
    if (!parsed.success) {
      return err(
        new AppError({
          code: 'PROVIDER_BAD_RESPONSE',
          message: `Firecrawl search returned an unexpected shape: ${parsed.error.message}`,
        }),
      );
    }

    const results: WebSearchResult[] = (parsed.data.data?.web ?? []).map((item, index) => ({
      url: item.url,
      title: item.title ?? null,
      description: item.description ?? null,
      position: item.position ?? index + 1,
    }));

    return ok({ data: results, usage });
  }

  async fetchPage(request: PageFetchRequest): Promise<Result<WithUsage<FetchedPage>>> {
    const log = providerLogger(this.name, 'scrape');

    // SSRF check before spending a credit, and before Firecrawl is asked to
    // fetch anything on our behalf. Cheaper and safer in that order.
    const guarded = await validateExternalUrl(request.url);
    if (!guarded.ok) {
      log.warn({ err: guarded.error, url: request.url }, 'Refused to scrape a blocked URL');
      return err(guarded.error);
    }

    await acquireBlocking({ key: this.name, ...PROVIDER_LIMITS.firecrawl! });

    const response = await requestWithRetry({
      url: `${BASE_URL}/scrape`,
      method: 'POST',
      headers: { authorization: `Bearer ${this.apiKey}` },
      body: {
        url: guarded.value.url.toString(),
        // Formats are billed per page, not per format, so asking for html when
        // analysis needs it costs no extra credits. Screenshots are still never
        // requested — those carry no decision value here.
        formats: [
          'markdown',
          ...(request.includeLinks ? ['links'] : []),
          ...(request.includeHtml ? ['html'] : []),
        ],
        // Analysis needs the whole document: onlyMainContent strips <head>, and
        // with it the viewport tag, canonical link, and structured data the
        // analyzer exists to measure.
        onlyMainContent: request.includeHtml !== true,
        timeout: request.timeoutMs ?? 20_000,
        // Skip the TLS-verified but dead pages quickly rather than waiting out a
        // full render on a parked domain.
        waitFor: 0,
      },
      provider: this.name,
      operation: 'scrape',
      timeoutMs: (request.timeoutMs ?? 20_000) + 10_000,
      maxBytes: request.maxBytes ?? MAX_RESPONSE_BYTES,
    });

    if (!response.ok) return err(response.error);
    const usage = [creditUsage('scrape', response.value.durationMs)];

    if (response.value.status !== 200) {
      return err(
        this.mapError(response.value.status, response.value.text, response.value.headers, 'scrape'),
      );
    }

    const json = parseJson(response.value.text, { provider: this.name, operation: 'scrape' });
    if (!json.ok) return err(json.error);

    const parsed = scrapeResponseSchema.safeParse(json.value);
    if (!parsed.success) {
      return err(
        new AppError({
          code: 'PROVIDER_BAD_RESPONSE',
          message: `Firecrawl scrape returned an unexpected shape: ${parsed.error.message}`,
        }),
      );
    }

    const payload = parsed.data.data;
    if (!payload) {
      return err(
        new AppError({
          code: 'PROVIDER_BAD_RESPONSE',
          message: 'Firecrawl scrape returned no page payload',
          retryability: 'never',
          context: { url: guarded.value.url.toString() },
        }),
      );
    }

    const finalUrl =
      payload.metadata?.sourceURL ?? payload.metadata?.url ?? guarded.value.url.toString();
    const content = (payload.markdown ?? '').slice(0, MAX_CONTENT_CHARS);

    return ok({
      data: {
        url: guarded.value.url.toString(),
        finalUrl,
        statusCode: payload.metadata?.statusCode ?? null,
        title: payload.metadata?.title ?? null,
        description: payload.metadata?.description ?? null,
        // UNTRUSTED. Never placed in an instruction channel; see the AI layer.
        content,
        html: request.includeHtml ? (payload.html ?? '').slice(0, MAX_HTML_CHARS) || null : null,
        links: (payload.links ?? []).slice(0, 300),
        httpsEnabled: finalUrl.startsWith('https://'),
        byteLength: content.length,
        fetchedAt: new Date(),
      },
      usage,
    });
  }

  private mapError(status: number, text: string, headers: Headers, operation: string): AppError {
    const code = statusToErrorCode(status);
    // 402 means credits are exhausted, which is a budget condition rather than a
    // transport error — retrying immediately would just fail again.
    const finalCode = status === 402 ? 'PROVIDER_QUOTA_EXCEEDED' : code;

    return new AppError({
      code: finalCode,
      message: `Firecrawl ${operation} failed with HTTP ${status}`,
      retryAfterSeconds: parseRetryAfter(headers),
      context: {
        provider: this.name,
        operation,
        httpStatus: status,
        bodySnippet: text.slice(0, 200),
      },
    });
  }
}

export function createProvider(): WebDiscoveryProvider {
  const key = env().FIRECRAWL_API_KEY;
  if (!key) {
    throw new AppError({
      code: 'CONFIG_INVALID',
      message: 'FIRECRAWL_API_KEY is required to construct the live Firecrawl provider',
    });
  }
  return new FirecrawlProvider(key);
}

export { MAX_CONTENT_CHARS, MAX_HTML_CHARS };
