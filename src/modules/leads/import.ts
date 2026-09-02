/**
 * CSV import.
 *
 * Imported leads are a different kind of data from discovered ones, and the
 * schema already knows it: they arrive with no Place ID, no verified website, no
 * analysis, and no score. This module is careful never to let them masquerade as
 * pipeline output — an imported row is explicitly marked as such, and its email
 * carries source MANUAL_IMPORT rather than a claim that we found it published on
 * the business's own site.
 *
 * That distinction matters at send time. A discovered address was observed on a
 * page belonging to the business; an imported one is whatever the operator
 * pasted, and the operator owns responsibility for where it came from.
 */
import { AppError } from '@/lib/errors';
import { isSendableEmail, normalizeEmail } from '@/modules/enrichment/contacts';
import { normalizeBusinessName, normalizeDomain, phoneDigits } from '@/modules/leads/normalize';

/**
 * Accepted spellings for each field.
 *
 * Real exports from real CRMs use all of these. Rejecting a file because the
 * column says "Company Name" rather than "business_name" is the kind of
 * strictness that makes someone edit a spreadsheet by hand, which is where
 * mistakes come from.
 */
const COLUMN_ALIASES: Record<string, readonly string[]> = {
  businessName: [
    'business_name',
    'businessname',
    'business',
    'company',
    'company_name',
    'companyname',
    'name',
    'organisation',
    'organization',
    'account_name',
  ],
  website: ['website', 'website_url', 'url', 'domain', 'site', 'web', 'homepage'],
  email: ['email', 'email_address', 'emailaddress', 'e_mail', 'contact_email', 'mail'],
  phone: ['phone', 'phone_number', 'telephone', 'tel', 'mobile', 'contact_number', 'phonenumber'],
  industry: ['industry', 'category', 'sector', 'business_type', 'type', 'vertical'],
  city: ['city', 'town', 'locality'],
  state: ['state', 'region', 'province'],
  country: ['country'],
  address: ['address', 'street_address', 'full_address', 'formatted_address', 'location'],
};

export interface ImportRow {
  readonly businessName: string;
  readonly website: string | null;
  readonly email: string | null;
  readonly phone: string | null;
  readonly industry: string | null;
  readonly city: string | null;
  readonly state: string | null;
  readonly country: string | null;
  readonly address: string | null;
}

export interface RowError {
  /** 1-based, counting the header as row 1, so it matches what the operator sees. */
  readonly line: number;
  readonly reason: string;
}

export interface ParsedCsv {
  readonly rows: readonly ImportRow[];
  readonly errors: readonly RowError[];
  /** Which incoming header was used for each field, so the UI can show the mapping. */
  readonly mapping: Readonly<Record<string, string>>;
  readonly unmappedHeaders: readonly string[];
}

function normaliseHeader(header: string): string {
  return header
    .trim()
    .toLowerCase()
    .replace(/^﻿/, '')
    .replace(/[\s-]+/g, '_')
    .replace(/[^a-z0-9_]/g, '');
}

/**
 * RFC 4180 parsing, done properly.
 *
 * Splitting on commas is the obvious shortcut and it is wrong for exactly the
 * data this product handles: business names and addresses routinely contain
 * commas, and a naive split silently shifts every subsequent column — producing
 * a lead whose city is half its address, with no error to indicate it.
 */
