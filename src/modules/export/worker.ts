/**
 * Export worker.
 *
 * Runs in the background because a 10,000-row XLSX with formatting takes long
 * enough to time out an HTTP request, and because building it in a request would
 * hold a serverless function open for the duration.
 *
 * Streams rows in pages rather than loading the whole result set: a tenant with
 * 200,000 leads must not be able to exhaust worker memory by clicking Export.
 */
import ExcelJS from 'exceljs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { AppError } from '@/lib/errors';
import { jobLogger } from '@/lib/logger';
import { db, type TenantContext } from '@/modules/database/client';
import { leadWhere, recordAudit, type LeadFilters } from '@/modules/database/repositories';
import { QUEUE_NAMES } from '@/modules/jobs/queues';
import { exportPayloadSchema, parsePayload, type ExportPayload } from '@/modules/jobs/schemas';
import { priorityLabel } from '@/modules/scoring/config';

import {
  GOOGLE_ATTRIBUTION,
  columnsFor,
  neutraliseFormula,
  toCsv,
  type ExportColumn,
  type ExportPolicy,
} from './policy';

/** Rows per database page. Bounded so memory stays flat regardless of total size. */
const PAGE_SIZE = 500;
/** Hard row ceiling per export, so one click cannot produce a 2 GB file. */
const MAX_ROWS = 50_000;

const EXPORT_DIR = join(process.cwd(), 'exports');

type LeadRow = Awaited<ReturnType<typeof fetchPage>>[number];

async function fetchPage(tenant: TenantContext, filters: LeadFilters, skip: number) {
  return db().business.findMany({
    where: leadWhere(tenant, filters),
    orderBy: [{ opportunityScore: { sort: 'desc', nulls: 'last' } }, { id: 'asc' }],
    skip,
    take: PAGE_SIZE,
    include: {
      placeIdentifier: { select: { googlePlaceId: true } },
      leadScores: { where: { isCurrent: true }, take: 1 },
      recommendations: { where: { isCurrent: true }, orderBy: { strength: 'desc' } },
      socialProfiles: { select: { platform: true, url: true } },
      verifications: { orderBy: { verifiedAt: 'desc' }, take: 1 },
    },
  });
}

/** Flattens a lead into export cells. Every value here is already policy-filtered. */
function toExportRecord(row: LeadRow): Record<string, unknown> {
  const score = row.leadScores[0];
  const verification = row.verifications[0];
  const top = row.recommendations[0];

  return {
    opportunityScore: row.opportunityScore ?? '',
    leadPriority: row.leadPriority ? priorityLabel(row.leadPriority) : '',
    digitalPresence: row.digitalPresence ?? '',
    recommendedServices: row.recommendations.map((rec) => rec.service).join('; '),
    // The pitch is stored as the last element of `reasons`.
    topPitch: top?.reasons.at(-1) ?? '',
    independentWebsiteStatus: row.independentWebsiteStatus,
    verificationConfidence: verification ? verification.confidence.toFixed(2) : '',
    identityVerification: row.identityVerification,
    isChain: row.isChain ? 'yes' : 'no',
    needFactor: score?.needFactor?.toFixed(3) ?? '',
    valueFactor: score?.valueFactor?.toFixed(3) ?? '',
    reachFactor: score?.reachFactor?.toFixed(3) ?? '',

    verifiedDomain: row.verifiedDomain ?? '',
    socialProfiles: row.socialProfiles.map((profile) => profile.url).join('; '),

    googlePlaceId: row.placeIdentifier.googlePlaceId,

    displayName: row.displayName,
    formattedAddress: row.formattedAddress ?? '',
    city: row.city ?? '',
    state: row.state ?? '',
    phone: row.phone ?? '',
    rating: row.rating ?? '',
    reviewCount: row.reviewCount ?? '',
    primaryCategory: row.primaryCategory ?? '',
    googleWebsiteStatus: row.googleWebsiteStatus,
  };
}

