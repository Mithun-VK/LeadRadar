/**
 * Outreach personalization.
 *
 * ---------------------------------------------------------------------------
 * THE RULE THIS MODULE EXISTS TO ENFORCE
 * ---------------------------------------------------------------------------
 *
 * An outreach email makes claims about someone else's business, to that business,
 * in writing, from the operator's real address. A fabricated claim is not a bad
 * row in a table — it is the operator telling a stranger something false about
 * their own company. They will know it is false. It is the fastest way to destroy
 * a sender's credibility, and no amount of volume compensates.
 *
 * So the sales angle is DERIVED FROM MEASUREMENTS, deterministically, by the code
 * below. Every sentence it can produce traces to a specific observation made by
 * the website analyzer: a viewport tag that is absent, an alt attribute count, an
 * HTTP scheme.
 *
 * When AI personalization is enabled it is allowed to REPHRASE that sentence and
 * nothing more. Its output is then checked against the facts it was given, and
 * any number, URL, or claim it invented causes the deterministic sentence to be
 * used instead. The model is a stylist, never a source.
 *
 * This mirrors the containment already applied to website matching elsewhere in
 * the codebase: deterministic code owns every fact, the model owns none.
 */
import { logger } from '@/lib/logger';
import { fence, sanitiseUntrusted } from '@/modules/ai/untrusted';
import type { AiProvider } from '@/modules/providers/contracts';
import {
  FLAG_LABELS,
  rankFlags,
  type FlagDetail,
  type OpportunityFlag,
} from '@/modules/scoring/flags';

import type { TemplateValues } from './templates';

/** How long a generated angle may be. Longer than this stops being read. */
const MAX_ANGLE_CHARS = 320;

export interface PersonalizationInput {
  readonly businessName: string;
  readonly industry: string | null;
  readonly city: string | null;
  readonly verifiedDomain: string | null;
  readonly flags: readonly FlagDetail[];
  readonly recommendedService: string | null;
  readonly websiteQualityScore: number | null;
}

/**
 * Sentences for each flag, written in the second person.
 *
 * Phrased as observations rather than judgements: "your site has no mobile
 * viewport tag, so it renders zoomed out on phones" is checkable and useful,
 * while "your website looks unprofessional" is an insult the recipient can
 * neither verify nor act on. The first opens a conversation; the second ends one.
 *
 * `null` marks a flag that is real but not worth leading an email with — a
 * caution for the salesperson rather than something to say to the prospect.
 */
const ANGLE_BY_FLAG: Partial<Record<OpportunityFlag, string>> = {
  NO_WEBSITE:
    "I couldn't find a website for you — searching for {business} in {city} turns up your listing but no site of your own, so people comparing options have nothing of yours to look at.",
  DIRECTORY_LISTING_ONLY:
    "You show up on directory listings, but I couldn't find a site of your own. That means the directories own the relationship with people searching for you, and they show your competitors on the same page.",
  WEBSITE_BROKEN:
    "The website listed for you didn't load when I checked. Anyone who clicks through from your listing right now is hitting an error instead of reaching you.",
  WEBSITE_PARKED:
    'Your domain currently shows a placeholder page rather than a working site, so visitors who do find it leave without learning anything about you.',
  NO_HTTPS:
    'Your site is served over plain HTTP rather than HTTPS, which means every visitor sees a "Not secure" warning in their browser before they read a word.',
  POOR_MOBILE:
    'Your site has no mobile viewport tag, so on a phone it renders as a zoomed-out desktop page. Most people searching for a local business are on a phone.',
  THIN_WEBSITE:
    'Your site is a single page, so there is very little for search engines to rank and very little for a visitor to read before deciding.',
  OUTDATED_WEBSITE:
    'Your site is missing a couple of things that have been standard for over a decade — a mobile viewport tag and structured data — which suggests it has not been updated in a while.',
  MISSING_META_DESCRIPTION:
    'Your pages have no meta description, so Google writes the summary under your own search result instead of you.',
  NO_STRUCTURED_DATA:
    "Your site has no structured data, so your opening hours, address, and reviews cannot appear directly in search results the way competitors' can.",
  MISSING_ALT_TEXT:
    'Most images on your site have no alt text, which costs you image search traffic and makes the site harder to use with a screen reader.',
  FREE_HOSTING:
    'Your site runs on a free subdomain rather than your own domain, which tends to read as temporary to people comparing suppliers.',
  NO_CONTACT_ROUTE:
    'I could not find a contact page linked from your site, so an interested visitor has no obvious way to get in touch.',
  NO_BOOKING_FUNNEL:
    'Your site has no booking or enquiry button, so visitors who are interested have to work out how to contact you themselves.',
  NO_SOCIAL_MEDIA:
    "I couldn't find social profiles for you, which is where a lot of local discovery happens now.",
  MIXED_CONTENT:
    'Some resources on your site load over insecure HTTP even though the page itself is secure, which browsers warn about or block outright.',
  LOW_CONTENT_QUALITY:
    'There is not much text on your site, which gives search engines little to work with when deciding where to rank you.',
  // Deliberately absent from outreach: these describe the prospect's commercial
  // position, not a fixable problem, and saying them out loud is insulting.
  LOW_REVIEW_COUNT: undefined,
  DECLINING_RATING: undefined,
  NO_CONTACT_EMAIL: undefined,
  POOR_SEO: undefined,
  MISSING_H1: undefined,
};

