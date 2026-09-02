# Revenue Engine Audit

**Date:** 2026-08-30
**Scope:** Audit before extending LeadRadar from a lead-generation and outreach
application into a revenue acquisition operating system (phases 14–37).
**Baseline verified before any change:** provider guard pass (164 files),
typecheck pass, lint pass (0 warnings), **618 unit tests passing**, 34 integration
tests, `verify:pipeline` 9/9, `verify:outreach` 29/29, production build passing.

---

## 1. Headline findings

Three findings shape the whole plan.

**1. There is no lead lifecycle status.** `Business` carries `leadPriority`
(A+/A/B/C/D), `opportunityScore`, `digitalPresence`, `identityVerification`, and
`independentWebsiteStatus` — but **no `NEW/QUALIFIED/CONTACTED/...` field at all**.
The pipeline state currently lives implicitly in `CampaignLead.status`, which is
per-campaign rather than per-lead. Phase 14 is therefore genuinely new work, not a
rename, and it is the foundation everything else in this brief sits on.

**2. `REPLIED` exists in three enums and nothing ever writes it.**
`CampaignLeadStatusDb.REPLIED`, `EmailStatusDb.REPLIED`, and
`EmailEventTypeDb.REPLIED` are all defined. Analytics reads the count. **No code
path sets any of them.** The value is currently dead.

**3. Reply detection requires reversing a documented promise.** This is the most
consequential item in the brief and is covered in full in §6.

---

## 2. Existing CRM-like functionality

More exists than the brief assumes. Nothing below should be rebuilt.

| Capability | Where | State |
|---|---|---|
| Lead records, tenant-scoped | `Business` | Complete |
| Lead grading (A+…D) | `LeadScore`, `scoring/opportunity.ts` | Complete, multiplicative model |
| Opportunity flags (22) | `scoring/flags.ts` | Complete |
| Service recommendation | `ServiceRecommendation`, `scoring/services.ts` | **Exists** — phase 17 extends, does not create |
| Free-text notes per lead | `LeadNote` | Complete, unused by UI |
| Campaign lifecycle + transition table | `email/campaigns.ts` | Complete, with `canTransition`/`assertTransition` |
| Campaign enrolment with skip reasons | `enrolLeads` | Complete |
| Readiness gating before activation | `assessReadiness` | Complete |
| Send guard chain (8 checks) | `email/send.ts` | Complete |
| Suppression, permanent | `SuppressionEntry`, `email/suppression.ts` | Complete |
| Unsubscribe, one-click | `/unsubscribe/[token]` | Complete |
| Audit log | `AuditLog` | Complete, written by route handlers |
| Status-change history | — | **Missing** (phase 14) |

**Reusable directly:** the campaign transition table is the exact pattern phase 14
and 16 should copy. `assertTransition` already produces a safe error with an
actionable message; lead-status and deal-stage transitions should use the same
shape rather than inventing a third convention.

---

## 3. Existing state vocabularies

Nothing here may be destroyed.

**Campaign** (`CampaignStatusDb`): `DRAFT READY RUNNING PAUSED COMPLETED CANCELLED`
— with a documented transition table. `DRAFT→RUNNING` is permitted (a bug where it
was not is recorded in `campaigns.ts`).

**Campaign lead** (`CampaignLeadStatusDb`): `PENDING SKIPPED QUEUED SENT FAILED
REPLIED UNSUBSCRIBED` — per enrolment, not per lead.

**Email message** (`EmailStatusDb`): `DRAFT QUEUED SENDING SENT FAILED BOUNCED
REPLIED UNSUBSCRIBED`.

**Email event** (`EmailEventTypeDb`): append-only history per message.

**Lead grade** (`LeadPriorityDb`): `A_PLUS A B C D` — a *quality* grade, orthogonal
to lifecycle. The new `leadStatus` must not collapse into it.

**Website state** (`IndependentWebsiteStatusDb`, `GoogleWebsiteStatusDb`): the
product's central data-quality distinction. Untouched by this phase.

---

## 4. Existing Gmail functionality

