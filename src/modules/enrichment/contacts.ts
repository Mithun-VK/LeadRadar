/**
 * Contact extraction.
 *
 * Runs over pages the enrichment pipeline has ALREADY fetched, so it adds no
 * marginal provider cost. That is the whole design: the expensive act — loading
 * the business's homepage and, sometimes, its contact page — has already been
 * paid for to answer a different question, and the addresses are sitting in the
 * bytes we bought.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS DELIBERATELY DOES NOT DO
 * ---------------------------------------------------------------------------
 *
 * It does not guess. There is no `first.last@domain` permutation generator and
 * no SMTP probe, and `EmailSourceDb` has no enum member that would let one be
 * added quietly. Guessed addresses bounce; bounces destroy the sender's domain
 * reputation; a damaged reputation silently degrades every campaign the operator
 * ever runs afterwards. The cost of a guessed address is not one bad email, it
 * is every future good one.
 *
 * Every address returned here was published, by the business, on a page we
 * confirmed belongs to that business.
 */
import { normalizeDomain } from '@/modules/leads/normalize';
import type { FetchedPage } from '@/modules/providers/contracts';

/**
 * Local-parts that address a function rather than a person.
 *
 * Marked, never discarded. For a small clinic or restaurant `info@` is usually
 * the only published address, and it is entirely legitimate to write to — it is
 * published precisely so that people write to it. Response rates are lower,
 * which is a ranking input, not a reason to drop the lead.
 */
const ROLE_LOCAL_PARTS = new Set([
  'info',
  'contact',
  'hello',
  'enquiry',
  'enquiries',
  'inquiry',
  'inquiries',
  'admin',
  'office',
  'mail',
  'email',
  'support',
  'help',
  'sales',
  'marketing',
  'reception',
  'frontdesk',
  'front-desk',
  'appointments',
  'booking',
  'bookings',
  'care',
  'team',
  'general',
]);

/**
 * Addresses that belong to infrastructure rather than the business.
 *
 * These appear on real business sites via theme boilerplate, privacy-policy
 * templates, and analytics snippets. Mailing them is at best useless and at
 * worst a complaint against a third party who never had any relationship with us.
 */
const BLOCKED_LOCAL_PARTS = new Set([
  'abuse',
  'postmaster',
  'noreply',
  'no-reply',
  'donotreply',
  'do-not-reply',
  'mailer-daemon',
  'webmaster',
  'hostmaster',
  'privacy',
  'dpo',
  'security',
  'unsubscribe',
  'bounce',
  'bounces',
  'notifications',
  'no_reply',
]);

/**
 * Domains that are never a business's own contact address.
 *
 * `example.com` and friends come from documentation copied into templates;
 * `sentry.io` and `wixpress.com` come from platform boilerplate. Mailing any of
 * them is a guaranteed miss.
 */
const BLOCKED_DOMAINS = new Set([
  'example.com',
  'example.org',
  'example.net',
  'domain.com',
  'yourdomain.com',
  'email.com',
  'sentry.io',
  'sentry-cdn.com',
  'wixpress.com',
  'wix.com',
  'squarespace.com',
  'godaddy.com',
  'shopify.com',
  'cloudflare.com',
  'w3.org',
  'schema.org',
  'googleapis.com',
  'gstatic.com',
  'jquery.com',
]);

/** File extensions that a greedy email regex mistakes for a domain. */
const IMAGE_LIKE_TLD =
  /\.(png|jpe?g|gif|svg|webp|avif|ico|css|js|mjs|woff2?|ttf|eot|mp4|webm|pdf)$/i;

/**
 * Email pattern.
 *
 * Deliberately stricter than RFC 5322, which permits quoted strings and comments
 * that no business publishes and that would mostly match noise. Requires a TLD of
 * at least two letters and forbids consecutive dots.
 */
const EMAIL_PATTERN =
  /\b[a-z0-9](?:[a-z0-9._%+-]{0,62}[a-z0-9])?@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}\b/gi;

