/**
 * ExportPolicyService.
 *
 * Export is where the compliance boundary becomes commercially real: a CSV leaves
 * our system and lands in a customer's CRM, beyond any retention control we have.
 * So the exporter classifies every column by provenance and, by default, ships only
 * what LeadRadar independently established or computed.
 *
 * Google-derived columns are excluded unless a caller explicitly opts in, and that
 * opt-in is recorded on the ExportJob and in the audit log — because it is a
 * decision someone made, not a default someone inherited. See
 * docs/google-maps-compliance.md for what remains legally unresolved.
 *
 * Also handles CSV injection, which is a real vulnerability rather than a
 * formatting nicety: a cell beginning `=` is executed by Excel and Sheets when the
 * file is opened, and business names are attacker-influenced free text.
 */
import type { DataProvenance } from '@/types/domain';

export interface ExportColumn {
  readonly key: string;
  readonly header: string;
  readonly provenance: DataProvenance;
  /** Why this column carries the provenance it does. */
  readonly note?: string;
}

/**
 * Every exportable column.
 *
 * Note what is NOT here: `googleMapsUri`, review text, and photos. Maps URIs and
 * review content carry display and attribution obligations that a CSV cannot
 * satisfy once it leaves our UI, so they are not exportable at any policy level.
 */
export const EXPORT_COLUMNS: readonly ExportColumn[] = [
  // --- application-generated: unambiguously ours -----------------------------
  { key: 'opportunityScore', header: 'Opportunity Score', provenance: 'APPLICATION_GENERATED' },
  { key: 'leadPriority', header: 'Priority', provenance: 'APPLICATION_GENERATED' },
  { key: 'digitalPresence', header: 'Digital Presence', provenance: 'APPLICATION_GENERATED' },
  { key: 'recommendedServices', header: 'Recommended Services', provenance: 'APPLICATION_GENERATED' },
  { key: 'topPitch', header: 'Opening Pitch', provenance: 'APPLICATION_GENERATED' },
  { key: 'independentWebsiteStatus', header: 'Website Status (verified)', provenance: 'APPLICATION_GENERATED' },
  { key: 'verificationConfidence', header: 'Verification Confidence', provenance: 'APPLICATION_GENERATED' },
  { key: 'identityVerification', header: 'Identity Verification', provenance: 'APPLICATION_GENERATED' },
  { key: 'isChain', header: 'Chain/Franchise', provenance: 'APPLICATION_GENERATED' },
  { key: 'needFactor', header: 'Need Factor', provenance: 'APPLICATION_GENERATED' },
  { key: 'valueFactor', header: 'Value Factor', provenance: 'APPLICATION_GENERATED' },
  { key: 'reachFactor', header: 'Reach Factor', provenance: 'APPLICATION_GENERATED' },

  // --- public web: gathered by our own crawl of the business's own site ------
  {
    key: 'verifiedDomain',
    header: 'Verified Website',
    provenance: 'PUBLIC_WEB',
    note: 'Confirmed by our own crawl to belong to this business',
  },
  { key: 'socialProfiles', header: 'Social Profiles', provenance: 'PUBLIC_WEB' },

  // --- place identifier: retained indefinitely by provider terms -------------
  {
    key: 'googlePlaceId',
    header: 'Place ID',
    provenance: 'PLACE_IDENTIFIER',
    note: 'Provider terms permit storing place IDs indefinitely',
  },

  // --- Google-derived: excluded by default -----------------------------------
  {
    key: 'displayName',
    header: 'Business Name',
    provenance: 'GOOGLE_DERIVED',
    note: 'Originates from Places; subject to provider caching and attribution terms',
  },
  { key: 'formattedAddress', header: 'Address', provenance: 'GOOGLE_DERIVED' },
  { key: 'city', header: 'City', provenance: 'GOOGLE_DERIVED' },
  { key: 'state', header: 'State', provenance: 'GOOGLE_DERIVED' },
  { key: 'phone', header: 'Phone', provenance: 'GOOGLE_DERIVED' },
  { key: 'rating', header: 'Rating', provenance: 'GOOGLE_DERIVED' },
  { key: 'reviewCount', header: 'Reviews', provenance: 'GOOGLE_DERIVED' },
  { key: 'primaryCategory', header: 'Category', provenance: 'GOOGLE_DERIVED' },
  { key: 'googleWebsiteStatus', header: 'Website Listed on Google', provenance: 'GOOGLE_DERIVED' },
];

