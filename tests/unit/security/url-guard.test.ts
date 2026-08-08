import { describe, expect, it } from 'vitest';

import {
  validateExternalUrl,
  validateRedirectChain,
  type DnsResolver,
} from '@/modules/security/url-guard';

/** Deterministic resolver so DNS behaviour is a test input, not a dependency. */
function resolverFor(map: Record<string, readonly string[]>): DnsResolver {
  return async (hostname) => {
    const addresses = map[hostname];
    if (!addresses) throw new Error(`ENOTFOUND ${hostname}`);
    return addresses.map((address) => ({
      address,
      family: address.includes(':') ? 6 : 4,
    }));
  };
}

const publicResolver = resolverFor({
  'example.com': ['93.184.216.34'],
  'abcdentalclinic.in': ['104.21.5.6'],
  'redirect-target.com': ['151.101.1.1'],
});

describe('validateExternalUrl — scheme, port, and shape', () => {
  it('accepts an ordinary https business URL', async () => {
    const result = await validateExternalUrl('https://abcdentalclinic.in/contact', {
      resolve: publicResolver,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.hostname).toBe('abcdentalclinic.in');
      expect(result.value.port).toBe(443);
      // The pinned address is what the caller must connect to; re-resolving the
      // hostname would reopen the rebinding hole.
      expect(result.value.pinnedAddress).toBe('104.21.5.6');
    }
  });

  const badSchemes = [
    'file:///etc/passwd',
    'gopher://example.com/',
    'ftp://example.com/',
    'data:text/html,<script>alert(1)</script>',
    'javascript:alert(1)',
    'redis://localhost:6379',
  ];
  for (const url of badSchemes) {
    it(`rejects scheme in ${url}`, async () => {
      const result = await validateExternalUrl(url, { resolve: publicResolver });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('URL_REJECTED');
    });
  }

  it('rejects embedded credentials', async () => {
    const result = await validateExternalUrl('https://user:pass@example.com/', {
      resolve: publicResolver,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toMatch(/credentials/i);
  });

  it('rejects non-standard ports', async () => {
    for (const url of [
      'http://example.com:22/',
      'https://example.com:6379/',
      'http://example.com:8080/',
    ]) {
      const result = await validateExternalUrl(url, { resolve: publicResolver });
      expect(result.ok).toBe(false);
    }
  });

  it('rejects unparseable and empty input', async () => {
    for (const url of ['', '   ', 'not a url', 'https://']) {
      const result = await validateExternalUrl(url, { resolve: publicResolver });
      expect(result.ok).toBe(false);
    }
  });

  it('rejects control characters used for request smuggling', async () => {
    const result = await validateExternalUrl('https://example.com/\r\nHost: evil', {
      resolve: publicResolver,
    });
    expect(result.ok).toBe(false);
  });
});

describe('validateExternalUrl — hostname denylist', () => {
  const blockedHosts = [
    'http://localhost/',
    'http://localhost.localdomain/',
    'http://metadata.google.internal/computeMetadata/v1/',
    'http://instance-data/latest/meta-data/',
    'http://foo.internal/',
    'http://db.local/',
    'http://api.corp/',
    'http://something.lan/',
  ];

  for (const url of blockedHosts) {
    it(`blocks ${url}`, async () => {
      const result = await validateExternalUrl(url, { resolve: publicResolver });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('SSRF_BLOCKED');
    });
  }

  it('blocks single-label hostnames that resolve via internal search domains', async () => {
    const result = await validateExternalUrl('http://intranet/', {
      resolve: resolverFor({ intranet: ['10.1.1.1'] }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.context.reason).toBe('single-label');
  });

  it('normalises a trailing dot before checking the denylist', async () => {
    const result = await validateExternalUrl('http://localhost./', { resolve: publicResolver });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('SSRF_BLOCKED');
  });
});

describe('validateExternalUrl — IP literals', () => {
  const blocked = [
    'http://127.0.0.1/',
    'http://127.1/',
    'http://0.0.0.0/',
    'http://10.0.0.5/',
    'http://192.168.1.1/',
    'http://172.16.5.4/',
    'http://169.254.169.254/latest/meta-data/',
    'http://100.100.100.200/',
    'http://[::1]/',
    'http://[fe80::1]/',
    'http://[fd00::1]/',
    'http://[::ffff:127.0.0.1]/',
  ];

  for (const url of blocked) {
    it(`blocks IP literal ${url}`, async () => {
      const result = await validateExternalUrl(url, { resolve: publicResolver });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('SSRF_BLOCKED');
    });
  }

  it('allows a public IP literal without consulting DNS', async () => {
    const result = await validateExternalUrl('https://8.8.8.8/', {
      // Deliberately a resolver that throws: a literal must not need DNS.
      resolve: async () => {
        throw new Error('resolver must not be called for an IP literal');
      },
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.pinnedAddress).toBe('8.8.8.8');
  });
});

describe('validateExternalUrl — DNS-based attacks', () => {
  it('blocks a public name that resolves to a private address', async () => {
    const result = await validateExternalUrl('https://evil.example/', {
      resolve: resolverFor({ 'evil.example': ['10.0.0.99'] }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('SSRF_BLOCKED');
      expect(result.error.context.blockedAddress).toBe('10.0.0.99');
    }
  });

  it('blocks a name that resolves to the cloud metadata address', async () => {
    const result = await validateExternalUrl('https://metadata-proxy.example/', {
      resolve: resolverFor({ 'metadata-proxy.example': ['169.254.169.254'] }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.context.reason).toBe('cloud-metadata');
  });

  // A round-robin record mixing one public and one private answer is a
  // rebinding primitive: the attacker only needs the private answer chosen once.
  it('blocks when ANY resolved address is private, not just the first', async () => {
    const result = await validateExternalUrl('https://mixed.example/', {
      resolve: resolverFor({ 'mixed.example': ['93.184.216.34', '127.0.0.1'] }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.context.blockedAddress).toBe('127.0.0.1');
  });

  it('fails closed when resolution errors', async () => {
    const result = await validateExternalUrl('https://nonexistent.example/', {
      resolve: resolverFor({}),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.context.reason).toBe('dns-failure');
  });

  it('fails closed when resolution returns no addresses', async () => {
    const result = await validateExternalUrl('https://empty.example/', {
      resolve: async () => [],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.context.reason).toBe('dns-empty');
  });

  it('reports every resolved address so callers can pin deliberately', async () => {
    const result = await validateExternalUrl('https://multi.example/', {
      resolve: resolverFor({ 'multi.example': ['93.184.216.34', '151.101.1.1'] }),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.resolvedAddresses).toEqual(['93.184.216.34', '151.101.1.1']);
      expect(result.value.pinnedAddress).toBe('93.184.216.34');
    }
  });
});

describe('validateRedirectChain', () => {
  it('accepts a chain whose every hop is public', async () => {
    const result = await validateRedirectChain(
      ['https://example.com/a', 'https://redirect-target.com/b'],
      { resolve: publicResolver },
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.hostname).toBe('redirect-target.com');
  });

  // The whole point: hop 1 being safe says nothing about hop 2.
  it('rejects a chain that redirects into private space', async () => {
    const result = await validateRedirectChain(
      ['https://example.com/a', 'http://169.254.169.254/latest/meta-data/'],
      { resolve: publicResolver },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('SSRF_BLOCKED');
      expect(result.error.context.hopIndex).toBe(1);
    }
  });

  it('rejects an over-long chain', async () => {
    const chain = Array.from({ length: 5 }, () => 'https://example.com/');
    const result = await validateRedirectChain(chain, { resolve: publicResolver, maxHops: 3 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toMatch(/exceeded/i);
  });

  it('rejects an empty chain', async () => {
    const result = await validateRedirectChain([], { resolve: publicResolver });
    expect(result.ok).toBe(false);
  });
});
