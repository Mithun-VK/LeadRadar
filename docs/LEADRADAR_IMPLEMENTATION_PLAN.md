# LeadRadar — Implementation Plan

**Status:** Phase 0 complete (audit + plan). Implementation begins at Phase 1.
**Author:** Principal engineer (Claude Code as development agent).
**Runtime AI provider:** Groq. **Claude API is NOT integrated into the product.**

---

## 1. Repository Assessment

`d:\LeadRadar` was empty at the start of this engagement. Full audit:

| Check | Finding | Consequence |
|---|---|---|
| Repository contents | Empty directory | Greenfield |
| Git | Not a git repository | `git init` required in Phase 1 |
| Existing framework | None | Adopt Next.js App Router as specified |
| Package manager | None installed in repo; npm 11.5.2 on host | **npm** (no pnpm/yarn lockfile to honour) |
| `package.json` | Absent | Created in Phase 1 |
| Environment config | Absent | `.env.example` created in Phase 1 |
| Database config | Absent; host has `psql` 17.6 | Postgres 17 via Docker Compose |
| Routes | None | Clean App Router tree |
| UI components | None | shadcn/ui from scratch |
| Tests | None | Vitest from scratch |
| Docker config | Absent; Docker 28.3.2 on host | Compose for Postgres + Redis |
| Deployment config | Absent | Documented in Phase 13 |
| Reusable modules | None | — |
| Technical debt | **None inherited** | No refactor budget needed |
| Conflicting dependencies | None | Free choice of versions |
| Must preserve | **Nothing** | No destructive risk in any phase |

**Toolchain:** Node v22.14.0, npm 11.5.2, Docker 28.3.2, PostgreSQL client 17.6.

Because nothing exists, the "do not destroy working functionality" rule is trivially satisfied. From Phase 1 onward it becomes a live constraint: each phase must leave `typecheck`, `lint`, and `test` green before the next begins.

---

## 2. Current Architecture

None. This section exists so future audits can diff against it.

---

## 3. Target Architecture

### 3.1 Shape

LeadRadar is a **staged, cost-gated enrichment pipeline** fronted by a Next.js SaaS dashboard, with all expensive work pushed onto BullMQ workers.

```
Next.js (App Router)          Workers (long-lived Node process)
┌────────────────────┐        ┌──────────────────────────────────┐
│ /dashboard/*  RSC  │        │ search        → plan + fan-out   │
│ /api/*  route      │        │ google-places → discovery        │
│         handlers   │──BullMQ│ website-discovery → Firecrawl /search
│                    │  jobs  │ website-verification → deterministic
│ Zod at every edge  │───────▶│ firecrawl     → scrape           │
└────────────────────┘        │ groq          → ambiguous only   │
         │                    │ scoring       → deterministic    │
         │                    │ export        → CSV/XLSX         │
         ▼                    └──────────────────────────────────┘
   PostgreSQL (Prisma)  ◀────────────────┘         │
   Redis (queues, rate limits, budget tokens, cache)
```

### 3.2 Layering rule

Domain logic never imports a provider SDK. Providers implement interfaces:

- `BusinessDiscoveryProvider` — Google Places today, Overture/OSM tomorrow
- `WebDiscoveryProvider` — Firecrawl today
- `AIProvider` — Groq today
- `WebsiteVerificationProvider` — internal deterministic engine, AI-assisted

Each has a **real** implementation and a **mock** implementation selected by `MOCK_EXTERNAL_APIS`. Mock mode is not a test fixture — it is a first-class runtime mode, so the entire product is demonstrable with zero credentials.

### 3.3 Directory layout

