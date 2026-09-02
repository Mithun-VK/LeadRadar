/**
 * Service offerings — the commercial catalogue.
 *
 * Sits on top of the existing scoring engine rather than replacing it.
 * `ServiceOpportunityDb` remains the taxonomy the scoring rules reason about
 * ("this business needs WEBSITE_DEVELOPMENT"); this layer answers the commercial
 * question the scoring engine cannot: *which of the things we actually sell, at
 * what price*.
 *
 * That separation matters. Scoring rules are calibrated against outcomes and
 * should change rarely; a price list changes whenever the operator feels like it.
 * Coupling them would mean a pricing edit invalidating scoring history.
 *
 * ---------------------------------------------------------------------------
 * THE REASONING RULE
 * ---------------------------------------------------------------------------
 *
 * `reasoning` is assembled from FLAGS THAT WERE ACTUALLY DETECTED, and nothing
 * else. There is no template sentence that fires when no evidence exists, and no
 * fallback that invents a plausible problem. If nothing was detected, the
 * recommendation comes back with empty reasoning and the UI says so — because a
 * salesperson repeating a fabricated defect to a prospect who can check it is the
 * single most expensive thing this product could cause.
 */
import { notFound } from '@/lib/errors';
import { db, type TenantContext } from '@/modules/database/client';
import { FLAG_LABELS, rankFlags, type FlagDetail, type OpportunityFlag } from '@/modules/scoring/flags';
import type { ServiceOpportunity } from '@/types/domain';

/**
 * Which opportunity each flag argues for.
 *
 * Every entry is a DERIVATION: the named, measured defect directly calls for that
 * service. Flags describing the prospect's commercial position rather than a
 * fixable problem (LOW_REVIEW_COUNT, DECLINING_RATING) map to nothing, because
 * there is no service that fixes "you have few reviews" honestly.
 */
export const FLAG_TO_OPPORTUNITY: Partial<Record<OpportunityFlag, ServiceOpportunity>> = {
  NO_WEBSITE: 'WEBSITE_DEVELOPMENT',
  DIRECTORY_LISTING_ONLY: 'WEBSITE_DEVELOPMENT',
  WEBSITE_BROKEN: 'WEBSITE_DEVELOPMENT',
  WEBSITE_PARKED: 'WEBSITE_DEVELOPMENT',

  THIN_WEBSITE: 'WEBSITE_REDESIGN',
  OUTDATED_WEBSITE: 'WEBSITE_REDESIGN',
  FREE_HOSTING: 'WEBSITE_REDESIGN',
  POOR_MOBILE: 'WEBSITE_REDESIGN',
  NO_HTTPS: 'WEBSITE_REDESIGN',
  MIXED_CONTENT: 'WEBSITE_REDESIGN',
  NO_CONTACT_ROUTE: 'WEBSITE_REDESIGN',

  POOR_SEO: 'SEO',
  MISSING_META_DESCRIPTION: 'SEO',
  MISSING_H1: 'SEO',
  MISSING_ALT_TEXT: 'SEO',
  NO_STRUCTURED_DATA: 'LOCAL_SEO',

  LOW_CONTENT_QUALITY: 'CONTENT_MARKETING',
  NO_SOCIAL_MEDIA: 'SOCIAL_MEDIA_MARKETING',
  NO_BOOKING_FUNNEL: 'AI_AUTOMATION',
};

/**
 * The catalogue an organization starts with.
 *
 * Prices are deliberately null. A default price list would be a guess about
 * someone else's business, and an operator who never revisits it would send
 * proposals at numbers this software invented. Null renders as "quoted per
 * engagement" until a human sets a figure.
 */
