import { describe, expect, it } from 'vitest';

import { parseEnv } from '@/lib/env';

/** A minimal environment that is valid in mock mode. */
function baseEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'development',
    DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
    REDIS_URL: 'redis://localhost:6379',
    MOCK_EXTERNAL_APIS: 'true',
    ...overrides,
  } as NodeJS.ProcessEnv;
}

describe('parseEnv — mock mode', () => {
  it('boots with no provider credentials at all', () => {
    const env = parseEnv(baseEnv());
    expect(env.isMockMode).toBe(true);
    expect(env.GOOGLE_MAPS_API_KEY).toBeUndefined();
    expect(env.GROQ_API_KEY).toBeUndefined();
    expect(env.FIRECRAWL_API_KEY).toBeUndefined();
  });

  it('defaults GROQ_MODEL rather than hard-coding it at a call site', () => {
    expect(parseEnv(baseEnv()).GROQ_MODEL).toBe('openai/gpt-oss-20b');
    expect(parseEnv(baseEnv({ GROQ_MODEL: 'llama-3.3-70b-versatile' })).GROQ_MODEL).toBe(
      'llama-3.3-70b-versatile',
    );
  });

  it('accepts the several spellings of a boolean', () => {
    for (const value of ['true', '1', 'yes']) {
      expect(parseEnv(baseEnv({ MOCK_EXTERNAL_APIS: value })).isMockMode).toBe(true);
    }
    for (const value of ['false', '0', 'no']) {
      // Live mode needs credentials, so supply them.
      const env = parseEnv(
        baseEnv({
          MOCK_EXTERNAL_APIS: value,
          GOOGLE_MAPS_API_KEY: 'g',
          GROQ_API_KEY: 'q',
          FIRECRAWL_API_KEY: 'f',
        }),
      );
      expect(env.isMockMode).toBe(false);
    }
  });

  it('treats an empty credential string as absent', () => {
    const env = parseEnv(baseEnv({ GOOGLE_MAPS_API_KEY: '' }));
    expect(env.GOOGLE_MAPS_API_KEY).toBeUndefined();
  });

  /**
   * The documented setup path is "copy .env.example, then npm run dev", and that
   * file ships ENCRYPTION_KEY blank. An empty value must therefore normalise to
   * absent rather than failing the hex pattern.
   */
  it('accepts a blank ENCRYPTION_KEY outside production, as .env.example ships it', () => {
    const env = parseEnv(baseEnv({ ENCRYPTION_KEY: '' }));
    expect(env.ENCRYPTION_KEY).toBeUndefined();
  });

  it('still rejects a non-empty but malformed ENCRYPTION_KEY', () => {
    expect(() => parseEnv(baseEnv({ ENCRYPTION_KEY: 'not-hex' }))).toThrowError(/64 hex characters/);
  });
});

describe('parseEnv — live mode requires credentials', () => {
  it('fails fast when a provider key is missing, naming every one', () => {
    expect(() => parseEnv(baseEnv({ MOCK_EXTERNAL_APIS: 'false' }))).toThrowError(
      /GOOGLE_MAPS_API_KEY[\s\S]*GROQ_API_KEY[\s\S]*FIRECRAWL_API_KEY/,
    );
  });

  it('succeeds when all three are present', () => {
    const env = parseEnv(
      baseEnv({
        MOCK_EXTERNAL_APIS: 'false',
        GOOGLE_MAPS_API_KEY: 'gkey',
        GROQ_API_KEY: 'qkey',
        FIRECRAWL_API_KEY: 'fkey',
      }),
    );
    expect(env.isMockMode).toBe(false);
  });
});

