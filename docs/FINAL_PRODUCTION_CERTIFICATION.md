# Final production certification

**Date:** 2026-09-06
**Commit:** `184383c` on `feat/revenue-engine-production-hardening`
**Standard:** nothing is GREEN because code exists. Every GREEN cites a command
actually run during this certification.

---

## Verdict

| Readiness | Status |
|---|---|
| **Technical** | 🟢 **READY** |
| **Operational** | 🟡 **READY WITH MANUAL VALIDATION** |
| **Commercial** | 🔴 **NOT VALIDATED** |

The system is internally correct, load-verified to 10,000 leads, and operable.

It has **never sent a real email**, and has therefore **generated no revenue and
produced no commercial evidence of any kind**. That is not a defect — it is an
un-crossed threshold, and it can only be crossed by a human with real credentials.

---

## 1. Evidence base

Every figure below came from a command run during this certification.

| Gate | Result |
|---|---|
| Provider guard | **pass** — 211 files, 6 rules |
| Typecheck | **pass** |
| Lint | **pass**, 0 warnings |
| Prisma schema validation | **valid** |
| Schema drift | **none** — "Database schema is up to date!" |
| Unit tests | **775 passed**, 33 files |
| Integration tests | **34 passed**, real PostgreSQL |
| `verify:pipeline` | **9/9** |
| `verify:outreach` | **29/29** |
| `verify:sequence` | **38/38** |
| `verify:revenue` | **47/47** |
| `verify:recovery` | **27/27** |
| Production build | **pass** |
| Load @ 10K leads | **worst p95 257ms**, heap 54MB |
| `certify:gmail` | **refused** — provider is a mock (correct behaviour) |

**809 automated tests. 150 end-to-end assertions.**

---

## 2. Scorecard

| # | Category | Status | Evidence | Remaining action |
|---|---|---|---|---|
| 1 | Architecture | 🟢 | Provider abstraction holds; guard enforces no SDK outside `providers/`; 211 files scanned | — |
| 2 | Security | 🟢 | No secrets tracked or in history; 0 `console.log`; no token values logged; token ciphers unreachable from any route | — |
| 3 | Authentication | 🟢 | Server-side sessions, scrypt (~1s), lockout, hashed tokens; 16 auth tests | — |
| 4 | Authorization | 🟢 | All routes via `handler()` except 6 audited exceptions, each enforcing its own check; OWNER/ADMIN gates on mailbox + kill switches | — |
| 5 | Multi-tenancy | 🟢 | 98 `TenantContext` references; org always from the session row — **zero** routes read it from client input | Cross-tenant penetration test |
| 6 | Database | 🟢 | No drift; 7 migrations, all additive; FK/index audit; 34 integration tests | — |
| 7 | Redis | 🟢 | Health checked; queue + cache + subscriber separated; failure path drilled | — |
| 8 | Workers | 🟢 | Heartbeat with TTL; crash + restart drilled (`critical → ok`); graceful SIGTERM drain | — |
| 9 | Queues | 🟢 | 10 queues, DLQ each, idempotent job ids; **colon-id bug found and fixed** | — |
| 10 | Discovery | 🟡 | 9/9 against **mock** Google Places | One live search |
| 11 | Enrichment | 🟡 | Verified against **mock** Firecrawl | One live crawl |
| 12 | Scoring | 🟢 | Multiplicative model, 0 placeholders, `SIGNALS_VERSION` recompute | Predictive validity — see §5 |
| 13 | Personalization | 🟢 | Facts from measurements; AI may only rephrase; fabricated numbers/URLs discarded; 17 tests | — |
| 14 | Email composition | 🟢 | 27 MIME tests incl. header injection via scraped names; plain-text only | — |
| 15 | **Gmail** | 🔴 | **Never executed against Google.** Mock only | `certify:gmail` |
| 16 | Inbox sync | 🟡 | Logic verified via mock; **unbounded-lookback bug fixed** | Live sync |
| 17 | Reply detection | 🟡 | 3-tier matching verified via mock | Live reply |
| 18 | Follow-ups | 🟢 | 38/38 incl. reply/suppression termination, concurrency, no-steps compatibility | — |
| 19 | Suppression | 🟢 | Re-checked at send time; no bypass parameter exists; unsubscribe permanent | — |
| 20 | Kill switches | 🟢 | Outbound fails **closed**; drilled — a real send returned `OUTBOUND_PAUSED` | — |
| 21 | CRM | 🟢 | 47/47; idempotent transitions; audited history | — |
| 22 | Meetings | 🟢 | Lifecycle verified | — |
| 23 | Proposals | 🟢 | Lifecycle verified | — |
| 24 | Deals | 🟢 | Stage machine verified; `listDeals` capped | — |
| 25 | Revenue | 🟢 | Unvalued deals excluded not zeroed; integer minor units | **No real revenue** — §5 |
| 26 | Analytics | 🟢 | Funnel counts distinct businesses; **655ms→170ms p95 fix**, verified identical over 4,992 flag instances | — |
| 27 | Observability | 🟢 | Liveness/readiness split; 13 alert rules; found 3 real problems on first run | External monitor |
| 28 | Infrastructure | 🟡 | Compose valid; containers healthy; `leadradar-web` image built (645MB) | **Worker image never built**; no deploy |
| 29 | Load | 🟢 | 10K leads, worst p95 **257ms**, heap flat | Concurrency untested |
| 30 | Compliance controls | 🟡 | Retention scheduled + verified; suppression permanent; unsubscribe headers | **DPDP not legally reviewed** |
| 31 | Documentation | 🟢 | 22 docs; runbook with 12 procedures; states what is *not* built | — |
| 32 | Disaster recovery | 🟡 | 27/27 drills: worker crash, kill switch, DB/Redis unreachable | DB/Redis simulated by **unreachable port**, not container stop |

