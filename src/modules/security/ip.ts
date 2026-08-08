/**
 * IP address classification for SSRF defence.
 *
 * Kept separate from the URL guard and free of I/O so the full blocklist can be
 * exhaustively unit-tested. The default posture is deny: an address we cannot
 * parse is treated as blocked, because "unparseable" and "safe" are unrelated.
 */
import { isIP } from 'node:net';

export type IpBlockReason =
  | 'unspecified'
  | 'loopback'
  | 'private'
  | 'carrier-nat'
  | 'link-local'
  | 'cloud-metadata'
  | 'unique-local'
  | 'multicast'
  | 'reserved'
  | 'documentation'
  | 'benchmark'
  | 'broadcast'
  | 'unparseable';

export interface IpClassification {
  readonly blocked: boolean;
  readonly reason?: IpBlockReason;
  /** The range that matched, for audit logs and test assertions. */
  readonly range?: string;
}

const ALLOWED: IpClassification = { blocked: false };

interface Range4 {
  readonly cidr: string;
  readonly reason: IpBlockReason;
}

/**
 * IPv4 ranges that must never be fetched. Includes the well-known cloud
 * metadata address, which is inside link-local but called out separately
 * because it is the highest-value SSRF target and deserves its own audit
 * reason.
 */
const BLOCKED_V4: readonly Range4[] = [
  { cidr: '0.0.0.0/8', reason: 'unspecified' },
  { cidr: '10.0.0.0/8', reason: 'private' },
  { cidr: '100.64.0.0/10', reason: 'carrier-nat' },
  { cidr: '127.0.0.0/8', reason: 'loopback' },
  { cidr: '169.254.169.254/32', reason: 'cloud-metadata' },
  { cidr: '169.254.0.0/16', reason: 'link-local' },
  { cidr: '172.16.0.0/12', reason: 'private' },
  { cidr: '192.0.0.0/24', reason: 'reserved' },
  { cidr: '192.0.2.0/24', reason: 'documentation' },
  { cidr: '192.88.99.0/24', reason: 'reserved' },
  { cidr: '192.168.0.0/16', reason: 'private' },
  { cidr: '198.18.0.0/15', reason: 'benchmark' },
  { cidr: '198.51.100.0/24', reason: 'documentation' },
  { cidr: '203.0.113.0/24', reason: 'documentation' },
  { cidr: '224.0.0.0/4', reason: 'multicast' },
  // Most specific first: 255.255.255.255 also falls inside 240.0.0.0/4, and
  // 'broadcast' is the more useful reason in an audit log. Matching is
  // first-hit, so ordering is the specificity mechanism.
  { cidr: '255.255.255.255/32', reason: 'broadcast' },
  { cidr: '240.0.0.0/4', reason: 'reserved' },
];

function parseV4(address: string): number | undefined {
  const parts = address.split('.');
  if (parts.length !== 4) return undefined;

  let value = 0;
  for (const part of parts) {
    // Reject empty, non-numeric, and octal-style forms such as `0177.0.0.1`,
    // which some resolvers accept and which are a classic filter bypass.
    if (!/^\d{1,3}$/.test(part)) return undefined;
    if (part.length > 1 && part.startsWith('0')) return undefined;
    const octet = Number(part);
    if (octet > 255) return undefined;
    value = value * 256 + octet;
  }
  return value >>> 0;
}

function parseCidr4(cidr: string): { base: number; mask: number } {
  const [address, bitsRaw] = cidr.split('/');
  const base = parseV4(address!);
  const bits = Number(bitsRaw);
  if (base === undefined || !Number.isInteger(bits) || bits < 0 || bits > 32) {
    throw new Error(`Invalid IPv4 CIDR in blocklist: ${cidr}`);
  }
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return { base: (base & mask) >>> 0, mask };
}

const COMPILED_V4 = BLOCKED_V4.map((range) => ({ ...range, ...parseCidr4(range.cidr) }));

function classifyV4(address: string): IpClassification {
  const value = parseV4(address);
  if (value === undefined) return { blocked: true, reason: 'unparseable' };

  for (const range of COMPILED_V4) {
    if (((value & range.mask) >>> 0) === range.base) {
      return { blocked: true, reason: range.reason, range: range.cidr };
    }
  }
  return ALLOWED;
}

