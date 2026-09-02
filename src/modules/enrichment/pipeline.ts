/**
 * Enrichment pipeline — the cost-gated core of the product.
 *
 * Each stage narrows the set before the next, more expensive one runs, and every
 * gate here is a spending decision:
 *
 *   1. Candidates are assembled from what we already have (free) before any
 *      search is bought.
 *   2. A web search runs only when there is no owned-domain candidate at all.
 *   3. Only the single best candidate is fetched. Scraping three plausible
 *      domains to pick one triples the bill for a decision the top candidate
 *      usually settles.
 *   4. A second page is fetched only when the first left the verdict ambiguous.
 *   5. Groq is called only for the inconclusive band — and, because a Groq call
 *      costs less than a page fetch, it is preferred over fetching more pages.
 *
 * The pipeline reports its own spend and the reason for every decision, so an
 * unexpected bill is traceable to the choice that caused it.
 */
import { logger } from '@/lib/logger';
import { isThirdPartyListing, normalizeDomain, phoneDigits } from '@/modules/leads/normalize';
import type { FetchedPage, ProviderRegistry, UsageRecord } from '@/modules/providers/contracts';
import { validateExternalUrl } from '@/modules/security/url-guard';
import {
  confidenceBand,
  type IndependentWebsiteStatus,
  type SocialPlatform,
  type WebsiteMatchStatus,
} from '@/types/domain';

import {
  assessWebsiteQuality,
  mergeResults,
  needsAiAdjudication,
  outcomeFromDeterministic,
  scoreDeterministic,
  secondaryPagePaths,
  type DeterministicResult,
  type WebsiteQualitySignals,
} from './verification';
import {
  extractSocialProfiles,
  matchSocialToBusiness,
  type DiscoveredSocialProfile,
} from './social';
import { extractEmailsFromPage, mergeEmails, type DiscoveredEmail } from './contacts';
import { analyzeWebsite, type WebsiteAnalysisResult } from './website-analysis';

export interface EnrichmentSubject {
  readonly id: string;
  readonly displayName: string;
  readonly normalizedName: string;
  readonly city: string | null;
  readonly primaryCategory: string | null;
  readonly formattedAddress: string | null;
  readonly phone: string | null;
  readonly googleWebsiteStatus: string;
  /** The URL Google listed, if any. Untrusted: may be a directory page. */
  readonly websiteUri: string | null;
}

export interface WebsiteCandidateDraft {
  readonly url: string;
  readonly domain: string;
  readonly title: string | null;
  readonly description: string | null;
  readonly source:
    | 'GOOGLE_PLACES_FIELD'
    | 'WEB_SEARCH_NAME_CITY'
    | 'WEB_SEARCH_NAME_PHONE'
    | 'WEB_SEARCH_NAME_ADDRESS';
  readonly position: number | null;
  readonly isThirdPartyListing: boolean;
}

export interface EnrichmentResult {
  readonly independentWebsiteStatus: IndependentWebsiteStatus;
  readonly verifiedDomain: string | null;
  readonly candidates: readonly WebsiteCandidateDraft[];
  readonly verification: {
    readonly status: WebsiteMatchStatus;
    readonly confidence: number;
    readonly deterministicScore: number;
    readonly evidence: readonly DeterministicResult['evidence'][number][];
    readonly usedAi: boolean;
    readonly matched: DeterministicResult['matched'];
    readonly candidateDomain: string | null;
  } | null;
  readonly websiteQuality: WebsiteQualitySignals | null;
  /**
   * Structured analysis of the verified site. Null when no site was verified —
   * there is nothing to analyse, which is different from analysing it as zero.
   */
  readonly websiteAnalysis: WebsiteAnalysisResult | null;
  readonly socialProfiles: readonly DiscoveredSocialProfile[];
  /**
   * Addresses published on the business's own pages. Extracted from documents
   * the pipeline already paid to fetch, so this costs nothing extra.
   */
  readonly emails: readonly DiscoveredEmail[];
  readonly usage: readonly UsageRecord[];
  /** Ordered decision trail, for cost debugging and the lead's processing history. */
  readonly decisions: readonly string[];
  /** True when the lead needs a human look. */
  readonly needsManualReview: boolean;
}

