/**
 * GET /api/export/:id — status, or the file itself once ready.
 *
 * The file is streamed through this route rather than exposed as a static path.
 * Serving from a public directory would make exports reachable by anyone who
 * guessed an id, which for a lead list is a cross-tenant data leak.
 */
import { readFile } from 'node:fs/promises';
import { NextResponse } from 'next/server';

import { AppError } from '@/lib/errors';
import { handler, resolveTenant } from '@/modules/api/handler';
import { db } from '@/modules/database/client';
import { recordAudit } from '@/modules/database/repositories';
import { GOOGLE_ATTRIBUTION } from '@/modules/export/policy';

export const GET = handler(async ({ tenant, params }) => {
  const job = await db().exportJob.findFirst({
    where: { id: params.id ?? '', organizationId: tenant.organizationId },
    select: {
      id: true,
      status: true,
      format: true,
      rowCount: true,
      byteSize: true,
      includesGoogleDerived: true,
      errorCode: true,
      createdAt: true,
      completedAt: true,
    },
  });

  if (!job) {
    throw new AppError({
      code: 'NOT_FOUND',
      message: `Export job ${params.id} not found`,
      safeMessage: 'That export could not be found.',
    });
  }

  return {
    ...job,
    downloadUrl: job.status === 'COMPLETED' ? `/api/export/${job.id}/download` : null,
    ...(job.includesGoogleDerived && { attribution: GOOGLE_ATTRIBUTION }),
  };
});

/**
 * The download itself.
 *
 * Not wrapped in `handler` because it returns a binary body rather than JSON, so it
 * repeats the tenant check explicitly. That duplication is deliberate: the check is
 * the only thing preventing one tenant reading another's lead export.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const tenant = await resolveTenant(request);
  const { id } = await context.params;

  const job = await db().exportJob.findFirst({
    where: { id, organizationId: tenant.organizationId },
    select: { id: true, status: true, format: true, storagePath: true, includesGoogleDerived: true },
  });

  if (!job || job.status !== 'COMPLETED' || !job.storagePath) {
    return NextResponse.json({ error: { code: 'NOT_FOUND', message: 'Export not ready.' } }, { status: 404 });
  }

  let contents: Buffer;
  try {
    contents = await readFile(job.storagePath);
  } catch {
    return NextResponse.json(
      { error: { code: 'NOT_FOUND', message: 'Export file is no longer available.' } },
      { status: 410 },
    );
  }

  await recordAudit(tenant, {
    action: 'export.downloaded',
    resourceType: 'ExportJob',
    resourceId: job.id,
    metadata: { includesGoogleDerived: job.includesGoogleDerived },
  });

  const isCsv = job.format === 'CSV';

  return new NextResponse(new Uint8Array(contents), {
    headers: {
      'content-type': isCsv
        ? 'text/csv; charset=utf-8'
        : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      // Filename carries only the job id — never a tenant name or filter value,
      // which would leak business context into browser history and proxy logs.
      'content-disposition': `attachment; filename="leadradar-${job.id}.${isCsv ? 'csv' : 'xlsx'}"`,
      'cache-control': 'private, no-store',
      // Stops a browser from rendering a CSV as HTML if the type were ever wrong.
      'x-content-type-options': 'nosniff',
    },
  });
}
