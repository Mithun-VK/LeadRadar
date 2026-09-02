import { describe, expect, it } from 'vitest';

import {
  MAX_IMPORT_ROWS,
  dedupeRows,
  importDedupeKey,
  mapHeaders,
  parseCsvRows,
  parseLeadCsv,
  type ImportRow,
} from '@/modules/leads/import';

function row(overrides: Partial<ImportRow> = {}): ImportRow {
  return {
    businessName: 'Acme Dental',
    website: null,
    email: null,
    phone: null,
    industry: null,
    city: null,
    state: null,
    country: null,
    address: null,
    ...overrides,
  };
}

describe('parseCsvRows', () => {
  it('parses a simple file', () => {
    expect(parseCsvRows('a,b\n1,2')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('keeps a comma inside a quoted field', () => {
    // The failure this exists to prevent: a naive split shifts every subsequent
    // column and silently produces a lead whose city is half its address.
    expect(parseCsvRows('name,city\n"Acme, Inc.",Chennai')).toEqual([
      ['name', 'city'],
      ['Acme, Inc.', 'Chennai'],
    ]);
  });

  it('handles escaped quotes', () => {
    expect(parseCsvRows('name\n"Say ""hello"""')).toEqual([['name'], ['Say "hello"']]);
  });

  it('handles a newline inside a quoted field', () => {
    expect(parseCsvRows('name,note\n"Acme","line one\nline two"')).toEqual([
      ['name', 'note'],
      ['Acme', 'line one\nline two'],
    ]);
  });

  it('treats CRLF as one row terminator', () => {
    expect(parseCsvRows('a,b\r\n1,2\r\n')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('strips a UTF-8 BOM, which Excel writes by default', () => {
    expect(parseCsvRows('﻿name\nAcme')[0]).toEqual(['name']);
  });

  it('drops entirely blank rows', () => {
    expect(parseCsvRows('a\n\n1\n')).toEqual([['a'], ['1']]);
  });
});

describe('mapHeaders', () => {
  it('maps the canonical names', () => {
    const { mapping } = mapHeaders(['business_name', 'email', 'phone']);
    expect(mapping.businessName).toBe(0);
    expect(mapping.email).toBe(1);
    expect(mapping.phone).toBe(2);
  });

  it.each([
    ['company', 'businessName'],
    ['Company Name', 'businessName'],
    ['organisation', 'businessName'],
    ['email_address', 'email'],
    ['E-Mail', 'email'],
    ['Phone Number', 'phone'],
    ['Category', 'industry'],
    ['Town', 'city'],
    ['URL', 'website'],
  ])('maps %s onto %s', (header, field) => {
    const { mapping } = mapHeaders([header]);
    expect(mapping[field]).toBe(0);
  });

  it('reports headers it could not map, rather than silently ignoring them', () => {
    const { unmapped } = mapHeaders(['business_name', 'Internal Ref']);
    expect(unmapped).toEqual(['Internal Ref']);
  });

  it('keeps the first match when two columns map to the same field', () => {
    const { mapping } = mapHeaders(['company', 'business_name']);
    expect(mapping.businessName).toBe(0);
  });
});

describe('parseLeadCsv', () => {
  it('parses a realistic export', () => {
    const csv = [
      'Company Name,Email Address,Phone,City,Category',
      'Acme Dental,info@acmedental.in,+91 44 2815 1234,Chennai,dental clinic',
      'Bright Smiles,hello@brightsmiles.in,+91 80 4123 4567,Bangalore,dental clinic',
    ].join('\n');

    const result = parseLeadCsv(csv);

    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]!.businessName).toBe('Acme Dental');
    expect(result.rows[0]!.email).toBe('info@acmedental.in');
    expect(result.rows[0]!.city).toBe('Chennai');
    expect(result.errors).toEqual([]);
  });

  it('refuses a file with no business name column', () => {
    expect(() => parseLeadCsv('email,phone\na@b.in,123')).toThrow(/business name/i);
  });

  it('refuses an empty file', () => {
    expect(() => parseLeadCsv('')).toThrow(/empty/i);
  });

  it('records a row with no business name as an error and skips it', () => {
    const result = parseLeadCsv('business_name,email\n,a@b.in\nAcme,c@d.in');

    expect(result.rows).toHaveLength(1);
    expect(result.errors[0]!.line).toBe(2);
  });

  it('numbers error lines the way the operator sees them in a spreadsheet', () => {
    // Header is line 1, so the first data row is line 2.
    const result = parseLeadCsv('business_name,email\nAcme,not-an-email');
    expect(result.errors[0]!.line).toBe(2);
  });

  it('keeps a lead whose email is unusable, recording the problem', () => {
    const result = parseLeadCsv('business_name,email\nAcme,not-an-email');

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]!.email).toBeNull();
    expect(result.errors[0]!.reason).toMatch(/not a usable email/i);
  });

  it('normalises an email on the way in', () => {
    const result = parseLeadCsv('business_name,email\nAcme,  INFO+Tag@Acme.IN ');
    expect(result.rows[0]!.email).toBe('info@acme.in');
  });

  it('normalises a website to a bare domain', () => {
    const result = parseLeadCsv('business_name,website\nAcme,https://www.acme.in/contact');
    expect(result.rows[0]!.website).toBe('acme.in');
  });

  it('reports the header mapping it used, so the operator can check it', () => {
    const result = parseLeadCsv('Company,Email Address\nAcme,a@b.in');
    expect(result.mapping.businessName).toBe('Company');
    expect(result.mapping.email).toBe('Email Address');
  });

  it('refuses a file above the row limit', () => {
    const rows = [
      'business_name',
      ...Array.from({ length: MAX_IMPORT_ROWS + 1 }, (_, i) => `Biz ${i}`),
    ];
    expect(() => parseLeadCsv(rows.join('\n'))).toThrow(/rows/i);
  });
});

describe('importDedupeKey', () => {
  it('keys on the domain when one is present', () => {
    expect(importDedupeKey(row({ website: 'acme.in' }))).toBe('domain:acme.in');
  });

  it('falls back to the phone number', () => {
    expect(importDedupeKey(row({ phone: '+91 44 2815 1234' }))).toContain('phone:');
  });

  it('falls back to name plus city', () => {
    const key = importDedupeKey(row({ city: 'Chennai' }));
    expect(key).toContain('name:');
    expect(key).toContain('chennai');
  });

  it('does not merge same-named businesses in different cities', () => {
    // Two unrelated clinics sharing a name is common enough that merging on the
    // name alone would corrupt real leads.
    expect(importDedupeKey(row({ city: 'Chennai' }))).not.toBe(
      importDedupeKey(row({ city: 'Bangalore' })),
    );
  });
});

describe('dedupeRows', () => {
  it('collapses rows sharing a domain', () => {
    const result = dedupeRows([row({ website: 'acme.in' }), row({ website: 'acme.in' })]);

    expect(result.unique).toHaveLength(1);
    expect(result.duplicates).toBe(1);
  });

  it('keeps the richer of two duplicates', () => {
    const sparse = row({ website: 'acme.in' });
    const rich = row({ website: 'acme.in', email: 'a@acme.in', phone: '123', city: 'Chennai' });

    const result = dedupeRows([sparse, rich]);

    expect(result.unique).toHaveLength(1);
    expect(result.unique[0]!.email).toBe('a@acme.in');
  });

  it('keeps genuinely distinct businesses', () => {
    const result = dedupeRows([row({ website: 'a.in' }), row({ website: 'b.in' })]);
    expect(result.unique).toHaveLength(2);
    expect(result.duplicates).toBe(0);
  });
});
