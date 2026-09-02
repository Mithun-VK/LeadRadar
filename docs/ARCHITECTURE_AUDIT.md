# Architecture Audit — LeadRadar → Outreach

**Date:** 2026-08-29
**Scope:** Audit the existing repository before extending it into a full lead-generation
and outreach system.
**Baseline verified before any change:** `npm run check` → provider guard pass (92 files),
typecheck pass, lint pass (0 warnings), **361 unit tests passing**.

---

## 1. Headline finding

The brief that prompted this work assumes a greenfield or toy repository and specifies a
**separate Python/FastAPI backend**. That assumption is wrong for this repository.

`d:\LeadRadar` contains a **complete, tested, production-shaped lead-generation system**
built over 13 documented phases as a single Next.js/TypeScript full-stack application.
Roughly **70% of the requested product already exists and works** — discovery, crawling,
extraction, verification, scoring, jobs, dashboard, export, auth, and security controls.

Rebuilding that in FastAPI would mean re-implementing 361 passing tests' worth of working,
carefully-reasoned logic in a second language, for no product gain. **Decision (confirmed
with the repository owner): extend the existing Next.js/TypeScript stack.** The requested
`backend/app/...` Python tree is deliberately not created; each of its modules maps onto an
existing `src/modules/*` equivalent (mapping in §7).

The second deviation from the brief is recorded in §8: automated email outreach was
previously ruled **out of scope** in this repository's own roadmap for documented legal
reasons. The owner has explicitly reversed that decision, accepting the tradeoffs. That
reversal — and the safeguards it obliges — is tracked here rather than left implicit.

---

## 2. Existing stack

| Layer      | Technology                            | Notes                                              |
| ---------- | ------------------------------------- | -------------------------------------------------- |
| Framework  | Next.js 16.3 (App Router), React 19.2 | Single app; route handlers are the API             |
| Language   | TypeScript 5, `strict`                | No `any` in module code                            |
| Styling    | Tailwind CSS 4                        | CSS custom properties for the design tokens        |
| Database   | PostgreSQL 17 + Prisma 6.17           | 3 migrations applied                               |
| Queue      | Redis 7 + BullMQ 5                    | 9 queues, DLQ per queue, long-lived worker process |
| Validation | Zod 4                                 | At every trust boundary                            |
| Logging    | Pino 10                               | Structured, redacting, correlation ids             |
| AI         | Groq (`groq-sdk`)                     | The **only** runtime AI provider, guard-enforced   |
| Discovery  | Google Places API (New)               | Enterprise Text Search, minimal field mask         |
| Crawling   | Firecrawl                             | Search + single-page scrape; no whole-site crawl   |
| Export     | ExcelJS                               | CSV + XLSX                                         |
| Tests      | Vitest 3                              | 361 unit + 15 integration (real Postgres)          |
| Container  | Docker Compose                        | Postgres + Redis                                   |

**Toolchain guard:** `npm run guard:providers` fails the build on an Anthropic/Claude SDK
dependency, a hard-coded model id, a `process.env` read outside `src/lib/env.ts`, or a
secret-shaped `NEXT_PUBLIC_*` variable. Any new code must satisfy all four rules.

---

## 3. Existing features (verified by reading the code, not the README)

**Discovery and search**

- Natural-language query → Zod-validated `StructuredQuery` (`src/schemas/query.ts`)
- Cost estimate shown **before** any billable call (`/api/search/parse` is side-effect free)
- Adaptive quadtree geography: a cell is subdivided **only when saturated**
  (`src/modules/search/geography.ts`) — blind subdivision would raise cost per business
- Deterministic pre-enrichment filters (`src/modules/search/filters.ts`)

**Crawling and extraction**

- `WebDiscoveryProvider` abstraction: `search()` + `fetchPage()`, deliberately **no**
  whole-site crawl method (`src/modules/providers/contracts.ts:162`)
- Cost-gated enrichment pipeline (`src/modules/enrichment/pipeline.ts`): candidates from
  data in hand → search only if needed → fetch the single best candidate → one extra page
  only if ambiguous → AI only for the inconclusive band
- Social profile extraction with confidence (`src/modules/enrichment/social.ts`)
- Website quality signals: HTTPS, parked, thin, free hosting, contact funnel, booking
  indicator, link count (`assessWebsiteQuality`, `verification.ts:426`)

**Verification (the strongest part of the codebase)**

- Deterministic weighted matching, phone-dominant (45/100), with per-field evidence spans
- Explicit same-name-different-city guard against the classic false positive
- Third-party-listing disqualification before scoring
- AI adjudicates only the 25–70 ambiguous band, and its verdict is accepted only at
  ≥0.90 confidence

