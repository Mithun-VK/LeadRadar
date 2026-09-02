/**
 * GET  /api/ops/controls — current state of every kill switch.
 * POST /api/ops/controls — throw or clear one.
 *
 * Restricted to OWNER/ADMIN. Pausing outbound stops every campaign in the
 * organization at once, which is not a decision to leave with every seat.
 *
 * Reading is deliberately NOT restricted beyond normal authentication: anyone
 * who can see a campaign should be able to see why it has stopped sending.
 * Hiding that turns a deliberate pause into an apparent bug.
 */
import { z } from 'zod';

import { AppError } from '@/lib/errors';
import { handler, resolveSession } from '@/modules/api/handler';
import { allControls, setControl, type ControlName } from '@/modules/ops/controls';

export const GET = handler(async ({ tenant }) => {
  const controls = await allControls(tenant);

  return {
    controls,
    /** Convenience for the UI banner, so it need not scan the array. */
    outboundPaused: controls.find((c) => c.name === 'outbound')?.paused ?? false,
  };
});

const bodySchema = z
  .object({
    control: z.enum(['outbound', 'ai', 'crawler']),
    paused: z.boolean(),
    reason: z.string().trim().max(300).optional(),
  })
  .strict();

export const POST = handler(
  async ({ tenant, body, logger }) => {
    const session = await resolveSession();

    if (session.role !== 'OWNER' && session.role !== 'ADMIN') {
      throw new AppError({
        code: 'FORBIDDEN',
        message: 'Only an owner or admin may change operational controls',
        safeMessage: 'You need admin access to pause or resume this.',
      });
    }

    const state = await setControl(tenant, {
      name: body.control as ControlName,
      paused: body.paused,
      ...(body.reason && { reason: body.reason }),
    });

    logger.warn(
      { control: body.control, paused: body.paused, userId: session.userId },
      'Operational control changed via API',
    );

    return state;
  },
  {
    bodySchema,
    auditAction: 'ops.control.set',
    // Generous rather than tight: an operator hammering the brake during an
    // incident must not be rate limited away from stopping the system.
    rateLimit: { capacity: 30, refillPerSecond: 1 },
  },
);
