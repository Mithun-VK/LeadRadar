import { describe, expect, it } from 'vitest';

import {
  emailDomain,
  extractEmailsFromPage,
  isBlockedAddress,
  isRoleAccount,
  isSendableEmail,
  mergeEmails,
  normalizeEmail,
  rankEmails,
  scoreEmailConfidence,
  selectPrimaryEmail,
  type DiscoveredEmail,
} from '@/modules/enrichment/contacts';
import type { FetchedPage } from '@/modules/providers/contracts';

function page(overrides: Partial<FetchedPage> = {}): FetchedPage {
  return {
    url: 'https://srikrishnadental.in',
    finalUrl: 'https://srikrishnadental.in/',
    statusCode: 200,
    title: 'Sri Krishna Dental Care',
    description: 'Dental clinic',
    content: 'Sri Krishna Dental Care, Anna Nagar, Chennai.',
    html: null,
    links: [],
    httpsEnabled: true,
    byteLength: 100,
    fetchedAt: new Date('2026-08-08T00:00:00.000Z'),
    ...overrides,
  };
}

describe('normalizeEmail', () => {
  it('lowercases the whole address', () => {
    expect(normalizeEmail('INFO@Example.IN')).toBe('info@example.in');
  });

  it('strips a mailto: prefix and query parameters', () => {
    expect(normalizeEmail('mailto:hi@clinic.in?subject=Appointment')).toBe('hi@clinic.in');
  });

  it('strips a plus tag, so one mailbox is not stored twice', () => {
    expect(normalizeEmail('info+website@clinic.in')).toBe('info@clinic.in');
  });

  it('rejects an address with no domain dot', () => {
    expect(normalizeEmail('info@localhost')).toBeNull();
  });

  it('rejects consecutive dots', () => {
    expect(normalizeEmail('a@b..com')).toBeNull();
  });

  it('rejects an asset path a greedy regex would mistake for an address', () => {
    expect(normalizeEmail('sprite@2x.png')).toBeNull();
  });

  it('rejects an empty local part', () => {
    expect(normalizeEmail('@clinic.in')).toBeNull();
  });
});

describe('isRoleAccount', () => {
  it.each(['info', 'contact', 'hello', 'appointments', 'reception'])(
    'recognises %s@ as a role account',
    (local) => {
      expect(isRoleAccount(`${local}@clinic.in`)).toBe(true);
    },
  );

  it('treats a personal mailbox as not a role account', () => {
    expect(isRoleAccount('priya.raman@clinic.in')).toBe(false);
  });
});

describe('isBlockedAddress', () => {
  it.each(['noreply', 'postmaster', 'abuse', 'privacy', 'webmaster'])(
    'blocks %s@, which is infrastructure rather than the business',
    (local) => {
      expect(isBlockedAddress(`${local}@clinic.in`)).toBe(true);
    },
  );

  it('blocks documentation placeholder domains', () => {
    expect(isBlockedAddress('info@example.com')).toBe(true);
  });

  it('blocks a subdomain of a platform host', () => {
    expect(isBlockedAddress('x@o1234.ingest.sentry.io')).toBe(true);
  });

  it('permits an ordinary business address', () => {
    expect(isBlockedAddress('info@srikrishnadental.in')).toBe(false);
  });
});