/** Expands an IPv6 address to its 8 numeric groups, or undefined if malformed. */
function parseV6Groups(address: string): number[] | undefined {
  let work = address;

  // Strip a zone index (`fe80::1%eth0`) — irrelevant to classification.
  const zone = work.indexOf('%');
  if (zone !== -1) work = work.slice(0, zone);

  // An embedded IPv4 tail (::ffff:127.0.0.1) becomes two 16-bit groups.
  let tail: number[] = [];
  const lastColon = work.lastIndexOf(':');
  const candidate = work.slice(lastColon + 1);
  if (candidate.includes('.')) {
    const v4 = parseV4(candidate);
    if (v4 === undefined) return undefined;
    tail = [(v4 >>> 16) & 0xffff, v4 & 0xffff];
    work = work.slice(0, lastColon + 1);
    if (work.endsWith(':') && !work.endsWith('::')) work = work.slice(0, -1);
  }

  const doubleColon = work.indexOf('::');
  let head: string[];
  let rest: string[];

  if (doubleColon === -1) {
    head = work === '' ? [] : work.split(':');
    rest = [];
  } else {
    const before = work.slice(0, doubleColon);
    const after = work.slice(doubleColon + 2);
    head = before === '' ? [] : before.split(':');
    rest = after === '' ? [] : after.split(':');
  }

  const toNumbers = (groups: string[]): number[] | undefined => {
    const out: number[] = [];
    for (const group of groups) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return undefined;
      out.push(Number.parseInt(group, 16));
    }
    return out;
  };

  const headNums = toNumbers(head);
  const restNums = toNumbers(rest);
  if (!headNums || !restNums) return undefined;

  const explicit = headNums.length + restNums.length + tail.length;
  if (doubleColon === -1) {
    return explicit === 8 ? [...headNums, ...tail] : undefined;
  }
  if (explicit > 8) return undefined;

  return [...headNums, ...Array<number>(8 - explicit).fill(0), ...restNums, ...tail];
}

function classifyV6(address: string): IpClassification {
  const groups = parseV6Groups(address);
  if (!groups) return { blocked: true, reason: 'unparseable' };

  const isZeroPrefix = (count: number) => groups.slice(0, count).every((g) => g === 0);

  // IPv4-mapped (::ffff:a.b.c.d) and NAT64 (64:ff9b::/96) carry a real IPv4
  // destination. Classify the embedded address, or the mapping becomes a bypass.
  if (isZeroPrefix(5) && groups[5] === 0xffff) {
    const embedded = `${groups[6]! >> 8}.${groups[6]! & 0xff}.${groups[7]! >> 8}.${groups[7]! & 0xff}`;
    const inner = classifyV4(embedded);
    return inner.blocked ? { ...inner, range: `::ffff:${embedded}` } : ALLOWED;
  }
  if (groups[0] === 0x64 && groups[1] === 0xff9b && groups[2] === 0 && isZeroPrefixFrom(groups, 2, 6)) {
    const embedded = `${groups[6]! >> 8}.${groups[6]! & 0xff}.${groups[7]! >> 8}.${groups[7]! & 0xff}`;
    const inner = classifyV4(embedded);
    return inner.blocked ? { ...inner, range: `64:ff9b::${embedded}` } : ALLOWED;
  }

  if (groups.every((g) => g === 0)) {
    return { blocked: true, reason: 'unspecified', range: '::/128' };
  }
  if (isZeroPrefix(7) && groups[7] === 1) {
    return { blocked: true, reason: 'loopback', range: '::1/128' };
  }
  // 100::/64 discard-only
  if (groups[0] === 0x100 && isZeroPrefixFrom(groups, 1, 4)) {
    return { blocked: true, reason: 'reserved', range: '100::/64' };
  }
  // fe80::/10 link-local
  if ((groups[0]! & 0xffc0) === 0xfe80) {
    return { blocked: true, reason: 'link-local', range: 'fe80::/10' };
  }
  // fc00::/7 unique local
  if ((groups[0]! & 0xfe00) === 0xfc00) {
    return { blocked: true, reason: 'unique-local', range: 'fc00::/7' };
  }
  // ff00::/8 multicast
  if ((groups[0]! & 0xff00) === 0xff00) {
    return { blocked: true, reason: 'multicast', range: 'ff00::/8' };
  }
  // 2001:db8::/32 documentation
  if (groups[0] === 0x2001 && groups[1] === 0x0db8) {
    return { blocked: true, reason: 'documentation', range: '2001:db8::/32' };
  }

  return ALLOWED;
}

function isZeroPrefixFrom(groups: number[], start: number, end: number): boolean {
  for (let i = start; i < end; i += 1) {
    if (groups[i] !== 0) return false;
  }
  return true;
}

/**
 * Classifies an IP literal. Anything not positively recognised as a public
 * address is blocked.
 */
export function classifyIp(address: string): IpClassification {
  const trimmed = address.trim().replace(/^\[|\]$/g, '');
  const version = isIP(trimmed);
  if (version === 4) return classifyV4(trimmed);
  if (version === 6) return classifyV6(trimmed);

  // `isIP` rejects some forms our own parsers still understand (and that some
  // resolvers accept). Try both before giving up, so a bypass attempt is
  // classified rather than merely unrecognised.
  if (trimmed.includes(':')) return classifyV6(trimmed);
  return classifyV4(trimmed);
}

export function isBlockedIp(address: string): boolean {
  return classifyIp(address).blocked;
}
