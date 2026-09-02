/**
 * Operational kill switches.
 *
 * The control an operator reaches for when something is going wrong and they do
 * not yet know what. Not a feature flag system — a brake.
 *
 * ---------------------------------------------------------------------------
 * WHY THESE FAIL IN DIFFERENT DIRECTIONS
 * ---------------------------------------------------------------------------
 *
 * `outbound` fails CLOSED: if the control state cannot be read, sending stops.
 * Every other control fails OPEN: if the state cannot be read, work continues.
 *
 * That asymmetry is deliberate and is the whole design. The two failures are not
 * symmetric in cost:
 *
 *   - An email that should have gone and did not is recoverable. Resume the
 *     campaign and it sends.
 *   - An email that should NOT have gone and did cannot be recalled. It is in a
 *     stranger's inbox, under the operator's own name and sending reputation.
 *
 * So a database blip must never be able to produce the second outcome. For
 * crawling and AI the calculation reverses: failing closed there would halt the
 * whole pipeline over a transient read error, and the cost of proceeding is money
 * rather than harm.
 *
 * Stored in `OrgSetting` rather than a new table. A kill switch needs to be
 * readable on every send and writable instantly; a key/value row already scoped
 * to the tenant is exactly that, and adding a table would mean a migration for no
 * capability.
 *
 * NOT cached. A brake with a 30-second cache is a brake that does not work when
 * you press it.
 */
import { AppError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { db, type TenantContext } from '@/modules/database/client';
import { recordAudit, recordEvent } from '@/modules/database/repositories';

/** The switches an operator can throw. */
export type ControlName = 'outbound' | 'ai' | 'crawler';

export const CONTROLS: Record<
  ControlName,
  { key: string; label: string; description: string; failsClosed: boolean }
> = {
  outbound: {
    key: 'ops.outbound.paused',
    label: 'Outbound email',
    description:
      'Stops every campaign send immediately, across all campaigns. Queued work is not lost — it resumes when this is cleared.',
    // The one control where an unreadable state must mean "stop".
    failsClosed: true,
  },
  ai: {
    key: 'ops.ai.paused',
    label: 'AI processing',
    description:
      'Stops AI personalization and intent classification. Deterministic fallbacks continue, so nothing breaks — output is simply less tailored.',
    failsClosed: false,
  },
  crawler: {
    key: 'ops.crawler.paused',
    label: 'Discovery and crawling',
    description:
      'Stops new discovery and website crawling. Existing leads are untouched.',
    failsClosed: false,
  },
};

export interface ControlState {
  readonly name: ControlName;
  readonly label: string;
  readonly description: string;
  readonly paused: boolean;
  readonly reason: string | null;
  readonly changedAt: Date | null;
  readonly changedByUserId: string | null;
  /** True when the value could not be read and the fail-safe default applied. */
  readonly indeterminate: boolean;
}

interface StoredControl {
  paused: boolean;
  reason: string | null;
  changedAt: string;
  changedByUserId: string | null;
}

function parse(value: unknown): StoredControl | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.paused !== 'boolean') return null;

  return {
    paused: record.paused,
    reason: typeof record.reason === 'string' ? record.reason : null,
    changedAt: typeof record.changedAt === 'string' ? record.changedAt : new Date(0).toISOString(),
    changedByUserId:
      typeof record.changedByUserId === 'string' ? record.changedByUserId : null,
  };
}

/**
 * Whether a control is currently pausing work.
 *
 * Never throws. A control that throws is a control that can take the system down
 * with it, which is the opposite of its purpose — so a read failure resolves to
 * the fail-safe default for that specific control instead.
 */
export async function isPaused(
  tenant: TenantContext,
  name: ControlName,
): Promise<{ paused: boolean; reason: string | null; indeterminate: boolean }> {
  const control = CONTROLS[name];

  try {
    const row = await db().orgSetting.findUnique({
      where: {
        organizationId_key: { organizationId: tenant.organizationId, key: control.key },
      },
      select: { value: true },
    });

    const stored = row ? parse(row.value) : null;
    if (!stored) return { paused: false, reason: null, indeterminate: false };

    return { paused: stored.paused, reason: stored.reason, indeterminate: false };
  } catch (error) {
    logger().error(
      { err: error, control: name, failsClosed: control.failsClosed },
      'Could not read operational control; applying the fail-safe default',
    );

    return {
      paused: control.failsClosed,
      reason: control.failsClosed
        ? 'The pause state could not be read, so sending stopped as a precaution.'
        : null,
      indeterminate: true,
    };
  }
}

