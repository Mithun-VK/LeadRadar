/**
 * Social profile discovery.
 *
 * Extraction only — links found on the business's own pages, or in public search
 * results. There is no scraping of authenticated or private platform surfaces, and
 * no attempt to read follower counts or engagement: those sit behind terms that
 * forbid it, and inferring "active" from a URL would be presenting a guess as a
 * fact.
 *
 * So the claim this module supports is deliberately narrow and honest: "a public
 * profile exists on this platform, and here is the URL". That is enough for the
 * commercially useful signal — a business investing in Instagram but owning no
 * website is a prime web-development lead.
 */
import { normalizeDomain } from '@/modules/leads/normalize';
import type { SocialPlatform } from '@/types/domain';

interface PlatformSpec {
  readonly platform: SocialPlatform;
  readonly hosts: readonly string[];
  /** Extracts the handle, and rejects non-profile URLs by returning null. */
  readonly handle: (url: URL) => string | null;
}

/** Path segments that are platform features, never a business handle. */
const RESERVED = new Set([
  'p',
  'reel',
  'reels',
  'stories',
  'explore',
  'tv',
  'about',
  'privacy',
  'terms',
  'help',
  'legal',
  'login',
  'signup',
  'sharer',
  'share',
  'watch',
  'events',
  'groups',
  'marketplace',
  'pages',
  'profile.php',
  'search',
  'hashtag',
  'directory',
  'feed',
  'company',
  'showcase',
  'jobs',
  'shorts',
  'playlist',
  'results',
  'intent',
  'home',
]);

function firstSegment(url: URL): string | null {
  const segments = url.pathname.split('/').filter((segment) => segment !== '');
  if (segments.length === 0) return null;
  const first = segments[0]!.toLowerCase();
  return RESERVED.has(first) ? null : segments[0]!;
}

const PLATFORMS: readonly PlatformSpec[] = [
  {
    platform: 'INSTAGRAM',
    hosts: ['instagram.com'],
    handle: firstSegment,
  },
  {
    platform: 'FACEBOOK',
    hosts: ['facebook.com', 'fb.com', 'fb.me'],
    handle: firstSegment,
  },
  {
    platform: 'LINKEDIN',
    hosts: ['linkedin.com'],
    handle: (url) => {
      // LinkedIn business identity lives under /company/, not the root path.
      const segments = url.pathname.split('/').filter((s) => s !== '');
      if (segments[0]?.toLowerCase() === 'company' && segments[1]) return segments[1];
      return null;
    },
  },
  {
    platform: 'YOUTUBE',
    hosts: ['youtube.com', 'youtu.be'],
    handle: (url) => {
      const segments = url.pathname.split('/').filter((s) => s !== '');
      const first = segments[0] ?? '';
      if (first.startsWith('@')) return first.slice(1);
      if ((first === 'c' || first === 'channel' || first === 'user') && segments[1]) return segments[1];
      return null;
    },
  },
  {
    platform: 'X',
    hosts: ['x.com', 'twitter.com'],
    handle: firstSegment,
  },
  {
    platform: 'WHATSAPP_BUSINESS',
    hosts: ['wa.me', 'api.whatsapp.com'],
    handle: (url) => {
      const segment = url.pathname.split('/').filter((s) => s !== '')[0];
      if (segment && /^\d{7,15}$/.test(segment)) return segment;
      const phone = url.searchParams.get('phone');
      return phone && /^\+?\d{7,15}$/.test(phone) ? phone.replace('+', '') : null;
    },
  },
];

export interface DiscoveredSocialProfile {
  readonly platform: SocialPlatform;
  readonly url: string;
  readonly username: string | null;
  /**
   * DISCOVERED is the honest default: the link was found on a page we believe
   * belongs to the business. VERIFIED is only used when the link came from a page
   * whose ownership was already confirmed.
   */
  readonly status: 'DISCOVERED' | 'VERIFIED' | 'PROBABLE';
  readonly confidence: number;
}

/**
 * Extracts social profiles from a set of links.
 *
 * @param fromVerifiedPage when true, links came from a page whose ownership was
 * confirmed, so the profiles inherit that confidence. A social link on a verified
 * site is the business's own; the same link found in a search result is a guess.
 */
export function extractSocialProfiles(
  links: readonly string[],
  options: { fromVerifiedPage?: boolean } = {},
): DiscoveredSocialProfile[] {
  const verified = options.fromVerifiedPage ?? false;
  const seen = new Map<string, DiscoveredSocialProfile>();

  for (const raw of links) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      continue;
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') continue;

    const host = normalizeDomain(url.hostname);
    const spec = PLATFORMS.find((candidate) =>
      candidate.hosts.some((listed) => host === listed || host.endsWith(`.${listed}`)),
    );
    if (!spec) continue;

    const username = spec.handle(url);
    // A bare platform link with no handle identifies nothing — usually a share
    // button or a footer icon pointing at the platform's home page.
    if (!username) continue;

    // Canonical form, so the same profile linked from header and footer counts once.
    const canonical = `${spec.platform}:${username.toLowerCase()}`;
    if (seen.has(canonical)) continue;

    seen.set(canonical, {
      platform: spec.platform,
      url: `${url.origin}${url.pathname}`.replace(/\/$/, ''),
      username,
      status: verified ? 'VERIFIED' : 'DISCOVERED',
      confidence: verified ? 0.95 : 0.6,
    });
  }

  return [...seen.values()];
}

/**
 * Filters search-result URLs down to plausible profiles for a named business.
 *
 * Requires the handle to overlap the business name. Without that check, searching
 * "Bandra Brew Cafe Mumbai" and taking the first Instagram result attaches a food
 * blogger's account to the business — a confidently wrong lead.
 */
export function matchSocialToBusiness(
  candidates: readonly DiscoveredSocialProfile[],
  businessName: string,
): DiscoveredSocialProfile[] {
  const tokens = businessName
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .split(/\s+/)
    .filter((token) => token.length >= 4);

  if (tokens.length === 0) return [];

  return candidates
    .map((candidate) => {
      const handle = (candidate.username ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
      const hits = tokens.filter((token) => handle.includes(token)).length;
      const ratio = hits / tokens.length;
      return { candidate, ratio };
    })
    .filter((entry) => entry.ratio >= 0.5)
    .map((entry) => ({
      ...entry.candidate,
      status: entry.ratio >= 0.99 ? ('PROBABLE' as const) : ('DISCOVERED' as const),
      confidence: Number(Math.min(0.85, 0.45 + entry.ratio * 0.4).toFixed(2)),
    }));
}