**🟢 22 · 🟡 9 · 🔴 1 · ⚪ 0**

---

## 3. Security review

| Check | Result |
|---|---|
| Secrets tracked in git | **none**; `.env` ignored |
| Secrets in history (`GOCSPX-`, `AIzaSy`) | **none ever committed** |
| Token/credential values in logs | **none** |
| `console.log` in `src/` | **0** |
| Token ciphers reachable from a route | **never referenced** |
| Client-supplied `organizationId` trusted | **zero occurrences** |
| Raw SQL | 2 uses, both parameterised (`$queryRaw` tagged template) |
| `queryRawUnsafe` in `src/` | **none** |
| SSRF guard | 7 call sites; DNS pinning, redirect re-validation |
| CSV formula injection | `neutraliseFormula` on CSV **and** XLSX |
| Duplicate sends | 6 DB unique constraints incl. `(campaignId, businessId, campaignStepId)` |
| Rate limiting | 14 routes |
| Unbounded queries | `listDeals` capped; analytics aggregate in SQL |
| Race conditions | Concurrent same-step send drilled → exactly one message |

**No security blocker found.**

Not done: dependency CVE audit, and a real cross-tenant penetration test. Isolation
is enforced structurally (org from session row only) and reviewed, but not attacked.

---

## 4. What is real vs mocked

The distinction that matters most.

| Capability | Mock verified | Real-credential verified |
|---|---|---|
| Google Places discovery | ✅ | ❌ **never** |
| Firecrawl crawl | ✅ | ❌ **never** |
| Groq AI | ✅ | ❌ **never** |
| Gmail OAuth | ✅ | ❌ **never** |
| Gmail send | ✅ | ❌ **never — no real email has been sent** |
| Inbox sync / replies | ✅ | ❌ **never** |
| Campaign termination on reply | ✅ | ❌ **never** |

`MOCK_EXTERNAL_APIS` is rejected in production and live mode fails at boot without
credentials — so mock mode cannot leak into production. Equally, **nothing in the
live path has ever executed.**

---

## 5. Commercial status

```
0 real leads contacted
0 real replies
0 real meetings
0 real won deals
0 revenue
```

`calibrate:scoring` reports **`INSUFFICIENT REAL DATA FOR MODEL TRAINING`** —
every recorded outcome came from the mock provider (16 synthetic messages across
6 leads).