/** Convenience for the send path, which only ever asks about outbound. */
export async function outboundPaused(
  tenant: TenantContext,
): Promise<{ paused: boolean; reason: string | null }> {
  const result = await isPaused(tenant, 'outbound');
  return { paused: result.paused, reason: result.reason };
}

export interface SetControlInput {
  readonly name: ControlName;
  readonly paused: boolean;
  /** Why. Required when pausing — an unexplained halt wastes the next person's time. */
  readonly reason?: string;
}

/**
 * Throws or clears a switch.
 *
 * Writes an audit row and a system event. Both, deliberately: the audit log
 * answers "who did this" and the event feed answers "what was happening at the
 * time", and during an incident those are different questions.
 */
export async function setControl(
  tenant: TenantContext,
  input: SetControlInput,
): Promise<ControlState> {
  const control = CONTROLS[input.name];

  if (input.paused && !input.reason?.trim()) {
    throw new AppError({
      code: 'VALIDATION_FAILED',
      message: 'A reason is required when pausing an operational control',
      safeMessage: 'Say why you are pausing this, so the next person knows.',
    });
  }

  const stored: StoredControl = {
    paused: input.paused,
    reason: input.reason?.trim() ?? null,
    changedAt: new Date().toISOString(),
    changedByUserId: tenant.userId ?? null,
  };

  await db().orgSetting.upsert({
    where: {
      organizationId_key: { organizationId: tenant.organizationId, key: control.key },
    },
    update: { value: stored as never, updatedByUserId: tenant.userId ?? null },
    create: {
      organizationId: tenant.organizationId,
      key: control.key,
      value: stored as never,
      updatedByUserId: tenant.userId ?? null,
    },
  });

  await recordAudit(tenant, {
    action: input.paused ? `ops.${input.name}.paused` : `ops.${input.name}.resumed`,
    resourceType: 'OperationalControl',
    resourceId: control.key,
    metadata: { reason: stored.reason },
  });

  await recordEvent({
    organizationId: tenant.organizationId,
    level: input.paused ? 'WARN' : 'INFO',
    code: input.paused ? 'OPS_CONTROL_PAUSED' : 'OPS_CONTROL_RESUMED',
    message: input.paused
      ? `${control.label} paused: ${stored.reason}`
      : `${control.label} resumed.`,
    context: { control: input.name, userId: tenant.userId ?? null },
  });

  logger().warn(
    { control: input.name, paused: input.paused, userId: tenant.userId },
    'Operational control changed',
  );

  return {
    name: input.name,
    label: control.label,
    description: control.description,
    paused: stored.paused,
    reason: stored.reason,
    changedAt: new Date(stored.changedAt),
    changedByUserId: stored.changedByUserId,
    indeterminate: false,
  };
}

/** Every control's current state, for the operations screen. */
export async function allControls(tenant: TenantContext): Promise<ControlState[]> {
  const rows = await db()
    .orgSetting.findMany({
      where: {
        organizationId: tenant.organizationId,
        key: { in: Object.values(CONTROLS).map((c) => c.key) },
      },
      select: { key: true, value: true },
    })
    .catch(() => []);

  const byKey = new Map(rows.map((row) => [row.key, parse(row.value)]));

  return (Object.keys(CONTROLS) as ControlName[]).map((name) => {
    const control = CONTROLS[name];
    const stored = byKey.get(control.key) ?? null;

    return {
      name,
      label: control.label,
      description: control.description,
      paused: stored?.paused ?? false,
      reason: stored?.reason ?? null,
      changedAt: stored ? new Date(stored.changedAt) : null,
      changedByUserId: stored?.changedByUserId ?? null,
      indeterminate: false,
    };
  });
}

/**
 * Pauses outbound automatically, in response to the system noticing trouble
 * rather than a human noticing it.
 *
 * Separated from `setControl` because the actor is the system: it records no
 * user, and it will not overwrite a pause a human already placed — their reason
 * is more informative than ours, and clobbering it would hide why the stop
 * originally happened.
 */
export async function autoPauseOutbound(
  tenant: TenantContext,
  reason: string,
): Promise<{ paused: boolean; alreadyPaused: boolean }> {
  const current = await isPaused(tenant, 'outbound');
  if (current.paused) return { paused: true, alreadyPaused: true };

  await setControl(tenant, {
    name: 'outbound',
    paused: true,
    reason: `Paused automatically: ${reason}`,
  });

  return { paused: true, alreadyPaused: false };
}