describe('scoreEmailConfidence', () => {
  it('scores an address on the verified domain far above one on a foreign domain', () => {
    const own = scoreEmailConfidence({
      matchesVerifiedDomain: true,
      source: 'PAGE_MAILTO',
      isRoleAccount: false,
    });
    const foreign = scoreEmailConfidence({
      matchesVerifiedDomain: false,
      source: 'PAGE_MAILTO',
      isRoleAccount: false,
    });

    expect(own).toBeGreaterThan(foreign);
    // The gap must be decisive, not marginal: a gmail.com address on a business
    // site may well belong to the web designer.
    expect(own - foreign).toBeGreaterThanOrEqual(0.3);
  });

  it('ranks a mailto: link above loose page text', () => {
    const link = scoreEmailConfidence({
      matchesVerifiedDomain: true,
      source: 'PAGE_MAILTO',
      isRoleAccount: false,
    });
    const text = scoreEmailConfidence({
      matchesVerifiedDomain: true,
      source: 'PAGE_TEXT',
      isRoleAccount: false,
    });

    expect(link).toBeGreaterThan(text);
  });

  it('penalises a role account only on a foreign domain', () => {
    const ownRole = scoreEmailConfidence({
      matchesVerifiedDomain: true,
      source: 'PAGE_TEXT',
      isRoleAccount: true,
    });
    const ownPersonal = scoreEmailConfidence({
      matchesVerifiedDomain: true,
      source: 'PAGE_TEXT',
      isRoleAccount: false,
    });
    const foreignRole = scoreEmailConfidence({
      matchesVerifiedDomain: false,
      source: 'PAGE_TEXT',
      isRoleAccount: true,
    });
    const foreignPersonal = scoreEmailConfidence({
      matchesVerifiedDomain: false,
      source: 'PAGE_TEXT',
      isRoleAccount: false,
    });

    expect(ownRole).toBeGreaterThanOrEqual(ownPersonal);
    expect(foreignRole).toBeLessThan(foreignPersonal);
  });

  it('never returns a confidence outside 0-1', () => {
    for (const matchesVerifiedDomain of [true, false]) {
      for (const source of ['PAGE_MAILTO', 'PAGE_TEXT', 'CONTACT_PAGE', 'MANUAL_IMPORT'] as const) {
        for (const isRoleAccount of [true, false]) {
          const value = scoreEmailConfidence({ matchesVerifiedDomain, source, isRoleAccount });
          expect(value).toBeGreaterThan(0);
          expect(value).toBeLessThanOrEqual(1);
        }
      }
    }
  });
});

describe('extractEmailsFromPage', () => {
  it('finds a mailto: address in the raw document', () => {
    const found = extractEmailsFromPage(
      page({
        html: '<a href="mailto:info@srikrishnadental.in">Email us</a>',
      }),
      { verifiedDomain: 'srikrishnadental.in' },
    );

    expect(found.map((e) => e.email)).toContain('info@srikrishnadental.in');
    expect(found[0]!.source).toBe('PAGE_MAILTO');
    expect(found[0]!.matchesVerifiedDomain).toBe(true);
  });

  it('finds an address written in plain page text', () => {
    const found = extractEmailsFromPage(
      page({ content: 'Write to us at hello@srikrishnadental.in for appointments.' }),
      { verifiedDomain: 'srikrishnadental.in' },
    );

    expect(found.map((e) => e.email)).toEqual(['hello@srikrishnadental.in']);
  });

  it('records the same address once, keeping the stronger source', () => {
    const found = extractEmailsFromPage(
      page({
        html: '<a href="mailto:info@srikrishnadental.in">Email</a>',
        content: 'Contact info@srikrishnadental.in for details.',
      }),
      { verifiedDomain: 'srikrishnadental.in' },
    );

    expect(found).toHaveLength(1);
    expect(found[0]!.source).toBe('PAGE_MAILTO');
  });

  it('excludes infrastructure addresses that appear in boilerplate', () => {
    const found = extractEmailsFromPage(
      page({
        content: 'Questions: info@clinic.in. Abuse reports: abuse@clinic.in. noreply@clinic.in',
      }),
      { verifiedDomain: 'clinic.in' },
    );

    expect(found.map((e) => e.email)).toEqual(['info@clinic.in']);
  });

  it('ranks an address on the verified domain above a free-mail one on the same page', () => {
    const found = extractEmailsFromPage(
      page({
        content: 'Clinic: info@srikrishnadental.in. Site by designer99@gmail.com',
      }),
      { verifiedDomain: 'srikrishnadental.in' },
    );

    expect(found[0]!.email).toBe('info@srikrishnadental.in');
    expect(found[0]!.matchesVerifiedDomain).toBe(true);
    expect(found[1]!.matchesVerifiedDomain).toBe(false);
  });

  it('marks addresses from a contact page with that source', () => {
    const found = extractEmailsFromPage(page({ content: 'reception@clinic.in' }), {
      verifiedDomain: 'clinic.in',
      isContactPage: true,
    });

    expect(found[0]!.source).toBe('CONTACT_PAGE');
  });

  it('records where each address was found, for auditability', () => {
    const found = extractEmailsFromPage(page({ content: 'info@clinic.in' }), {
      verifiedDomain: 'clinic.in',
    });

    expect(found[0]!.foundOnUrl).toBe('https://srikrishnadental.in/');
  });

  it('finds a mailto: entry surfaced only in the link set', () => {
    const found = extractEmailsFromPage(
      page({ content: 'No address in the text.', links: ['mailto:desk@clinic.in'] }),
      { verifiedDomain: 'clinic.in' },
    );

    expect(found.map((e) => e.email)).toEqual(['desk@clinic.in']);
  });

  it('returns nothing when a page publishes no address', () => {
    expect(extractEmailsFromPage(page())).toEqual([]);
  });

  it('does not mistake an image filename for an address', () => {
    const found = extractEmailsFromPage(page({ content: 'See logo@2x.png and icon@3x.svg' }));
    expect(found).toEqual([]);
  });

  it('treats a subdomain of the verified domain as belonging to the business', () => {
    const found = extractEmailsFromPage(page({ content: 'info@mail.clinic.in' }), {
      verifiedDomain: 'clinic.in',
    });

    expect(found[0]!.matchesVerifiedDomain).toBe(true);
  });
});

