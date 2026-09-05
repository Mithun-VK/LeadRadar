/**
 * Revenue intelligence: is there enough real evidence to draw a conclusion?
 *
 * ---------------------------------------------------------------------------
 * THE QUESTION THIS ANSWERS FIRST
 * ---------------------------------------------------------------------------
 *
 * Not "what is the reply rate by score bucket" — `calibration.ts` computes that.
 * This answers the prior question: **is any of it real, and is there enough of
 * it to mean anything?**
 *
 * That ordering matters because the failure mode here is not a wrong number, it
 * is a confident number. A reply rate computed from eleven mock-provider sends
 * looks exactly like a reply rate computed from eleven thousand real ones, and
 * someone will plan a quarter around the difference.
 *
 * ---------------------------------------------------------------------------
 * SYNTHETIC DATA IS NOT EVIDENCE
 * ---------------------------------------------------------------------------
 *
 * Every verification script in this repository moves leads through the full
 * lifecycle — CONTACTED, REPLIED, MEETING, WON — using the mock email provider.
 * Those leads are indistinguishable from real ones by `leadStatus` alone.
 * `EmailMessage.mocked` is the only field that separates them, so it is the
 * basis of every count here.
 *
 * A deployment that has never sent a real email has, by definition, zero real
 * commercial outcomes, however full its database looks.
 */
import { db, type TenantContext } from '@/modules/database/client';

// ---------------------------------------------------------------------------
// Data sufficiency
// ---------------------------------------------------------------------------

/**
 * Real replies needed before per-bucket rates are worth acting on.
 *
 * The binding constraint is positive outcomes, not leads. At a realistic 5–10%
 * reply rate, 30 replies implies roughly 300–600 contacted leads — which is the
 * honest cost of a directional answer, and stating it as replies rather than
 * leads stops it being quietly satisfied by a large unengaged list.
 */
export const MIN_REPLIES_FOR_DIRECTION = 30;

/**
 * Real wins needed before the score can be said to predict REVENUE.
 *
 * Deliberately modest and still rarely met: with a 20% close rate on meetings,
 * 10 wins is already a few hundred contacted leads. Below it, "revenue per score
 * bucket" is a story about three deals.
 */
export const MIN_WINS_FOR_REVENUE = 10;

/**
 * Real replies before fitting anything resembling a model.
 *
 * Ten events per feature is the conventional floor for a logistic fit, and the
 * scoring model already has three factors and a dozen flags. 200 is the point at
 * which a fit stops being an elaborate way to overfit noise — and this codebase
 * should reach it with real data before anyone writes a model, not before.
 */
export const MIN_REPLIES_FOR_MODEL = 200;

export type SufficiencyVerdict =
  | 'NO_DATA'
  | 'SYNTHETIC_ONLY'
  | 'INSUFFICIENT_SAMPLE'
  | 'SUFFICIENT_DIRECTIONAL'
  | 'SUFFICIENT_FOR_MODELLING';

export interface DataSufficiency {
  readonly verdict: SufficiencyVerdict;
  /** The sentence to put in a report. Deliberately blunt. */
  readonly statement: string;
  readonly real: {
    readonly contacted: number;
    readonly replied: number;
    readonly meetings: number;
    readonly won: number;
    readonly valuedWonDeals: number;
  };
  /** Outcomes produced by the mock provider. Never counted as evidence. */
  readonly synthetic: {
    readonly contacted: number;
    readonly messages: number;
  };
  /** What is still needed, in plain terms. */
  readonly needed: readonly string[];
  readonly canReportRates: boolean;
  readonly canReportRevenue: boolean;
  readonly canTrainModel: boolean;
}

/**
 * Whether this deployment has enough real outcome data to support a claim.
 *
 * Returns a verdict rather than a boolean because the four ways of having too
 * little data need four different responses: none at all, only synthetic, real
 * but thin, and real but not yet enough to model.
 */
