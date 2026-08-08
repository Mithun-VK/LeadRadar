/**
 * Field masks.
 *
 * The field mask IS the pricing decision. Requesting a single field from a
 * higher tier promotes the entire request to that tier's SKU, so masks are
 * defined once, here, and validated against the tier table — never assembled
 * ad hoc at a call site.
 *
 * `X-Goog-FieldMask: *` is never used. It would silently request Atmosphere
 * fields and multiply the bill.
 */
import {
  GOOGLE_FIELD_TIERS,
  GOOGLE_TIER_ORDER,
  type GooglePlacesTier,
  type GoogleSkuKey,
} from '@/config/pricing';
import { AppError } from '@/lib/errors';

/**
 * The discovery mask.
 *
 * Every field here is one LeadRadar actually uses to filter, verify, or score:
 *
 * - `id` is the only value retained indefinitely, so it is mandatory.
 * - `rating` and `userRatingCount` are the ability-to-pay signal; without them
 *   the product cannot rank opportunity and would just be a business directory.
 * - `websiteUri` is the need signal, and must be inspected rather than trusted:
 *   it frequently points at a directory listing.
 * - `nationalPhoneNumber` is both a reachability signal and the strongest
 *   deterministic key for website verification.
 * - `businessStatus` lets closed listings be dropped before any enrichment spend.
 *
 * These land in the Enterprise tier, which makes LeadRadar inherently an
 * Enterprise-tier product. `reviews` and `editorialSummary` are deliberately
 * excluded: they would escalate to Enterprise + Atmosphere, add review-author
 * attribution obligations, and provide nothing the score needs.
 */
export const DISCOVERY_FIELDS = [
  'id',
  'displayName',
  'formattedAddress',
  'addressComponents',
  'location',
  'types',
  'primaryType',
  'businessStatus',
  'googleMapsUri',
  'rating',
  'userRatingCount',
  'websiteUri',
  'nationalPhoneNumber',
] as const;

/** Free mask for confirming a Place ID still exists. */
export const REFRESH_FIELDS = ['id'] as const;

/** Prefix required by Text Search; Place Details takes bare field names. */
export type MaskPrefix = 'places.' | '';

/** Highest tier touched by a set of fields — the tier that will be billed. */
export function tierForFields(fields: readonly string[]): GooglePlacesTier {
  let highest: GooglePlacesTier = 'essentials-ids-only';

  for (const field of fields) {
    // Sub-fields are billed at their parent's tier (`addressComponents.longText`).
    const root = field.split('.')[0]!;
    const tier = GOOGLE_TIER_ORDER.find((candidate) =>
      GOOGLE_FIELD_TIERS[candidate].includes(root),
    );

    if (!tier) {
      // Fail rather than guess: an unrecognised field could be an Atmosphere
      // field, and guessing low would under-report cost and over-spend.
      throw new AppError({
        code: 'INVARIANT_VIOLATED',
        message:
          `Field '${field}' is not in the SKU tier table. Add it to ` +
          'GOOGLE_FIELD_TIERS so its cost is known before it is requested.',
        context: { field },
      });
    }

    if (GOOGLE_TIER_ORDER.indexOf(tier) > GOOGLE_TIER_ORDER.indexOf(highest)) {
      highest = tier;
    }
  }

  return highest;
}

/** SKU key for a Text Search request with the given fields. */
export function textSearchSkuFor(fields: readonly string[]): GoogleSkuKey {
  const tier = tierForFields(fields);
  switch (tier) {
    case 'essentials-ids-only':
      return 'text-search:essentials-ids-only';
    case 'essentials':
    case 'pro':
      return 'text-search:pro';
    case 'enterprise':
      return 'text-search:enterprise';
    case 'enterprise-atmosphere':
      // Reachable only by a mistake, and an expensive one: refuse it.
      throw new AppError({
        code: 'INVARIANT_VIOLATED',
        message:
          'A field mask requested Atmosphere-tier fields. LeadRadar never needs ' +
          'reviews or editorial summaries; remove them from the mask.',
        context: { fields: [...fields] },
      });
  }
}

/**
 * Renders a mask header value.
 *
 * `nextPageToken` is added for Text Search because pagination is unusable
 * without it, and it is an Essentials field so it costs nothing.
 */
export function renderMask(fields: readonly string[], prefix: MaskPrefix): string {
  const prefixed = fields.map((field) => `${prefix}${field}`);
  if (prefix === 'places.') prefixed.push('nextPageToken');
  return prefixed.join(',');
}

export const DISCOVERY_MASK = renderMask(DISCOVERY_FIELDS, 'places.');
export const DISCOVERY_SKU = textSearchSkuFor(DISCOVERY_FIELDS);
export const REFRESH_MASK = renderMask(REFRESH_FIELDS, '');
