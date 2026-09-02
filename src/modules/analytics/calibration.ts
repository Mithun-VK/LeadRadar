/**
 * Lead-score calibration.
 *
 * Answers one question: **does the score actually predict commercial outcomes?**
 *
 * A scoring model that does not correlate with replies, meetings, and wins is
 * decoration — it sorts the list confidently and wrongly, and everyone downstream
 * trusts it. This buckets leads by score and reports what actually happened to
 * each bucket, so the model can be checked rather than believed.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS DELIBERATELY DOES NOT DO
 * ---------------------------------------------------------------------------
 *
 * It does not rewrite scoring weights. Recalibrating is a judgement about
 * whether a sample is representative — whether the low bucket underperformed
 * because the score is right, or because nobody ever emailed it — and that
 * judgement belongs to a person looking at the numbers.
 *
 * It also refuses to report on samples too small to mean anything. A bucket with
 * four leads and one reply is a 25% reply rate that will not survive contact with
 * the fifth lead, and printing it invites someone to act on noise.
 *
 * Note this is a DIFFERENT tool from `npm run calibrate`, which calibrates the
 * COST funnel (how many searches and scrapes per business). That script's own job
 * is still undone; see docs/REVENUE_ENGINE_AUDIT.md §7.
 */
import { db, type TenantContext } from '@/modules/database/client';
import { statusesAtOrBeyond } from '@/modules/crm/lead-status';

/** Below this, a bucket's rates are computed but flagged as unreliable. */
export const MIN_BUCKET_SAMPLE = 20;

export interface ScoreBucket {
  readonly label: string;
  readonly min: number;
  readonly max: number;
}

export const SCORE_BUCKETS: readonly ScoreBucket[] = [
  { label: '80–100', min: 80, max: 100 },
  { label: '60–79', min: 60, max: 79 },
  { label: '40–59', min: 40, max: 59 },
  { label: '0–39', min: 0, max: 39 },
];

export interface BucketOutcome {
  readonly bucket: string;
  readonly leads: number;
  readonly contacted: number;
  readonly replied: number;
  readonly meetings: number;
  readonly won: number;
  /** Null when the denominator is zero — never a misleading 0%. */
  readonly replyRate: number | null;
  readonly meetingRate: number | null;
  readonly winRate: number | null;
  /** False when the sample is too small to draw a conclusion from. */
  readonly reliable: boolean;
}

export interface CalibrationReport {
  readonly buckets: readonly BucketOutcome[];
  readonly totalContacted: number;
  /**
   * Whether higher-scoring buckets actually replied more often. The headline
   * finding, and the thing the score exists to achieve.
   */
  readonly monotonic: boolean | null;
  readonly recommendations: readonly string[];
  readonly websiteScoreBuckets: readonly BucketOutcome[];
}

function rate(numerator: number, denominator: number): number | null {
  if (denominator === 0) return null;
  return Number((numerator / denominator).toFixed(4));
}

async function outcomesFor(
  tenant: TenantContext,
  field: 'opportunityScore' | 'websiteQualityScore',
  bucket: ScoreBucket,
): Promise<BucketOutcome> {
  const base = {
    organizationId: tenant.organizationId,
    [field]: { gte: bucket.min, lte: bucket.max },
  };

  const [leads, contacted, replied, meetings, won] = await Promise.all([
    db().business.count({ where: base }),
    db().business.count({
      where: { ...base, leadStatus: { in: statusesAtOrBeyond('CONTACTED') } },
    }),
    db().business.count({
      where: { ...base, leadStatus: { in: statusesAtOrBeyond('REPLIED') } },
    }),
    db().business.count({
      where: { ...base, leadStatus: { in: statusesAtOrBeyond('MEETING') } },
    }),
    db().business.count({ where: { ...base, leadStatus: 'WON' } }),
  ]);

  return {
    bucket: bucket.label,
    leads,
    contacted,
    replied,
    meetings,
    won,
    replyRate: rate(replied, contacted),
    meetingRate: rate(meetings, replied),
    winRate: rate(won, meetings),
    reliable: contacted >= MIN_BUCKET_SAMPLE,
  };
}

/**
 * Builds the calibration report.
 *
 * Only CONTACTED leads are used as the denominator throughout. A lead nobody
 * emailed cannot have replied, and including it would make every bucket look
 * worse in proportion to how many leads were discovered but never worked —
 * measuring outreach volume rather than score quality.
 */
export async function calibrationReport(tenant: TenantContext): Promise<CalibrationReport> {
  const buckets = await Promise.all(
    SCORE_BUCKETS.map((bucket) => outcomesFor(tenant, 'opportunityScore', bucket)),
  );

  const websiteScoreBuckets = await Promise.all(
    SCORE_BUCKETS.map((bucket) => outcomesFor(tenant, 'websiteQualityScore', bucket)),
  );

  const totalContacted = buckets.reduce((sum, bucket) => sum + bucket.contacted, 0);

  /**
   * Monotonicity across the buckets that have enough data.
   *
   * Null rather than false when fewer than two buckets are reliable: "we cannot
   * tell yet" is the honest answer, and returning false would read as "the score
   * does not work".
   */
  const reliable = buckets.filter((bucket) => bucket.reliable && bucket.replyRate !== null);

  const monotonic =
    reliable.length < 2
      ? null
      : reliable.every(
          (bucket, index) =>
            index === 0 || (reliable[index - 1]!.replyRate ?? 0) >= (bucket.replyRate ?? 0),
        );

  const recommendations: string[] = [];

  if (totalContacted < MIN_BUCKET_SAMPLE) {
    recommendations.push(
      `Only ${totalContacted} lead(s) have been contacted. Calibration needs at least ` +
        `${MIN_BUCKET_SAMPLE} per bucket before any conclusion is meaningful. Keep running ` +
        'campaigns and revisit this.',
    );
  } else if (monotonic === null) {
    recommendations.push(
      'Not enough buckets have a usable sample yet. Contact more leads across the score ' +
        'range — including low-scoring ones — before drawing a conclusion.',
    );
  } else if (monotonic) {
    recommendations.push(
      'Higher-scoring leads reply more often, so the score is doing its job. No change recommended.',
    );
  } else {
    recommendations.push(
      'Reply rate does NOT fall consistently as score falls, which means the score is not ' +
        'currently predicting engagement. Before changing weights, check whether low-scoring ' +
        'leads were contacted with the same templates and at the same volume — an apparent ' +
        'scoring failure is often a sampling artefact.',
    );
  }

  const top = buckets[0];
  const bottom = buckets[buckets.length - 1];

  if (top?.reliable && bottom?.reliable && top.replyRate !== null && bottom.replyRate !== null) {
    const lift = bottom.replyRate === 0 ? null : top.replyRate / bottom.replyRate;
    if (lift !== null) {
      recommendations.push(
        `Top-bucket leads reply ${lift.toFixed(1)}× as often as bottom-bucket leads.` +
          (lift < 1.5
            ? ' That is a weak separation — the score is barely distinguishing between them.'
            : ' That is a meaningful separation.'),
      );
    }
  }

  // Never rewritten automatically. Stated explicitly so nobody expects it to be.
  recommendations.push(
    'Weights are never changed automatically. Edit src/modules/scoring/config.ts and bump ' +
      'SIGNALS_VERSION; every score then recomputes from stored signals without re-spending ' +
      'API budget.',
  );

  return { buckets, totalContacted, monotonic, recommendations, websiteScoreBuckets };
}
