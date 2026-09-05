/**
 * Gmail live certification.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS FOR
 * ---------------------------------------------------------------------------
 *
 * Every automated test in this repository exercises Gmail against a mock this
 * repository also wrote. That proves our code is internally consistent. It
 * proves nothing whatsoever about Google.
 *
 * This script is the other half: it drives the real Gmail API with real
 * credentials and reports what actually happened. It is the only thing in the
 * codebase permitted to say LIVE GMAIL VERIFIED.
 *
 * ---------------------------------------------------------------------------
 * THE ONE RULE
 * ---------------------------------------------------------------------------
 *
 * It REFUSES to run against the mock provider. Not "warns" — refuses, and exits
 * non-zero. A certification tool that can be satisfied by a mock is worse than
 * no certification tool, because it converts "we have not tested this" into "we
 * tested it and it passed", which is a false statement that people then plan
 * around.
 *
 * Every line it prints is labelled with what was actually proven.
 *
 *   npm run certify:gmail            # steps 1-5: connection and send
 *   npm run certify:gmail -- --sync  # step 6-8: reply detection (after replying)
 */
import 'dotenv/config';

import { randomToken } from '@/lib/crypto';
import { env } from '@/lib/env';
import { db, closeDatabase, type TenantContext } from '@/modules/database/client';
import { closeRedis } from '@/lib/redis';
import { closeQueues } from '@/modules/jobs/queues';
import { accessTokenFor, getConnectedAccount } from '@/modules/email/gmail-account';
import { gmailHealth } from '@/modules/email/gmail-health';
import { syncInbox } from '@/modules/email/inbox-sync';
import { buildMimeMessage, generateMessageId } from '@/modules/email/mime';
import { providers } from '@/modules/providers/registry';

type Verdict = 'LIVE' | 'FAIL' | 'SKIP' | 'INFO';

const findings: Array<{ verdict: Verdict; label: string; detail?: string }> = [];

function record(verdict: Verdict, label: string, detail?: string): void {
  findings.push({ verdict, label, ...(detail !== undefined && { detail }) });
  const tag =
    verdict === 'LIVE'
      ? 'LIVE GMAIL VERIFIED'
      : verdict === 'FAIL'
        ? 'FAILED            '
        : verdict === 'SKIP'
          ? 'SKIPPED           '
          : 'INFO              ';
  console.log(`  [${tag}] ${label}${detail ? ` — ${detail}` : ''}`);
}

function section(title: string): void {
  console.log(`\n=== ${title} ===`);
}

