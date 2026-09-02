# Production Readiness Audit

**Date:** 2026-09-02
**Question asked:** not "have the features been coded?" but "does the system work
correctly from lead discovery to revenue attribution?"
**Method:** every claim below is backed by a command actually run in this audit.
Nothing is marked verified on the basis of reading code alone.

---

## Verdict

### 🟡 YELLOW — READY WITH MANUAL VALIDATION

The system is internally correct and end-to-end verified **in mock mode**. It is
not yet proven against real Google, Firecrawl, Groq, or Gmail credentials, and
**no real email has ever been sent by this codebase**.

That is the whole of the gap. It is not a code-quality gap — it is an
*unvalidated-against-reality* gap, and it can only be closed by running the
documented manual validation in §9 with real credentials.

One genuine bug was found and fixed during this audit (§4).

---

## 1. Evidence

Every figure here came from a command run during this audit.

| Gate | Result | Command |
|---|---|---|
| Provider guard | **pass** — 190 files, 6 rules | `npm run guard:providers` |
| Typecheck | **pass** | `npm run typecheck` |
| Lint | **pass**, 0 warnings | `npm run lint` |
| Unit tests | **714 passed**, 28 files | `npx vitest run` |
| Integration tests | **34 passed**, 2 files | `npm run test:integration` |
| Pipeline verification | **9/9**, exit 0 | `npm run verify:pipeline` |
| Outreach verification | **29/29**, exit 0 | `npm run verify:outreach` |
| Revenue verification | **47/47**, exit 0 | `npm run verify:revenue` |
| Production build | **pass**, exit 0 | `npm run build` |
| Schema drift | **none** — "Database schema is up to date!" | `npx prisma migrate status` |

**85 end-to-end assertions** across the three verification scripts, plus 748
automated tests.

All three verification scripts set `process.exitCode = 1` on failure (verified at
`verify-pipeline.ts:172`, `verify-outreach.ts:368`, `verify-revenue-engine.ts:549`),
so they fail CI loudly rather than passing silently.

---

## 2. Component classification

| Component | Status | Basis |
|---|---|---|
| Architecture | 🟢 GREEN | Provider abstraction holds; nothing imports an SDK outside `providers/` |
| Database | 🟢 GREEN | No drift; 5 migrations applied; FK and index audit below |
| Lead discovery | 🟡 YELLOW | 9/9 verified **against mock Google Places**; never run live |
| Crawler | 🟡 YELLOW | Verified against mock Firecrawl; never run live |
| Contact extraction | 🟢 GREEN | 51 unit tests; no guessing path exists in schema or code |
| Website analysis | 🟢 GREEN | 28 unit tests; `performanceScore` provably always null |
| Scoring | 🟢 GREEN | Placeholder defect fixed and confirmed absent (§5) |
| AI | 🟢 GREEN | Cannot fabricate; fails closed to measured text (§6) |
| Email composition | 🟢 GREEN | 27 MIME tests incl. header-injection |
| Gmail | 🔴 **RED (unvalidated)** | **Never executed against real Google.** Mock only |
| Reply detection | 🟡 YELLOW | Logic verified via mock inbox; real IMAP/Gmail sync unproven |
| CRM / deals / meetings / proposals | 🟢 GREEN | 47/47 revenue assertions |
| Analytics | 🟢 GREEN | Revenue never fabricated (§7) |
| Attribution | 🟢 GREEN | Covered by revenue verification |
| Security | 🟢 GREEN | No secrets in git; no token logging (§8) |
| Performance | 🟡 YELLOW | Indexes correct by inspection; **not load-tested at 10k leads** |
| Docker | 🟡 YELLOW | Compose valid; daemon intermittently hangs (§10) |
| Documentation | 🟢 GREEN | Retention docs match implementation exactly |

---

## 3. What is real and what is mocked

This distinction matters more than any other in this document.

| Capability | Mock verified | Real-credential verified |
|---|---|---|
| Google Places discovery | ✅ | ❌ never |
| Firecrawl crawl/scrape | ✅ | ❌ never |
| Groq AI classification | ✅ | ❌ never |
| Gmail OAuth connect | ✅ | ❌ never |
| Gmail send | ✅ | ❌ **never — no real email has been sent** |
| Gmail inbox sync / replies | ✅ | ❌ never |

`MOCK_EXTERNAL_APIS` is rejected in production (`env.ts:151-155`), and live mode
without credentials fails at boot rather than mid-job (`env.ts:160`). So mock mode
cannot leak into production — but equally, **nothing in the live path has ever
executed.**

