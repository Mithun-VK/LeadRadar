import { describe, expect, it } from 'vitest';

import { classifyIp, isBlockedIp } from '@/modules/security/ip';

describe('classifyIp — IPv4 blocklist', () => {
  const blocked: ReadonlyArray<[string, string]> = [
    ['0.0.0.0', 'unspecified'],
    ['0.1.2.3', 'unspecified'],
    ['10.0.0.1', 'private'],
    ['10.255.255.254', 'private'],
    ['100.64.0.1', 'carrier-nat'],
    ['100.127.255.255', 'carrier-nat'],
    ['127.0.0.1', 'loopback'],
    ['127.1.2.3', 'loopback'],
    ['169.254.169.254', 'cloud-metadata'],
    ['169.254.1.1', 'link-local'],
    ['172.16.0.1', 'private'],
    ['172.31.255.254', 'private'],
    ['192.168.0.1', 'private'],
    ['192.168.255.254', 'private'],
    ['192.0.0.1', 'reserved'],
    ['192.0.2.5', 'documentation'],
    ['198.18.0.1', 'benchmark'],
    ['198.51.100.7', 'documentation'],
    ['203.0.113.9', 'documentation'],
    ['224.0.0.1', 'multicast'],
    ['239.255.255.255', 'multicast'],
    ['240.0.0.1', 'reserved'],
    ['255.255.255.255', 'broadcast'],
  ];

  for (const [address, reason] of blocked) {
    it(`blocks ${address} as ${reason}`, () => {
      const result = classifyIp(address);
      expect(result.blocked).toBe(true);
      expect(result.reason).toBe(reason);
    });
  }

  const allowed = ['8.8.8.8', '1.1.1.1', '142.250.183.100', '172.32.0.1', '100.63.255.255', '11.0.0.1'];
  for (const address of allowed) {
    it(`allows public address ${address}`, () => {
      expect(isBlockedIp(address)).toBe(false);
    });
  }

  // 172.16.0.0/12 ends at 172.31.255.255 — an off-by-one here would expose an
  // entire private range, so both edges are pinned.
  it('pins the 172.16/12 boundaries exactly', () => {
    expect(isBlockedIp('172.15.255.255')).toBe(false);
    expect(isBlockedIp('172.16.0.0')).toBe(true);
    expect(isBlockedIp('172.31.255.255')).toBe(true);
    expect(isBlockedIp('172.32.0.0')).toBe(false);
  });
});

describe('classifyIp — malformed and bypass-shaped input', () => {
  // Octal-looking octets are accepted by some resolvers as a different address
  // (0177.0.0.1 -> 127.0.0.1), so they must never be parsed as decimal.
  const rejected = [
    '0177.0.0.1',
    '010.0.0.1',
    '1.2.3',
    '1.2.3.4.5',
    '1.2.3.256',
    '1.2.3.-1',
    'not-an-ip',
    '',
    '1.2.3.4a',
    '0x7f.0.0.1',
  ];

  for (const address of rejected) {
    it(`treats ${JSON.stringify(address)} as blocked`, () => {
      expect(isBlockedIp(address)).toBe(true);
    });
  }
});

describe('classifyIp — IPv6 blocklist', () => {
  const blocked: ReadonlyArray<[string, string]> = [
    ['::', 'unspecified'],
    ['::1', 'loopback'],
    ['fe80::1', 'link-local'],
    ['febf::1', 'link-local'],
    ['fc00::1', 'unique-local'],
    ['fd12:3456::1', 'unique-local'],
    ['ff02::1', 'multicast'],
    ['2001:db8::1', 'documentation'],
    ['100::1', 'reserved'],
  ];

  for (const [address, reason] of blocked) {
    it(`blocks ${address} as ${reason}`, () => {
      const result = classifyIp(address);
      expect(result.blocked).toBe(true);
      expect(result.reason).toBe(reason);
    });
  }

  it('allows a public IPv6 address', () => {
    expect(isBlockedIp('2606:4700:4700::1111')).toBe(false);
    expect(isBlockedIp('2404:6800:4007:80b::200e')).toBe(false);
  });

  // IPv4-mapped form is the classic IPv6 bypass: ::ffff:127.0.0.1 reaches
  // loopback while looking like an IPv6 address.
  it('unwraps IPv4-mapped addresses and applies IPv4 rules', () => {
    expect(classifyIp('::ffff:127.0.0.1').reason).toBe('loopback');
    expect(classifyIp('::ffff:169.254.169.254').reason).toBe('cloud-metadata');
    expect(classifyIp('::ffff:10.0.0.1').reason).toBe('private');
    expect(isBlockedIp('::ffff:8.8.8.8')).toBe(false);
  });

  it('unwraps NAT64 addresses and applies IPv4 rules', () => {
    expect(classifyIp('64:ff9b::127.0.0.1').reason).toBe('loopback');
    expect(isBlockedIp('64:ff9b::8.8.8.8')).toBe(false);
  });

  it('ignores a zone index', () => {
    expect(classifyIp('fe80::1%eth0').reason).toBe('link-local');
  });

  it('rejects malformed IPv6 as blocked', () => {
    for (const address of ['::ffff:999.0.0.1', '1:2:3', 'gggg::1', '1::2::3']) {
      expect(isBlockedIp(address)).toBe(true);
    }
  });

  it('accepts a fully-expanded address', () => {
    expect(isBlockedIp('2606:4700:4700:0000:0000:0000:0000:1111')).toBe(false);
    expect(classifyIp('0000:0000:0000:0000:0000:0000:0000:0001').reason).toBe('loopback');
  });
});
