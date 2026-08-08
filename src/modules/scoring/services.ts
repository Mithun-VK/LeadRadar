/**
 * Service recommendation.
 *
 * Answers the question an agency actually asks: not "is this a good lead?" but
 * "what do I sell them, and what do I open the call with?"
 *
 * Deterministic rules, because the mapping from signals to services is genuinely
 * rule-shaped and an agency needs to trust it. AI narrative is layered on top for
 * high-value leads only, and it explains the recommendation rather than making it.
 */
import type { ServiceOpportunity, SocialPlatform } from '@/types/domain';
import type { WebsiteQualitySignals } from '@/modules/enrichment/verification';

import type { OpportunityResult } from './opportunity';

export interface RecommendationInput {
  readonly googleWebsiteStatus: string;
  readonly independentWebsiteStatus: string;
  readonly websiteQuality: WebsiteQualitySignals | null;
  readonly socialPlatforms: readonly SocialPlatform[];
  readonly rating: number | null;
  readonly reviewCount: number | null;
  readonly isChain: boolean;
  readonly primaryCategory: string | null;
}

export interface ServiceRecommendation {
  readonly service: ServiceOpportunity;
  /** 0-100. Ranks services against each other for one lead. */
  readonly strength: number;
  /** Rule ids that fired, for explainability. */
  readonly reasons: readonly string[];
  /** One-line opener a salesperson can actually use. */
  readonly pitch: string;
}

interface Rule {
  readonly id: string;
  readonly service: ServiceOpportunity;
  readonly strength: number;
  readonly pitch: (input: RecommendationInput) => string;
  readonly when: (input: RecommendationInput) => boolean;
}

const hasNoOwnedSite = (input: RecommendationInput): boolean =>
  input.independentWebsiteStatus === 'NO_INDEPENDENT_WEBSITE_FOUND' ||
  input.independentWebsiteStatus === 'WEBSITE_MISMATCH' ||
  (input.independentWebsiteStatus === 'NOT_CHECKED' &&
    input.googleWebsiteStatus !== 'GOOGLE_WEBSITE_PRESENT');

const hasRealSite = (input: RecommendationInput): boolean =>
  input.independentWebsiteStatus === 'INDEPENDENT_WEBSITE_FOUND' &&
  input.websiteQuality !== null &&
  !input.websiteQuality.isParked;

const isEstablished = (input: RecommendationInput): boolean => (input.reviewCount ?? 0) >= 50;
const isBusy = (input: RecommendationInput): boolean => (input.reviewCount ?? 0) >= 200;

/**
 * Rules in rough priority order. Several can fire; strengths rank them.
 *
 * Strength encodes both fit and deal size — a website build is worth more than a
 * social retainer, so an equally-good fit for both should surface the build first.
 */