---

## 4. Bug found and fixed

### 4.1 `verify:outreach` failed ~6% of runs for no product reason

**Severity:** Medium — a flaky verification suite trains its reader to ignore it.

**Symptom.** `verify:outreach` reported **7 of 29 assertions FAILED**, exit 1.

**Diagnosis.** The mock sender fails deterministically when
`addressHash(to) > 0.94` — a ~6% slice, added so retry and DLQ paths are exercised
by ordinary mock runs. Its docstring justified this as reproducible "because the
same recipient always behaves the same way."

But the verification scripts mint a **fresh random address per run**
(`good-${randomUUID().slice(0,8)}@verify-example.in`) so repeated runs do not
collide in the database. Each run therefore drew a *fresh sample* from the failure
distribution. This run drew `0.9607` and failed.

The premise in the comment was violated by its own callers.

**Confirmed, not assumed:**
- Log showed `code: "PROVIDER_UNAVAILABLE"` — the exact code that branch emits
- `mailable@verify-outreach.test` → hash **0.9607** > 0.94
- Cascade: first send failed → no `SENT` message → the duplicate-send assertion
  failed too, which is *correct product behaviour* (a transiently failed send
  must be retryable), not a second bug

**Product code was correct throughout.** It recorded the failure, marked the
message `FAILED`, and permitted retry. The defect was in the test harness.

**Fix.** `src/modules/providers/mock/email.ts` — reserved the
`@verify-example.in` domain from the probabilistic branch, symmetric with the
existing `ALWAYS_FAIL` / `ALWAYS_RATE_LIMIT` conventions. Checked **after** the
explicit failure prefixes, so `bounce@verify-example.in` still bounces:
determinism means "the address states the outcome", not "everything succeeds".
Ordinary domains keep the realistic failure rate.

**Regression test.** `tests/unit/email/campaign-rules.test.ts` — 7 new tests.
The addresses used (`good-2f`, `good-30`, `good-3c`, `revenue-46`) were *computed*
to hash **above** 0.94 (0.9503 / 0.9558 / 0.9949 / 0.9793), so the test genuinely
reproduces the bug rather than passing by luck.

**Proven to catch the regression:**

```
fix disabled  →  5 failed | 2 passed
fix restored  →  26 passed
verify:outreach → 29/29, exit 0
```

An earlier draft of this test used invented addresses that hashed *below* the
threshold and would have passed without the fix. That draft was discarded.

### 4.2 Not a bug: `verify:pipeline` initial failure

First run showed 5 failures and `0/0 cells completed`. Cause: **the worker was not
running**, a documented precondition. With the worker started: **9/9 pass**. No
code change.

---

## 5. Scoring integrity (Phase 9)

The most consequential defect found in the earlier architecture audit was
`processScore` substituting **hardcoded placeholders** (`contentLength: 2_000`,
`hasContactPage: true`, `isThin: false`) for any lead with a verified website —
meaning part of every such score was fiction.

**Verified fixed:**
- Placeholder literals: **absent** from `processors.ts`
- `processors.ts:732` reads `business.websiteAnalyses[0]` — the stored measurement
- Grep for other hardcoded scores across `src/modules/`: **none**
- `performanceScore` is only ever passed through from the analyzer, which returns
  `null` unconditionally

---

## 6. AI safety (Phase 8)

The spec requires that low-confidence AI must not trigger irreversible actions,
and that explicit unsubscribe signals outrank AI. **Both hold** —
`intent.ts:374-395`:

```ts
suppressPermanently: result.source === 'DETERMINISTIC',
leadEvent:           result.source === 'DETERMINISTIC' ? 'UNSUBSCRIBED' : null,
needsHumanReview:    result.source !== 'DETERMINISTIC',
```

Permanent suppression requires a **regex-matched explicit phrase**. An
AI-inferred unsubscribe stops the campaign (the safe direction) and raises a human
task instead — same outcome for the recipient, but the mistake stays recoverable.

Personalization is equally contained: the sales angle is derived from measurements,
the model may only rephrase it, and any rephrasing that introduces a number or URL
it was not given is discarded in favour of the measured sentence
(`personalization.ts`, verified by 17 unit tests).

---

## 7. Analytics honesty (Phase 24)

Revenue is **not fabricated**. `analytics/revenue.ts` sums only `valuedOpen` /
`valuedWon`; deals nobody has valued are counted separately and excluded, and
`averageDealMinor` is `number | null` — "mean value of WON deals that carry one".

Money is stored in **integer minor units** (`valueMinor`), not floats.

