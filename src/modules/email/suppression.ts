/**
 * Suppression list.
 *
 * The one control in this subsystem with no override, no force flag, and no
 * "skip checks" parameter anywhere in its API. That absence is the design: a
 * suppression list that can be bypassed is not a suppression list, and the
 * bypass is always added for a good reason and then used for a bad one.
 *
 * Someone who asks not to be contacted must stay uncontacted even if an operator
 * later re-imports them from a CSV, re-discovers them in a new search, or adds
 * them to a different campaign. That is why suppression is keyed on the
 * ORGANIZATION and the ADDRESS rather than on a campaign or a lead — the lead row
 * can be deleted and rediscovered, but the request not to be emailed persists.
 */
import type { Prisma } from '@prisma/client';

import { hashForLookup } from '@/lib/crypto';
import { db, type TenantContext } from '@/modules/database/client';
import { normalizeEmail } from '@/modules/enrichment/contacts';

export type SuppressionReason = 'UNSUBSCRIBED' | 'BOUNCED' | 'COMPLAINED' | 'MANUAL' | 'INVALID';

export interface SuppressionCheck {
  readonly suppressed: boolean;
  readonly reason: SuppressionReason | null;
  readonly since: Date | null;
}

/**
 * Normalises before hashing.
 *
 * Critical for correctness: someone who unsubscribes as `Info@Clinic.IN` must
 * also be suppressed when the same mailbox is later discovered as
 * `info+web@clinic.in`. Without shared normalisation the list would silently
 * fail to match the very addresses it was created from.
 */
function keyFor(email: string): string | null {
  const normalised = normalizeEmail(email);
  return normalised ? hashForLookup(normalised) : null;
}

/** Whether one address may be contacted. */
export async function checkSuppression(
  tenant: TenantContext,
  email: string,
): Promise<SuppressionCheck> {
  const hash = keyFor(email);

  // An unparseable address is treated as suppressed. Failing closed is correct
  // here: we cannot prove it is safe to contact, and the cost of a false
  // suppression is one unsent email against the cost of one unwanted one.
  if (!hash) return { suppressed: true, reason: 'INVALID', since: null };

  const row = await db().suppressionEntry.findUnique({
    where: {
      organizationId_emailHash: { organizationId: tenant.organizationId, emailHash: hash },
    },
    select: { reason: true, createdAt: true },
  });

  if (!row) return { suppressed: false, reason: null, since: null };
  return { suppressed: true, reason: row.reason, since: row.createdAt };
}

/**
 * Bulk check, for enrolling a campaign.
 *
 * One query rather than N: enrolling 500 leads must not issue 500 round trips,
 * and a slow enrolment is a screen the operator abandons halfway through — which
 * leaves a half-built campaign.
 */
export async function filterSuppressed(
  tenant: TenantContext,
  emails: readonly string[],
): Promise<Set<string>> {
  const byHash = new Map<string, string>();

  for (const email of emails) {
    const normalised = normalizeEmail(email);
    if (normalised) byHash.set(hashForLookup(normalised), normalised);
  }

  if (byHash.size === 0) return new Set();

  const rows = await db().suppressionEntry.findMany({
    where: {
      organizationId: tenant.organizationId,
      emailHash: { in: [...byHash.keys()] },
    },
    select: { emailHash: true },
  });

  return new Set(
    rows
      .map((row) => byHash.get(row.emailHash))
      .filter((value): value is string => value !== undefined),
  );
}

export interface SuppressInput {
  readonly email: string;
  readonly reason: SuppressionReason;
  readonly detail?: string;
  readonly sourceMessageId?: string;
}

/**
 * Adds an address to the list.
 *
 * Idempotent: an unsubscribe link clicked twice, or a bounce recorded by two
 * paths, must not fail. The FIRST reason is kept, because "they asked to
 * unsubscribe" is more meaningful than a later "the address bounced", and losing
 * the human decision to a subsequent technical event would misrepresent why they
 * are on the list.
 */
export async function suppress(
  tenant: TenantContext,
  input: SuppressInput,
  tx?: Prisma.TransactionClient,
): Promise<{ added: boolean }> {
  const normalised = normalizeEmail(input.email);
  if (!normalised) return { added: false };

  const client = tx ?? db();
  const hash = hashForLookup(normalised);

  const existing = await client.suppressionEntry.findUnique({
    where: { organizationId_emailHash: { organizationId: tenant.organizationId, emailHash: hash } },
    select: { id: true },
  });

  if (existing) return { added: false };

  await client.suppressionEntry.create({
    data: {
      organizationId: tenant.organizationId,
      email: normalised,
      emailHash: hash,
      reason: input.reason,
      detail: input.detail ?? null,
      sourceMessageId: input.sourceMessageId ?? null,
    },
  });

  return { added: true };
}

/**
 * Removes an address.
 *
 * Deliberately narrow: only a MANUAL entry can be removed, and only by an
 * explicit operator action. An UNSUBSCRIBED entry is permanent — allowing it to
 * be cleared would let an operator undo a recipient's decision, which is the
 * thing the list exists to prevent. A BOUNCED or COMPLAINED entry is likewise
 * kept, because re-mailing a hard bounce damages the sender's own reputation.
 */
export async function unsuppress(
  tenant: TenantContext,
  email: string,
): Promise<{ removed: boolean; refusedReason: SuppressionReason | null }> {
  const normalised = normalizeEmail(email);
  if (!normalised) return { removed: false, refusedReason: null };

  const hash = hashForLookup(normalised);
  const row = await db().suppressionEntry.findUnique({
    where: { organizationId_emailHash: { organizationId: tenant.organizationId, emailHash: hash } },
    select: { id: true, reason: true },
  });

  if (!row) return { removed: false, refusedReason: null };
  if (row.reason !== 'MANUAL') return { removed: false, refusedReason: row.reason };

  await db().suppressionEntry.delete({ where: { id: row.id } });
  return { removed: true, refusedReason: null };
}

export async function listSuppressions(
  tenant: TenantContext,
  options: { page?: number; pageSize?: number } = {},
) {
  const page = Math.max(1, options.page ?? 1);
  const pageSize = Math.min(200, Math.max(1, options.pageSize ?? 50));

  const [rows, total] = await Promise.all([
    db().suppressionEntry.findMany({
      where: { organizationId: tenant.organizationId },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: { id: true, email: true, reason: true, detail: true, createdAt: true },
    }),
    db().suppressionEntry.count({ where: { organizationId: tenant.organizationId } }),
  ]);

  return { rows, total, page, pageSize, pageCount: Math.max(1, Math.ceil(total / pageSize)) };
}
