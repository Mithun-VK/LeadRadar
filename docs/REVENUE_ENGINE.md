# Revenue engine

How LeadRadar measures money, and what it refuses to measure.

---

## 1. The rule

**Every figure is a count of rows or a sum of values a human entered.** Nothing is
estimated, imputed, extrapolated, or defaulted.

A revenue dashboard is the screen an operator plans against. A number that looks
like money but is actually an assumption is worse than a blank — a blank prompts a
question, a fabricated figure does not.

Three consequences:

**An unvalued deal is excluded, not zeroed.** Deals with `valueMinor = null` are
left out of every money sum and reported separately as `unvaluedOpenDeals` and
`unvaluedWonDeals`. Averaging a null in as zero drags every average down and
understates the pipeline. The UI shows "₹4.2L across 12 deals, 3 not yet valued".

**A rate with an empty denominator is `null`, not 0%.** "No data yet" and "nobody
replied" are different facts. Rendering the first as 0% invites someone to conclude
the second and change strategy over noise.

**Revenue is only what closed.** `revenueWonMinor` sums values on deals in stage
`WON`. There is no projected revenue, no expected close value, and no default deal
size anywhere in the codebase.

---

## 2. Metrics

| Metric | Definition |
|---|---|
| Leads | Businesses discovered |
| Qualified | At or beyond `QUALIFIED` |
| Contacted | At or beyond `CONTACTED` |
| Replied | At or beyond `REPLIED` |
| Meetings | At or beyond `MEETING` |
| Proposals | At or beyond `PROPOSAL` |
| Won / Lost | Currently `WON` / `LOST` |
| Pipeline | Σ value of **open** deals with a value |
| Weighted pipeline | Σ (value × probability) over open valued deals |
| Revenue won | Σ value of `WON` deals with a value |
| Average deal | Revenue won ÷ count of **valued** won deals |

### Rates

```
Reply rate      = replied     / contacted
Meeting rate    = meetings    / replied
Proposal rate   = proposals   / meetings
Win rate        = won         / proposals
Lead-to-client  = won         / qualified
```

Each is `null` when its denominator is zero.

---

## 3. Cumulative counting

Funnel stages are **cumulative**: a lead at `PROPOSAL` has also been contacted and
has also replied.

Counting only leads *currently* at each status would produce a funnel that narrows
as deals progress — the opposite of what a funnel means. A single lead moving from
`REPLIED` to `MEETING` would appear to reduce the reply count.

`statusesAtOrBeyond` also **includes `LOST`**. A lead that reached `PROPOSAL` and
then lost did reach proposal. Excluding it would make the funnel narrow
retroactively as deals close badly, misrepresenting what happened.

`UNSUBSCRIBED` is excluded from denominators. Including opt-outs would make every
conversion rate look worse as compliance improved — exactly the wrong incentive.

### Distinct businesses, not events

The funnel counts businesses. Counting messages would let a lead mailed by two
campaigns appear twice and produce a conversion rate above 100%, which quietly
discredits the whole dashboard.

---

## 4. Attribution

### Source

Every lead carries `source` (`WEB_DISCOVERY`, `DIRECTORY`, `CSV_IMPORT`, `MANUAL`,
`REFERRAL`, `CAMPAIGN`), `sourceUrl`, `firstTouchAt`, and `lastTouchAt`.
`firstTouchAt` is written once and never moved — it is the anchor for "how long
from first contact to close".

`sourceAttribution()` answers which source produces the most qualified leads, the
most clients, and the most revenue.

### Campaign

`Deal.sourceCampaignId` is stamped at deal creation from the campaign that last
emailed the lead, automatically. Attribution relying on a human remembering to pick
a campaign would be missing for most deals.

**This is a LAST-TOUCH model, and it is stated rather than dressed up.** A lead
emailed by two campaigns attributes wholly to the second. Multi-touch attribution
needs a weighting model the operator should choose, not one this code picks
silently.

### Mixed currencies

If deals exist in more than one currency they are summed **without conversion**, and
`notes.revenue` says so explicitly. Silently adding rupees to dollars would be the
worst possible failure in a money report.

---

## 5. Score calibration

Answers: **does the score actually predict outcomes?** A model that does not
correlate with replies and wins is decoration — it sorts the list confidently and
wrongly, and everyone downstream trusts it.

Leads are bucketed 80–100, 60–79, 40–59, 0–39, and each bucket's reply, meeting,
and win rates are computed. `monotonic` reports whether higher buckets actually
replied more often.

**Only contacted leads are denominators.** A lead nobody emailed cannot have
replied; including it would measure outreach volume rather than score quality.

**Buckets below 20 contacted leads are flagged unreliable.** Four leads and one
reply is a 25% rate that will not survive the fifth lead.

**Weights are never rewritten automatically.** Recalibrating is a judgement about
whether a sample is representative — whether the low bucket underperformed because
the score is right, or because nobody ever emailed it — and that belongs to a
person. The report recommends; `src/modules/scoring/config.ts` is edited by hand.

> Note: this is a **different tool** from `npm run calibrate`, which calibrates the
> *cost* funnel (searches and scrapes per business). That script's own job is still
> undone.

---

## 6. What is not measured

| Not reported | Why |
|---|---|
| Email opens | Needs a tracking pixel. None is implemented, and claiming open rates without one would be a lie. |
| Click-through | Same. |
| Delivery confirmation | Gmail's API confirms *acceptance*, not delivery to an inbox. |
| Proposal views | Needs a hosted proposal page or a pixel. `VIEWED` is operator-set, not measured. |
| Projected revenue | An assumption wearing a currency symbol. |
| ROI | Requires cost-per-lead attribution that does not exist. |

---

## 7. Where to look

| Concern | File |
|---|---|
| Revenue metrics and funnel | `src/modules/analytics/revenue.ts` |
| Score calibration | `src/modules/analytics/calibration.ts` |
| Marketing metrics | `src/modules/analytics/service.ts` |
| Pipeline totals | `src/modules/crm/deals.ts` |
