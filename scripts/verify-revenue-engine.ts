/**
 * End-to-end verification of the revenue engine.
 *
 * `verify:pipeline` proves discovery → scoring. `verify:outreach` proves
 * templates → send → suppression. This proves the rest: reply detection, intent
 * classification, automatic campaign stopping, the CRM pipeline, deals,
 * meetings, proposals, and revenue analytics.
 *
 * Runs against REAL PostgreSQL and REAL Redis with the MOCK email provider, so
 * every transaction, constraint, and state machine is genuinely exercised and no
 * message reaches a real person. The script refuses to run against a live sender.
 *
 * The assertions that matter most are the negative ones. Proving a deal can be
 * marked won is easy; proving that a reply STOPS a campaign, that an
 * AI-inferred unsubscribe does NOT permanently suppress, and that an unvalued
 * deal is NOT counted as zero revenue is what this exists for.
 *
 *   npm run verify:revenue
 */
import 'dotenv/config';

import { randomUUID } from 'node:crypto';

import { closeDatabase, db, type TenantContext } from '@/modules/database/client';
import { closeRedis } from '@/lib/redis';
import { closeQueues } from '@/modules/jobs/queues';
import { providers } from '@/modules/providers/registry';
import { MockEmailSendProvider } from '@/modules/providers/mock/email';

import { changeLeadStatus, applyLeadEvent } from '@/modules/crm/leads';
import { canTransition } from '@/modules/crm/lead-status';
import { createDeal, moveDealStage, pipelineTotals, toMinorUnits } from '@/modules/crm/deals';
import { createMeeting } from '@/modules/crm/meetings';
import { createProposal, updateProposal } from '@/modules/crm/proposals';
import { listActivitiesForLead } from '@/modules/crm/activities';
import { buildWorkQueue } from '@/modules/crm/work-queue';
import { recommendServices, ensureDefaultOfferings } from '@/modules/crm/service-offerings';
import { syncInbox } from '@/modules/email/inbox-sync';
import { storeTokens } from '@/modules/email/gmail-account';
import { classifyDeterministic, actionsFor } from '@/modules/email/intent';
import { checkSuppression } from '@/modules/email/suppression';
import { revenueMetrics } from '@/modules/analytics/revenue';
import { deriveOpportunityFlags } from '@/modules/scoring/flags';

const results: Array<{ label: string; pass: boolean; detail?: string }> = [];

function assert(label: string, pass: boolean, detail?: string): void {
  results.push({ label, pass, ...(detail !== undefined && { detail }) });
}

function section(title: string): void {
  console.log(`\n=== ${title} ===`);
}