| Piece | Where |
|---|---|
| OAuth connect / callback with signed, org-bound state | `api/email/gmail/{connect,callback}` |
| Token storage, AES-256-GCM encrypted | `email/gmail-account.ts` |
| Access-token refresh ahead of expiry | `accessTokenFor` |
| Permanent-failure detection → account invalidated | `isPermanentAuthFailure` |
| Send, with typed error mapping | `providers/gmail/provider.ts` |
| Mock sender with deterministic failures | `providers/mock/email.ts` |
| MIME composition + header-injection defence | `email/mime.ts` |
| Per-mailbox daily counter | `recordSend`, `remainingDailyQuota` |

**Scope requested today:** `gmail.send` + `userinfo.email`. Nothing else.

**Absent:** any inbox read, thread listing, message fetch, or history sync. There
is no `EmailConversation` table and no inbound message concept anywhere.

---

## 5. Existing analytics

`modules/analytics/service.ts` provides:

- Lead counts: total, qualified (score ≥ 60), hot (A/A+), with email, with website, new in 7 days
- Email counts: sent, queued, failed, bounced, unsubscribed, suppressed, sent in 7 days
- Campaign counts by status
- A 6-stage funnel counting **distinct businesses** (deliberately — counting
  messages would let a lead mailed twice exceed 100%)
- Opportunity-flag distribution
- Per-campaign performance with a delivery rate
- A `notes` object stating which figures are not measurements

**Deliberately absent, and correctly so:** revenue, ROI, pipeline value. There is
no deal concept to derive them from. Phase 24 makes them *measurable* for the first
time by introducing `Deal.value` — it does not license estimating them.

**Reusable:** the `notes` pattern (caveats travelling with the numbers) should
extend to revenue metrics rather than being dropped.

---

## 6. The decision this phase forces: Gmail read scope

Phase 18 requires reading the connected mailbox. The product currently promises the
opposite, in four places:

| Location | Current text |
|---|---|
| `README.md` | "LeadRadar can send as you and **cannot read your mailbox**" |
| `docs/GMAIL_SETUP.md` | A table of "It can / It cannot", plus a paragraph explaining why reply detection is impossible |
| `src/app/dashboard/email/page.tsx` | "it **cannot read your mailbox**, list your messages, or see your contacts" |
| `src/modules/analytics/service.ts` | The `notes.replies` caveat shown on the analytics page |

That promise was a deliberate design choice, and it was the right one for a
send-only product. **Phase 18 reverses it.** The brief asks for reply detection
explicitly, so the decision is made — but it is not a silent implementation
detail, and the consequences are mandatory rather than optional:

1. **A broader scope must be requested.** `gmail.readonly` is the narrowest scope
   that permits reading a reply body. `gmail.metadata` returns headers only, which
   cannot feed intent classification. There is no "read only threads you sent"
   scope; Google does not offer one.
2. **Every already-connected account must re-consent.** A stored grant carries only
   `gmail.send`. Adding a scope does not retroactively widen it, so the app must
   detect the missing scope and prompt, rather than failing at first sync.
3. **All four documents above must be corrected** in the same change. Leaving a
   promise in place that the code no longer honours is worse than never having
   made it.
4. **Retention must be bounded.** The mailbox will contain messages that have
   nothing to do with LeadRadar. Only messages matching a known outbound thread
   should be stored at all, and their bodies should expire — see phase 33.

This is recorded here so the reversal is a documented decision rather than
something a future reader discovers by noticing the scope list grew.

---

## 7. Missing functionality