The payload also carries a `notes` object stating which figures are *not*
measurements — replies are manually recorded because the `gmail.send` scope
deliberately cannot read a mailbox. Those caveats travel with the data rather than
living in UI copy, so they survive being read through the API.

---

## 8. Security (Phase 15)

| Check | Result |
|---|---|
| Secrets tracked in git | **none**; `.env` is gitignored |
| Token values in log/console calls | **none** |
| `console.log` in `src/` | **0** |
| `refreshTokenCipher` / `accessTokenCipher` referenced in any route | **never** |
| Production forbids mock mode | enforced, `env.ts:151` |
| Refresh tokens | AES-256-GCM, purpose-bound AAD, 22 crypto tests |

**Route authorization.** Six routes bypass the `handler()` wrapper. All six are
legitimate and each enforces its own access control:

| Route | Justification |
|---|---|
| `/api/health` | deliberately public liveness |
| `/api/auth/login` | no session can exist yet; has same-origin + per-IP rate limit + account lockout |
| `/api/auth/session`, `/api/auth/logout` | call `currentSession()` directly |
| `/api/email/gmail/connect`, `/callback` | call `requireSession()`; connect additionally requires OWNER/ADMIN; callback verifies signed OAuth state against the session's org |

`/api/auth/logout` has no CSRF token, but the session cookie is `sameSite: 'lax'`
— a cross-site POST arrives without it, so there is nothing to revoke. Not a
vulnerability.

**Every other API route** goes through `handler()`, which applies auth, CSRF,
tenant scoping, Zod validation, rate limiting, and error mapping uniformly.

---

## 9. Referential integrity and retention

**FK rules** are coherent — no orphan paths. Two are notably correct rather than
accidental:

- `EmailMessage.businessId → SetNull` — deleting a lead does **not** erase the
  record that a real person was emailed. The compliance trail survives the lead.
- User references → `SetNull` — a departing user does not cascade-delete their
  deals.

Everything else is `Cascade` from `organizationId` / `businessId`.

**Retention docs match implementation**, and the jobs are actually *scheduled*
(a purge function never called is not a policy):

| Policy | Documented | Scheduled |
|---|---|---|
| Google snapshots | 30 days, hourly | `17 * * * *` ✅ |
| Inbound email bodies | 90 days, daily | `23 4 * * *` ✅ |
| Place ID refresh | daily | `0 3 * * *` ✅ |
| Suppression | **never purged** | correct — you must remember who opted out |

`EmailConversation.bodyExpiresAt` is indexed, so the daily purge does not full-scan.

**Indexes** map to real queries: `SalesActivity(organizationId, status, dueAt)` is
exactly the work-queue "follow-ups due" shape; `Deal(organizationId, stage)` is the
Kanban board; tenant-first ordering throughout.

---

## 10. Known gaps and risks

### 🔴 Gmail has never touched Google

The single largest risk. Everything works against `mock-gmail`. Real OAuth token
exchange, real refresh, real send, real inbox sync, and real bounce handling are
**entirely unproven**. See §11.

### 🟡 `CampaignStep` is dead schema

The table exists (`schema.prisma:1937`) with a considered design, but **zero code
references it** — confirmed by grep across `src/`, `scripts/`, `tests/`.
Multi-step follow-up sequences **do not work**; campaigns are single-send.