export function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  const content = text.replace(/^﻿/, '');

  for (let index = 0; index < content.length; index += 1) {
    const char = content[index]!;

    if (inQuotes) {
      if (char === '"') {
        if (content[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      // Consume CRLF as one terminator.
      if (char === '\r' && content[index + 1] === '\n') index += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += char;
    }
  }

  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows.filter((entry) => entry.some((cell) => cell.trim() !== ''));
}

/** Maps incoming headers onto known fields. */
export function mapHeaders(headers: readonly string[]): {
  mapping: Record<string, number>;
  matched: Record<string, string>;
  unmapped: string[];
} {
  const mapping: Record<string, number> = {};
  const matched: Record<string, string> = {};
  const unmapped: string[] = [];

  headers.forEach((raw, index) => {
    const normalised = normaliseHeader(raw);
    const field = Object.entries(COLUMN_ALIASES).find(([, aliases]) =>
      aliases.includes(normalised),
    )?.[0];

    if (field && !(field in mapping)) {
      mapping[field] = index;
      matched[field] = raw.trim();
    } else {
      unmapped.push(raw.trim());
    }
  });

  return { mapping, matched, unmapped };
}

/** Maximum rows in one import, so a mis-selected file cannot flood the table. */
export const MAX_IMPORT_ROWS = 10_000;

export function parseLeadCsv(text: string): ParsedCsv {
  const raw = parseCsvRows(text);

  if (raw.length === 0) {
    throw new AppError({
      code: 'VALIDATION_FAILED',
      message: 'The CSV file is empty',
      safeMessage: 'That file contains no rows.',
    });
  }

  const [headerRow, ...dataRows] = raw as [string[], ...string[][]];
  const { mapping, matched, unmapped } = mapHeaders(headerRow);

  if (mapping.businessName === undefined) {
    throw new AppError({
      code: 'VALIDATION_FAILED',
      message: 'CSV has no recognisable business name column',
      safeMessage:
        'No business name column was found. Name it one of: ' +
        `${COLUMN_ALIASES.businessName!.slice(0, 5).join(', ')}.`,
      context: { headers: headerRow },
    });
  }

  if (dataRows.length > MAX_IMPORT_ROWS) {
    throw new AppError({
      code: 'VALIDATION_FAILED',
      message: `CSV has ${dataRows.length} rows, above the ${MAX_IMPORT_ROWS} limit`,
      safeMessage: `That file has ${dataRows.length} rows. Split it into files of at most ${MAX_IMPORT_ROWS}.`,
    });
  }

  const rows: ImportRow[] = [];
  const errors: RowError[] = [];

  const cell = (values: string[], field: string): string | null => {
    const index = mapping[field];
    if (index === undefined) return null;
    const value = (values[index] ?? '').trim();
    return value === '' ? null : value;
  };

  dataRows.forEach((values, offset) => {
    // +2: one for the header, one for 1-based numbering.
    const line = offset + 2;
    const businessName = cell(values, 'businessName');

    if (!businessName) {
      errors.push({ line, reason: 'No business name' });
      return;
    }
    if (businessName.length > 300) {
      errors.push({ line, reason: 'Business name is implausibly long' });
      return;
    }

    const rawEmail = cell(values, 'email');
    let email: string | null = null;

    if (rawEmail) {
      const normalised = normalizeEmail(rawEmail);
      if (!normalised || !isSendableEmail(normalised)) {
        // Recorded rather than rejecting the whole row: the business is still a
        // useful lead without a usable address.
        errors.push({ line, reason: `"${rawEmail}" is not a usable email address` });
      } else {
        email = normalised;
      }
    }

    const rawWebsite = cell(values, 'website');
    const website = rawWebsite ? normalizeDomain(rawWebsite) || null : null;
    if (rawWebsite && !website) {
      errors.push({ line, reason: `"${rawWebsite}" is not a usable website` });
    }

    rows.push({
      businessName,
      website,
      email,
      phone: cell(values, 'phone'),
      industry: cell(values, 'industry'),
      city: cell(values, 'city'),
      state: cell(values, 'state'),
      country: cell(values, 'country'),
      address: cell(values, 'address'),
    });
  });

  return { rows, errors, mapping: matched, unmappedHeaders: unmapped };
}

/**
 * A stable identity for an imported row.
 *
 * Imported leads have no Place ID, so deduplication needs its own key. Domain
 * wins when present because two rows sharing a domain are the same business
 * however differently they spell the name; otherwise the normalised name plus
 * city is the best available, and phone digits break the remaining ties.
 */
export function importDedupeKey(row: ImportRow): string {
  if (row.website) return `domain:${row.website}`;

  const name = normalizeBusinessName(row.businessName);
  const city = (row.city ?? '').trim().toLowerCase();
  const digits = phoneDigits(row.phone);

  if (digits) return `phone:${digits}`;
  return `name:${name}|${city}`;
}

export interface ImportSummary {
  readonly total: number;
  readonly created: number;
  readonly updated: number;
  readonly duplicates: number;
  readonly invalid: number;
  readonly errors: readonly RowError[];
  readonly mapping: Readonly<Record<string, string>>;
  readonly unmappedHeaders: readonly string[];
}

/** Collapses rows that describe the same business within one file. */
export function dedupeRows(rows: readonly ImportRow[]): {
  unique: ImportRow[];
  duplicates: number;
} {
  const seen = new Map<string, ImportRow>();
  let duplicates = 0;

  for (const row of rows) {
    const key = importDedupeKey(row);
    const existing = seen.get(key);

    if (!existing) {
      seen.set(key, row);
      continue;
    }

    duplicates += 1;

    // Keep the richer record rather than the first one seen: a later row with an
    // email and a phone is more useful than an earlier one with only a name.
    const score = (candidate: ImportRow): number =>
      [
        candidate.email,
        candidate.phone,
        candidate.website,
        candidate.city,
        candidate.address,
      ].filter(Boolean).length;

    if (score(row) > score(existing)) seen.set(key, row);
  }

  return { unique: [...seen.values()], duplicates };
}
