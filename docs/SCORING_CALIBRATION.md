# Scoring calibration and revenue intelligence

Does the lead score actually predict commercial outcomes?

**Current answer: unknown, and honestly so.**

```
INSUFFICIENT REAL DATA FOR MODEL TRAINING
```

---

## 1. Current status — 2026-09-06

Run `npm run calibrate:scoring` for the live figure. At the time of writing:

| | |
|---|---|
| Real leads contacted | **0** |
| Real replies | **0** |
| Real won deals | **0** |
| Synthetic messages (mock provider) | 15 across 6 leads |
| Verdict | `SYNTHETIC_ONLY` |

No real email has ever been sent by this system, so there are no commercial
outcomes to calibrate against. **The pipeline is proven; the scoring model is
not.** It remains a set of documented, reasoned estimates that has never met an
outcome.

Nothing in this document, and nothing the tooling prints, should be read as
evidence that the scoring works. It does not yet say either way.

---

## 2. Why synthetic data is excluded

Every verification script moves leads through the full lifecycle —
`CONTACTED`, `REPLIED`, `MEETING`, `WON` — using the **mock** email provider.
Those leads are indistinguishable from real ones by `leadStatus` alone.

`EmailMessage.mocked` is the only field that separates a message that reached a
person from one that reached an in-process fake. Every count in the calibration
layer is therefore filtered on `emailMessages: { some: { mocked: false } }`.

This was a real defect when Phase 5 began: calibration counted leads by
`leadStatus` with no such filter, so a lead marked `WON` by `verify:revenue`
would have been reported as commercial evidence. A reply rate computed from
eleven mock sends looks exactly like one computed from eleven thousand real ones,
and the difference is a quarter's planning.

---

## 3. Data requirements

Thresholds are in `src/modules/analytics/intelligence.ts`. Each is a judgement,
so each carries its reasoning.

| Claim | Needs | Why that number |
|---|---|---|
| Per-bucket reply rates | **30 real replies** | The binding constraint is positive outcomes, not leads — otherwise a large unengaged list satisfies the bar. At a realistic 5–10% reply rate this implies roughly 300–600 contacted leads. |
| Revenue per bucket | **10 won deals with a value** | At a 20% close rate on meetings, already a few hundred contacted leads. Below it, "revenue by score" is a story about three deals. |
| Fitting a model | **200 real replies** | Ten events per feature is the conventional floor; the model has three factors and a dozen flags. Below 200 a fit is an elaborate way to overfit noise. |
| A single bucket's rate | **20 contacted** | Four leads and one reply is a "25% reply rate" that will not survive the fifth lead. |

Verdicts:

| Verdict | Meaning |
|---|---|
| `NO_DATA` | Nothing contacted at all |
| `SYNTHETIC_ONLY` | Every outcome came from the mock provider ← **current** |
| `INSUFFICIENT_SAMPLE` | Real outcomes, but too few |
| `SUFFICIENT_DIRECTIONAL` | Enough to see whether the score orders leads; not enough to model |
| `SUFFICIENT_FOR_MODELLING` | Enough to consider a fit, validated on held-out data |

---

## 4. Methodology

### Buckets

`80–100 / 60–79 / 40–59 / 0–39`, covering 0–100 with no gaps or overlaps (a gap
would silently drop leads; an overlap would double-count them — either makes
every rate wrong). Asserted by test.

Reported per bucket: leads, contacted, replied, meetings, won, and the three
rates. **A rate with a zero denominator is `null`, never `0%`** — "no data" and
"measured zero" are different claims and only one of them is honest before the
first campaign.

### Monotonicity

The headline finding: do higher-scoring buckets reply more often? That is what
the score exists to achieve.

`null` rather than `false` when fewer than two buckets are reliable — "we cannot
tell" is not "it failed".

### Lift

Top-bucket reply rate ÷ population baseline. The single number that says whether
the score is worth having:

| Lift | Reading |
|---|---|
| ≥ 1.5 | Earning its place |
| 1.1–1.5 | Real but modest edge |
| 0.9–1.1 | Not sorting usefully — a score that adds nothing is worse than none, because everyone downstream trusts it |
| < 0.9 | **Inverted** — the most important finding this can produce |

### Segments

Grouped by category, city, and source, on real sends only, with a 20-lead
reliability floor.

**Correlation, not causation.** A segment that replies more may do so because of
the attribute, or because it was targeted earlier, written to better, or worked
by a more experienced salesperson. Nothing here separates those, and the report
says so rather than implying the attribute caused the outcome.

### Revenue

Revenue per contacted lead, per qualified lead, average deal size, and **median**
days to close — median, not mean, because sales cycles are right-skewed and one
eleven-month deal would drag a mean into uselessness.

Unvalued deals are excluded and counted separately, never treated as zero.

---

## 5. Is the machinery itself correct?

Validated on **synthetic data with an injected signal** — 400 leads whose reply
probability rises with score:

| | |
|---|---|
| Buckets | 45% / 34% / 25% / 11% — correctly descending |
| Monotonic | `true` — detected the injected signal |
| Lift | **1.77×** |
| Verdict at 101 replies | `SUFFICIENT_DIRECTIONAL` — correctly refused model training |
| Segments (no injected effect) | Chennai 26%, Bangalore 25% — correctly found nothing |

**This validates the CODE, not any commercial claim.** The data was invented. It
demonstrates that if a real signal exists, the tooling will find it — and that if
one does not, it will not manufacture one.

---

## 6. Weights are never changed automatically

`calibrate:scoring` computes and prints. It does not edit
`src/modules/scoring/config.ts`.

Recalibrating is a judgement about whether a sample is representative — whether
the low bucket underperformed because the score is right, or because nobody ever
emailed it — and that judgement belongs to a person looking at the numbers.

When you do change weights, bump `SIGNALS_VERSION`. Every score then recomputes
from **stored** signals without re-spending a rupee of API budget, and historical
scores stay attributable to the version that produced them.

---

## 7. What is needed next

In order:

1. **Certify Gmail against Google** (`npm run certify:gmail`). Nothing below can
   start until real email leaves the system.
2. **Run one real campaign** of 50–100 leads spanning the score range. Do not
   send only to high scorers — a calibration set with no low-score leads cannot
   show whether the score discriminates.
3. **Wait.** Replies arrive over days; meetings over weeks; deals over months.
4. **Re-run `calibrate:scoring`** at roughly 300 contacted leads for a
   directional read.
5. **Only then** consider adjusting weights, and only with a stated rationale.

The single most common way to get this wrong is to contact only high-scoring
leads and conclude the score works. If the low buckets are never contacted, their
reply rate is `null` and the comparison is unavailable — which is why the tooling
reports `null` rather than `0%`.

---

## 8. Experimentation

Deliberately **not** built as a platform. The groundwork that exists:

- `EmailTemplate` is per-campaign, so two campaigns over the same segment with
  different templates is already an A/B test.
- `campaignRevenue()` reports outcomes per campaign.
- `sourceAttribution()` reports outcomes per lead source.
- Scores carry `SIGNALS_VERSION`, so a threshold change is attributable.

What is missing for real experiments: variant assignment within one campaign, and
statistical significance testing. Neither is worth building before there is
enough traffic for a result to mean anything — which is the same threshold as
§3, reached at the same time.
