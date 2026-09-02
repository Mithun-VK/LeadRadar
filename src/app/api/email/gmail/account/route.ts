/**
 * DELETE /api/email/gmail/account — disconnect the mailbox.
 *
 * Deletes the stored grant, which stops all sending immediately. It does NOT
 * revoke the grant at Google: that is the user's own action to take in their
 * Google security settings, and the UI says so. Silently revoking on their behalf
 * would be surprising, and failing to revoke while implying we had would be worse.
 */
import { z } from 'zod';

import { AppError } from '@/lib/errors';
import { handler, resolveSession } from '@/modules/api/handler';
import { db } from '@/modules/database/client';
import { disconnectAccount } from '@/modules/email/gmail-account';

const querySchema = z.object({ id: z.string().min(1) }).strict();

export const DELETE = handler(
  async ({ tenant, query, logger }) => {
    const session = await resolveSession();

    if (session.role !== 'OWNER' && session.role !== 'ADMIN') {
      throw new AppError({
        code: 'FORBIDDEN',
        message: 'Only an owner or admin may disconnect the sending mailbox',
        safeMessage: 'You need admin access to disconnect the Gmail account.',
      });
    }

    /**
     * Running campaigns are paused rather than left pointing at a mailbox that
     * no longer exists. Leaving them RUNNING would mean every subsequent send
     * fails and retries, filling the dead-letter queue with noise.
     */
    const { count: paused } = await db().campaign.updateMany({
      where: { organizationId: tenant.organizationId, status: 'RUNNING' },
      data: { status: 'PAUSED' },
    });

    const disconnected = await disconnectAccount(tenant, query.id);

    logger.info({ disconnected, pausedCampaigns: paused }, 'Gmail account disconnected');

    return { disconnected, pausedCampaigns: paused };
  },
  { querySchema, auditAction: 'gmail.disconnect' },
);