/**
 * Assembles candidates from data already in hand.
 *
 * Costs nothing, and for the ~65% of businesses with a listed website it removes
 * the need for a search entirely.
 */
export function buildInitialCandidates(subject: EnrichmentSubject): WebsiteCandidateDraft[] {
  if (!subject.websiteUri) return [];

  const domain = normalizeDomain(subject.websiteUri);
  if (domain === '') return [];

  return [
    {
      url: subject.websiteUri,
      domain,
      title: null,
      description: null,
      source: 'GOOGLE_PLACES_FIELD',
      position: 0,
      // Recorded rather than filtered: a directory URL is meaningful data, and the
      // scoring engine treats it as high need.
      isThirdPartyListing: isThirdPartyListing(domain),
    },
  ];
}

/** Search queries, cheapest-signal-first. Only run until one yields candidates. */
export function searchQueriesFor(subject: EnrichmentSubject): Array<{
  query: string;
  source: WebsiteCandidateDraft['source'];
}> {
  const queries: Array<{ query: string; source: WebsiteCandidateDraft['source'] }> = [];
  const name = subject.displayName;

  if (subject.city) {
    queries.push({
      query: `"${name}" "${subject.city}"${subject.primaryCategory ? ` ${subject.primaryCategory}` : ''}`,
      source: 'WEB_SEARCH_NAME_CITY',
    });
  }

  // Phone is the strongest identifier, so a phone-anchored search yields the
  // fewest false candidates — but it is second because name+city returns the
  // owned domain most of the time and costs the same.
  const digits = phoneDigits(subject.phone);
  if (digits) {
    queries.push({ query: `"${name}" "${digits}"`, source: 'WEB_SEARCH_NAME_PHONE' });
  }

  if (subject.formattedAddress) {
    queries.push({
      query: `"${name}" ${subject.formattedAddress.split(',').slice(0, 2).join(' ')}`,
      source: 'WEB_SEARCH_NAME_ADDRESS',
    });
  }

  if (queries.length === 0) queries.push({ query: `"${name}"`, source: 'WEB_SEARCH_NAME_CITY' });
  return queries;
}

export interface EnrichmentOptions {
  /** Hard ceiling on Firecrawl page fetches for one business. */
  readonly maxPageFetches?: number;
  /** Hard ceiling on web searches for one business. */
  readonly maxSearches?: number;
  /** Allow the AI adjudication step. Disabled when the AI budget is exhausted. */
  readonly allowAi?: boolean;
}

const DEFAULTS = { maxPageFetches: 2, maxSearches: 2, allowAi: true } as const;

/**
 * Enriches one business.
 *
 * Never throws for ordinary web failure: a dead domain, a blocked crawler, or an
 * unparseable page are expected outcomes that must be recorded rather than allowed
 * to fail a job containing thousands of other businesses.
 */
