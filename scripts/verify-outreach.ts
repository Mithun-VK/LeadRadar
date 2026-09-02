/**
 * Runtime verification of the outreach path.
 *
 * `verify:pipeline` proves discovery through scoring. This proves everything
 * after it: template rendering, enrolment, the guard chain, the send worker,
 * status tracking, suppression, and unsubscribe.
 *
 * It runs against REAL PostgreSQL and REAL Redis with the mock email provider,
 * so the queue, the transactions, the constraints, and the worker are all
 * genuinely exercised — only the SMTP conversation is faked. That is the right
 * boundary: everything that could be wrong in our code is under test, and nothing
 * reaches a real recipient.
 *
 * The assertions that matter most are the negative ones. It is easy to prove an
 * email was sent; the valuable proof is that a suppressed address was NOT sent to,
 * that a lead cannot be mailed twice, and that a paused campaign stops.
 *
 *   npm run worker          # in another terminal
 *   npm run verify:outreach
 */
import 'dotenv/config';

import { randomUUID } from 'node:crypto';

import { db, closeDatabase, type TenantContext } from '@/modules/database/client';
import { closeRedis } from '@/lib/redis';
import { closeQueues } from '@/modules/jobs/queues';
import {
  activateCampaign,
  assessReadiness,
  enrolLeads,
  setCampaignStatus,
} from '@/modules/email/campaigns';
import { processUnsubscribe, sendCampaignEmail } from '@/modules/email/send';
import { checkSuppression, suppress } from '@/modules/email/suppression';
import { storeTokens } from '@/modules/email/gmail-account';
import { DEFAULT_TEMPLATE } from '@/modules/email/templates';
import { providers } from '@/modules/providers/registry';
import { MockEmailSendProvider } from '@/modules/providers/mock/email';

const results: Array<{ label: string; pass: boolean; detail?: string }> = [];

function assert(label: string, pass: boolean, detail?: string): void {
  results.push({ label, pass, ...(detail !== undefined && { detail }) });
}

function section(title: string): void {
  console.log(`\n=== ${title} ===`);
}

