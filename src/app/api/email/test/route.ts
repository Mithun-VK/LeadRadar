/**
 * POST /api/email/test — sends one message to the operator's own address.
 *
 * Deliberately restricted to the CONNECTED MAILBOX'S OWN ADDRESS, with no
 * recipient parameter at all. An arbitrary-recipient test endpoint is an open
 * relay wearing a friendly name: anyone with an account could use the operator's
 * Gmail to send anything to anyone. Removing the parameter removes the abuse.
 *
 * The test also proves the whole path — token refresh, MIME composition, the
 * provider call — which is exactly what an operator needs before activating a
 * campaign.
 */
import { z } from 'zod';

import { randomToken } from '@/lib/crypto';
import { env } from '@/lib/env';
import { AppError } from '@/lib/errors';
import { handler } from '@/modules/api/handler';
import { db } from '@/modules/database/client';
import { accessTokenFor } from '@/modules/email/gmail-account';
import { buildMimeMessage, generateMessageId } from '@/modules/email/mime';
import { providers } from '@/modules/providers/registry';

const bodySchema = z
  .object({
    /** Optional note, so an operator can tell several tests apart. */
    note: z.string().trim().max(200).optional(),
  })
  .strict();

export const POST = handler(
  async ({ tenant, body, logger }) => {
    const config = env();
    const registry = providers();

    if (!registry.email) {
      throw new AppError({
        code: 'CONFIG_INVALID',
        message: 'Email sending is not enabled on this server',
        safeMessage: 'Outbound email is disabled on this server.',
      });
    }

    const account = await db().gmailAccount.findFirst({
      where: { organizationId: tenant.organizationId, invalidatedAt: null },
      select: { id: true, emailAddress: true, displayName: true },
    });

    if (!account) {
      throw new AppError({
        code: 'NOT_FOUND',
        message: 'No connected Gmail account',
        safeMessage: 'Connect a Gmail account before sending a test.',
      });
    }

    const token = randomToken(24);
    const unsubscribeUrl = `${config.APP_PUBLIC_URL.replace(/\/+$/, '')}/unsubscribe/${token}`;

    const mime = buildMimeMessage({
      // The only permitted recipient: the mailbox that was connected.
      to: account.emailAddress,
      from: account.emailAddress,
      fromName: account.displayName,
      subject: 'LeadRadar test message',
      body:
        'This is a test message from LeadRadar, sent to confirm that your Gmail ' +
        'connection works.\n\n' +
        (body.note ? `Note: ${body.note}\n\n` : '') +
        'If you received this, campaigns will be able to send from this address.',
      replyTo: account.emailAddress,
      unsubscribeUrl,
      messageId: generateMessageId(randomToken(12), new URL(config.APP_PUBLIC_URL).hostname),
    });

    const accessToken = await accessTokenFor(account.id, registry.email);
    const result = await registry.email.send({
      accessToken,
      mime,
      to: account.emailAddress,
    });

    if (!result.ok) throw result.error;

    /**
     * Recorded like any other message, with no campaign attached. A test that
     * left no trace would make the sent-count reconciliation wrong, and the
     * mailbox's daily counter must include it because Gmail's quota certainly
     * does.
     */
    await db().emailMessage.create({
      data: {
        organizationId: tenant.organizationId,
        gmailAccountId: account.id,
        toEmail: account.emailAddress,
        fromEmail: account.emailAddress,
        subject: 'LeadRadar test message',
        body: 'Test message',
        status: 'SENT',
        sentAt: new Date(),
        providerMessageId: result.value.providerMessageId,
        providerThreadId: result.value.providerThreadId,
        unsubscribeToken: token,
        mocked: registry.email.isMock,
        attempts: 1,
        events: { create: { type: 'SENT', detail: 'Test message' } },
      },
    });

    logger.info({ accountId: account.id }, 'Test email sent');

    return {
      sent: true,
      to: account.emailAddress,
      mocked: registry.email.isMock,
      message: registry.email.isMock
        ? 'Mock mode: the message was composed and accepted by the in-process sender, and reached nobody.'
        : `A test message was sent to ${account.emailAddress}.`,
    };
  },
  {
    bodySchema,
    auditAction: 'email.test',
    // Tight: a test endpoint that can be hammered is a way to burn the mailbox's
    // daily Gmail quota.
    rateLimit: { capacity: 5, refillPerSecond: 0.02 },
  },
);