async function main(): Promise<void> {
  const config = env();
  const registry = providers();
  const syncOnly = process.argv.includes('--sync');

  section('0. Preconditions');

  /**
   * The refusal. Checked before anything else and before any database work.
   */
  if (!registry.email) {
    console.error(
      '\nREFUSING: no email provider is configured.\n' +
        'Set EMAIL_SENDING_ENABLED=true and configure the Google OAuth client.',
    );
    process.exitCode = 1;
    return;
  }

  if (registry.email.isMock) {
    console.error(
      '\nREFUSING TO CERTIFY: the email provider is a MOCK.\n\n' +
        'This script exists to prove the real Gmail API works. Running it against\n' +
        'the mock would produce a green report that means nothing.\n\n' +
        'Set MOCK_EXTERNAL_APIS=false and supply real Google credentials.\n' +
        'For mock-mode coverage use `npm run verify:outreach` instead — it is\n' +
        'honest about being a mock.',
    );
    process.exitCode = 1;
    return;
  }

  record('INFO', 'provider is live', registry.email.name);
  record('INFO', 'sending enabled', String(config.EMAIL_SENDING_ENABLED));

  const org = await db().organization.findFirst({ select: { id: true } });
  if (!org) throw new Error('No organization. Run `npm run db:seed` first.');
  const tenant: TenantContext = { organizationId: org.id };

  // -------------------------------------------------------------------------
  section('1. Connected mailbox');

  const account = await getConnectedAccount(tenant);

  if (!account) {
    record('FAIL', 'a Gmail account is connected', 'none found');
    console.error(
      '\nConnect one first: Dashboard → Email → Connect Gmail.\n' +
        'See docs/GMAIL_SETUP.md.',
    );
    process.exitCode = 1;
    return;
  }

  record('LIVE', 'a Gmail account is connected', account.emailAddress);
  record(
    account.healthy ? 'LIVE' : 'FAIL',
    'the stored grant is valid',
    account.healthy ? undefined : `invalidated: ${account.invalidatedCode ?? 'unknown'}`,
  );

  const hasSend = account.grantedScopes.some((s) => s.endsWith('/gmail.send'));
  record(hasSend ? 'LIVE' : 'FAIL', 'the send scope was granted');

  const hasRead = account.grantedScopes.some(
    (s) => s.endsWith('/gmail.readonly') || s.endsWith('/gmail.modify'),
  );
  record(
    hasRead ? 'LIVE' : 'SKIP',
    'a read scope was granted (needed for reply detection)',
    hasRead ? undefined : 'reconnect with read access to certify replies',
  );

  // -------------------------------------------------------------------------
  section('2. Token exchange against Google');

  let accessToken: string;
  try {
    accessToken = await accessTokenFor(account.id, registry.email);
    // Proves the refresh token is genuinely accepted by Google right now — not
    // merely that a decryptable string is stored.
    record('LIVE', 'Google issued an access token from the stored refresh token');
  } catch (error) {
    record('FAIL', 'token refresh', (error as Error).message);
    process.exitCode = 1;
    return;
  }

  const profile = await registry.email.getProfile(accessToken);
  if (profile.ok) {
    record('LIVE', 'Gmail profile reachable', profile.value.emailAddress);
    record(
      profile.value.emailAddress.toLowerCase() === account.emailAddress.toLowerCase()
        ? 'LIVE'
        : 'FAIL',
      'the token belongs to the mailbox we recorded',
    );
  } else {
    record('FAIL', 'Gmail profile fetch', profile.error.code);
  }

  // -------------------------------------------------------------------------
  if (!syncOnly) {
    section('3. Real send');

    const token = randomToken(24);
    const marker = `LR-CERT-${token.slice(0, 10)}`;
    const messageIdHeader = generateMessageId(
      randomToken(12),
      new URL(config.APP_PUBLIC_URL).hostname,
    );

    /**
     * Sent to the connected mailbox's own address, never anywhere else. A
     * certification tool that can email an arbitrary recipient is a way to send
     * mail to a stranger by typo.
     */
    const mime = buildMimeMessage({
      to: account.emailAddress,
      from: account.emailAddress,
      fromName: account.displayName,
      subject: `${marker} LeadRadar live certification`,
      body:
        'This is a live Gmail certification message from LeadRadar.\n\n' +
        `Marker: ${marker}\n\n` +
        'To certify reply detection, REPLY to this message from a different\n' +
        'mailbox you control, then run:\n\n' +
        '    npm run certify:gmail -- --sync\n',
      replyTo: account.emailAddress,
      unsubscribeUrl: `${config.APP_PUBLIC_URL.replace(/\/+$/, '')}/unsubscribe/${token}`,
      messageId: messageIdHeader,
    });

    const sent = await registry.email.send({ accessToken, mime, to: account.emailAddress });

    if (!sent.ok) {
      record('FAIL', 'Gmail accepted the message', sent.error.code);
      process.exitCode = 1;
    } else {
      record('LIVE', 'Gmail accepted the message');
      record('LIVE', 'a provider message id was returned', sent.value.providerMessageId);
      record(
        sent.value.providerThreadId ? 'LIVE' : 'INFO',
        'a provider thread id was returned',
        sent.value.providerThreadId ?? 'none (reply matching will fall back to headers)',
      );

      // Persisted so the reply, when it arrives, can be matched back to it by
      // In-Reply-To — exactly as a campaign message would be.
      await db().emailMessage.create({
        data: {
          organizationId: org.id,
          gmailAccountId: account.id,
          toEmail: account.emailAddress,
          fromEmail: account.emailAddress,
          subject: `${marker} LeadRadar live certification`,
          body: 'Live certification message.',
          status: 'SENT',
          sentAt: new Date(),
          providerMessageId: sent.value.providerMessageId,
          providerThreadId: sent.value.providerThreadId,
          messageIdHeader,
          unsubscribeToken: token,
          mocked: false,
          attempts: 1,
        },
      });
      record('LIVE', 'the send was persisted with its provider identifiers');

      console.log(
        `\n  Check the Sent folder of ${account.emailAddress} for "${marker}".\n` +
          '  The Sent folder is the real proof — an API 200 only means Google\n' +
          '  accepted the request.\n\n' +
          '  Then reply from another mailbox and run:\n' +
          '      npm run certify:gmail -- --sync',
      );
    }
  }

  // -------------------------------------------------------------------------
  if (syncOnly) {
    section('4. Inbox sync and reply detection');

    if (!hasRead) {
      record('SKIP', 'inbox sync', 'no read scope granted');
    } else {
      const before = await db().emailConversation.count({
        where: { organizationId: org.id, direction: 'INBOUND' },
      });

      const result = await syncInbox(tenant, registry.email, { maxMessages: 50 });

      record('LIVE', 'Gmail inbox was read', `${result.fetched} message(s) in the window`);
      record(
        result.skippedNoScope ? 'FAIL' : 'LIVE',
        'the granted scope permitted the read',
      );

      const after = await db().emailConversation.count({
        where: { organizationId: org.id, direction: 'INBOUND' },
      });

      record(
        result.matched > 0 ? 'LIVE' : 'INFO',
        'a message was matched to a lead or a sent message',
        `matched=${result.matched}, stored=${after - before}, replies=${result.replies}`,
      );

      if (result.matched === 0) {
        console.log(
          '\n  No match yet. That is expected if you have not replied to the\n' +
            '  certification message, or if the reply has not arrived yet.\n' +
            '  Reply from a DIFFERENT mailbox, wait a moment, and re-run.',
        );
      }

      // Idempotency, proven against live data: a second sync of the same window
      // must not duplicate anything.
      const second = await syncInbox(tenant, registry.email, { maxMessages: 50 });
      const afterSecond = await db().emailConversation.count({
        where: { organizationId: org.id, direction: 'INBOUND' },
      });

      record(
        afterSecond === after ? 'LIVE' : 'FAIL',
        're-syncing the same window creates no duplicates',
        `before=${after}, after=${afterSecond}, refetched=${second.fetched}`,
      );
    }
  }

  // -------------------------------------------------------------------------
  section('5. Provider health after the run');

  const health = await gmailHealth(tenant);
  record(
    health.state === 'HEALTHY' ? 'LIVE' : 'INFO',
    `provider state is ${health.state}`,
    health.summary,
  );
  record('INFO', 'last successful auth', health.lastAuthAt?.toISOString() ?? 'never');
  record('INFO', 'last successful send', health.lastSendAt?.toISOString() ?? 'never');
  record('INFO', 'last successful sync', health.lastSyncAt?.toISOString() ?? 'never');
  record('INFO', 'consecutive failures', String(health.consecutiveFailures));
}