| # | Phase | Requirement | Present? |
|---|---|---|---|
| G1 | 14 | Lead lifecycle status + transition validation | **Absent** |
| G2 | 14 | `LeadStatusHistory` | **Absent** |
| G3 | 15 | `SalesActivity` + timeline | **Absent** |
| G4 | 16 | `Deal` + stages + Kanban | **Absent** |
| G5 | 17 | Configurable `ServiceOffering` with pricing | Partial — recommendation exists, offerings/prices do not |
| G6 | 18 | Inbox sync, `EmailConversation` | **Absent** (and scope-blocked, §6) |
| G7 | 19 | `EmailIntentClassifier` | **Absent** — `AiProvider` has no such task |
| G8 | 20 | Reply-driven campaign control | **Absent** |
| G9 | 21 | `CampaignStep` multi-touch sequences | **Absent** — campaigns are single-send |
| G10 | 22 | `Meeting` | **Absent** |
| G11 | 23 | `Proposal` | **Absent** |
| G12 | 24 | Revenue metrics | **Absent** (no deal value to measure) |
| G13 | 25 | Source attribution fields | Partial — `SearchResult` links a lead to a job; no `source` enum, no touch timestamps |
| G14 | 26 | Campaign → revenue attribution | **Absent** |
| G15 | 27 | Score calibration against outcomes | **Absent** — `calibrate` targets *cost* funnel assumptions, not lead quality. Different thing entirely. |
| G16 | 28 | Revenue funnel dashboard + date filters | Partial — funnel exists, no dates, no revenue |
| G17 | 29 | Lead detail as command centre | Partial — rich detail page exists, no actions |
| G18 | 30 | `/sales` work queue | **Absent** |
| G19 | 32 | Deliverability controls | Partial — daily limit, delay, suppression, bounce→suppress all exist; bounce *threshold* and active hours do not |
| G20 | 33 | Retention policies | Partial — Google snapshots have a TTL and hourly purge; nothing else does |

**Correction to a brief assumption:** phase 27 says "the current report says
`npm run calibrate` is still required against real data". That script calibrates
the **cost** funnel (`DEFAULT_FUNNEL` — how many searches/scrapes per business),
not lead-quality-versus-outcome. Phase 27 is a new tool, not an extension of it.
The existing script must not be repurposed; its own job is still undone.

---

## 8. Implementation order

Dependency-ordered, which differs slightly from the brief's numbering where a
later phase is a hard prerequisite of an earlier one.

| Batch | Phases | Rationale |
|---|---|---|
| **A** | 14, 25 | Lead status + history + source attribution. Everything else keys off lead state, and attribution fields are cheapest to add while touching `Business` anyway. |
| **B** | 15, 16 | Activities and deals. Both hang off a lead and are independent of email. |
| **C** | 17 | Service offerings with prices — needed before deals can carry a meaningful value. |
| **D** | 18, 19, 20 | Inbox sync → intent classification → campaign control. Must land together: sync without classification is noise, and classification without control changes nothing. |
| **E** | 21 | Follow-up sequences. Depends on D, because a sequence that cannot stop on reply is dangerous. |
| **F** | 22, 23 | Meetings and proposals. Depend on deals (B). |
| **G** | 24, 26, 28 | Revenue analytics, campaign attribution, funnel dashboard. Need A–F to have data to report. |
| **H** | 29, 30 | Lead command centre and `/sales` queue. Surfaces everything above; pointless earlier. |
| **I** | 27 | Score calibration — needs real outcomes, so it is last among features. |
| **J** | 31–35 | Human-in-the-loop boundaries, deliverability, retention, security review, ops. |
| **K** | 36, 37 | End-to-end revenue verification and documentation. |

**Migration strategy.** Additive throughout. `Business` gains `leadStatus`
defaulting to a value derived from existing data, so no lead is stranded. No
existing table is dropped or repurposed; no existing enum member is removed.

**Rule carried forward from the previous phase:** each batch ends green on
`npm run check`, and the two existing verification scripts must keep passing —
they are the regression guard for everything built before this brief.

---

## 9. Constraints that continue to apply

These are project rules, enforced or documented, and this phase does not relax any:

- **No fabricated metrics.** Phase 24 must not display revenue where no deal value
  exists. Phase 28's funnel must keep counting distinct businesses.
- **No fabricated claims in outreach.** Phase 17's `reasoning` must derive from
  detected flags only, exactly as the existing sales angle does.
- **Suppression has no bypass.** Phase 20 and 21 add stop conditions; none may add
  an override.
- **`npm run guard:providers`** — no Anthropic SDK, no hard-coded model ids,
  `process.env` only in `env.ts`, no secret-shaped `NEXT_PUBLIC_*`.
- **Low-confidence AI must not trigger irreversible actions** (phase 19, and the
  existing confidence-band routing in `types/domain.ts`).
- **Explicit unsubscribe beats AI classification** — an `List-Unsubscribe` action
  or the unsubscribe link is deterministic evidence; a model's `UNSUBSCRIBE` intent
  is not, and must not be treated as equivalent.