This is **already declared** in `REVENUE_ENGINE_AUDIT.md:174` ("Absent — campaigns
are single-send"), so it is a documented limitation, not a hidden failure. The
model's own comment notes a campaign with no steps behaves exactly as before the
table existed, so it degrades safely. The residual risk is that dead schema invites
a future reader to assume it works.

### 🟡 Docker daemon instability

`docker compose config` validates and `web`/`worker` exist under
`profiles: ['app']`. But `docker info` **timed out (exit 124)** during this audit,
while `docker ps` had succeeded minutes earlier. The daemon is intermittently
unresponsive on this machine.

Container images were **not built or run** in this audit. Per instruction, no
destructive Docker command was issued and `leadradar-pgdata` was not touched.

**Root cause of the earlier collapse was disk exhaustion** — the drive reached
0.62 GB free, Postgres began blocking writes (reads kept working, which is why
`/api/health` passed while login hung for 317s), and Docker Desktop crashed. The
drive is now at 23 GB free and the containers are healthy. This is an
**environmental** risk, not a code defect, but it will recur if the disk refills.

### 🟡 Not load-tested

Indexes are correct by inspection, and pagination is capped at 200 rows. But the
10,000-lead load test in the brief was **not run**. No N+1 profiling was performed
under volume.

### 🟡 Intermittent Prisma cold-connect

`npx prisma migrate status` failed with `P1001: Can't reach database server` on
first attempt and succeeded on the second, with TCP to 5433 open throughout.
Cold-connection establishment is unreliable on this Windows/Docker port-forward
setup. Retrying resolves it. Worth watching in production deployment.

---

## 11. Before the first real campaign

These steps are **mandatory** and none has been performed.

1. **Free disk headroom.** Keep >10 GB. The failure mode is silent: Postgres
   blocks writes while reads keep working, so the app looks half-alive.
2. **Set real credentials** — `GOOGLE_MAPS_API_KEY`, `FIRECRAWL_API_KEY`,
   `GROQ_API_KEY`, and a 64-hex `ENCRYPTION_KEY`. Set `MOCK_EXTERNAL_APIS=false`.
3. **Run one small live discovery** (a single city, one category) and confirm the
   funnel and cost figures are sane before scaling.
4. **Complete the Gmail OAuth flow against real Google** — see
   `docs/GMAIL_SETUP.md`. Confirm the send scope is granted.
5. **Send a real test to yourself** via `POST /api/email/test`. This is the first
   real email this system will ever have sent.
6. **Run a 3–5 lead campaign to addresses you control.** Verify: arrival, correct
   rendering, `List-Unsubscribe` visible in the client, and that clicking
   unsubscribe suppresses permanently.
7. **Reply to one of those messages** and confirm inbox sync detects it within the
   10-minute cadence, classifies intent, and **stops the campaign for that lead**.
8. **Only then** raise `EMAIL_DAILY_LIMIT` beyond single digits.
9. **Confirm `APP_PUBLIC_URL` is publicly reachable** — a localhost unsubscribe
   link in a real email is a broken legal promise. Boot refuses this in
   production, but verify it resolves externally.
10. **Legal review.** `docs/legal-review-brief.md` §5 (DPDP: business addresses as
    personal data for sole proprietors) is still open and is a prerequisite for
    outreach in India.

---

## 12. Operational workflow

```
DISCOVER    Dashboard → Search. Natural-language query; review the parsed
            criteria and cost estimate BEFORE confirming. Nothing is spent
            until you confirm.

QUALIFY     Leads. Filter: score > 70, has email, website score < 60.
            Flags tell you what to say; the score tells you who to call.

REVIEW      Open a lead. Check the website analysis findings — every claim is
            evidence you can repeat to the prospect. Performance reads
            "Not measured"; that is deliberate, not missing data.

CAMPAIGN    Campaigns → New. Name, template, sender identity, daily limit,
            delay. Add leads by filter. Unmailable leads are listed with a
            reason, so the deliverable count is honest before you commit.

PERSONALIZE Optionally enable AI rephrasing. The observation always comes from
            measurement; the model may only reword it.

GMAIL       Email → Connect Gmail (OWNER/ADMIN only). Send a test to yourself.

TEST        Read the rendered preview on the campaign page. This is the actual
            text that will be sent, per lead — not a template.

ACTIVATE    Type SEND to confirm. Deliberate friction: this is the only action
            that puts mail in a stranger's inbox under your name.

MONITOR     Sales — your daily screen. Replies, meeting requests, pricing
            requests, follow-ups due, stale proposals.

REPLIES     Detected within ~10 min. Follow-ups stop automatically. Intent is
            classified; an explicit unsubscribe suppresses permanently, an
            AI-inferred one pauses and asks you.

DEAL        Create from the lead. Value in minor units; unvalued deals are
            excluded from revenue rather than counted as zero.

MEETING     Manual scheduling and URL. No calendar integration exists — do not
            expect invites to be sent.

PROPOSAL    Draft → Sent → Accepted. Lifecycle tracking only; not a contract.

CLOSE       Move the deal to WON. Lead status and deal stage are related but
            independent, by design.

ANALYZE     Analytics. Funnel counts distinct businesses, so a lead mailed by
            two campaigns cannot appear twice. No revenue is invented.
```

---

## 13. Bottom line

The code is in good shape: 748 tests, 85 end-to-end assertions, a clean build, no
schema drift, no secrets, no fabricated metrics, and one real bug found and fixed
with a regression test proven to catch it.

But **automated tests passing is not the same as production readiness**, and the
brief was right to insist on the distinction. Every external integration in this
system has been exercised only against a mock that this repository also wrote.
Until §11 is complete, the honest status is:

**🟡 YELLOW — ready for supervised first use with real credentials, not for
unattended operation.**