The scoring model's predictive validity is **unknown**. It is a set of documented,
reasoned estimates that has never met an outcome. The calibration machinery is
proven to work (synthetic signal → buckets 45/34/25/11%, monotonic, 1.77× lift),
but that validates the *code*, not the model.

**No claim of commercial success can be made.** Not "early", not "promising" —
there is no data.

---

## 6. P0 blockers — before the first real campaign

1. **Certify Gmail against Google.** `npm run certify:gmail`. Everything
   downstream is blocked on it.
2. **Send one real test to yourself, and check the Sent folder.** An API 200 means
   Google accepted the request; the Sent folder means it sent.
3. **Run 3–5 leads to addresses you own**, then reply from another mailbox and
   confirm the campaign stops. This is the single most important safety property
   and it has never been observed for real.
4. **Confirm `APP_PUBLIC_URL` is publicly reachable.** A localhost unsubscribe
   link in a real email is a broken legal promise.
5. **DPDP legal review** (`legal-review-brief.md` §5) — whether business addresses
   are personal data for sole proprietors. A prerequisite for outreach in India.

## 7. P1 risks

1. **Worker container image never built.** The web image exists (645MB); the
   worker build hung on an earlier attempt. Deployment is unproven.
2. **Concurrency untested.** All load figures are single-client.
3. **DB/Redis outage simulated by unreachable port**, not by stopping containers.
4. **Disk exhaustion is a silent killer.** At 0.62GB free, Postgres blocked
   *writes* while *reads* passed — health returned 200 while login hung 317s.
   Keep **>10GB**.
5. **No external monitor.** Alerts are exposed at `/api/ops/status`; nothing polls.
6. **Refresh tokens expire in 7 days** while the OAuth app is in Testing mode.

## 8. P2 improvements

Deep-page OFFSET (257ms — keyset would fix it); dependency CVE audit; per-campaign
open/reply attribution; multi-mailbox rotation; queue metrics history.

## 9. Deferred by design

| Deferred | Why |
|---|---|
| Open/click tracking | Needs pixels and link rewriting — hurts deliverability and honesty |
| Delivery confirmation | Gmail's API does not confirm it; reporting it would be a guess |
| Automatic reply detection beyond the sending mailbox | `gmail.send` deliberately cannot read mail |
| Calendar integration | Meetings are manual by design |
| Contract generation | Proposals track a lifecycle; they are not legal documents |
| ML scoring model | Requires 200 real replies. See §5 |
| Experimentation platform | Meaningless below the same threshold |
| Automatic weight recalibration | A judgement about sample representativeness — belongs to a person |

---

## 10. Bugs found and fixed during hardening

Five phases of certification found five real defects, four of which were invisible
in normal operation:

| Bug | Impact | How found |
|---|---|---|
| Scoring used hardcoded placeholders | Part of every website-lead's score was fiction | Architecture audit |
| Mock sender failed ~6% of runs at random | `verify:outreach` flaky 1-in-17 | Running it |
| **BullMQ colon job ids** | **Campaign sending through the queue never worked**; scheduler failed every 15min for 89 cycles | Observability, first run |
| Inbox lookback unbounded | Query window grew a day per day until quota refused it — replies would stop **silently** | Gmail hardening |
| Calibration counted mock outcomes | Would have reported synthetic wins as commercial evidence | Revenue intelligence |

The colon-id bug is the instructive one: it survived four phases because every
verification script calls `sendCampaignEmail` **directly**, exercising the send
path thoroughly while never once exercising the enqueue. Test coverage is not the
same as path coverage.

---

## 11. Honest summary

**Technically ready.** 809 tests, 150 end-to-end assertions, 10K load-verified,
clean build, no drift, no secrets, no security blocker.

**Operationally ready with validation.** Health probes, worker heartbeat, 13 alert
rules, fail-closed kill switches, and drilled recovery — but the runbook's
first-run sequence has never been executed and the worker image has never built.

**Commercially unvalidated.** Zero real emails, zero replies, zero revenue. The
scoring model has never been tested against an outcome.

The gap between here and production is not code. It is one person, with real
credentials, working through §6 — and that is the correct place for the gap to be.