export const DEFAULT_OFFERINGS: ReadonlyArray<{
  name: string;
  description: string;
  opportunity: ServiceOpportunity;
  priority: number;
}> = [
  {
    name: 'Website Development',
    description: 'A new website for a business that has none, or only a directory listing.',
    opportunity: 'WEBSITE_DEVELOPMENT',
    priority: 100,
  },
  {
    name: 'Website Redesign',
    description: 'Rebuilding a site that exists but is dated, insecure, or unusable on a phone.',
    opportunity: 'WEBSITE_REDESIGN',
    priority: 90,
  },
  {
    name: 'E-commerce Development',
    description: 'An online store for a business currently selling only in person.',
    opportunity: 'WEBSITE_DEVELOPMENT',
    priority: 80,
  },
  {
    name: 'SEO',
    description: 'Search visibility work: metadata, structure, content, and technical fixes.',
    opportunity: 'SEO',
    priority: 70,
  },
  {
    name: 'Local SEO',
    description: 'Local search presence: structured data, listings, and map visibility.',
    opportunity: 'LOCAL_SEO',
    priority: 65,
  },
  {
    name: 'AI Automation',
    description: 'Automating repetitive work such as enquiry handling, booking, and follow-up.',
    opportunity: 'AI_AUTOMATION',
    priority: 60,
  },
  {
    name: 'CRM Development',
    description: 'A customer database and pipeline for a business tracking work in spreadsheets.',
    opportunity: 'AI_AUTOMATION',
    priority: 55,
  },
  {
    name: 'Custom Software',
    description: 'Bespoke internal tools built around an existing process.',
    opportunity: 'AI_AUTOMATION',
    priority: 50,
  },
  {
    name: 'Web Application Development',
    description: 'An interactive application rather than a brochure site.',
    opportunity: 'WEBSITE_DEVELOPMENT',
    priority: 45,
  },
  {
    name: 'Social Media Marketing',
    description: 'Building and running social presence for a business with none.',
    opportunity: 'SOCIAL_MEDIA_MARKETING',
    priority: 40,
  },
  {
    name: 'Content Marketing',
    description: 'Content for a site with too little for search engines or visitors to work with.',
    opportunity: 'CONTENT_MARKETING',
    priority: 35,
  },
];

export interface ServiceRecommendationResult {
  readonly primaryService: {
    readonly offeringId: string | null;
    readonly name: string;
    readonly opportunity: ServiceOpportunity;
    readonly basePriceMinor: number | null;
    readonly currency: string;
  } | null;
  readonly secondaryServices: ReadonlyArray<{
    readonly offeringId: string | null;
    readonly name: string;
    readonly opportunity: ServiceOpportunity;
  }>;
  readonly salesAngle: string | null;
  /**
   * Why, one line per detected flag. Empty when nothing was detected — which is a
   * real and honest answer, not a failure to fill in.
   */
  readonly reasoning: readonly string[];
  /** True when no evidence supports any recommendation. */
  readonly insufficientEvidence: boolean;
}

/** Seeds the default catalogue. Idempotent. */
export async function ensureDefaultOfferings(
  tenant: TenantContext,
): Promise<{ created: number }> {
  let created = 0;

  for (const offering of DEFAULT_OFFERINGS) {
    const existing = await db().serviceOffering.findUnique({
      where: {
        organizationId_name: { organizationId: tenant.organizationId, name: offering.name },
      },
      select: { id: true },
    });

    if (existing) continue;

    await db().serviceOffering.create({
      data: {
        organizationId: tenant.organizationId,
        name: offering.name,
        description: offering.description,
        opportunity: offering.opportunity,
        priority: offering.priority,
        basePriceMinor: null,
        active: true,
      },
    });
    created += 1;
  }

  return { created };
}

export async function listOfferings(tenant: TenantContext, activeOnly = false) {
  return db().serviceOffering.findMany({
    where: {
      organizationId: tenant.organizationId,
      ...(activeOnly && { active: true }),
    },
    orderBy: [{ active: 'desc' }, { priority: 'desc' }, { name: 'asc' }],
  });
}

export interface UpsertOfferingInput {
  readonly name: string;
  readonly description?: string | null;
  readonly opportunity?: ServiceOpportunity | null;
  readonly basePriceMinor?: number | null;
  readonly currency?: string;
  readonly active?: boolean;
  readonly priority?: number;
}

export async function createOffering(tenant: TenantContext, input: UpsertOfferingInput) {
  return db().serviceOffering.create({
    data: {
      organizationId: tenant.organizationId,
      name: input.name,
      description: input.description ?? null,
      opportunity: input.opportunity ?? null,
      basePriceMinor: input.basePriceMinor ?? null,
      currency: input.currency ?? 'INR',
      active: input.active ?? true,
      priority: input.priority ?? 0,
    },
  });
}