export async function dataSufficiency(tenant: TenantContext): Promise<DataSufficiency> {
  const org = { organizationId: tenant.organizationId };
  const realSend = { emailMessages: { some: { mocked: false } } };

  const [
    realContacted,
    realReplied,
    realMeetings,
    realWon,
    valuedWonDeals,
    syntheticContacted,
    syntheticMessages,
  ] = await Promise.all([
    db().business.count({ where: { ...org, ...realSend } }),
    db().business.count({
      where: { ...org, ...realSend, leadStatus: { in: ['REPLIED', 'SQL', 'MEETING', 'PROPOSAL', 'NEGOTIATION', 'WON'] } },
    }),
    db().business.count({
      where: { ...org, ...realSend, leadStatus: { in: ['MEETING', 'PROPOSAL', 'NEGOTIATION', 'WON'] } },
    }),
    db().business.count({ where: { ...org, ...realSend, leadStatus: 'WON' } }),
    db().deal.count({ where: { ...org, stage: 'WON', valueMinor: { not: null } } }),
    db().business.count({
      where: {
        ...org,
        emailMessages: { some: { mocked: true }, none: { mocked: false } },
      },
    }),
    db().emailMessage.count({ where: { ...org, mocked: true } }),
  ]);

  const canReportRates = realReplied >= MIN_REPLIES_FOR_DIRECTION;
  const canReportRevenue = valuedWonDeals >= MIN_WINS_FOR_REVENUE;
  const canTrainModel = realReplied >= MIN_REPLIES_FOR_MODEL;

  const needed: string[] = [];
  if (!canReportRates) {
    needed.push(
      `${MIN_REPLIES_FOR_DIRECTION - realReplied} more real replies before per-bucket rates are meaningful (have ${realReplied})`,
    );
  }
  if (!canReportRevenue) {
    needed.push(
      `${MIN_WINS_FOR_REVENUE - valuedWonDeals} more won deals carrying a value before revenue-per-bucket means anything (have ${valuedWonDeals})`,
    );
  }
  if (!canTrainModel) {
    needed.push(
      `${MIN_REPLIES_FOR_MODEL - realReplied} more real replies before fitting a model would be anything but overfitting (have ${realReplied})`,
    );
  }

  let verdict: SufficiencyVerdict;
  let statement: string;

  if (realContacted === 0 && syntheticContacted === 0) {
    verdict = 'NO_DATA';
    statement =
      'INSUFFICIENT REAL DATA FOR MODEL TRAINING — no lead has been contacted at all. ' +
      'The scoring model is unvalidated: it has never been tested against an outcome.';
  } else if (realContacted === 0) {
    verdict = 'SYNTHETIC_ONLY';
    statement =
      'INSUFFICIENT REAL DATA FOR MODEL TRAINING — every recorded outcome came from the ' +
      `mock provider (${syntheticMessages} synthetic message(s), ${syntheticContacted} lead(s)). ` +
      'No real email has been sent, so there are no commercial outcomes to calibrate against. ' +
      'The pipeline is proven; the scoring model is not.';
  } else if (!canReportRates) {
    verdict = 'INSUFFICIENT_SAMPLE';
    statement =
      `INSUFFICIENT REAL DATA FOR MODEL TRAINING — ${realContacted} real lead(s) contacted ` +
      `producing ${realReplied} reply(ies), below the ${MIN_REPLIES_FOR_DIRECTION} needed for a ` +
      'directional read. Rates computed now would not survive the next dozen leads.';
  } else if (!canTrainModel) {
    verdict = 'SUFFICIENT_DIRECTIONAL';
    statement =
      `Directional only — ${realReplied} real replies across ${realContacted} contacted leads. ` +
      'Enough to see whether the score orders leads correctly; NOT enough to fit a model.';
  } else {
    verdict = 'SUFFICIENT_FOR_MODELLING';
    statement =
      `${realReplied} real replies across ${realContacted} contacted leads — enough to consider ` +
      'a fitted model. Validate on held-out data before replacing the current weights.';
  }

  return {
    verdict,
    statement,
    real: {
      contacted: realContacted,
      replied: realReplied,
      meetings: realMeetings,
      won: realWon,
      valuedWonDeals,
    },
    synthetic: { contacted: syntheticContacted, messages: syntheticMessages },
    needed,
    canReportRates,
    canReportRevenue,
    canTrainModel,
  };
}

// ---------------------------------------------------------------------------
// Lift
// ---------------------------------------------------------------------------