const RULES: readonly Rule[] = [
  {
    id: 'no-site-established',
    service: 'WEBSITE_DEVELOPMENT',
    strength: 95,
    when: (input) => hasNoOwnedSite(input) && isEstablished(input),
    pitch: (input) =>
      `${input.reviewCount?.toLocaleString('en-IN')} Google reviews but no website — ` +
      'customers are finding them and then finding nothing to convert on.',
  },
  {
    id: 'no-site-social-active',
    service: 'WEBSITE_DEVELOPMENT',
    strength: 92,
    when: (input) => hasNoOwnedSite(input) && input.socialPlatforms.length > 0,
    pitch: (input) =>
      `Already investing in ${input.socialPlatforms[0]} but has no website to send that traffic to.`,
  },
  {
    id: 'third-party-listing-only',
    service: 'WEBSITE_DEVELOPMENT',
    strength: 90,
    when: (input) => input.googleWebsiteStatus === 'GOOGLE_WEBSITE_IS_THIRD_PARTY_LISTING',
    pitch: () =>
      'Their "website" is a directory listing — they are paying a platform for traffic they could own.',
  },
  {
    id: 'no-site-small',
    service: 'WEBSITE_DEVELOPMENT',
    strength: 60,
    when: (input) => hasNoOwnedSite(input) && !isEstablished(input),
    pitch: () => 'No website yet; a starter site plus a Google Business Profile is the entry point.',
  },
  {
    id: 'site-parked',
    service: 'WEBSITE_DEVELOPMENT',
    strength: 88,
    when: (input) => input.websiteQuality?.isParked === true,
    pitch: () => 'Their domain shows a placeholder page — they bought a domain and stopped.',
  },
  {
    id: 'site-broken',
    service: 'WEBSITE_DEVELOPMENT',
    strength: 93,
    when: (input) => input.independentWebsiteStatus === 'WEBSITE_BROKEN',
    pitch: () => 'Their website does not load — every visitor right now is a lost customer.',
  },
  {
    id: 'site-thin-busy',
    service: 'WEBSITE_REDESIGN',
    strength: 85,
    when: (input) => hasRealSite(input) && input.websiteQuality!.isThin && isBusy(input),
    pitch: (input) =>
      `Strong reputation (${input.rating?.toFixed(1)}, ${input.reviewCount?.toLocaleString('en-IN')} reviews) ` +
      'behind a single thin page that does not reflect it.',
  },
  {
    id: 'site-thin',
    service: 'WEBSITE_REDESIGN',
    strength: 68,
    when: (input) => hasRealSite(input) && input.websiteQuality!.isThin,
    pitch: () => 'Website is a single page with almost no content.',
  },
  {
    id: 'free-hosting',
    service: 'WEBSITE_REDESIGN',
    strength: 62,
    when: (input) => input.websiteQuality?.isFreeHosting === true,
    pitch: () => 'Running on a free subdomain rather than their own domain — weak for brand and SEO.',
  },
  {
    id: 'no-https',
    service: 'WEBSITE_REDESIGN',
    strength: 55,
    when: (input) => hasRealSite(input) && !input.websiteQuality!.httpsEnabled,
    pitch: () => 'Site has no HTTPS, so browsers warn visitors before they see it.',
  },
  {
    id: 'local-seo-visible',
    service: 'LOCAL_SEO',
    strength: 80,
    when: (input) => isEstablished(input),
    pitch: (input) =>
      `Already ranking locally with ${input.reviewCount?.toLocaleString('en-IN')} reviews — ` +
      'local SEO compounds what they have rather than starting from zero.',
  },
  {
    id: 'local-seo-invisible',
    service: 'LOCAL_SEO',
    strength: 58,
    when: (input) => (input.reviewCount ?? 0) < 50,
    pitch: () => 'Very little local visibility; profile optimisation and review generation come first.',
  },
  {
    id: 'seo-has-site',
    service: 'SEO',
    strength: 66,
    when: (input) => hasRealSite(input) && !input.websiteQuality!.isThin,
    pitch: () => 'A real site exists, so organic growth is the next lever rather than a rebuild.',
  },
  {
    id: 'social-absent-established',
    service: 'SOCIAL_MEDIA_MARKETING',
    strength: 78,
    when: (input) => input.socialPlatforms.length === 0 && isEstablished(input),
    pitch: (input) =>
      `Strong offline reputation (${input.reviewCount?.toLocaleString('en-IN')} reviews) with no social presence at all.`,
  },
  {
    id: 'social-single-channel',
    service: 'SOCIAL_MEDIA_MARKETING',
    strength: 60,
    when: (input) => input.socialPlatforms.length === 1,
    pitch: (input) => `Only on ${input.socialPlatforms[0]}; a second channel is low-effort growth.`,
  },
  {
    id: 'content-thin-site',
    service: 'CONTENT_MARKETING',
    strength: 52,
    when: (input) => hasRealSite(input) && input.websiteQuality!.contentLength < 3_000,
    pitch: () => 'Site has minimal content, which limits both search reach and credibility.',
  },
  {
    id: 'no-booking-appointment-trade',
    service: 'AI_AUTOMATION',
    strength: 64,
    when: (input) =>
      input.websiteQuality?.hasBookingIndicator === false &&
      /clinic|dental|salon|spa|physio|veterinar|hospital|doctor/i.test(input.primaryCategory ?? ''),
    pitch: () =>
      'Appointment-driven business with no online booking — every booking is currently a phone call.',
  },
  {
    id: 'paid-ads-ready',
    service: 'PAID_ADVERTISING',
    strength: 56,
    when: (input) => hasRealSite(input) && isBusy(input),
    pitch: () => 'Proven demand and a working site: paid acquisition has somewhere to land.',
  },
  {
    id: 'branding-weak-identity',
    service: 'BRANDING',
    strength: 45,
    when: (input) => hasNoOwnedSite(input) && input.socialPlatforms.length === 0 && isEstablished(input),
    pitch: () => 'Established business with no digital identity at all — branding precedes the build.',
  },
];

/**
 * Recommends services for a lead.
 *
 * Deduplicates by service, keeping the strongest matching rule, so a lead does not
 * show WEBSITE_DEVELOPMENT three times with different pitches.
 */
export function recommendServices(
  input: RecommendationInput,
  options: { limit?: number } = {},
): ServiceRecommendation[] {
  const limit = options.limit ?? 4;

  // A franchise outlet cannot buy; recommending to it wastes a salesperson's day.
  if (input.isChain) return [];

  const byService = new Map<ServiceOpportunity, ServiceRecommendation>();

  for (const rule of RULES) {
    if (!rule.when(input)) continue;

    const existing = byService.get(rule.service);
    if (existing && existing.strength >= rule.strength) {
      byService.set(rule.service, {
        ...existing,
        reasons: [...existing.reasons, rule.id],
      });
      continue;
    }

    byService.set(rule.service, {
      service: rule.service,
      strength: rule.strength,
      reasons: [...(existing?.reasons ?? []), rule.id],
      pitch: rule.pitch(input),
    });
  }

  return [...byService.values()].sort((a, b) => b.strength - a.strength).slice(0, limit);
}

/** Signals for the narrative task: our own facts, never scraped text. */
export function narrativeSignals(
  score: OpportunityResult,
  recommendations: readonly ServiceRecommendation[],
): string[] {
  return [
    ...score.signals.filter((signal) => signal.points !== 0).map((signal) => signal.label),
    ...recommendations.slice(0, 2).map((rec) => `Recommended: ${rec.service}`),
  ];
}