async function main(): Promise<void> {
  const registry = providers();

  if (!registry.email) throw new Error('No email provider. Set MOCK_EXTERNAL_APIS=true.');
  if (!registry.email.isMock) {
    throw new Error('Refusing to run: the email provider is NOT a mock. This script sends messages.');
  }

  const mock = registry.email as MockEmailSendProvider;
  const run = randomUUID().slice(0, 8);

  const org = await db().organization.findFirst({ select: { id: true } });
  if (!org) throw new Error('No organization. Run `npm run db:seed` first.');

  const tenant: TenantContext = { organizationId: org.id };
  const email = `revenue-${run}@verify-example.in`;

  section('1. Lead discovered, enriched, and scored');

  const place = await db().placeIdentifier.create({
    data: { googlePlaceId: `revenue:${run}` },
    select: { id: true },
  });

  const lead = await db().business.create({
    data: {
      organizationId: org.id,
      placeIdentifierId: place.id,
      normalizedName: `verify revenue clinic ${run}`,
      displayName: `Verify Revenue Clinic ${run}`,
      primaryCategory: 'dental clinic',
      city: 'Chennai',
      categories: [],
      rating: 4.6,
      reviewCount: 240,
      primaryEmail: email,
      googleWebsiteStatus: 'GOOGLE_WEBSITE_NOT_LISTED',
      independentWebsiteStatus: 'NO_INDEPENDENT_WEBSITE_FOUND',
      opportunityFlags: ['NO_WEBSITE', 'NO_SOCIAL_MEDIA'],
      opportunityScore: 84,
      leadPriority: 'A',
      websiteQualityScore: null,
      source: 'WEB_DISCOVERY',
      enrichedAt: new Date(),
    },
    select: { id: true, leadStatus: true, displayName: true },
  });

  console.log(`  lead                               ${lead.id}`);
  assert('a discovered lead starts at NEW', lead.leadStatus === 'NEW', lead.leadStatus);

  section('2. Service recommendation from detected evidence');

  await ensureDefaultOfferings(tenant);

  const flags = deriveOpportunityFlags({
    googleWebsiteStatus: 'GOOGLE_WEBSITE_NOT_LISTED',
    independentWebsiteStatus: 'NO_INDEPENDENT_WEBSITE_FOUND',
    observations: null,
    seoScore: null,
    mobileScore: null,
    hasEmail: true,
    socialPlatformCount: 0,
    rating: 4.6,
    reviewCount: 240,
  });

  const recommendation = await recommendServices(tenant, flags);
  console.log(`  primary service                    ${recommendation.primaryService?.name}`);
  console.log(`  reasoning lines                    ${recommendation.reasoning.length}`);

  assert('a service is recommended', recommendation.primaryService !== null);
  assert(
    'the recommendation is website development for a lead with no website',
    recommendation.primaryService?.opportunity === 'WEBSITE_DEVELOPMENT',
    recommendation.primaryService?.opportunity,
  );
  assert('the reasoning cites detected evidence', recommendation.reasoning.length > 0);
  assert('evidence is not claimed to be insufficient', !recommendation.insufficientEvidence);

  const emptyRecommendation = await recommendServices(tenant, []);
  assert(
    'no evidence yields no recommendation rather than a guess',
    emptyRecommendation.insufficientEvidence && emptyRecommendation.primaryService === null,
  );

  section('3. Qualify and contact');

  await changeLeadStatus(tenant, {
    businessId: lead.id,
    to: 'QUALIFIED',
    reason: 'Score above threshold with a contact address',
    source: 'USER',
  });

  await applyLeadEvent(tenant, lead.id, 'EMAIL_SENT', 'Campaign email sent', 'SYSTEM');

  const afterContact = await db().business.findUnique({
    where: { id: lead.id },
    select: { leadStatus: true, firstTouchAt: true },
  });

  console.log(`  status                             ${afterContact?.leadStatus}`);
  assert('the lead reaches CONTACTED', afterContact?.leadStatus === 'CONTACTED');

  const history = await db().leadStatusHistory.findMany({
    where: { businessId: lead.id },
    orderBy: { createdAt: 'asc' },
  });

  console.log(`  status history rows                ${history.length}`);
  assert('every status change is recorded', history.length === 2, `${history.length} rows`);
  assert('history records who or what caused it', history.every((row) => row.source !== null));

  section('4. Campaign, send, and reply detection');

  const template = await db().emailTemplate.create({
    data: {
      organizationId: org.id,
      name: `Revenue verification ${run}`,
      subject: 'Quick note about {{business_name}}',
      body: 'Hi {{business_name}} team,\n\n{{sales_angle}}\n\nRegards,\n{{sender_name}}\n{{company_name}}',
      variables: [],
    },
    select: { id: true },
  });

  // Stored through the real path, so the token is genuinely encrypted and the
  // refresh/decrypt cycle is exercised rather than bypassed with a fake cipher.
  const stored = await storeTokens(tenant, {
    emailAddress: `sender-${run}@leadradar.test`,
    displayName: 'Revenue Verification',
    tokens: {
      accessToken: 'mock-access-token',
      refreshToken: 'mock-refresh-token',
      expiresAt: new Date(Date.now() + 3_600_000),
      scopes: [
        'https://www.googleapis.com/auth/gmail.send',
        'https://www.googleapis.com/auth/gmail.readonly',
      ],
    },
  });

  const account = (await db().gmailAccount.findUniqueOrThrow({
    where: { id: stored.id },
    select: { id: true, emailAddress: true, grantedScopes: true },
  }))!;

  assert(
    'the connected mailbox has the read scope needed for reply detection',
    account.grantedScopes.some((scope) => scope.endsWith('/gmail.readonly')),
  );

  const campaign = await db().campaign.create({
    data: {
      organizationId: org.id,
      name: `Revenue verification campaign ${run}`,
      templateId: template.id,
      gmailAccountId: account.id,
      senderName: 'Verification',
      companyName: 'LeadRadar',
      status: 'RUNNING',
      activatedAt: new Date(),
    },
    select: { id: true },
  });

  // An outbound message, as the send path would have written it.
  const outbound = await db().emailMessage.create({
    data: {
      organizationId: org.id,
      campaignId: campaign.id,
      businessId: lead.id,
      gmailAccountId: account.id,
      toEmail: email,
      fromEmail: account.emailAddress,
      subject: 'Quick note',
      body: 'Hello',
      status: 'SENT',
      sentAt: new Date(),
      providerThreadId: `thread-${run}`,
      messageIdHeader: `msg-${run}@leadradar.test`,
      unsubscribeToken: `tok-${run}`,
      mocked: true,
    },
    select: { id: true },
  });

  await db().campaignLead.create({
    data: {
      campaignId: campaign.id,
      businessId: lead.id,
      status: 'QUEUED',
      resolvedEmail: email,
      queuedAt: new Date(),
    },
  });

  // The prospect replies asking about price.
  mock.queueReply({
    fromEmail: email,
    toEmail: account.emailAddress,
    subject: 'Re: Quick note',
    body: 'Thanks for reaching out. This sounds interesting — how much would it cost?',
    threadId: `thread-${run}`,
    inReplyTo: `msg-${run}@leadradar.test`,
  });

  const sync = await syncInbox(tenant, registry.email, { ai: null });
  console.log(`  fetched / matched / replies        ${sync.fetched} / ${sync.matched} / ${sync.replies}`);

  assert('the reply was matched to the lead', sync.matched === 1, `matched ${sync.matched}`);
  assert('the reply was recorded as a reply', sync.replies === 1);

  const conversation = await db().emailConversation.findFirst({
    where: { organizationId: org.id, businessId: lead.id, direction: 'INBOUND' },
    include: { intent: true },
  });

  console.log(`  intent                             ${conversation?.intent?.intent}`);
  assert('the reply was stored', conversation !== null);
  assert(
    'the intent is PRICE_REQUEST',
    conversation?.intent?.intent === 'PRICE_REQUEST',
    conversation?.intent?.intent,
  );
  assert(
    'the classification is deterministic, not a model guess',
    conversation?.intent?.source === 'DETERMINISTIC',
  );
  assert('the stored body has an expiry set', conversation?.bodyExpiresAt !== null);

  section('5. The reply stopped the campaign');

  const enrolment = await db().campaignLead.findFirst({
    where: { campaignId: campaign.id, businessId: lead.id },
    select: { status: true },
  });

  console.log(`  enrolment status                   ${enrolment?.status}`);
  assert(
    'queued follow-ups were stopped',
    enrolment?.status === 'REPLIED',
    enrolment?.status,
  );

  const leadAfterReply = await db().business.findUnique({
    where: { id: lead.id },
    select: { leadStatus: true, lastReplyAt: true },
  });

  assert('the lead moved to REPLIED', leadAfterReply?.leadStatus === 'REPLIED');
  assert('the reply timestamp was recorded', leadAfterReply?.lastReplyAt !== null);

  const activities = await listActivitiesForLead(tenant, lead.id);
  const pricingTask = activities.find((activity) => /pricing/i.test(activity.title));

  console.log(`  activities raised                  ${activities.length}`);
  assert('a pricing task was raised for a human', pricingTask !== undefined);
  assert('the task was raised by the system', pricingTask?.createdBySystem === true);
  assert(
    'no price was sent automatically',
    mock.sentMessages().every((message) => !/₹|\bprice\b|\bcost\b/i.test(message.mime)),
  );

  section('6. Human-in-the-loop boundaries');

  const aiUnsubscribe = actionsFor({
    intent: 'UNSUBSCRIBE',
    confidence: 0.8,
    source: 'AI',
    reason: 'inferred',
    model: 'stub',
  });

  assert(
    'an AI-inferred unsubscribe does NOT permanently suppress',
    aiUnsubscribe.suppressPermanently === false && aiUnsubscribe.needsHumanReview,
  );

  const explicitUnsubscribe = classifyDeterministic({
    subject: null,
    body: 'Please remove me from your list.',
  });

  assert(
    'an explicit unsubscribe IS deterministic and does suppress',
    explicitUnsubscribe?.intent === 'UNSUBSCRIBE' &&
      actionsFor(explicitUnsubscribe).suppressPermanently,
  );

  const stillContactable = await checkSuppression(tenant, email);
  assert('the replying lead was not suppressed', !stillContactable.suppressed);

  section('7. Deal, meeting, proposal');

  const deal = await createDeal(tenant, {
    businessId: lead.id,
    name: 'Website development',
    stage: 'DISCOVERY',
    valueMinor: toMinorUnits(45_000),
    currency: 'INR',
  });

  console.log(`  deal                               ${deal.id} (${deal.valueMinor} paise)`);
  assert('a deal was created', deal.id !== undefined);
  assert('deal value is stored as integer minor units', deal.valueMinor === 4_500_000);
  assert(
    'the deal inherited campaign attribution',
    deal.sourceCampaignId === campaign.id,
    deal.sourceCampaignId ?? 'null',
  );

  await createMeeting(tenant, {
    businessId: lead.id,
    dealId: deal.id,
    title: 'Discovery call',
    scheduledAt: new Date(Date.now() + 2 * 86_400_000),
    meetingUrl: 'https://meet.example/abc',
  });

  const afterMeeting = await db().business.findUnique({
    where: { id: lead.id },
    select: { leadStatus: true },
  });

  assert('booking a meeting advances the lead', afterMeeting?.leadStatus === 'MEETING');

  const proposal = await createProposal(tenant, {
    businessId: lead.id,
    dealId: deal.id,
    title: 'Website development proposal',
    amountMinor: toMinorUnits(45_000),
    scope: [{ item: 'Five-page responsive website' }, { item: 'Contact form and booking' }],
    timeline: '4 weeks',
  });

  assert('a proposal is created as a DRAFT, never already sent', proposal.status === 'DRAFT');

  await updateProposal(tenant, proposal.id, { status: 'SENT' });

  const afterProposal = await db().business.findUnique({
    where: { id: lead.id },
    select: { leadStatus: true },
  });

  assert('sending a proposal advances the lead', afterProposal?.leadStatus === 'PROPOSAL');

  await updateProposal(tenant, proposal.id, { status: 'ACCEPTED' });

  const dealAfterAccept = await db().deal.findUnique({
    where: { id: deal.id },
    select: { stage: true },
  });

  assert(
    'accepting a proposal does NOT close the deal automatically',
    dealAfterAccept?.stage !== 'WON',
    dealAfterAccept?.stage,
  );

  section('8. Close and record revenue');

  await moveDealStage(tenant, { dealId: deal.id, to: 'NEGOTIATION', source: 'USER' });
  await moveDealStage(tenant, { dealId: deal.id, to: 'WON', reason: 'Client accepted', source: 'USER' });

  const wonDeal = await db().deal.findUnique({
    where: { id: deal.id },
    select: { stage: true, closedAt: true, probability: true },
  });

  assert('the deal is WON', wonDeal?.stage === 'WON');
  assert('the close date was stamped', wonDeal?.closedAt !== null);
  assert('probability moved to 100', wonDeal?.probability === 100);

  const wonLead = await db().business.findUnique({
    where: { id: lead.id },
    select: { leadStatus: true },
  });

  assert('the lead is WON', wonLead?.leadStatus === 'WON');

  const stageHistory = await db().dealStageHistory.findMany({ where: { dealId: deal.id } });
  console.log(`  deal stage history rows            ${stageHistory.length}`);
  assert('every deal stage change is recorded', stageHistory.length >= 4);

  section('9. Revenue analytics');

  // A second, unvalued won deal — the case that must NOT be counted as zero.
  const unvaluedLead = await db().business.create({
    data: {
      organizationId: org.id,
      placeIdentifierId: (
        await db().placeIdentifier.create({
          data: { googlePlaceId: `revenue-unvalued:${run}` },
          select: { id: true },
        })
      ).id,
      normalizedName: `unvalued ${run}`,
      displayName: `Unvalued Clinic ${run}`,
      categories: [],
      source: 'MANUAL',
      leadStatus: 'WON',
    },
    select: { id: true },
  });

  await createDeal(tenant, {
    businessId: unvaluedLead.id,
    name: 'Unvalued engagement',
    stage: 'WON',
    valueMinor: null,
  });

  const metrics = await revenueMetrics(tenant);

  console.log(`  revenue won (paise)                ${metrics.money.revenueWonMinor}`);
  console.log(`  unvalued won deals                 ${metrics.money.unvaluedWonDeals}`);
  console.log(`  reply rate                         ${metrics.rates.reply}`);

  assert(
    'revenue counts the valued won deal',
    metrics.money.revenueWonMinor >= 4_500_000,
    String(metrics.money.revenueWonMinor),
  );
  assert(
    'an unvalued deal is excluded and reported separately, not counted as zero',
    metrics.money.unvaluedWonDeals >= 1,
  );
  assert(
    'the unvalued caveat travels with the numbers',
    metrics.notes.unvalued !== null && /not counted as zero/i.test(metrics.notes.unvalued),
  );
  assert('the funnel has a WON stage', metrics.funnel.some((stage) => stage.key === 'won'));
  assert(
    'every conversion rate is a fraction or null, never a fabricated zero',
    Object.values(metrics.rates).every(
      (value) => value === null || (value >= 0 && value <= 1),
    ),
  );

  const totals = await pipelineTotals(tenant);
  const wonTotals = totals.find((total) => total.stage === 'WON');
  assert('pipeline totals report unvalued deals separately', (wonTotals?.unvaluedCount ?? 0) >= 1);

  section('10. Sales work queue');

  const queue = await buildWorkQueue(tenant);
  console.log(`  queue items                        ${queue.totalItems}`);

  assert('the work queue builds', queue.totalItems >= 0);
  assert(
    'a closed lead no longer appears as an unanswered reply',
    !queue.replies.some((item) => item.businessId === lead.id) &&
      !queue.priceRequests.some((item) => item.businessId === lead.id),
  );

  section('11. Invariants');

  assert(
    'an unsubscribed lead can never re-enter the funnel',
    !canTransition('UNSUBSCRIBED', 'CONTACTED') && !canTransition('UNSUBSCRIBED', 'WON'),
  );
  assert('a lead cannot reach WON without contact', !canTransition('NEW', 'WON'));

  section('12. Cleanup');

  await db().deal.deleteMany({ where: { businessId: { in: [lead.id, unvaluedLead.id] } } });
  await db().campaign.delete({ where: { id: campaign.id } });
  await db().emailTemplate.delete({ where: { id: template.id } });
  await db().gmailAccount.delete({ where: { id: account.id } });
  await db().business.deleteMany({ where: { id: { in: [lead.id, unvaluedLead.id] } } });
  await db().placeIdentifier.deleteMany({
    where: { googlePlaceId: { startsWith: `revenue` , contains: run } },
  });
  await db().emailConversation.deleteMany({ where: { organizationId: org.id, threadId: `thread-${run}` } });
  void outbound;
  mock.clear();
  console.log('  removed everything this run created');

  section('13. Assertions');

  for (const result of results) {
    console.log(`  ${result.pass ? 'PASS' : 'FAIL'}  ${result.label}`);
    if (!result.pass && result.detail) console.log(`        got: ${result.detail}`);
  }

  const failed = results.filter((result) => !result.pass);
  console.log(
    failed.length === 0
      ? `\nAll ${results.length} revenue-engine assertions passed.`
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
