/**
 * Scoring calibration report.
 *
 * Answers: does the lead score predict commercial outcomes, and is there enough
 * REAL evidence to say so?
 *
 * The second half of that question comes first. A reply rate computed from
 * eleven mock-provider sends looks identical to one computed from eleven
 * thousand real ones, and the difference is a quarter's planning.
 *
 * Distinct from `npm run calibrate`, which calibrates the COST funnel — how many
 * searches and scrapes per business. This one is about outcomes.
 *
 * It changes nothing. Recalibrating weights is a judgement about whether a
 * sample is representative, and that judgement belongs to a person reading these
 * numbers.
 *
 *   npm run calibrate:scoring
 */
import 'dotenv/config';

import { closeDatabase, db, type TenantContext } from '@/modules/database/client';
import { closeRedis } from '@/lib/redis';
import { calibrationReport } from '@/modules/analytics/calibration';
import {
  computeLift,
  dataSufficiency,
  revenuePerLead,
  segmentOutcomes,
} from '@/modules/analytics/intelligence';
import { formatMoney } from '@/modules/crm/deals';

function section(title: string): void {
  console.log(`\n${'='.repeat(72)}\n${title}\n${'='.repeat(72)}`);
}

function pct(value: number | null): string {
  return value === null ? '—' : `${(value * 100).toFixed(1)}%`;
}