export async function updateOffering(
  tenant: TenantContext,
  offeringId: string,
  input: Partial<UpsertOfferingInput>,
) {
  const existing = await db().serviceOffering.findFirst({
    where: { id: offeringId, organizationId: tenant.organizationId },
    select: { id: true },
  });

  if (!existing) throw notFound('Service offering', { offeringId });

  return db().serviceOffering.update({
    where: { id: existing.id },
    data: {
      ...(input.name !== undefined && { name: input.name }),
      ...(input.description !== undefined && { description: input.description }),
      ...(input.opportunity !== undefined && { opportunity: input.opportunity }),
      ...(input.basePriceMinor !== undefined && { basePriceMinor: input.basePriceMinor }),
      ...(input.currency !== undefined && { currency: input.currency }),
      ...(input.active !== undefined && { active: input.active }),
      ...(input.priority !== undefined && { priority: input.priority }),
    },
  });
}

/**
 * Recommends what to sell, from detected evidence only.
 *
 * Walks the flags in severity order, maps each to an opportunity, then matches
 * opportunities against the operator's active catalogue. When the catalogue has
 * no offering for a needed opportunity, the opportunity is still returned with a
 * null `offeringId` — the need is real even if the operator does not sell it, and
 * hiding it would misrepresent the lead.
 */
export async function recommendServices(
  tenant: TenantContext,
  flags: readonly FlagDetail[],
): Promise<ServiceRecommendationResult> {
  const ranked = rankFlags(flags);

  // Preserve first-seen (severity) order while deduplicating.
  const opportunities: ServiceOpportunity[] = [];
  const reasoning: string[] = [];

  for (const detail of ranked) {
    const opportunity = FLAG_TO_OPPORTUNITY[detail.flag];
    if (!opportunity) continue;

    if (!opportunities.includes(opportunity)) opportunities.push(opportunity);

    // The rationale is the flag's own measured sentence. Nothing is composed
    // here, so nothing can be invented here.
    reasoning.push(`${FLAG_LABELS[detail.flag]}: ${detail.rationale}`);
  }

  if (opportunities.length === 0) {
    return {
      primaryService: null,
      secondaryServices: [],
      salesAngle: null,
      reasoning: [],
      insufficientEvidence: true,
    };
  }

  const catalogue = await db().serviceOffering.findMany({
    where: { organizationId: tenant.organizationId, active: true },
    orderBy: { priority: 'desc' },
  });

  const forOpportunity = (opportunity: ServiceOpportunity) =>
    catalogue.find((offering) => offering.opportunity === opportunity) ?? null;

  const primaryOpportunity = opportunities[0]!;
  const primaryOffering = forOpportunity(primaryOpportunity);

  const primaryService = {
    offeringId: primaryOffering?.id ?? null,
    name: primaryOffering?.name ?? humanizeOpportunity(primaryOpportunity),
    opportunity: primaryOpportunity,
    basePriceMinor: primaryOffering?.basePriceMinor ?? null,
    currency: primaryOffering?.currency ?? 'INR',
  };

  const secondaryServices = opportunities.slice(1, 4).map((opportunity) => {
    const offering = forOpportunity(opportunity);
    return {
      offeringId: offering?.id ?? null,
      name: offering?.name ?? humanizeOpportunity(opportunity),
      opportunity,
    };
  });

  // The angle is the single highest-severity measured finding, verbatim. The
  // existing outreach personalization uses the same source, so a lead's angle in
  // the CRM and in an email cannot disagree.
  const leadFinding = ranked.find((detail) => FLAG_TO_OPPORTUNITY[detail.flag] !== undefined);

  return {
    primaryService,
    secondaryServices,
    salesAngle: leadFinding?.rationale ?? null,
    reasoning,
    insufficientEvidence: false,
  };
}

/** Fallback label when the operator has no offering for an opportunity. */
function humanizeOpportunity(opportunity: ServiceOpportunity): string {
  return opportunity
    .toLowerCase()
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}