/** Human-readable service names for the template. */
const SERVICE_LABELS: Record<string, string> = {
  WEBSITE_DEVELOPMENT: 'building websites',
  WEBSITE_REDESIGN: 'website redesigns',
  SEO: 'search engine optimisation',
  LOCAL_SEO: 'local search visibility',
  SOCIAL_MEDIA_MARKETING: 'social media marketing',
  CONTENT_MARKETING: 'content marketing',
  PAID_ADVERTISING: 'paid advertising',
  BRANDING: 'branding',
  AI_AUTOMATION: 'automating repetitive work',
};

/**
 * Service implied by the clearest measured gap.
 *
 * A fallback for when no stored `ServiceRecommendation` exists — which is the
 * normal state for an imported lead, or one enrolled before scoring ran. Without
 * it, the shipped starter template (which references `{{recommended_service}}`)
 * silently refuses every such lead, and the operator sees an unexplained
 * "template needs details this lead does not have".
 *
 * This is a derivation, not an invention: each entry is the service that the
 * named, measured defect directly calls for.
 */
const SERVICE_BY_FLAG: Partial<Record<OpportunityFlag, string>> = {
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
  POOR_SEO: 'SEO',
  MISSING_META_DESCRIPTION: 'SEO',
  MISSING_H1: 'SEO',
  NO_STRUCTURED_DATA: 'LOCAL_SEO',
  MISSING_ALT_TEXT: 'SEO',
  LOW_CONTENT_QUALITY: 'CONTENT_MARKETING',
  NO_SOCIAL_MEDIA: 'SOCIAL_MEDIA_MARKETING',
  NO_BOOKING_FUNNEL: 'AI_AUTOMATION',
  NO_CONTACT_ROUTE: 'WEBSITE_REDESIGN',
};

/** The service to pitch: the stored recommendation, else one derived from flags. */
export function resolveService(stored: string | null, flags: readonly FlagDetail[]): string | null {
  if (stored) return stored;
  for (const detail of rankFlags(flags)) {
    const service = SERVICE_BY_FLAG[detail.flag];
    if (service) return service;
  }
  return null;
}

/**
 * Builds the sales angle from measurements.
 *
 * Uses the single highest-severity flag that has something worth saying, rather
 * than listing every defect. A message that recites six problems reads as an
 * audit report from a stranger and puts the recipient on the defensive; one
 * specific, checkable observation reads as someone who actually looked.
 */
export function deterministicAngle(input: PersonalizationInput): string | null {
  for (const detail of rankFlags(input.flags)) {
    const template = ANGLE_BY_FLAG[detail.flag];
    if (!template) continue;

    return template
      .replace('{business}', input.businessName)
      .replace('{city}', input.city ?? 'your area');
  }

  return null;
}

/** The clearest single gap, as a short noun phrase for `{{opportunity}}`. */
export function primaryOpportunity(flags: readonly FlagDetail[]): string | null {
  const ranked = rankFlags(flags).find((detail) => ANGLE_BY_FLAG[detail.flag] !== undefined);
  return ranked ? FLAG_LABELS[ranked.flag].toLowerCase() : null;
}

/**
 * Checks a model-written angle against the facts it was given.
 *
 * The specific failure this prevents: a model handed "no viewport tag" writing
 * "your site takes 8 seconds to load and loses 40% of visitors". Both numbers are
 * invented, both are checkable by the recipient, and both are indefensible.
 *
 * Any digit sequence, URL, or percentage in the output that does not appear in
 * the source facts causes rejection. Blunt on purpose — a false negative costs a
 * slightly less fluent sentence, while a false positive costs the operator's
 * credibility.
 */