**Scoring**

- Multiplicative `need × value × reach` model with documented rationale for why purely
  additive scoring mis-ranks leads (`src/modules/scoring/config.ts:1-42`)
- Hard caps (low review count, chain, unverified identity, closed)
- `SIGNALS_VERSION` so a weights change recomputes scores **without re-spending budget**
- Service recommendations with rule ids for explainability

**Platform**

- Tenancy: `organizationId` non-null on every business row, first column of composite
  indexes; every repository function takes an explicit `TenantContext`
- Provenance: Google-derived data isolated in a TTL'd `GooglePlaceSnapshot`, purged hourly;
  Place IDs retained indefinitely; own-crawl data durable. **The compliance boundary is a
  schema fact, not a convention.**
- Auth: server-side sessions (hashed tokens), scrypt passwords, lockout, CSRF double-submit
  with HMAC binding, membership re-checked every request
- SSRF guard with DNS pinning, redirect re-validation, and private/metadata range blocking
- Budget enforcement in a Redis token bucket **before** each provider call
- Full mock mode as a first-class runtime mode — the whole product runs with zero credentials

---

## 4. Reusable components (keep and build on)

| Component              | Location                         | Why it is reusable as-is                                                         |
| ---------------------- | -------------------------------- | -------------------------------------------------------------------------------- |
| Provider contracts     | `modules/providers/contracts.ts` | Clean interfaces; adding an email provider follows the same shape                |
| Mock adapters          | `modules/providers/mock/`        | The pattern to copy for a mock Gmail sender                                      |
| Route handler wrapper  | `modules/api/handler.ts`         | Auth, CSRF, Zod, rate limit, error mapping in one place                          |
| Queue infrastructure   | `modules/jobs/queues.ts`         | Policy per queue, DLQ, idempotent ids — an email queue is a config entry         |
| Repositories + tenancy | `modules/database/`              | `TenantContext` pattern extends to campaign tables unchanged                     |
| SSRF guard             | `modules/security/url-guard.ts`  | Required for any new outbound fetch                                              |
| Export policy          | `modules/export/policy.ts`       | Provenance gating + CSV-injection defence; email columns must be classified here |
| Scoring engine         | `modules/scoring/`               | Configurable; opportunity flags derive from existing signals                     |
| UI primitives          | `components/ui/primitives.tsx`   | Grade, provenance, presence, confidence badges                                   |
| API client             | `lib/api-client.ts`              | CSRF handled once, 401 → login                                                   |

---

## 5. Gaps against the target product

| #   | Requirement                                                               | Current state                                     | Work required                                                                                                 |
| --- | ------------------------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| G1  | Email address extraction                                                  | **Absent.** No email field anywhere in the schema | New `EmailCandidate` model; extract from pages the pipeline **already fetches** (near-zero marginal cost)     |
| G2  | Website analysis sub-scores (SEO, mobile, security, performance, content) | Raw boolean signals only                          | New `WebsiteAnalysis` model + analyzer producing sub-scores **only from what a page fetch honestly supports** |
| G3  | Explicit opportunity flags                                                | Implicit in service recommendations               | Derive a first-class `opportunityFlags[]` from existing signals                                               |
| G4  | Gmail OAuth + sending                                                     | **Absent entirely**                               | `EmailSendProvider` contract + Gmail adapter + mock; OAuth routes; encrypted refresh-token storage            |
| G5  | Campaigns, templates, suppression                                         | **Absent entirely**                               | 6 new models; campaign lifecycle service; suppression checked before every send                               |
| G6  | AI outreach personalization                                               | AI tasks are classification-only by design        | New constrained AI task; must not fabricate facts (see §8)                                                    |
| G7  | CSV import                                                                | Export only                                       | Import with flexible column mapping + validation summary                                                      |
| G8  | Analytics endpoints                                                       | Cost/usage only                                   | Funnel + campaign analytics                                                                                   |
| G9  | Settings write path                                                       | Read-only by deliberate design                    | Add **validated, non-budget** tenant settings only; env stays authoritative for spend                         |

---

## 6. Problems and technical debt found