async function main(): Promise<void> {
  const org = await db().organization.findFirst({
    where: { slug: { not: { startsWith: '__loadtest__' } } },
    select: { id: true, name: true },
  });
  if (!org) throw new Error('No organization. Run `npm run db:seed`.');

  const tenant: TenantContext = { organizationId: org.id };

  // -------------------------------------------------------------------------
  section('1. DATA SUFFICIENCY — is any of this real?');

  const sufficiency = await dataSufficiency(tenant);

  console.log(`\n  ${sufficiency.statement}\n`);
  console.log('  Real outcomes (at least one non-mocked send):');
  console.log(`    contacted            ${sufficiency.real.contacted}`);
  console.log(`    replied              ${sufficiency.real.replied}`);
  console.log(`    meetings             ${sufficiency.real.meetings}`);
  console.log(`    won                  ${sufficiency.real.won}`);
  console.log(`    won deals with value ${sufficiency.real.valuedWonDeals}`);
  console.log('\n  Synthetic (mock provider — NOT evidence):');
  console.log(`    leads contacted      ${sufficiency.synthetic.contacted}`);
  console.log(`    messages             ${sufficiency.synthetic.messages}`);

  if (sufficiency.needed.length > 0) {
    console.log('\n  Still needed:');
    for (const item of sufficiency.needed) console.log(`    · ${item}`);
  }

  console.log('\n  Permitted claims:');
  console.log(`    per-bucket rates     ${sufficiency.canReportRates ? 'yes' : 'NO'}`);
  console.log(`    revenue per bucket   ${sufficiency.canReportRevenue ? 'yes' : 'NO'}`);
  console.log(`    fit a model          ${sufficiency.canTrainModel ? 'yes' : 'NO'}`);

  // -------------------------------------------------------------------------
  section('2. SCORE BUCKETS — real sends only');

  const report = await calibrationReport(tenant);

  console.log(
    `\n  ${'bucket'.padEnd(10)}${'leads'.padStart(7)}${'contacted'.padStart(11)}` +
      `${'replied'.padStart(9)}${'reply%'.padStart(9)}${'meet%'.padStart(8)}${'win%'.padStart(8)}   sample`,
  );
  console.log('  ' + '-'.repeat(74));

  for (const bucket of report.buckets) {
    console.log(
      `  ${bucket.bucket.padEnd(10)}${String(bucket.leads).padStart(7)}` +
        `${String(bucket.contacted).padStart(11)}${String(bucket.replied).padStart(9)}` +
        `${pct(bucket.replyRate).padStart(9)}${pct(bucket.meetingRate).padStart(8)}` +
        `${pct(bucket.winRate).padStart(8)}   ${bucket.reliable ? 'ok' : 'TOO SMALL'}`,
    );
  }

  console.log(
    `\n  Monotonic (higher score replies more often): ${
      report.monotonic === null ? 'UNKNOWN — too few reliable buckets' : report.monotonic ? 'yes' : 'NO'
    }`,
  );

  // -------------------------------------------------------------------------
  section('3. LIFT — is the score better than picking at random?');

  const top = report.buckets.find((b) => b.bucket === '80–100');
  const lift = computeLift(
    top?.replied ?? 0,
    top?.contacted ?? 0,
    report.buckets.reduce((sum, b) => sum + b.replied, 0),
    report.totalContacted,
  );

  console.log(`\n  baseline reply rate  ${pct(lift.baselineReplyRate)}`);
  console.log(`  top bucket           ${pct(lift.topBucketReplyRate)}`);
  console.log(`  lift                 ${lift.replyLift === null ? '—' : `${lift.replyLift}x`}`);
  console.log(`\n  ${lift.interpretation}`);

  // -------------------------------------------------------------------------
  section('4. REVENUE');

  const revenue = await revenuePerLead(tenant);

  console.log(`\n  won deals            ${revenue.wonDeals} (${revenue.unvaluedWonDeals} without a value)`);
  console.log(`  revenue              ${formatMoney(revenue.revenueMinor)}`);
  console.log(`  average deal         ${revenue.averageDealMinor === null ? '—' : formatMoney(revenue.averageDealMinor)}`);
  console.log(
    `  per contacted lead   ${revenue.perContactedLeadMinor === null ? '— (nothing contacted)' : formatMoney(revenue.perContactedLeadMinor)}`,
  );
  console.log(
    `  per qualified lead   ${revenue.perQualifiedLeadMinor === null ? '— (none qualified)' : formatMoney(revenue.perQualifiedLeadMinor)}`,
  );
  console.log(
    `  median days to close ${revenue.medianDaysToCloseDays === null ? '— (no closed deal with a first touch)' : revenue.medianDaysToCloseDays}`,
  );

  if (!sufficiency.canReportRevenue) {
    console.log(
      `\n  NOT a reliable figure: ${revenue.wonDeals} won deal(s) is below the threshold for\n` +
        '  revenue analysis. Treat it as a record of what happened, not a rate to plan with.',
    );
  }

  // -------------------------------------------------------------------------
  section('5. SEGMENTS — correlation only');

  for (const dimension of ['primaryCategory', 'city', 'source'] as const) {
    const segments = await segmentOutcomes(tenant, dimension, 8);
    console.log(`\n  by ${dimension}:`);

    if (segments.length === 0) {
      console.log('    (no real outcomes to group)');
      continue;
    }

    for (const segment of segments) {
      console.log(
        `    ${segment.value.slice(0, 24).padEnd(26)}` +
          `leads ${String(segment.leads).padStart(5)}   ` +
          `reply ${pct(segment.replyRate).padStart(7)}   ` +
          `revenue ${formatMoney(segment.revenueMinor).padStart(12)}   ` +
          `${segment.reliable ? '' : 'TOO SMALL'}`,
      );
    }
  }

  console.log(
    '\n  Correlation, not causation. A segment that replies more may do so because\n' +
      '  of the attribute, or because it was targeted earlier, written to better, or\n' +
      '  worked by a more experienced salesperson. Nothing here separates those.',
  );

  // -------------------------------------------------------------------------
  section('6. RECOMMENDATIONS');

  console.log();
  for (const line of report.recommendations) console.log(`  · ${line}`);

  if (sufficiency.verdict === 'NO_DATA' || sufficiency.verdict === 'SYNTHETIC_ONLY') {
    console.log(
      '\n  No weights should change on this evidence. The scoring model remains a set\n' +
        '  of documented, reasoned estimates that has never met a real outcome.',
    );
  }

  console.log(`\n  Organization: ${org.name}`);
}

main()
  .catch((error) => {
    console.error('\nCalibration failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await Promise.allSettled([closeDatabase(), closeRedis()]);
  });