/** `mailto:` targets, including those carrying query parameters. */
const MAILTO_PATTERN = /mailto:([^"'?\s>)\]]+)/gi;

export type EmailSource = 'PAGE_MAILTO' | 'PAGE_TEXT' | 'CONTACT_PAGE' | 'MANUAL_IMPORT';

export interface DiscoveredEmail {
  readonly email: string;
  readonly domain: string;
  readonly source: EmailSource;
  readonly confidence: number;
  readonly isRoleAccount: boolean;
  readonly matchesVerifiedDomain: boolean;
  readonly foundOnUrl: string | null;
}

/**
 * Normalises an address for storage and comparison.
 *
 * Lowercases (the domain is case-insensitive, and no real business publishes two
 * addresses differing only in the case of the local part) and strips the
 * `+tag` suffix, which is a routing hint rather than a distinct mailbox — keeping
 * both `info@x.com` and `info+web@x.com` would mean mailing the same person twice.
 */
export function normalizeEmail(raw: string): string | null {
  const trimmed = raw
    .trim()
    .toLowerCase()
    .replace(/^mailto:/, '');
  const withoutQuery = trimmed.split('?')[0] ?? '';
  const at = withoutQuery.lastIndexOf('@');
  if (at <= 0 || at === withoutQuery.length - 1) return null;

  const local = withoutQuery.slice(0, at).replace(/\+[^@]*$/, '');
  const domain = withoutQuery.slice(at + 1);

  if (local === '' || domain === '') return null;
  if (!domain.includes('.')) return null;
  if (domain.includes('..') || local.includes('..')) return null;
  if (IMAGE_LIKE_TLD.test(domain)) return null;

  return `${local}@${domain}`;
}

export function emailDomain(email: string): string {
  return email.slice(email.lastIndexOf('@') + 1);
}

export function localPart(email: string): string {
  return email.slice(0, email.lastIndexOf('@'));
}

export function isRoleAccount(email: string): boolean {
  return ROLE_LOCAL_PARTS.has(localPart(email));
}

/** Whether an address should never be contacted, regardless of where it appeared. */
export function isBlockedAddress(email: string): boolean {
  if (BLOCKED_LOCAL_PARTS.has(localPart(email))) return true;

  const domain = emailDomain(email);
  if (BLOCKED_DOMAINS.has(domain)) return true;
  // Also block subdomains of blocked hosts, e.g. o1234.ingest.sentry.io.
  return [...BLOCKED_DOMAINS].some((blocked) => domain.endsWith(`.${blocked}`));
}

/**
 * Confidence that an address belongs to this business.
 *
 * The dominant term is domain agreement: an address on the domain we already
 * verified belongs to the business is near-certain, while a gmail.com address on
 * that same page could equally belong to the web designer who built the site.
 * A `mailto:` link outranks loose page text because it was marked up as a contact
 * point rather than merely mentioned.
 */
export function scoreEmailConfidence(input: {
  matchesVerifiedDomain: boolean;
  source: EmailSource;
  isRoleAccount: boolean;
}): number {
  let confidence = input.matchesVerifiedDomain ? 0.85 : 0.45;

  if (input.source === 'PAGE_MAILTO') confidence += 0.1;
  else if (input.source === 'CONTACT_PAGE') confidence += 0.07;

  // A role account on the business's own domain is the canonical published
  // contact, so it is a small positive rather than a penalty. On a foreign
  // domain it is more likely someone else's boilerplate.
  if (input.isRoleAccount) confidence += input.matchesVerifiedDomain ? 0.03 : -0.1;

  return Number(Math.max(0.05, Math.min(0.98, confidence)).toFixed(2));
}

export interface ExtractEmailsOptions {
  /** The domain confirmed to belong to this business, when one was verified. */
  readonly verifiedDomain?: string | null;
  /** Marks addresses as coming from a contact/about page rather than a homepage. */
  readonly isContactPage?: boolean;
}

/**
 * Extracts addresses from one already-fetched page.
 *
 * Reads both the raw document (for `mailto:` hrefs, which markdown conversion
 * often discards) and the text content, then deduplicates: the same address
 * usually appears in both, and the stronger source must win.
 */
export function extractEmailsFromPage(
  page: FetchedPage,
  options: ExtractEmailsOptions = {},
): DiscoveredEmail[] {
  const verifiedDomain = options.verifiedDomain ? normalizeDomain(options.verifiedDomain) : null;

  const best = new Map<string, DiscoveredEmail>();

  const consider = (raw: string, source: EmailSource): void => {
    const email = normalizeEmail(raw);
    if (!email || isBlockedAddress(email)) return;

    const domain = emailDomain(email);
    const matchesVerifiedDomain =
      verifiedDomain !== null &&
      (domain === verifiedDomain || domain.endsWith(`.${verifiedDomain}`));

    const role = isRoleAccount(email);
    const candidate: DiscoveredEmail = {
      email,
      domain,
      source,
      confidence: scoreEmailConfidence({ matchesVerifiedDomain, source, isRoleAccount: role }),
      isRoleAccount: role,
      matchesVerifiedDomain,
      foundOnUrl: page.finalUrl || page.url || null,
    };

    const existing = best.get(email);
    if (!existing || candidate.confidence > existing.confidence) best.set(email, candidate);
  };

  const linkSource: EmailSource = options.isContactPage ? 'CONTACT_PAGE' : 'PAGE_MAILTO';
  const textSource: EmailSource = options.isContactPage ? 'CONTACT_PAGE' : 'PAGE_TEXT';

  // mailto: hrefs first — an address marked up as a link was published as a
  // contact point, not merely mentioned in prose.
  const searchable = `${page.html ?? ''}\n${page.content}`;
  for (const match of searchable.matchAll(MAILTO_PATTERN)) {
    const value = match[1];
    if (value) consider(decodeURIComponent(value), linkSource);
  }

  for (const match of searchable.matchAll(EMAIL_PATTERN)) {
    consider(match[0], textSource);
  }

  // Also mine the link set: some providers surface mailto: links there and
  // nowhere else.
  for (const link of page.links) {
    if (link.toLowerCase().startsWith('mailto:')) consider(link, linkSource);
  }

  return rankEmails([...best.values()]);
}

/**
 * Orders addresses best-first.
 *
 * Domain agreement dominates, then confidence, then personal over role — a named
 * mailbox on the right domain reaches a person, which is what an outreach email
 * needs. Ties break on the address itself so the ordering is deterministic and
 * two runs over the same page produce the same primary contact.
 */
export function rankEmails(emails: readonly DiscoveredEmail[]): DiscoveredEmail[] {
  return [...emails].sort((a, b) => {
    if (a.matchesVerifiedDomain !== b.matchesVerifiedDomain) {
      return a.matchesVerifiedDomain ? -1 : 1;
    }
    if (a.confidence !== b.confidence) return b.confidence - a.confidence;
    if (a.isRoleAccount !== b.isRoleAccount) return a.isRoleAccount ? 1 : -1;
    return a.email.localeCompare(b.email);
  });
}

/** Merges addresses found across several pages, keeping the strongest of each. */
export function mergeEmails(
  ...groups: ReadonlyArray<readonly DiscoveredEmail[]>
): DiscoveredEmail[] {
  const best = new Map<string, DiscoveredEmail>();

  for (const group of groups) {
    for (const candidate of group) {
      const existing = best.get(candidate.email);
      if (!existing || candidate.confidence > existing.confidence) {
        best.set(candidate.email, candidate);
      }
    }
  }

  return rankEmails([...best.values()]);
}

/**
 * The address an outreach campaign should use, or null.
 *
 * Null is a real and common answer, and callers must treat it as "we found none"
 * rather than substituting a guess. The floor exists so a low-confidence address
 * scraped off a foreign domain never silently becomes a campaign recipient.
 */
export const PRIMARY_EMAIL_MIN_CONFIDENCE = 0.5;

export function selectPrimaryEmail(emails: readonly DiscoveredEmail[]): DiscoveredEmail | null {
  return rankEmails(emails).find((e) => e.confidence >= PRIMARY_EMAIL_MIN_CONFIDENCE) ?? null;
}

/**
 * Whether an address is syntactically usable as a recipient.
 *
 * Syntax only. There is no deliverability claim here, and none can be made
 * without either sending or an SMTP probe — the first is the thing we are gating,
 * and the second is the reputation-damaging behaviour this module refuses.
 */
export function isSendableEmail(value: string): boolean {
  const normalised = normalizeEmail(value);
  if (!normalised) return false;
  if (isBlockedAddress(normalised)) return false;
  return normalised.length <= 254;
}