main()
  .catch((error) => {
    console.error('\nCertification crashed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    const failed = findings.filter((f) => f.verdict === 'FAIL');
    const live = findings.filter((f) => f.verdict === 'LIVE');
    const skipped = findings.filter((f) => f.verdict === 'SKIP');

    console.log('\n' + '='.repeat(66));
    if (failed.length > 0) {
      console.log(`GMAIL CERTIFICATION FAILED — ${failed.length} check(s) did not pass.`);
      for (const f of failed) console.log(`  - ${f.label}${f.detail ? `: ${f.detail}` : ''}`);
      process.exitCode = 1;
    } else if (live.length === 0) {
      console.log('NOTHING WAS CERTIFIED. No live checks ran.');
      process.exitCode = 1;
    } else {
      console.log(`LIVE GMAIL VERIFIED — ${live.length} check(s) passed against Google.`);
      if (skipped.length > 0) {
        console.log(`${skipped.length} check(s) skipped:`);
        for (const s of skipped) console.log(`  - ${s.label}${s.detail ? `: ${s.detail}` : ''}`);
      }
      console.log(
        '\nThis certifies ONLY the checks listed above, on this deployment, now.\n' +
          'It does not certify deliverability, inbox placement, or reputation.',
      );
    }
    console.log('='.repeat(66));

    await Promise.allSettled([closeQueues(), closeDatabase(), closeRedis()]);
  });