| Severity   | Finding                                                                                                                                                                                                                                                                                              | Location                                 |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| **Medium** | `processScore` re-derives website quality from **hardcoded placeholder values** (`contentLength: 2_000`, `hasContactPage: true`, `isThin: false`) rather than stored signals. Scoring is therefore partly fictional for any lead with a verified website. G2 fixes this by persisting real analysis. | `modules/jobs/processors.ts:609-621`     |
| **Medium** | `ENCRYPTION_KEY` is validated at boot and required in production, but **nothing in the codebase uses it** — there is no crypto module. G4 needs it for refresh tokens.                                                                                                                               | `lib/env.ts:98`, no consumer             |
| Low        | Dead code in the enrichment error path: `usage.push(...(homepage.error instanceof AppError ? [] : []))` pushes nothing in both branches.                                                                                                                                                             | `modules/enrichment/pipeline.ts:291`     |
| Low        | `allowedOrigins()` returns a hardcoded empty array with no configuration path. Fine today (same-origin only), but it will silently block a split deployment.                                                                                                                                         | `modules/api/handler.ts:80`              |
| Low        | `sessionId` is assigned then explicitly discarded via `void sessionId` in the handler wrapper.                                                                                                                                                                                                       | `modules/api/handler.ts:154`             |
| Low        | Same-name-different-city guard hardcodes an India-specific city list. Documented as India-tuned, but it is a correctness limit outside India.                                                                                                                                                        | `modules/enrichment/verification.ts:260` |
| Note       | `reviewVelocity()` is implemented and wired into scoring, but needs two snapshots ≥1 day apart, so it is null on fresh data. Not a defect — worth knowing when reading scores.                                                                                                                       | `database/repositories.ts:389`           |

None of these block the extension work. G2 resolves the most consequential one as a
side effect.

---

## 7. Requested Python structure → existing TypeScript equivalent

The brief's `backend/app/**` tree maps one-to-one onto modules that already exist. No
functionality is dropped by not creating it:

| Brief (FastAPI)                       | This repository                                                           |
| ------------------------------------- | ------------------------------------------------------------------------- |
| `api/routes/leads.py`                 | `src/app/api/leads/`                                                      |
| `api/routes/crawl.py`                 | `src/app/api/search/` (crawl is a pipeline stage, not a user-facing verb) |
| `api/routes/campaigns.py`             | **new** `src/app/api/campaigns/`                                          |
| `api/routes/email.py`                 | **new** `src/app/api/email/`                                              |
| `api/routes/analytics.py`             | **new** `src/app/api/analytics/`                                          |
| `api/routes/settings.py`              | **new** `src/app/api/settings/`                                           |
| `api/routes/health.py`                | `src/app/api/health/`                                                     |
| `core/config.py`                      | `src/lib/env.ts`                                                          |
| `core/security.py`                    | `src/modules/security/` + `src/modules/auth/`                             |
| `core/logging.py`                     | `src/lib/logger.ts`                                                       |
| `db/models.py`, `migrations/`         | `prisma/schema.prisma`, `prisma/migrations/`                              |
| `schemas/*.py` (Pydantic)             | `src/schemas/`, `src/types/domain.ts` (Zod)                               |
| `services/crawler/`                   | `src/modules/providers/firecrawl/` + `enrichment/`                        |
| `services/lead_extraction/`           | `src/modules/enrichment/`, `src/modules/leads/normalize.ts`               |
| `services/lead_scoring/`              | `src/modules/scoring/`                                                    |
| `services/deduplication/`             | `upsertDiscoveredBusiness` (Place-ID keyed) + domain/phone normalization  |
| `services/email/`, `personalization/` | **new** `src/modules/email/`                                              |
| `workers/*.py`                        | `src/workers/index.ts` + `src/modules/jobs/processors.ts`                 |

`/docs` and `/redoc` (brief §20) have no Next.js equivalent. An OpenAPI document is
generated from the Zod schemas instead, so the API stays documented from a single source
of truth rather than a hand-written spec that drifts.

---

## 8. Deviations from the brief, and why

**8.1 No Python/FastAPI backend.** See §1 and §7. Confirmed with the owner.

**8.2 Automated Gmail outreach is being built, reversing a prior documented decision.**
`docs/roadmap-v2.md` explicitly excluded automated sending: _"Turns a data product into a
sending platform, with deliverability, consent, and TRAI/DPDP exposure attached."_ The
owner has reviewed that and accepted the tradeoffs. Consequences that are now **mandatory
rather than optional**, and are treated as acceptance criteria:

- Suppression list checked before _every_ send, with no bypass path
- Per-campaign daily limits and inter-send delay enforced in the worker, not the UI
- One send per (campaign, lead) — enforced by a unique constraint, not by application care
- Unsubscribe mechanism present in every outbound message
- Campaigns require explicit activation; nothing sends on discovery
- `docs/roadmap-v2.md` updated so the repository does not contain two contradictory
  positions on the same question