describe('parseEnv — production guardrails', () => {
  const prod = (overrides: Record<string, string> = {}) =>
    baseEnv({
      NODE_ENV: 'production',
      MOCK_EXTERNAL_APIS: 'false',
      GOOGLE_MAPS_API_KEY: 'g',
      GROQ_API_KEY: 'q',
      FIRECRAWL_API_KEY: 'f',
      ENCRYPTION_KEY: 'a'.repeat(64),
      ...overrides,
    });

  // Shipping mock mode to production would serve fabricated leads to paying
  // customers — the most damaging possible misconfiguration.
  it('refuses mock mode in production', () => {
    expect(() => parseEnv(prod({ MOCK_EXTERNAL_APIS: 'true' }))).toThrowError(
      /MOCK_EXTERNAL_APIS must be false in production/,
    );
  });

  it('requires ENCRYPTION_KEY in production', () => {
    const env = prod();
    delete env.ENCRYPTION_KEY;
    expect(() => parseEnv(env)).toThrowError(/ENCRYPTION_KEY is required in production/);
  });

  it('requires ENCRYPTION_KEY to be 32 bytes of hex', () => {
    expect(() => parseEnv(prod({ ENCRYPTION_KEY: 'tooshort' }))).toThrowError(/64 hex characters/);
    expect(() => parseEnv(prod({ ENCRYPTION_KEY: 'z'.repeat(64) }))).toThrowError(/64 hex characters/);
    expect(parseEnv(prod()).ENCRYPTION_KEY).toHaveLength(64);
  });

  it('accepts production config that satisfies every rule', () => {
    const env = parseEnv(prod());
    expect(env.isProduction).toBe(true);
    expect(env.isMockMode).toBe(false);
  });
});

describe('parseEnv — datastore URLs', () => {
  it('rejects a non-PostgreSQL DATABASE_URL', () => {
    expect(() => parseEnv(baseEnv({ DATABASE_URL: 'mysql://localhost/db' }))).toThrowError(
      /PostgreSQL/,
    );
  });

  it('rejects a non-Redis REDIS_URL', () => {
    expect(() => parseEnv(baseEnv({ REDIS_URL: 'http://localhost:6379' }))).toThrowError(
      /redis:\/\//,
    );
  });

  it('accepts rediss:// for TLS connections', () => {
    expect(parseEnv(baseEnv({ REDIS_URL: 'rediss://host:6380' })).REDIS_URL).toContain('rediss://');
  });
});

describe('parseEnv — budget and limit coherence', () => {
  it('rejects a daily budget larger than the monthly budget', () => {
    expect(() =>
      parseEnv(baseEnv({ DAILY_BUDGET_USD: '100', MONTHLY_BUDGET_USD: '50' })),
    ).toThrowError(/cannot exceed MONTHLY_BUDGET_USD/);
  });

  it('rejects non-positive request limits', () => {
    expect(() => parseEnv(baseEnv({ MAX_GOOGLE_REQUESTS_PER_JOB: '0' }))).toThrow();
    expect(() => parseEnv(baseEnv({ MAX_CONCURRENT_JOBS: '-2' }))).toThrow();
  });

  it('applies documented defaults', () => {
    const env = parseEnv(baseEnv());
    expect(env.MAX_RESULTS_PER_SEARCH).toBe(2000);
    expect(env.MAX_GOOGLE_REQUESTS_PER_JOB).toBe(200);
    expect(env.MAX_CONCURRENT_JOBS).toBe(5);
  });
});

describe('parseEnv — NEXT_PUBLIC secret leakage', () => {
  it('refuses to boot when a secret-shaped name is public', () => {
    expect(() =>
      parseEnv(baseEnv({ NEXT_PUBLIC_GROQ_API_KEY: 'anything' })),
    ).toThrowError(/NEXT_PUBLIC_GROQ_API_KEY \(name indicates a secret\)/);
  });

  // The subtler leak: an innocent-looking public name holding a real secret.
  it('refuses to boot when a public var holds a real secret value', () => {
    expect(() =>
      parseEnv(
        baseEnv({
          MOCK_EXTERNAL_APIS: 'false',
          GOOGLE_MAPS_API_KEY: 'super-secret-google-key',
          GROQ_API_KEY: 'q',
          FIRECRAWL_API_KEY: 'f',
          NEXT_PUBLIC_ANALYTICS_ID: 'super-secret-google-key',
        }),
      ),
    ).toThrowError(/value matches a server secret/);
  });

  it('allows harmless public variables', () => {
    expect(() => parseEnv(baseEnv({ NEXT_PUBLIC_APP_NAME: 'LeadRadar' }))).not.toThrow();
  });
});

describe('parseEnv — error reporting', () => {
  it('never echoes the offending value, which may be a secret', () => {
    let message = '';
    try {
      parseEnv(baseEnv({ DATABASE_URL: 'mysql://user:hunter2@host/db' }));
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/DATABASE_URL/);
    expect(message).not.toContain('hunter2');
  });
});
