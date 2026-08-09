/**
 * DNS resolution for the SSRF guard.
 *
 * Split out because mock mode needs a different resolver, and that need is
 * substantive rather than cosmetic:
 *
 * The guard performs REAL DNS even when the three providers are mocked — correctly,
 * because it is a security control and must not be weakened by a configuration flag.
 * But the mock fixtures use fictional domains (`srikrishnadentalcare.in`), which do
 * not resolve, so every verification in mock mode failed closed as
 * WEBSITE_UNVERIFIED. Mock mode could therefore never demonstrate a successful
 * website match — the single most important thing the product does.
 *
 * The fix is a resolver that answers for KNOWN FIXTURE DOMAINS ONLY, and only when
 * mock mode is on. Everything else still goes to the system resolver, and every
 * answer still passes through the full IP classification. The guard's logic is
 * exercised exactly as in production; only the name-to-address step is stubbed, and
 * only for names we invented ourselves.
 */
import { lookup } from 'node:dns/promises';

import { env } from '@/lib/env';

import type { DnsResolver, ResolvedAddress } from './url-guard';

/**
 * A documentation-range address (TEST-NET-3, RFC 5737) would be blocked by the IP
 * classifier, which is the point of blocking it — so fixtures resolve to a real
 * public address instead. Nothing ever connects to it: the mock web provider serves
 * page content from memory.
 */
const FIXTURE_ADDRESS = '93.184.216.34';

/**
 * Domains the mock fixtures reference. Kept explicit rather than pattern-matched:
 * a wildcard would let any typo resolve, quietly hiding a broken fixture.
 */
const FIXTURE_DOMAINS = new Set([
  'srikrishnadentalcare.in',
  'annanagarsmilestudio.in',
  'koramangaladentalhub.in',
  'velacheryfamilydental.in',
  'jubileehillsdentalstudio.example',
  'bandrabrewcafe.in',
  'wrong-business.example',
  'oldtowndentalclinic.in',
  'adyardentalspecialists.in',
]);

async function systemResolver(hostname: string): Promise<readonly ResolvedAddress[]> {
  const results = await lookup(hostname, { all: true, verbatim: true });
  return results.map((entry) => ({ address: entry.address, family: entry.family }));
}

/**
 * The resolver the guard should use.
 *
 * In live mode this is the system resolver, full stop. In mock mode, fixture
 * domains resolve to a public address and everything else still goes to the system
 * — so a real URL appearing in mock mode is still checked for real.
 */
export function defaultResolver(): DnsResolver {
  let mockMode = false;
  try {
    mockMode = env().isMockMode;
  } catch {
    // Configuration is invalid; fall back to the strictest behaviour.
    mockMode = false;
  }

  if (!mockMode) return systemResolver;

  return async (hostname: string) => {
    const normalised = hostname.toLowerCase().replace(/^www\./, '');
    if (FIXTURE_DOMAINS.has(normalised)) {
      return [{ address: FIXTURE_ADDRESS, family: 4 }];
    }
    return systemResolver(hostname);
  };
}

/** Exposed for tests that assert which domains mock mode recognises. */
export function isFixtureDomain(hostname: string): boolean {
  return FIXTURE_DOMAINS.has(hostname.toLowerCase().replace(/^www\./, ''));
}