**8.3 No fabricated website metrics.** The brief asks for performance and mobile scores.
A single page fetch cannot honestly measure Core Web Vitals, traffic, or rankings, and
`docs/roadmap-v2.md` §V2.4 is right that presenting a guess as a measurement is what
destroys trust in a lead list. Sub-scores are computed **only** from evidence actually
present in the fetched page (viewport meta tag, HTTPS, title/meta/H1, image alt coverage,
structured data, content volume, link graph). Anything not measured is reported as
"not measured", never as zero or as an estimate.

**8.4 Settings stay mostly read-only.** Spending limits and provider mode remain
environment configuration. Putting the budget guard behind a web form would place the
strongest cost control behind the weakest boundary. Only non-financial tenant preferences
become writable.

---

## 9. Migration strategy

Additive throughout. No existing table is dropped or repurposed; no existing module is
rewritten. Each phase ends green on `npm run check`.

| Phase | Work                                                                                                                                          | Risk                                                                       |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| **A** | Contact extraction (`EmailCandidate`) + website analysis (`WebsiteAnalysis`) + opportunity flags. Fixes the placeholder-scoring defect in §6. | Low — additive tables, existing pipeline already fetches the pages         |
| **B** | Crypto module (finally uses `ENCRYPTION_KEY`), `EmailSendProvider` contract, Gmail adapter + mock, OAuth routes, encrypted token storage      | Medium — OAuth flow; mitigated by mock adapter and mocked tests            |
| **C** | Campaign domain: templates, campaigns, campaign leads, messages, events, suppression. Lifecycle service.                                      | Medium — the compliance-critical phase; safeguards from §8.2 are the tests |
| **D** | Email queue + send worker: rate limiting, retries, suppression enforcement, status tracking                                                   | Medium — must not be able to send twice                                    |
| **E** | AI personalization as a constrained task; facts come from stored data only                                                                    | Low — reuses the existing containment design                               |
| **F** | Frontend: opportunity flags on leads, lead-detail analysis panel, campaign builder, templates, analytics                                      | Low                                                                        |
| **G** | CSV import, analytics endpoints, OpenAPI document, docs, Dockerfile for web + worker                                                          | Low                                                                        |

**Rollback:** no phase mutates data written by an earlier one, and every change is
additive — no existing table is dropped or repurposed.

**Correction to the plan as executed:** phases A–G were implemented as separate code
changes but share a **single migration**
(`20260829174629_phase15_contacts_analysis_outreach`) rather than one per phase. The
new tables are interdependent — `Business` gains relations to both
`EmailCandidate` and `CampaignLead` — so splitting them would have meant two Prisma
migrations touching the same table minutes apart, which is more risk than it
removes, not less. Verified applying cleanly to an empty database with zero
subsequent schema drift.

---

## 10. Files to create and change

**New Prisma models:** `EmailCandidate`, `WebsiteAnalysis`, `GmailAccount`, `EmailTemplate`,
`Campaign`, `CampaignLead`, `EmailMessage`, `EmailEvent`, `SuppressionEntry`,
`OrgSetting`. Plus `opportunityFlags String[]` on `Business`.

**New modules:** `src/lib/crypto.ts`, `src/modules/enrichment/contacts.ts`,
`src/modules/enrichment/website-analysis.ts`, `src/modules/scoring/flags.ts`,
`src/modules/email/{templates,personalization,suppression,campaigns,send}.ts`,
`src/modules/providers/gmail/{provider,schemas}.ts`, `src/modules/leads/import.ts`,
`src/modules/analytics/`.

**New routes:** `/api/campaigns/**`, `/api/templates/**`, `/api/email/**`,
`/api/analytics/**`, `/api/settings`, `/api/leads/import`.

**Changed (extended, not rewritten):** `prisma/schema.prisma`, `src/lib/env.ts`,
`src/modules/providers/contracts.ts`, `src/modules/providers/registry.ts`,
`src/modules/enrichment/pipeline.ts`, `src/modules/jobs/{queues,schemas,processors}.ts`,
`src/workers/index.ts`, `src/modules/export/policy.ts`,
`src/modules/database/repositories.ts`, dashboard pages, `.env.example`, `README.md`,
`docs/roadmap-v2.md`.

---

## 11. Baseline to preserve

Every phase must leave these green. They are the definition of "not broken":

```
npm run guard:providers   # 4 hard project rules
npm run typecheck         # tsc --noEmit
npm run lint              # eslint, 0 warnings
npm run test              # 361 tests at audit time, growing
npm run test:integration  # 15 tests against real PostgreSQL
```
