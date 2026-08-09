import { describe, expect, it } from 'vitest';

import {
  EXPORT_COLUMNS,
  columnsFor,
  csvCell,
  decidePolicy,
  neutraliseFormula,
  toCsv,
} from '@/modules/export/policy';

describe('columnsFor — provenance gating', () => {
  it('excludes Google-derived columns from the safe policy', () => {
    const safe = columnsFor('safe');
    expect(safe.some((column) => column.provenance === 'GOOGLE_DERIVED')).toBe(false);
    expect(safe.length).toBeGreaterThan(0);
  });

  it('includes them under the opt-in policy', () => {
    const full = columnsFor('with-google-derived');
    expect(full.some((column) => column.provenance === 'GOOGLE_DERIVED')).toBe(true);
    expect(full.length).toBeGreaterThan(columnsFor('safe').length);
  });

  it('always allows Place ID, which provider terms permit storing indefinitely', () => {
    expect(columnsFor('safe').some((column) => column.key === 'googlePlaceId')).toBe(true);
  });

  it('never exposes a column with no provenance', () => {
    for (const column of EXPORT_COLUMNS) {
      expect(
        ['GOOGLE_DERIVED', 'PLACE_IDENTIFIER', 'PUBLIC_WEB', 'APPLICATION_GENERATED'],
      ).toContain(column.provenance);
    }
  });

  /**
   * Maps URIs, review text, and photos are absent from the exportable set at every
   * policy level: they carry display and attribution obligations a CSV cannot honour
   * once it leaves our UI.
   */
  it('does not export Maps URIs, review text, or photos at any policy level', () => {
    const keys = columnsFor('with-google-derived').map((column) => column.key);
    expect(keys).not.toContain('googleMapsUri');
    expect(keys).not.toContain('reviews');
    expect(keys).not.toContain('photos');
  });
});

describe('decidePolicy', () => {
  it('defaults to safe and explains what was withheld', () => {
    const decision = decidePolicy({ includeGoogleDerived: false, acknowledgedTerms: false });
    expect(decision.policy).toBe('safe');
    expect(decision.warnings.join(' ')).toMatch(/Google-derived fields.*excluded/i);
  });

  // Silently downgrading would hand the user a file missing the columns they asked
  // for, with no explanation.
  it('refuses the opt-in without acknowledgement, and says so', () => {
    const decision = decidePolicy({ includeGoogleDerived: true, acknowledgedTerms: false });
    expect(decision.policy).toBe('safe');
    expect(decision.requiresAcknowledgement).toBe(true);
    expect(decision.warnings.join(' ')).toMatch(/requested but not acknowledged/i);
  });

  it('grants the opt-in with acknowledgement, and states the obligation', () => {
    const decision = decidePolicy({ includeGoogleDerived: true, acknowledgedTerms: true });
    expect(decision.policy).toBe('with-google-derived');
    expect(decision.requiresAcknowledgement).toBe(false);
    expect(decision.warnings.join(' ')).toMatch(/attribution/i);
    expect(decision.warnings.join(' ')).toMatch(/responsible/i);
  });

  it('always reports which columns were excluded', () => {
    const decision = decidePolicy({ includeGoogleDerived: false, acknowledgedTerms: false });
    expect(decision.excludedColumns.length).toBeGreaterThan(0);
    expect(decision.excludedColumns.map((column) => column.header)).toContain('Business Name');
  });
});

/**
 * CSV injection is a real vulnerability, not a formatting nicety: Excel, Sheets,
 * and LibreOffice EXECUTE a cell beginning with these characters when the file is
 * opened, and business names are third-party text.
 */
describe('neutraliseFormula', () => {
  const dangerous = [
    '=HYPERLINK("http://evil.example","Click me")',
    '=cmd|\' /c calc\'!A1',
    '+1+1',
    '-1+1',
    '@SUM(A1:A9)',
    '\tinjected',
    '\rinjected',
  ];

  for (const value of dangerous) {
    it(`prefixes a leading formula character: ${JSON.stringify(value.slice(0, 24))}`, () => {
      const safe = neutraliseFormula(value);
      expect(safe.startsWith("'")).toBe(true);
      expect(safe.slice(1)).toBe(value);
    });
  }

  it('leaves ordinary text alone', () => {
    for (const value of ['Sri Krishna Dental Care', '4.8', 'Anna Nagar, Chennai', '']) {
      expect(neutraliseFormula(value)).toBe(value);
    }
  });

  it('does not treat an interior formula character as dangerous', () => {
    expect(neutraliseFormula('A=B')).toBe('A=B');
    expect(neutraliseFormula('info@example.com')).toBe('info@example.com');
  });
});

describe('csvCell', () => {
  it('quotes values containing a delimiter, quote, or newline', () => {
    expect(csvCell('Anna Nagar, Chennai')).toBe('"Anna Nagar, Chennai"');
    expect(csvCell('He said "hello"')).toBe('"He said ""hello"""');
    expect(csvCell('line1\nline2')).toBe('"line1\nline2"');
  });

  it('renders null and undefined as empty', () => {
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
  });

  it('neutralises a formula even when the cell also needs quoting', () => {
    const cell = csvCell('=HYPERLINK("http://evil.example","x")');
    expect(cell.startsWith('"\'=')).toBe(true);
  });

  it('stringifies numbers and booleans', () => {
    expect(csvCell(4.8)).toBe('4.8');
    expect(csvCell(false)).toBe('false');
  });
});

describe('toCsv', () => {
  const columns = columnsFor('safe').slice(0, 3);

  it('emits a BOM and CRLF line endings so Excel reads UTF-8 correctly', () => {
    const csv = toCsv(columns, [{}]);
    expect(csv.startsWith('﻿')).toBe(true);
    expect(csv).toContain('\r\n');
  });

  it('writes a header row from the column definitions', () => {
    const csv = toCsv(columns, []);
    const header = csv.replace('﻿', '').split('\r\n')[0]!;
    for (const column of columns) {
      expect(header).toContain(column.header);
    }
  });

  it('renders missing values as empty rather than "undefined"', () => {
    const csv = toCsv(columns, [{}]);
    expect(csv).not.toContain('undefined');
    expect(csv).not.toContain('null');
  });

  it('neutralises formulas in data rows', () => {
    const csv = toCsv([{ key: 'name', header: 'Name', provenance: 'PUBLIC_WEB' }], [
      { name: '=1+1' },
    ]);
    expect(csv).toContain("'=1+1");
  });

  it('preserves non-ASCII business names', () => {
    const csv = toCsv([{ key: 'name', header: 'Name', provenance: 'PUBLIC_WEB' }], [
      { name: 'Café Möbius' },
    ]);
    expect(csv).toContain('Café Möbius');
  });
});