export interface Lift {
  /** Reply rate of the top bucket divided by the population baseline. */
  readonly replyLift: number | null;
  readonly baselineReplyRate: number | null;
  readonly topBucketReplyRate: number | null;
  readonly interpretation: string;
}

/**
 * How much better the top bucket does than picking at random.
 *
 * Lift is the single number that says whether the score is worth having. A lift
 * of 1.0 means the score sorts leads no better than shuffling them — and a
 * scoring model that adds nothing is worse than none, because everyone downstream
 * trusts it.
 */
export function computeLift(
  topBucketReplied: number,
  topBucketContacted: number,
  totalReplied: number,
  totalContacted: number,
): Lift {
  if (topBucketContacted === 0 || totalContacted === 0) {
    return {
      replyLift: null,
      baselineReplyRate: null,
      topBucketReplyRate: null,
      interpretation: 'Not computable: nothing has been contacted.',
    };
  }

  const baseline = totalReplied / totalContacted;
  const top = topBucketReplied / topBucketContacted;

  if (baseline === 0) {
    return {
      replyLift: null,
      baselineReplyRate: 0,
      topBucketReplyRate: top,
      interpretation: 'Not computable: no lead has replied, so there is no baseline to beat.',
    };
  }

  const lift = top / baseline;

  return {
    replyLift: Number(lift.toFixed(2)),
    baselineReplyRate: Number(baseline.toFixed(4)),
    topBucketReplyRate: Number(top.toFixed(4)),
    interpretation:
      lift >= 1.5
        ? `The top bucket replies ${lift.toFixed(1)}x more often than average. The score is earning its place.`
        : lift >= 1.1
          ? `The top bucket replies ${lift.toFixed(1)}x more often than average — a real but modest edge.`
          : lift >= 0.9
            ? 'The top bucket performs about the same as average. The score is not currently sorting usefully.'
            : 'The top bucket performs WORSE than average. If this holds, the score is inverted or measuring the wrong thing.',
  };
}

// ---------------------------------------------------------------------------
// Segments
// ---------------------------------------------------------------------------

export interface SegmentOutcome {
  readonly dimension: string;
  readonly value: string;
  readonly leads: number;
  readonly contacted: number;
  readonly replied: number;
  readonly won: number;
  readonly replyRate: number | null;
  readonly revenueMinor: number;
  /** False when the sample is too small to read anything into. */
  readonly reliable: boolean;
}

/** Contacted leads below which a segment's rates are noise. */
export const MIN_SEGMENT_SAMPLE = 20;

/**
 * Outcomes grouped by a lead attribute.
 *
 * Real sends only, for the reason at the top of this file.
 *
 * **Correlation, not causation.** A segment that replies more may reply more
 * because of the attribute, or because it was targeted earlier, contacted by a
 * better-written template, or worked by a more experienced salesperson. Nothing
 * here can separate those, and the report says so rather than implying the
 * attribute caused the outcome.
 */
export async function segmentOutcomes(
  tenant: TenantContext,
  dimension: 'city' | 'primaryCategory' | 'source',
  limit = 12,
): Promise<SegmentOutcome[]> {
  /**
   * `source` is a non-nullable enum with a default; `city` and `primaryCategory`
   * are nullable strings. Excluding nulls unconditionally makes Prisma reject the
   * query outright for `source` — "Argument `source` must not be null" — so the
   * exclusion applies only where null is actually representable.
   */
  const nullable = dimension === 'city' || dimension === 'primaryCategory';

  const rows = await db().business.findMany({
    where: {
      organizationId: tenant.organizationId,
      emailMessages: { some: { mocked: false } },
      ...(nullable ? { NOT: { [dimension]: null } } : {}),
    },
    select: {
      [dimension]: true,
      leadStatus: true,
      deals: { where: { stage: 'WON' }, select: { valueMinor: true } },
    },
    // Bounded: a tenant with many cities should not pull the whole table to
    // group it, and the tail of one-lead segments is noise anyway.
    take: 20_000,
  });

  const REPLIED_OR_BEYOND = ['REPLIED', 'SQL', 'MEETING', 'PROPOSAL', 'NEGOTIATION', 'WON'];

  const grouped = new Map<string, { leads: number; replied: number; won: number; revenue: number }>();

  for (const row of rows as unknown as Array<Record<string, unknown>>) {
    const key = String(row[dimension] ?? 'unknown');
    const status = String(row.leadStatus);
    const deals = (row.deals ?? []) as Array<{ valueMinor: number | null }>;

    const entry = grouped.get(key) ?? { leads: 0, replied: 0, won: 0, revenue: 0 };
    entry.leads += 1;
    if (REPLIED_OR_BEYOND.includes(status)) entry.replied += 1;
    if (status === 'WON') entry.won += 1;
    // Unvalued deals contribute nothing rather than zero — the distinction the
    // whole revenue layer is built on.
    entry.revenue += deals.reduce((sum, deal) => sum + (deal.valueMinor ?? 0), 0);
    grouped.set(key, entry);
  }

  return [...grouped.entries()]
    .map(([value, entry]) => ({
      dimension,
      value,
      leads: entry.leads,
      // Every lead counted here has had a real send, so contacted === leads.
      contacted: entry.leads,
      replied: entry.replied,
      won: entry.won,
      replyRate: entry.leads === 0 ? null : Number((entry.replied / entry.leads).toFixed(4)),
      revenueMinor: entry.revenue,
      reliable: entry.leads >= MIN_SEGMENT_SAMPLE,
    }))
    .sort((a, b) => b.leads - a.leads)
    .slice(0, limit);
}