export type ExportPolicy = 'safe' | 'with-google-derived';

/**
 * Columns permitted under a policy.
 *
 * `safe` is the default and produces a genuinely useful file: a verified domain,
 * a score, a grade, recommended services, and an opening pitch. What it lacks is
 * the business NAME, which makes it near-useless in practice — and that tension is
 * the honest state of this product's compliance position, not something to paper
 * over. The UI says so at the point of export rather than hiding it.
 */
export function columnsFor(policy: ExportPolicy): ExportColumn[] {
  if (policy === 'with-google-derived') return [...EXPORT_COLUMNS];
  return EXPORT_COLUMNS.filter((column) => column.provenance !== 'GOOGLE_DERIVED');
}

export interface PolicyDecision {
  readonly policy: ExportPolicy;
  readonly columns: readonly ExportColumn[];
  readonly excludedColumns: readonly ExportColumn[];
  /** Shown to the user before download; never suppressed. */
  readonly warnings: readonly string[];
  readonly requiresAcknowledgement: boolean;
}

export function decidePolicy(requested: {
  includeGoogleDerived: boolean;
  acknowledgedTerms: boolean;
}): PolicyDecision {
  const wantsGoogle = requested.includeGoogleDerived;

  // Opt-in is refused without acknowledgement. Silently downgrading would hand
  // the user a file missing the columns they asked for with no explanation.
  const granted = wantsGoogle && requested.acknowledgedTerms;
  const policy: ExportPolicy = granted ? 'with-google-derived' : 'safe';

  const columns = columnsFor(policy);
  const excluded = EXPORT_COLUMNS.filter((column) => !columns.includes(column));

  const warnings: string[] = [];

  if (policy === 'safe') {
    warnings.push(
      'Google-derived fields (business name, address, phone, rating, review count) are excluded. ' +
        'This export contains only independently verified web data and LeadRadar intelligence.',
    );
    if (wantsGoogle && !requested.acknowledgedTerms) {
      warnings.push(
        'Google-derived fields were requested but not acknowledged, so they were withheld.',
      );
    }
  } else {
    warnings.push(
      'This export includes Google-derived fields. Google Maps Platform terms restrict caching, ' +
        'storage, and redistribution of Places content and require attribution. You are responsible ' +
        'for compliant use of this file, including in any downstream CRM.',
    );
  }

  return {
    policy,
    columns,
    excludedColumns: excluded,
    warnings,
    requiresAcknowledgement: wantsGoogle && !requested.acknowledgedTerms,
  };
}

/**
 * Neutralises formula injection.
 *
 * Excel, Sheets, and LibreOffice execute a cell beginning with `=`, `+`, `-`, `@`,
 * tab, or CR. Business names come from a third party, so a listing named
 * `=HYPERLINK("http://evil.example","Click")` would execute on open. Prefixing with
 * a single quote makes the cell literal text.
 *
 * Applied to CSV and XLSX alike — the vulnerability is in the spreadsheet
 * application, not the file format.
 */
export function neutraliseFormula(value: string): string {
  if (value === '') return value;
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

/** Escapes and quotes one CSV field. */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';

  const raw = typeof value === 'string' ? value : String(value);
  const safe = neutraliseFormula(raw);

  // Quote when the value contains a delimiter, quote, or newline; double inner
  // quotes per RFC 4180.
  if (/[",\r\n]/.test(safe)) return `"${safe.replace(/"/g, '""')}"`;
  return safe;
}

export function toCsv(
  columns: readonly ExportColumn[],
  rows: readonly Record<string, unknown>[],
): string {
  const header = columns.map((column) => csvCell(column.header)).join(',');
  const body = rows.map((row) => columns.map((column) => csvCell(row[column.key])).join(','));
  // CRLF per RFC 4180, and a BOM so Excel reads UTF-8 rather than mangling
  // non-ASCII business names.
  return `﻿${[header, ...body].join('\r\n')}\r\n`;
}

/** Attribution line required when Google-derived data is present. */
export const GOOGLE_ATTRIBUTION = 'Business listing data powered by Google';