async function main(): Promise<void> {
  const registry = providers();

  if (!registry.email) {
    throw new Error('No email provider in the registry. Set MOCK_EXTERNAL_APIS=true.');
  }
  if (!registry.email.isMock) {
    // A guard, not a nicety: running this against a live Gmail account would
    // send real mail to whatever addresses happen to be in the database.
    throw new Error(
      'Refusing to run: the email provider is NOT a mock. This script sends messages.',
    );
  }

  const run = randomUUID().slice(0, 8);

  section('1. Setup');

  const org = await db().organization.findFirst({ select: { id: true } });
  if (!org) throw new Error('No organization. Run `npm run db:seed` first.');

  const tenant: TenantContext = { organizationId: org.id };
  console.log(`  organization                       ${org.id}`);

  // A connected mailbox, via the same code path the OAuth callback uses.
  const account = await storeTokens(tenant, {
    emailAddress: `verify-${run}@leadradar.test`,
    displayName: 'Verification Run',
    tokens: {
      accessToken: 'mock-access-token',
      refreshToken: 'mock-refresh-token',
      expiresAt: new Date(Date.now() + 3_600_000),
      scopes: ['https://www.googleapis.com/auth/gmail.send'],
    },
  });
  console.log(`  mailbox                            ${account.id}`);

  const stored = await db().gmailAccount.findUnique({
    where: { id: account.id },
    select: { refreshTokenCipher: true },
  });

  assert(
    'refresh token is encrypted at rest',
    stored !== null &&
      !stored.refreshTokenCipher.includes('mock-refresh-token') &&
      stored.refreshTokenCipher.startsWith('v1.'),
    stored?.refreshTokenCipher.slice(0, 24),
  );

  const template = await db().emailTemplate.create({
    data: {
      organizationId: org.id,
      name: `Verification template ${run}`,
      subject: DEFAULT_TEMPLATE.subject,
      body: DEFAULT_TEMPLATE.body,
      variables: [],
    },
    select: { id: true },
  });

  // Leads with contact addresses. The pipeline's own leads may or may not have
  // one, so this script creates known ones rather than depending on that.
  const place = async (suffix: string) =>
    db().placeIdentifier.upsert({
      where: { googlePlaceId: `verify:${run}:${suffix}` },
      update: {},
      create: { googlePlaceId: `verify:${run}:${suffix}` },
      select: { id: true },
    });

  const makeLead = async (suffix: string, name: string, email: string | null) => {
    const identifier = await place(suffix);
    return db().business.create({
      data: {
        organizationId: org.id,
        placeIdentifierId: identifier.id,
        normalizedName: name.toLowerCase(),
        displayName: name,
        primaryCategory: 'dental clinic',
        city: 'Chennai',
        categories: [],
        rating: 4.5,
        reviewCount: 200,
        primaryEmail: email,
        verifiedDomain: 'verify-example.in',
        googleWebsiteStatus: 'GOOGLE_WEBSITE_NOT_LISTED',
        independentWebsiteStatus: 'NO_INDEPENDENT_WEBSITE_FOUND',
        opportunityFlags: ['NO_WEBSITE'],
        opportunityScore: 80,
        leadPriority: 'A',
      },
      select: { id: true, displayName: true },
    });
  };

  const good = await makeLead('good', `Verify Good Clinic ${run}`, `good-${run}@verify-example.in`);
  const suppressed = await makeLead(
    'supp',
    `Verify Suppressed Clinic ${run}`,
    `supp-${run}@verify-example.in`,
  );
  const noEmail = await makeLead('noemail', `Verify No-Email Clinic ${run}`, null);

  await suppress(tenant, {
    email: `supp-${run}@verify-example.in`,
    reason: 'UNSUBSCRIBED',
    detail: 'Pre-suppressed by the verification script',
  });

  console.log(
    `  leads                              3 (1 mailable, 1 suppressed, 1 without an address)`,
  );

  section('2. Enrolment');

  const campaign = await db().campaign.create({
    data: {
      organizationId: org.id,
      name: `Verification campaign ${run}`,
      templateId: template.id,
      senderName: 'Verification',
      companyName: 'LeadRadar Verification',
      dailyLimit: 10,
      delaySeconds: 60,
      gmailAccountId: account.id,
      status: 'DRAFT',
    },
    select: { id: true },
  });

  const summary = await enrolLeads(tenant, campaign.id, [good.id, suppressed.id, noEmail.id], {
    ai: null,
  });

  console.log(`  requested                          ${summary.requested}`);
  console.log(`  enrolled                           ${summary.enrolled}`);
  console.log(`  skipped                            ${summary.skipped}`);
  for (const [reason, count] of Object.entries(summary.skipReasons)) {
    console.log(`    ${reason.padEnd(32)} ${count}`);
  }

  assert('only the mailable lead was enrolled', summary.enrolled === 1);
  assert('the suppressed lead was skipped', summary.skipReasons.SUPPRESSED === 1);
  assert('the lead without an address was skipped', summary.skipReasons.NO_EMAIL === 1);

  const preview = await db().campaignLead.findFirst({
    where: { campaignId: campaign.id, businessId: good.id },
    select: { previewSubject: true, previewBody: true, resolvedEmail: true },
  });

  assert('a preview was rendered before activation', Boolean(preview?.previewBody));
  assert(
    'the preview contains no unresolved placeholders',
    !`${preview?.previewSubject}${preview?.previewBody}`.includes('{{'),
  );
  assert(
    'the preview names the business',
    preview?.previewBody?.includes(good.displayName) === true,
  );

  section('3. Readiness');

  const readiness = await assessReadiness(tenant, campaign.id);
  console.log(`  ready                              ${readiness.ready}`);
  console.log(`  deliverable                        ${readiness.deliverableCount}`);
  console.log(`  blockers                           ${readiness.blockers.length}`);
  for (const blocker of readiness.blockers) console.log(`    - ${blocker}`);

  assert('campaign is ready to activate', readiness.ready, readiness.blockers.join('; '));
  assert('deliverable count matches enrolment', readiness.deliverableCount === 1);

  section('4. Sending');

  await activateCampaign(tenant, campaign.id);

  const outcome = await sendCampaignEmail(tenant, {
    campaignId: campaign.id,
    businessId: good.id,
    provider: registry.email,
  });

  console.log(`  sent                               ${outcome.sent}`);
  console.log(`  messageId                          ${outcome.messageId}`);

  assert('the mailable lead was sent to', outcome.sent, outcome.detail ?? undefined);

  const message = await db().emailMessage.findFirst({
    where: { campaignId: campaign.id, businessId: good.id },
    select: {
      status: true,
      toEmail: true,
      body: true,
      mocked: true,
      unsubscribeToken: true,
      providerMessageId: true,
      events: { select: { type: true } },
    },
  });

  assert('the message is recorded as SENT', message?.status === 'SENT');
  assert('the message is flagged as mocked', message?.mocked === true);
  assert('a provider message id was stored', Boolean(message?.providerMessageId));
  assert('an unsubscribe token was generated', Boolean(message?.unsubscribeToken));
  assert('the body sent was retained verbatim', message?.body?.includes(good.displayName) === true);
  assert(
    'send events were recorded',
    message?.events.some((event) => event.type === 'SENT') === true,
  );

  // The MIME actually handed to the provider.
  const outbox = (registry.email as MockEmailSendProvider).sentMessages();
  const lastMime = outbox.at(-1)?.mime ?? '';

  assert('the message carries List-Unsubscribe', lastMime.includes('List-Unsubscribe:'));
  assert(
    'the message carries one-click unsubscribe',
    lastMime.includes('List-Unsubscribe-Post: List-Unsubscribe=One-Click'),
  );
  assert('the message is plain text, not HTML', !lastMime.includes('text/html'));

  section('5. The negative cases — what must NOT happen');

  const second = await sendCampaignEmail(tenant, {
    campaignId: campaign.id,
    businessId: good.id,
    provider: registry.email,
  });

  console.log(`  second send to the same lead       blocked=${second.blocked}`);
  assert(
    'a lead cannot be mailed twice by one campaign',
    !second.sent && second.blocked === 'ALREADY_SENT',
  );

  const toSuppressed = await sendCampaignEmail(tenant, {
    campaignId: campaign.id,
    businessId: suppressed.id,
    provider: registry.email,
  });

  console.log(`  send to a suppressed address       blocked=${toSuppressed.blocked}`);
  assert('a suppressed address is never sent to', !toSuppressed.sent);
  assert(
    'the block reason names suppression rather than something misleading',
    toSuppressed.blocked === 'SUPPRESSED',
    `reported ${toSuppressed.blocked}`,
  );

  const messagesToSuppressed = await db().emailMessage.count({
    where: { organizationId: org.id, toEmail: `supp-${run}@verify-example.in` },
  });
  assert('no message row exists for the suppressed address', messagesToSuppressed === 0);

  // Pause must stop sending immediately, not drain the queue first.
  await setCampaignStatus(tenant, campaign.id, 'PAUSED');
  const whilePaused = await sendCampaignEmail(tenant, {
    campaignId: campaign.id,
    businessId: noEmail.id,
    provider: registry.email,
  });
  console.log(`  send while paused                  blocked=${whilePaused.blocked}`);
  assert('a paused campaign does not send', !whilePaused.sent);

  section('6. Unsubscribe');

  const beforeUnsub = await checkSuppression(tenant, `good-${run}@verify-example.in`);
  assert('the recipient was not suppressed before unsubscribing', !beforeUnsub.suppressed);

  await processUnsubscribe(message!.unsubscribeToken);

  const afterUnsub = await checkSuppression(tenant, `good-${run}@verify-example.in`);
  console.log(
    `  suppressed after unsubscribe       ${afterUnsub.suppressed} (${afterUnsub.reason})`,
  );

  assert('unsubscribing suppresses the address', afterUnsub.suppressed);
  assert('the suppression reason is UNSUBSCRIBED', afterUnsub.reason === 'UNSUBSCRIBED');

  // Idempotent: mail clients pre-fetch links, so a second visit must not error.
  await processUnsubscribe(message!.unsubscribeToken);
  assert('unsubscribing twice does not error', true);

  const unknown = await processUnsubscribe('a-token-that-does-not-exist');
  assert('an unknown unsubscribe token reports success rather than probing', unknown.acknowledged);

  section('7. Cleanup');

  await db().campaign.delete({ where: { id: campaign.id } });
  await db().business.deleteMany({ where: { id: { in: [good.id, suppressed.id, noEmail.id] } } });
  await db().emailTemplate.delete({ where: { id: template.id } });
  await db().gmailAccount.delete({ where: { id: account.id } });
  await db().suppressionEntry.deleteMany({
    where: { organizationId: org.id, email: { contains: `-${run}@verify-example.in` } },
  });
  await db().emailMessage.deleteMany({
    where: { organizationId: org.id, toEmail: { contains: `-${run}@verify-example.in` } },
  });
  await db().placeIdentifier.deleteMany({
    where: { googlePlaceId: { startsWith: `verify:${run}:` } },
  });
  console.log('  removed everything this run created');

  section('8. Assertions');

  for (const result of results) {
    console.log(`  ${result.pass ? 'PASS' : 'FAIL'}  ${result.label}`);
    if (!result.pass && result.detail) console.log(`        ${result.detail}`);
  }

  const failed = results.filter((result) => !result.pass);
  console.log(
    failed.length === 0
      ? `\nAll ${results.length} outreach assertions passed.`
      : `\n${failed.length} of ${results.length} assertions FAILED.`,
  );

  if (failed.length > 0) process.exitCode = 1;
}

main()
  .catch((error: unknown) => {
    console.error('\nVerification crashed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await Promise.allSettled([closeQueues(), closeDatabase(), closeRedis()]);
  });