// ---------------------------------------------------------------------------
// Revenue per lead
// ---------------------------------------------------------------------------

export interface RevenuePerLead {
  readonly revenueMinor: number;
  readonly wonDeals: number;
  readonly unvaluedWonDeals: number;
  readonly contactedLeads: number;
  readonly qualifiedLeads: number;
  /** Null when nothing has been contacted — never a misleading zero. */
  readonly perContactedLeadMinor: number | null;
  readonly perQualifiedLeadMinor: number | null;
  readonly averageDealMinor: number | null;
  /** Median days from first touch to close, or null. */
  readonly medianDaysToCloseDays: number | null;
}

/**
 * Revenue normalised by leads, on real outcomes only.
 *
 * Every ratio is null rather than zero when its denominator is empty. "₹0 per
 * lead" reads as a measured failure; null reads as "not measured", and only one
 * of those is true before the first campaign.
 */
export async function revenuePerLead(tenant: TenantContext): Promise<RevenuePerLead> {
  const org = { organizationId: tenant.organizationId };

  const [wonDeals, contactedLeads, qualifiedLeads] = await Promise.all([
    db().deal.findMany({
      where: { ...org, stage: 'WON' },
      select: { valueMinor: true, closedAt: true, business: { select: { firstTouchAt: true } } },
    }),
    db().business.count({ where: { ...org, emailMessages: { some: { mocked: false } } } }),
    db().business.count({ where: { ...org, opportunityScore: { gte: 60 } } }),
  ]);

  const valued = wonDeals.filter((deal) => deal.valueMinor !== null);
  const revenueMinor = valued.reduce((sum, deal) => sum + (deal.valueMinor ?? 0), 0);

  const cycleDays = wonDeals
    .map((deal) => {
      const from = deal.business?.firstTouchAt;
      if (!from || !deal.closedAt) return null;
      return (deal.closedAt.getTime() - from.getTime()) / 86_400_000;
    })
    .filter((days): days is number => days !== null && days >= 0)
    .sort((a, b) => a - b);

  // Median, not mean: one deal that took eleven months would drag a mean into
  // uselessness, and sales cycles are right-skewed by nature.
  const medianDays =
    cycleDays.length === 0
      ? null
      : Math.round(cycleDays[Math.floor(cycleDays.length / 2)]!);

  return {
    revenueMinor,
    wonDeals: wonDeals.length,
    unvaluedWonDeals: wonDeals.length - valued.length,
    contactedLeads,
    qualifiedLeads,
    perContactedLeadMinor:
      contactedLeads === 0 ? null : Math.round(revenueMinor / contactedLeads),
    perQualifiedLeadMinor:
      qualifiedLeads === 0 ? null : Math.round(revenueMinor / qualifiedLeads),
    averageDealMinor: valued.length === 0 ? null : Math.round(revenueMinor / valued.length),
    medianDaysToCloseDays: medianDays,
  };
}