async function buildXlsx(
  columns: readonly ExportColumn[],
  records: readonly Record<string, unknown>[],
  policy: ExportPolicy,
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'LeadRadar';
  workbook.created = new Date();

  const sheet = workbook.addWorksheet('Leads', {
    views: [{ state: 'frozen', ySplit: 1 }],
  });

  sheet.columns = columns.map((column) => ({
    header: column.header,
    key: column.key,
    width: Math.min(40, Math.max(14, column.header.length + 4)),
  }));

  sheet.getRow(1).font = { bold: true };

  for (const record of records) {
    const row: Record<string, unknown> = {};
    for (const column of columns) {
      const value = record[column.key];
      // Formula neutralisation applies to XLSX too: the vulnerability lives in the
      // spreadsheet application, not the file format.
      row[column.key] = typeof value === 'string' ? neutraliseFormula(value) : (value ?? '');
    }
    sheet.addRow(row);
  }

  // A provenance sheet, so the recipient can see which columns came from where
  // rather than having to ask. This is what makes the export defensible.
  const notes = workbook.addWorksheet('Data Sources');
  notes.columns = [
    { header: 'Column', key: 'column', width: 32 },
    { header: 'Source', key: 'source', width: 24 },
    { header: 'Note', key: 'note', width: 70 },
  ];
  notes.getRow(1).font = { bold: true };

  for (const column of columns) {
    notes.addRow({
      column: column.header,
      source: column.provenance,
      note: column.note ?? '',
    });
  }

  if (policy === 'with-google-derived') {
    notes.addRow({});
    notes.addRow({ column: 'Attribution', source: 'REQUIRED', note: GOOGLE_ATTRIBUTION });
  }

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

export async function processExport(
  raw: unknown,
  bullJobId?: string,
): Promise<{ rowCount: number; path: string }> {
  const payload = parsePayload<ExportPayload>(exportPayloadSchema, raw, QUEUE_NAMES.export);
  const tenant: TenantContext = {
    organizationId: payload.organizationId,
    ...(payload.userId !== undefined && { userId: payload.userId }),
  };
  const log = jobLogger(bullJobId ?? 'export', QUEUE_NAMES.export, { exportJobId: payload.exportJobId });

  const job = await db().exportJob.findFirst({
    where: { id: payload.exportJobId, organizationId: tenant.organizationId },
  });

  if (!job) {
    throw new AppError({
      code: 'NOT_FOUND',
      message: `Export job ${payload.exportJobId} not found for this organization`,
      retryability: 'never',
    });
  }

  await db().exportJob.update({
    where: { id: job.id },
    data: { status: 'RUNNING' },
  });

  try {
    const policy: ExportPolicy = job.includesGoogleDerived ? 'with-google-derived' : 'safe';
    const columns = columnsFor(policy).filter(
      // Honour an explicit column selection, but only within what policy allows.
      (column) => job.columns.length === 0 || job.columns.includes(column.key),
    );

    const filters = (job.filters ?? {}) as LeadFilters;
    const records: Record<string, unknown>[] = [];

    for (let skip = 0; skip < MAX_ROWS; skip += PAGE_SIZE) {
      const page = await fetchPage(tenant, filters, skip);
      if (page.length === 0) break;
      records.push(...page.map(toExportRecord));
      if (page.length < PAGE_SIZE) break;
    }

    await mkdir(EXPORT_DIR, { recursive: true });

    const extension = job.format === 'CSV' ? 'csv' : 'xlsx';
    // Filename includes the job id only — never a tenant name or a filter value,
    // which could leak business context through a shared filesystem or log.
    const filename = `leadradar-${job.id}.${extension}`;
    const path = join(EXPORT_DIR, filename);

    const contents =
      job.format === 'CSV'
        ? Buffer.from(toCsv(columns, records), 'utf8')
        : await buildXlsx(columns, records, policy);

    await writeFile(path, contents);

    await db().exportJob.update({
      where: { id: job.id },
      data: {
        status: 'COMPLETED',
        rowCount: records.length,
        storagePath: path,
        byteSize: contents.byteLength,
        completedAt: new Date(),
      },
    });

    // Audited because exporting Google-derived data is a decision someone made.
    await recordAudit(tenant, {
      action: 'export.completed',
      resourceType: 'ExportJob',
      resourceId: job.id,
      metadata: {
        format: job.format,
        rowCount: records.length,
        policy,
        includesGoogleDerived: job.includesGoogleDerived,
        columns: columns.map((column) => column.key),
      },
    });

    log.info({ rows: records.length, format: job.format, policy }, 'Export complete');
    return { rowCount: records.length, path };
  } catch (error) {
    await db().exportJob.update({
      where: { id: job.id },
      data: {
        status: 'FAILED',
        errorCode: error instanceof AppError ? error.code : 'INTERNAL',
        completedAt: new Date(),
      },
    });
    throw error;
  }
}