export async function enrichBusiness(
  subject: EnrichmentSubject,
  providers: ProviderRegistry,
  options: EnrichmentOptions = {},
): Promise<EnrichmentResult> {
  const limits = { ...DEFAULTS, ...options };
  const log = logger().child({ component: 'enrichment', businessId: subject.id });

  const usage: UsageRecord[] = [];
  const decisions: string[] = [];
  const candidates: WebsiteCandidateDraft[] = buildInitialCandidates(subject);
  let searches = 0;
  let fetches = 0;

  const ownedCandidate = candidates.find((candidate) => !candidate.isThirdPartyListing);

  if (ownedCandidate) {
    decisions.push(
      `Using the website Google listed (${ownedCandidate.domain}); no web search needed.`,
    );
  } else {
    if (candidates.length > 0) {
      decisions.push(
        `Google listed ${candidates[0]!.domain}, which is a directory or social listing — ` +
          'searching for an owned website instead.',
      );
    } else {
      decisions.push('No website listed on Google; searching the public web.');
    }

    for (const { query, source } of searchQueriesFor(subject)) {
      if (searches >= limits.maxSearches) break;

      const result = await providers.web.search({ query, limit: 5, country: 'IN' });
      searches += 1;

      if (!result.ok) {
        decisions.push(`Web search failed (${result.error.code}); continuing without it.`);
        log.debug({ err: result.error, query }, 'Web search failed');
        continue;
      }

      usage.push(...result.value.usage);

      const fresh = result.value.data
        .map((item) => ({
          url: item.url,
          domain: normalizeDomain(item.url),
          title: item.title,
          description: item.description,
          source,
          position: item.position,
          isThirdPartyListing: isThirdPartyListing(item.url),
        }))
        .filter(
          (candidate) =>
            candidate.domain !== '' &&
            !candidates.some((existing) => existing.domain === candidate.domain),
        );

      candidates.push(...fresh);

      // Stop as soon as an owned-domain candidate appears: further searches would
      // cost credits to confirm what we already have.
      if (fresh.some((candidate) => !candidate.isThirdPartyListing)) {
        decisions.push(`Found ${fresh.length} new candidate(s) via ${source}; stopping search.`);
        break;
      }
      decisions.push(`${source} returned only directory results.`);
    }
  }

  // Social profiles found in search results are recorded even when no website
  // exists — a social-only business is a strong lead, not a dead end.
  const socialFromSearch = matchSocialToBusiness(
    extractSocialProfiles(candidates.map((candidate) => candidate.url)),
    subject.displayName,
  );

  const target = candidates.find((candidate) => !candidate.isThirdPartyListing);

  if (!target) {
    decisions.push('No owned-domain candidate found; recording as no independent website.');
    return {
      independentWebsiteStatus: 'NO_INDEPENDENT_WEBSITE_FOUND',
      verifiedDomain: null,
      candidates,
      verification: null,
      websiteQuality: null,
      websiteAnalysis: null,
      socialProfiles: socialFromSearch,
      emails: [],
      usage,
      decisions,
      needsManualReview: false,
    };
  }

  // SSRF gate before spending. Free, and it must run whether the URL came from
  // Google or from a search engine — neither is trustworthy.
  const guard = await validateExternalUrl(target.url);
  if (!guard.ok) {
    decisions.push(`Candidate ${target.domain} was rejected by URL validation; not fetched.`);
    log.warn({ domain: target.domain, code: guard.error.code }, 'Candidate URL blocked');
    return {
      independentWebsiteStatus: 'WEBSITE_UNVERIFIED',
      verifiedDomain: null,
      candidates,
      verification: null,
      websiteQuality: null,
      websiteAnalysis: null,
      socialProfiles: socialFromSearch,
      emails: [],
      usage,
      decisions,
      needsManualReview: true,
    };
  }

  // includeHtml costs no extra credits (providers bill per page, not per format)
  // and is what makes honest website analysis possible at all.
  const homepage = await providers.web.fetchPage({
    url: target.url,
    includeLinks: true,
    includeHtml: true,
  });
  fetches += 1;

  if (!homepage.ok) {
    decisions.push(`Could not load ${target.domain} (${homepage.error.code}).`);

    // A listed-but-dead website is a strong signal, not a gap: the business is
    // actively losing customers, which is a better pitch than "you need a site".
    const broken = target.source === 'GOOGLE_PLACES_FIELD';
    return {
      independentWebsiteStatus: broken ? 'WEBSITE_BROKEN' : 'WEBSITE_UNVERIFIED',
      verifiedDomain: null,
      candidates,
      verification: null,
      websiteQuality: null,
      websiteAnalysis: null,
      socialProfiles: socialFromSearch,
      emails: [],
      usage,
      decisions,
      needsManualReview: !broken,
    };
  }

  usage.push(...homepage.value.usage);
  const page: FetchedPage = homepage.value.data;

  const businessFacts = {
    displayName: subject.displayName,
    normalizedName: subject.normalizedName,
    city: subject.city,
    primaryCategory: subject.primaryCategory,
    formattedAddress: subject.formattedAddress,
    phoneDigits: phoneDigits(subject.phone),
  };

  // Links accumulate across pages; the provider's response object stays immutable.
  const discoveredLinks: string[] = [...page.links];
  // Every page actually fetched, so contact extraction can mine all of them
  // without fetching anything again.
  const fetchedPages: Array<{ page: FetchedPage; isContactPage: boolean }> = [
    { page, isContactPage: false },
  ];

  let result = scoreDeterministic({ business: businessFacts, page });
  decisions.push(`Deterministic verification scored ${result.score}/100 on the homepage.`);

  // One extra page, only when it could change the verdict. Contact and about pages
  // carry the phone number that settles most ambiguity.
  if (needsAiAdjudication(result) && fetches < limits.maxPageFetches) {
    const secondary = secondaryPagePaths(discoveredLinks);
    if (secondary.length > 0) {
      const guarded = await validateExternalUrl(secondary[0]!);
      if (guarded.ok) {
        const second = await providers.web.fetchPage({
          url: secondary[0]!,
          includeLinks: true,
          includeHtml: true,
        });
        fetches += 1;

        if (second.ok) {
          usage.push(...second.value.usage);
          const secondResult = scoreDeterministic({
            business: businessFacts,
            page: second.value.data,
          });
          result = mergeResults(result, secondResult);
          decisions.push(
            `Fetched ${new URL(secondary[0]!).pathname} to resolve ambiguity; score is now ${result.score}/100.`,
          );
          discoveredLinks.push(...second.value.data.links);
          fetchedPages.push({ page: second.value.data, isContactPage: true });
        }
      }
    }
  }

  let outcome = outcomeFromDeterministic(result);

  /**
   * AI adjudication.
   *
   * Reached for roughly one candidate in five. Worth noting that a Groq call is
   * CHEAPER than another page fetch, so preferring it over more crawling is both
   * the more accurate and the cheaper choice — the opposite of the usual
   * "avoid AI to save money" instinct.
   */
  if (limits.allowAi && needsAiAdjudication(result)) {
    decisions.push(
      `Score ${result.score} is in the ambiguous band; asking the model to adjudicate.`,
    );

    const verdict = await providers.ai.matchWebsite({
      business: {
        name: subject.displayName,
        city: subject.city,
        category: subject.primaryCategory,
        phoneDigits: businessFacts.phoneDigits,
        addressTokens: (subject.formattedAddress ?? '').split(/[,\s]+/).filter((t) => t.length > 2),
      },
      candidate: {
        domain: target.domain,
        title: page.title,
        description: page.description,
        phoneDigitsFound: result.evidence
          .filter((entry) => entry.field === 'phone')
          .map((entry) => entry.detail),
        cityMentions: subject.city && result.matched.city ? [subject.city] : [],
        contentExcerpt: page.content,
      },
      deterministicScore: result.score,
      unresolvedReason: result.unresolvedReason,
    });

    if (verdict.ok) {
      usage.push(...verdict.value.usage);
      const ai = verdict.value.data;
      const band = confidenceBand(ai.confidence);

      // The model's verdict is accepted only in the high-confidence band. Below
      // that the deterministic result stands and the lead is flagged — a low
      // confidence verdict is information about uncertainty, not a decision.
      if (band === 'accept') {
        outcome = {
          status: ai.result.status,
          confidence: ai.confidence,
          deterministicScore: result.score,
          evidence: result.evidence,
          usedAi: true,
        };
        decisions.push(
          `Model returned ${ai.result.status} at ${ai.confidence.toFixed(2)} confidence; accepted.`,
        );
      } else {
        outcome = { ...outcome, usedAi: true, confidence: Math.min(outcome.confidence, 0.65) };
        decisions.push(
          `Model returned ${ai.result.status} at ${ai.confidence.toFixed(2)} confidence — ` +
            'too low to accept automatically; flagged for review.',
        );
      }
    } else {
      decisions.push(
        `Model adjudication failed (${verdict.error.code}); keeping the rule-based verdict.`,
      );
    }
  } else if (!limits.allowAi && needsAiAdjudication(result)) {
    decisions.push('Ambiguous, but AI adjudication is disabled for this job; flagged for review.');
  }

  const accepted = outcome.status === 'MATCH' || outcome.status === 'PROBABLE_MATCH';
  const quality = accepted ? assessWebsiteQuality(page) : null;

  /**
   * Analysis and contact extraction run ONLY on a site we accepted as this
   * business's own.
   *
   * This gate is the difference between a useful lead and a confidently wrong
   * one. Emails harvested from an unverified candidate would attach some other
   * company's address to this business, and a campaign would then mail a
   * stranger about a website that is not theirs — the failure mode that costs
   * credibility across the whole list, not just one row.
   */
  const analysis = accepted ? analyzeWebsite(page) : null;

  const emails = accepted
    ? mergeEmails(
        ...fetchedPages.map(({ page: fetched, isContactPage }) =>
          extractEmailsFromPage(fetched, {
            verifiedDomain: target.domain,
            isContactPage,
          }),
        ),
      )
    : [];

  if (accepted) {
    decisions.push(
      emails.length > 0
        ? `Found ${emails.length} contact address(es) on pages already fetched, at no extra cost.`
        : 'No contact address is published on the pages fetched.',
    );
    if (analysis) {
      decisions.push(
        `Website analysis scored ${analysis.qualityScore}/100 ` +
          `(SEO ${analysis.seoScore}/25, mobile ${analysis.mobileScore}/20, security ${analysis.securityScore}/15).`,
      );
    }
  }

  if (quality?.isParked) decisions.push('Verified site is a parked or placeholder page.');
  else if (quality?.isThin) decisions.push('Verified site is a single thin page.');

  // Social links on a verified site are the business's own, so they inherit that
  // confidence rather than being guesses.
  const socialFromSite = accepted
    ? extractSocialProfiles(discoveredLinks, { fromVerifiedPage: true })
    : [];

  const mergedSocial = new Map<string, DiscoveredSocialProfile>();
  for (const profile of [...socialFromSearch, ...socialFromSite]) {
    const key = `${profile.platform}:${(profile.username ?? '').toLowerCase()}`;
    const existing = mergedSocial.get(key);
    if (!existing || profile.confidence > existing.confidence) mergedSocial.set(key, profile);
  }

  const status: IndependentWebsiteStatus = accepted
    ? 'INDEPENDENT_WEBSITE_FOUND'
    : outcome.status === 'MISMATCH'
      ? 'WEBSITE_MISMATCH'
      : 'WEBSITE_UNVERIFIED';

  return {
    independentWebsiteStatus: status,
    verifiedDomain: accepted ? target.domain : null,
    candidates,
    verification: {
      status: outcome.status,
      confidence: outcome.confidence,
      deterministicScore: outcome.deterministicScore,
      evidence: outcome.evidence,
      usedAi: outcome.usedAi,
      matched: result.matched,
      candidateDomain: target.domain,
    },
    websiteQuality: quality,
    websiteAnalysis: analysis,
    socialProfiles: [...mergedSocial.values()],
    emails,
    usage,
    decisions,
    needsManualReview:
      outcome.status === 'UNKNOWN' ||
      (outcome.status === 'PROBABLE_MATCH' && outcome.confidence < 0.7),
  };
}

/** Platform list for the scoring engine. */
export function socialPlatformsOf(profiles: readonly DiscoveredSocialProfile[]): SocialPlatform[] {
  return [
    ...new Set(
      profiles.filter((p) => p.status !== 'PROBABLE' || p.confidence >= 0.6).map((p) => p.platform),
    ),
  ];
}