```
src/
  app/
    (marketing)/                 # public shell, later
    dashboard/                   # search, leads, jobs, usage, settings
    api/                         # route handlers only — thin, Zod-validated
  components/
    ui/                          # shadcn/ui primitives
    leads/  search/  usage/      # feature components
  modules/
    ai/            # task orchestration, confidence routing, injection defence
    database/      # Prisma client, repositories, tenant scoping
    enrichment/    # website discovery, verification, social, digital presence
    export/        # CSV/XLSX writers + ExportPolicyService
    google-places/ # geographic strategy, search planner, dedupe
    jobs/          # queue definitions, producers, job schemas
    leads/         # lead assembly, qualification
    scoring/       # opportunity score, lead score, service recommendation
    search/        # NL → structured query → search plan → cost estimate
    security/      # SSRF guard, URL validation, sanitizers, audit log
    providers/
      google-places/  groq/  firecrawl/
  lib/             # logger, env, errors, result types, redis, money
  schemas/         # Zod schemas shared by API, workers, AI
  types/           # domain types (no provider types leak here)
  workers/         # worker entrypoints, graceful shutdown
tests/  unit/ integration/ e2e/
prisma/ schema.prisma  migrations/  seed.ts
docs/
```

---

## 4. Dependency Changes

Nothing to remove. Additions (all pinned via lockfile):

**Runtime:** `next`, `react`, `react-dom`, `typescript`, `@prisma/client`, `prisma`, `bullmq`, `ioredis`, `zod`, `groq-sdk` *(OpenAI-compatible; no Anthropic SDK anywhere)*, `@tanstack/react-table`, `react-hook-form`, `@hookform/resolvers`, `tailwindcss`, `clsx`, `tailwind-merge`, `class-variance-authority`, `lucide-react`, `exceljs`, `pino`, `pino-pretty`, `nanoid`.

**Dev:** `vitest`, `@vitest/coverage-v8`, `eslint`, `eslint-config-next`, `prettier`, `tsx`, `@types/*`, `msw` (provider HTTP contract tests), `@playwright/test` (E2E, Phase 12).

**Deliberately excluded:** any Anthropic/Claude SDK; any headless-browser dependency (Firecrawl owns rendering); ORMs other than Prisma; a second HTTP client (native `fetch`).

**Guardrail:** a lint rule and a CI grep forbid `@anthropic-ai`, `anthropic`, and `claude-` model ids in `src/`.

---

## 5. Database Architecture

### 5.1 The governing constraint: data provenance

Google Maps Platform policy permits storing **Place IDs indefinitely** but restricts caching/storing other Places content, and requires attribution. Google also recommends refreshing Place IDs older than ~12 months (free, via an IDs-only request). A lead-gen product cannot therefore treat Google fields as a permanent owned asset.

The schema encodes this physically, not as a convention:

| Class | Table(s) | Retention | Exportable by default |
|---|---|---|---|
| **Place identity** | `PlaceIdentifier` | Indefinite (Place ID + our hashes only) | Yes |
| **Google-derived snapshot** | `GooglePlaceSnapshot` | TTL, `expiresAt` set on write, purged by cron; refreshed on demand | **No** — policy-gated |
| **Independently discovered web data** | `WebsiteCandidate`, `WebsiteVerification`, `SocialProfile`, `WebFact` | Indefinite (our own crawl of the business's own site) | Yes |
| **Application intelligence** | `LeadScore`, `OpportunityScore`, `ServiceRecommendation`, `AIAnalysis`, `DigitalPresence` | Indefinite | Yes |
| **Operational** | `SearchJob`, `EnrichmentJob`, `ExportJob`, `ApiUsage`, `SystemEvent`, `AuditLog` | Indefinite (metrics/audit) | Internal |

`Business` is the **normalized join** keyed on `PlaceIdentifier`, holding fields our own pipeline re-grounded from independent sources plus derived intelligence. Google-only fields (rating, reviewCount, googleMapsUri, google-listed website) live in the TTL'd snapshot and are read through `GoogleDataPolicyService`, never selected directly by feature code.

This is the single most important structural decision in the product: it makes the compliance boundary a compile-time fact, and the mandatory refresh loop doubles as **change detection** — a genuine V2/V3 feature that falls out of a constraint.

### 5.2 Tenancy from day one

Every business-owned row carries `organizationId` (non-null, indexed, first column of composite indexes). Phase 1 seeds a single default organization; auth arrives later without a migration of ownership semantics. All repository functions take an explicit `TenantContext` — there is no un-scoped query helper.

### 5.3 Core entities

`Organization`, `User`, `Membership`, `Project`, `SearchJob`, `SearchQuery`, `Business`, `PlaceIdentifier`, `GooglePlaceSnapshot`, `WebsiteCandidate`, `WebsiteVerification`, `SocialProfile`, `DigitalPresence`, `EnrichmentJob`, `AIAnalysis`, `LeadScore`, `ServiceRecommendation`, `ExportJob`, `ApiUsage`, `Budget`, `SystemEvent`, `AuditLog`.

Key indexes: `PlaceIdentifier(googlePlaceId)` unique; `Business(organizationId, opportunityScore desc)`; `Business(organizationId, city, category)`; `ApiUsage(organizationId, provider, createdAt)`; `GooglePlaceSnapshot(expiresAt)` for the purge job.

---

## 6. API Architecture

Route handlers are thin: authenticate → resolve tenant → Zod-parse → call a module service → serialize. No business logic, no provider calls, no SQL in handlers.

```
POST /api/search/parse       NL text → structured query (Groq) + cost estimate. No side effects.
POST /api/search             Create SearchJob, enqueue. Returns jobId.
GET  /api/search/:id         Job status + progress.
GET  /api/leads              Paginated, filtered, sorted lead list.
GET  /api/leads/:id          Full lead profile with provenance labels.
POST /api/leads/:id/enrich   Manual re-enrichment (budget-checked).
POST /api/export             Create ExportJob (format + field policy).
GET  /api/export/:id         Download when ready.
GET  /api/usage              Provider counts, cost, cost/qualified-lead.
GET  /api/health             Liveness + dependency checks.
```

`/api/search/parse` is separate from `/api/search` on purpose: the user reviews parsed criteria and the cost estimate **before** any billable discovery runs.

---

## 7. Worker Architecture

Queues: `search`, `google-places`, `website-discovery`, `website-verification`, `firecrawl`, `groq`, `scoring`, `export`.

Per-queue policy: bounded concurrency (from env), exponential backoff with jitter, explicit `timeout`, `attempts`, `removeOnComplete` caps, and a dead-letter queue per source queue with the original payload plus failure trail.

**Idempotency** is by deterministic job id, so BullMQ itself dedupes retries and re-runs:
- `discover:{searchJobId}:{cellId}:{categoryId}:{pageIndex}`
- `discover-website:{placeIdHash}`
- `verify:{placeIdHash}:{domainHash}`
- `score:{businessId}:{signalsVersion}`

`signalsVersion` in the scoring key means a weights change recomputes scores, while unchanged inputs never re-spend anything.

**Budget enforcement happens before the provider call**, in a Redis Lua token-bucket that atomically decrements job/daily/monthly allowances. Checking after the call — or in application code — lets concurrency overshoot the budget. Exhaustion pauses the queue and emits a `BUDGET_EXHAUSTED` `SystemEvent` rather than failing jobs.

Why asynchronous at all: a five-city, two-category search fans out to hundreds of paginated provider calls with third-party rate limits and multi-minute wall time. That cannot live in a request. Queues also give retry isolation (one dead website doesn't fail a search), fair provider pacing, resumability after a crash, and a natural place to enforce spend.

---

## 8. Security Architecture

Full threat model in `docs/security.md` (Phase 11). Load-bearing controls:

1. **SSRF** — the primary risk, because the server fetches URLs influenced by search results and by Google's `websiteUri`. `validateExternalUrl()` enforces: https/http only; port 80/443 only; DNS resolution followed by rejection of loopback, private IPv4 (RFC1918), CGNAT (100.64/10), link-local (169.254/16, fe80::), unique-local IPv6 (fc00::/7), `::1`, `0.0.0.0`, and cloud metadata (`169.254.169.254`, `metadata.google.internal`); **connect to the resolved-and-pinned IP with an explicit `Host` header** to defeat DNS rebinding; max 2 redirects with full re-validation of each hop; 5 s timeout; 2 MB response cap enforced while streaming.
2. **Prompt injection** — scraped pages are untrusted. Page text enters the model only in a data channel, fenced and length-capped, after stripping scripts, comments, and hidden text. The system prompt states that fenced content is data. Crucially, **the blast radius is bounded by design**: Groq may only return a constrained enum plus a confidence number, Zod-validated; it can never emit a fact, a URL, a score, or SQL. Deterministic code owns every number that reaches the user.
3. **AI output containment** — no tool calling, no function execution, no SQL generation, no queue control. Schema violation → retry once with a repair prompt → fall back to `UNKNOWN` and flag for manual review.
4. **Fact integrity** — the AI never *emits* facts, only *classifies* facts already extracted deterministically (regex/parser over scraped text). This structurally eliminates hallucinated phone numbers and addresses.
5. **Tenant isolation** — `organizationId` required in every repository call; integration tests assert cross-tenant reads return zero rows.
6. **CSV injection** — cells beginning `= + - @`, tab, or CR are prefixed with `'` in both CSV and XLSX.
7. **Secrets** — server-only; `env.ts` fails fast at boot; no secret may be referenced under `NEXT_PUBLIC_*` (enforced by lint rule); logger redacts `authorization`, `apiKey`, `password`, `DATABASE_URL`, cookies.
8. **Abuse** — per-tenant and per-IP rate limits on all mutating routes; job-flood protection via queue depth caps and per-tenant concurrency.

---

## 9. Cost-Control Strategy

### 9.1 Verified provider pricing (researched, not assumed)

**Google Places API (New)** — the March 2025 change replaced the old $200 pooled monthly credit with **per-SKU free monthly allowances**: Essentials 10,000, Pro 5,000, Enterprise 1,000 billable events per SKU per month.

| SKU | Price / 1,000 | Free / month |
|---|---|---|
| Text Search Essentials (IDs Only) | **$0.00** | Unlimited |
| Place Details Essentials | $5.00 | 10,000 |
| Text Search Pro | $32.00 | 5,000 |
| Place Details Pro | $17.00 | 5,000 |
| **Text Search Enterprise** | **$35.00** | **1,000** |
| Place Details Enterprise | $20.00 | 1,000 |

Field → SKU tier mapping (decisive for LeadRadar):
- **Essentials:** `id`, `name`, `formattedAddress`, `location`, `types`
- **Pro:** `displayName`, `businessStatus`, `googleMapsUri`, `primaryType`
- **Enterprise:** `rating`, `userRatingCount`, `websiteUri`, `nationalPhoneNumber`, `internationalPhoneNumber`, `regularOpeningHours`
- **Enterprise + Atmosphere:** `reviews`, `editorialSummary`, amenity fields

LeadRadar needs rating, review count, website, and phone → it is **inherently an Enterprise-tier product**. It must never request `reviews` or `editorialSummary`, which would escalate to Atmosphere for no product value.

**Correction to a natural assumption:** the "free IDs-only Text Search, then Place Details for the fields we need" pattern is a cost *trap*. Text Search is billed **per request** and returns up to 20 places per page, so one Enterprise Text Search costs `$0.035 ÷ 20 = $0.00175` per business. Place Details Enterprise costs `$0.020` per business — **~11× more**. Correct design: **one Enterprise Text Search with a tight field mask is the enrichment step.** The free IDs-only SKU is for Place-ID refresh, existence checks, and dedupe — never for bulk field acquisition.

**Firecrawl** — 1 credit per page for scrape/crawl/map/monitor; **2 credits per 10 results** for search; 2 credits per browser-minute for interact. Free 1,000 credits/month. Standard $83/mo (annual) for 100,000 credits ⇒ **$0.00083/credit**; pay-as-you-go $5 per 1,000 ⇒ $0.005/credit. Rate limits (Standard): 500 rpm scrape/search, 50 concurrent browsers.

**Groq** — `openai/gpt-oss-20b` at **$0.075 / 1M input, $0.30 / 1M output**; `openai/gpt-oss-120b` $0.15/$0.60; `llama-3.1-8b-instant` $0.05/$0.08; `llama-3.3-70b-versatile` $0.59/$0.79. Batch API and prompt caching each cut ~50% and stack. A typical LeadRadar classification (~3,000 in / 200 out on gpt-oss-20b) costs **$0.000285**.

### 9.2 The cost hierarchy is wrong as commonly stated

The intuitive ordering puts AI last as "most expensive." At current prices that is inverted:

| Operation | Unit cost | Rank |
|---|---|---|
| Local computation / Postgres filter | ~$0 | 1 |
| Cached result (Redis) | ~$0 | 2 |
| **Groq classification** | **$0.000285** | **3** |
| Firecrawl scrape (1 page) | $0.00083 | 4 |
| Firecrawl search (10 results) | $0.00166 | 5 |
| Google Text Search Enterprise (per business) | $0.00175 | 6 |
| Google Place Details Enterprise (per business) | $0.020 | 7 |

**Groq is roughly 3× cheaper than a single page scrape and 6× cheaper than a web search.** The operative principle is therefore not "avoid AI" — it is:

> Avoid **network** calls. Among network calls, avoid the ones billed **per business record** (Google Enterprise details) and **per page fetched** (Firecrawl) long before you worry about tokens.

"Don't use AI when rules will do" still holds, but for correctness, determinism, and explainability — not for cost. Where one Groq call **replaces** a Firecrawl fetch (e.g. deciding a second page is unnecessary), calling Groq is the *cheaper* choice. This reframing is applied throughout the pipeline design.

### 9.3 The funnel

For dental clinics across Chennai / Bangalore / Mumbai / Delhi / Hyderabad, per **N businesses discovered** (all thresholds configurable):

| Stage | Rate | Volume at N=10,000 |
|---|---|---|
| Discovered | N | 10,000 |
| Pass deterministic filter (rating, reviews, open, non-chain) | 45% | 4,500 |
| Need web search (no Google website) | 35% of filtered | 1,575 searches |
| Homepage scrape (candidate found, or thin/parked site to assess) | 76% of filtered | 3,430 scrapes |
| Second page (contact/about) needed | 30% of scrapes | 1,030 scrapes |
| Ambiguous → Groq match adjudication | 20% of filtered | 900 calls |
| Qualified leads (A/B grade) | ~25% of N | ~2,500 |

Unit economics, list price, Standard Firecrawl plan:

| Provider | Per business discovered |
|---|---|
| Google (Text Search Enterprise, ~13 unique businesses per billed request after page fill + overlap dedupe) | $0.00269 |
| Firecrawl (~0.76 credits) | $0.00063 |
| Groq (parse + classify + adjudicate + narrative) | $0.00013 |
| **Total** | **≈ $0.00346** |
| **Per qualified lead** | **≈ $0.0138 (~₹1.2)** |

### 9.4 Scenario costs

| Scenario | Discovered | Google requests | Firecrawl credits | Groq | Marginal cost (free tiers applied) | List cost |
|---|---|---|---|---|---|---|
| A | 100 | 8 | 76 | $0.013 | **$0.00** (inside all free tiers) | $0.35 |
| B | 1,000 | 77 | 762 | $0.13 | **≈$0.13** | $3.46 |
| C | 10,000 | 770 | 7,620 | $1.34 | **≈$41** (Google free; Firecrawl PAYG) | $34.60 |
| D | 100,000 | 7,692 | 76,200 | $13.40 | **≈$330/mo** ($234 Google + $83 Firecrawl Standard + $13 Groq) | — |

**The headline FinOps fact:** 1,000 free Enterprise Text Search calls/month ≈ **13,000 businesses/month at zero marginal Google cost**. MVP and early production are effectively free. Therefore the caching layer's job is **compliance, latency, and rate-limit headroom — not cost.** Do not over-engineer caching for savings that don't exist yet.

### 9.5 Architecture A vs B

**A (naive):** Google Place Details per business → Firecrawl crawl every site → Groq every business.
At N=100,000: Google $2,000 + Firecrawl ~1.5M credits (~$7,500 PAYG) + Groq $28 ≈ **$9,528**.

**B (staged, chosen):** ≈ **$330**. **~29× cheaper.**

The savings come almost entirely from (a) not using Place Details, and (b) not crawling whole sites. **Groq is 0.3% of the naive total** — proof that AI is not the cost driver. The expensive mistakes are per-record Google SKUs and unbounded page fetching.

### 9.6 Enforcement

`ProviderPricingConfig` is a single typed config (no prices scattered in code); every provider call writes an `ApiUsage` row with duration, status, and estimated cost; pre-flight estimates are shown before execution; job/daily/monthly budgets are enforced by the Redis token bucket described in §7.

---

## 10. Product Corrections

Two product assumptions are worth challenging before they get baked in.

**"No website on Google" is a weak primary filter.** It both over- and under-selects. Under-selects: a `websiteUri` frequently points at a Zomato/Practo/Justdial listing, a Facebook page, or a Linktree — the business has *no owned site*, yet the naive filter discards it, and it is an excellent web-development lead. Over-selects: a business with no Maps website may still have a perfectly good site Google simply doesn't list. Hence the website state machine has a distinct `GOOGLE_WEBSITE_IS_THIRD_PARTY_LISTING` state, and the pipeline **scores the digital gap rather than filtering on field absence**. This materially widens the addressable lead pool and is the defensible product edge over every Maps scraper.

**Purely additive scoring mis-ranks leads.** Website-absence (+30) plus no-verified-website (+25) is 55 points for *need alone*, so a 4.0-rated clinic with 20 reviews reaches grade A — a business that may have no budget. Commercial opportunity is `Need × Ability-to-pay × Reachability`, and review volume/rating are the ability-to-pay proxy. The engine therefore uses a **gated multiplicative model** — `100 × need × value × reach` — with a hard floor (fewer than 10 reviews caps the grade at C), while still reporting an additive-looking breakdown for explainability. Also: franchise/chain membership is a **negative** signal (decisions are made at HQ, not at the location), not the naive "+5 multiple branches."

Both are implemented as configuration with documented rationale, so they can be tuned against real conversion data.

---

## 11. Implementation Phases

Each phase ends with: `npm run typecheck`, `npm run lint`, `npm test` green; docs updated; security and cost implications reviewed; one logical commit.

| Phase | Objective | Key deliverables | Failure points |
|---|---|---|---|
| **0** | Audit + plan | This document | — |
| **1** | Foundation | git init, Next.js+TS, Tailwind, env validation, logger, error types, Result, Zod base, provider interfaces, Prisma init, Docker Compose, mock-mode wiring, Vitest | Env schema too strict for mock mode; Windows/Docker path issues |
| **2** | Database | Full `schema.prisma`, migration, provenance split, tenant scoping, repositories, seed | Getting the Google-TTL split wrong later forces a painful migration |
| **3** | Google Places | Client, field masks, pagination, normalizer, dedupe, errors, rate limit, usage tracking, mock provider | Field mask accidentally escalating SKU; pagination billing surprise |
| **4** | Search engine | Structured query schema, validation, geographic strategy (adaptive subdivision), search plan, cost estimator, deterministic filters | Over-subdivision *raising* cost via thin pages |
| **5** | Firecrawl | Search, scrape, minimal-operation selection, candidate discovery, rate limit, usage, mock | Unbounded page fetching; blocked/CAPTCHA sites |
| **6** | Groq | Query parser, structured output + repair, website matching, digital-presence classification, service recommendation, injection defence | Schema drift; injection via scraped text |
| **7** | Scoring | Opportunity score, lead score, service recommendation, `signalsVersion`, full explainability | Weights that don't survive contact with real conversions |
| **8** | Workers | All 8 queues, retries, backoff, timeouts, concurrency, idempotent job ids, DLQ, progress, budget bucket | Redis command volume; lost jobs on shutdown |
| **9** | Dashboard | Search UI, parsed criteria, cost estimate, job progress, lead table, filters, lead detail, usage dashboard | Provenance labels omitted in UI |
| **10** | Export | CSV, XLSX, `ExportPolicyService`, CSV-injection escaping | Exporting policy-restricted Google fields |
| **11** | Security | Full audit against §8, SSRF suite, threat model doc | DNS rebinding; redirect revalidation |
| **12** | Testing | Full unit/integration/security/E2E suite | Flaky E2E without deterministic mocks |
| **13** | Hardening | Health checks, graceful shutdown, worker monitoring, prod env validation, deploy docs | Worker not draining in-flight jobs |

### Geographic strategy (Phase 4 detail)

No hardcoded neighbourhoods. A `city` registry holds a bounding box per city; an **adaptive quadtree** issues Text Search with `locationRestriction` per cell and **splits a cell only when it saturates** (returns the documented 60-result maximum across 3 pages). Non-saturated cells are never split — over-subdivision produces many thin, partially-filled pages, and because Text Search bills per request, that *increases* cost per business. Cell saturation state is persisted so re-runs skip settled cells. This generalises to any city, seeded from open admin-boundary data rather than a Chennai-specific list.

---

## 12. Testing Strategy

Unit (pure, fast): query-parser schema handling, Google normalization, dedupe, domain/phone normalization, deterministic website matching, opportunity + lead scoring, digital-presence rules, export policy, CSV escaping.
Security: SSRF matrix (localhost, 127.0.0.1, 0.0.0.0, `::1`, RFC1918, CGNAT, link-local, ULA, metadata IP + hostname, redirect-to-private, DNS-rebinding), prompt-injection corpus, CSV injection, secret redaction, cross-tenant isolation.
Integration: Prisma against a real Postgres; BullMQ retries/backoff/idempotency/DLQ against a real Redis; provider HTTP contracts via MSW.
E2E (Playwright, mock mode): "Find dental clinics in Chennai with no website and more than 50 reviews" → parsed query → validation → plan → mock Google → dedupe → filter → website discovery → verification → Groq only when ambiguous → scoring → dashboard row → CSV export. Fully deterministic; zero credentials; runs in CI.

---

## 13. Deployment Strategy

BullMQ needs a long-lived process, so the web and worker tiers deploy separately.

**MVP / early production (recommended, cheapest sensible):** Next.js on Vercel; Postgres on Neon; **Redis and the worker container co-located on Railway or Fly.io**. Co-location matters: BullMQ's blocking reads generate very high command volume, and per-command serverless Redis pricing (Upstash PAYG) can cost more than the entire API bill for the same workload. ~$5–20/month.

**Scaling:** worker replicas per queue class, read replica for the lead table, object storage for exports, managed metrics.

**Alternative single-platform path:** replace BullMQ/Redis with Vercel Queues + Workflow to run everything on Vercel. Deferred — BullMQ is specified, portable, and locally testable via Docker Compose. Kept viable by the `jobs/` abstraction.

Environment variables per §"Environment Variables" in the brief; production boot fails fast if any secret is missing or if `MOCK_EXTERNAL_APIS=true` in production.

---

## 14. Cost-Control Strategy (summary)

1. One Enterprise Text Search with a minimal field mask — **never** Place Details for bulk fields; never Atmosphere fields.
2. Adaptive, saturation-driven geographic subdivision; never blind subdivision.
3. Deterministic filtering before any enrichment spend.
4. Firecrawl only for candidates that survive filtering; minimum operation (search → 1 page → at most 1 more); never a full crawl.
5. Groq only for genuine ambiguity — while recognising it is the *cheapest* network call, so it may replace fetches.
6. Confidence routing: ≥0.90 auto-accept, 0.70–0.89 secondary deterministic check, <0.70 manual review.
7. Every call metered into `ApiUsage`; prices centralised in `ProviderPricingConfig`.
8. Pre-flight cost estimate shown before execution.
9. Job / daily / monthly budgets enforced atomically in Redis **before** each call; exhaustion pauses queues.
10. Idempotent job ids so retries and re-runs never re-spend.

---

## 15. Definition of Done (per phase)

Implement → test → typecheck → lint → inspect → fix → document → security review → cost review → commit. A phase that compiles is not a phase that is done, and no functionality is reported complete unless it has been implemented and exercised by a test.