describe('mergeEmails', () => {
  const own: DiscoveredEmail = {
    email: 'info@clinic.in',
    domain: 'clinic.in',
    source: 'PAGE_TEXT',
    confidence: 0.6,
    isRoleAccount: true,
    matchesVerifiedDomain: true,
    foundOnUrl: 'https://clinic.in/',
  };

  it('keeps the highest-confidence copy of a repeated address', () => {
    const stronger = { ...own, source: 'PAGE_MAILTO' as const, confidence: 0.95 };
    const merged = mergeEmails([own], [stronger]);

    expect(merged).toHaveLength(1);
    expect(merged[0]!.confidence).toBe(0.95);
  });

  it('combines distinct addresses from several pages', () => {
    const other: DiscoveredEmail = { ...own, email: 'desk@clinic.in', isRoleAccount: false };
    expect(mergeEmails([own], [other])).toHaveLength(2);
  });
});

describe('rankEmails', () => {
  const base: DiscoveredEmail = {
    email: 'a@clinic.in',
    domain: 'clinic.in',
    source: 'PAGE_TEXT',
    confidence: 0.6,
    isRoleAccount: false,
    matchesVerifiedDomain: true,
    foundOnUrl: null,
  };

  it('puts verified-domain addresses first regardless of confidence', () => {
    const foreign = {
      ...base,
      email: 'x@gmail.com',
      matchesVerifiedDomain: false,
      confidence: 0.98,
    };
    expect(rankEmails([foreign, base])[0]!.email).toBe('a@clinic.in');
  });

  it('prefers a personal mailbox over a role account at equal confidence', () => {
    const role = { ...base, email: 'info@clinic.in', isRoleAccount: true };
    const person = { ...base, email: 'priya@clinic.in', isRoleAccount: false };
    expect(rankEmails([role, person])[0]!.email).toBe('priya@clinic.in');
  });

  it('is deterministic, so the same page always yields the same primary contact', () => {
    const a = { ...base, email: 'a@clinic.in' };
    const b = { ...base, email: 'b@clinic.in' };
    expect(rankEmails([a, b])).toEqual(rankEmails([b, a]));
  });
});

describe('selectPrimaryEmail', () => {
  it('returns null rather than a weak guess when nothing clears the floor', () => {
    const weak: DiscoveredEmail = {
      email: 'someone@gmail.com',
      domain: 'gmail.com',
      source: 'PAGE_TEXT',
      confidence: 0.35,
      isRoleAccount: false,
      matchesVerifiedDomain: false,
      foundOnUrl: null,
    };

    expect(selectPrimaryEmail([weak])).toBeNull();
  });

  it('returns null for an empty list', () => {
    expect(selectPrimaryEmail([])).toBeNull();
  });

  it('picks the strongest address above the floor', () => {
    const strong: DiscoveredEmail = {
      email: 'info@clinic.in',
      domain: 'clinic.in',
      source: 'PAGE_MAILTO',
      confidence: 0.95,
      isRoleAccount: true,
      matchesVerifiedDomain: true,
      foundOnUrl: null,
    };

    expect(selectPrimaryEmail([strong])?.email).toBe('info@clinic.in');
  });
});

describe('isSendableEmail', () => {
  it('accepts a well-formed business address', () => {
    expect(isSendableEmail('info@clinic.in')).toBe(true);
  });

  it.each(['not-an-email', 'a@b', '', 'noreply@clinic.in'])('rejects %s', (value) => {
    expect(isSendableEmail(value)).toBe(false);
  });

  it('rejects an address beyond the RFC length limit', () => {
    expect(isSendableEmail(`${'a'.repeat(250)}@clinic.in`)).toBe(false);
  });
});

describe('emailDomain', () => {
  it('returns the part after the final @', () => {
    expect(emailDomain('info@clinic.in')).toBe('clinic.in');
  });
});