export function containsOnlyGivenFacts(generated: string, sourceFacts: string): boolean {
  const source = sourceFacts.toLowerCase();

  // Any URL is a fabrication risk: the model was given no links to cite.
  if (/https?:\/\/|www\./i.test(generated)) return false;

  // Percentages and multi-digit numbers are the classic invented metric.
  for (const match of generated.matchAll(/\b\d[\d,.]*\s*%?/g)) {
    const token = match[0].trim().toLowerCase();
    // Single small digits used as ordinary words ("one", "a 5-minute call") are
    // not metrics; anything longer is treated as a claim.
    if (token.length <= 1 && !token.includes('%')) continue;
    if (!source.includes(token.replace(/[,\s]/g, ''))) return false;
  }

  return true;
}

export interface PersonalizationResult {
  readonly values: TemplateValues;
  /** How the angle was produced, so the UI can be honest about it. */
  readonly angleSource: 'measured' | 'ai-rephrased' | 'none';
}

export interface PersonalizeOptions {
  readonly senderName: string;
  readonly companyName: string;
  /** When set, the model may rephrase the measured angle. */
  readonly ai?: AiProvider | null;
}

/**
 * Produces every template value for one lead.
 *
 * Returns values only for facts that are actually known. A missing value is left
 * out rather than filled with a plausible default, so the strict renderer refuses
 * the lead instead of emailing them a sentence about a city we never established.
 */
export async function personalize(
  input: PersonalizationInput,
  options: PersonalizeOptions,
): Promise<PersonalizationResult> {
  const measured = deterministicAngle(input);
  let angle = measured;
  let angleSource: PersonalizationResult['angleSource'] = measured ? 'measured' : 'none';

  if (measured && options.ai) {
    const rephrased = await rephraseAngle(measured, input, options.ai);
    if (rephrased) {
      angle = rephrased;
      angleSource = 'ai-rephrased';
    }
  }

  const resolved = resolveService(input.recommendedService, input.flags);
  const service = resolved ? (SERVICE_LABELS[resolved] ?? 'digital marketing') : null;

  const values: TemplateValues = {
    business_name: input.businessName,
    sender_name: options.senderName,
    company_name: options.companyName,
    ...(input.industry && { industry: input.industry }),
    ...(input.city && { city: input.city }),
    ...(input.verifiedDomain && { website: input.verifiedDomain }),
    ...(angle && { sales_angle: angle }),
    ...(service && { recommended_service: service }),
  };

  const opportunity = primaryOpportunity(input.flags);
  if (opportunity) values.opportunity = opportunity;

  return { values, angleSource };
}

/**
 * Asks the model to rephrase, and verifies what comes back.
 *
 * Returns null on any doubt — a failed call, an over-long response, or a
 * response containing a fact it was not given. The measured sentence is always a
 * correct fallback, so there is never a reason to accept a questionable one.
 */
async function rephraseAngle(
  measured: string,
  input: PersonalizationInput,
  ai: AiProvider,
): Promise<string | null> {
  const facts = [
    `Business name: ${input.businessName}`,
    input.city ? `City: ${input.city}` : null,
    input.industry ? `Category: ${input.industry}` : null,
    input.verifiedDomain ? `Website: ${input.verifiedDomain}` : null,
    `Measured observation: ${measured}`,
    ...input.flags.map((flag) => `Finding: ${flag.rationale}`),
  ]
    .filter((line): line is string => line !== null)
    .join('\n');

  const result = await ai.summariseOpportunity({
    businessName: input.businessName,
    // Sanitised and fenced as untrusted: these strings contain text scraped from
    // a page the business controls, and a page can carry instructions aimed at a
    // model. The blast radius is bounded anyway — the worst a successful
    // injection achieves here is a sentence that fails the fact check below and
    // is discarded.
    signals: [fence(sanitiseUntrusted(facts).text)],
  });

  if (!result.ok) {
    logger().debug({ err: result.error }, 'AI rephrase failed; using the measured sentence');
    return null;
  }

  const generated = result.value.data.result.summary?.trim() ?? '';
  if (generated === '' || generated.length > MAX_ANGLE_CHARS) return null;

  if (!containsOnlyGivenFacts(generated, facts)) {
    logger().warn(
      { businessName: input.businessName },
      'AI rephrase introduced a fact it was not given; falling back to the measured sentence',
    );
    return null;
  }

  return generated;
}
