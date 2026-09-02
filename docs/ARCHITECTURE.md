# Architecture

A map of the system and the reasoning behind the decisions that are not obvious.
For the cost model and phase history see
[LEADRADAR_IMPLEMENTATION_PLAN.md](LEADRADAR_IMPLEMENTATION_PLAN.md); for the
audit that preceded the outreach work see
[ARCHITECTURE_AUDIT.md](ARCHITECTURE_AUDIT.md).

---

## 1. Shape

A staged, cost-gated enrichment pipeline fronted by a Next.js dashboard, with all
expensive and long-running work pushed onto BullMQ workers.

```
┌──────────────────────────┐        ┌────────────────────────────────────┐
│  Next.js 16 (App Router) │        │  Worker process (long-lived)       │
│                          │        │                                    │
│  /dashboard/*   RSC      │        │  search        → plan + fan-out    │
│  /api/*         handlers │──jobs─▶│  google-places → discovery         │
│                          │        │  website-*     → fetch + verify    │
│  Zod at every edge       │        │  scoring       → deterministic     │
└────────────┬─────────────┘        │  email         → campaign sends    │
             │                      │  export        → CSV / XLSX        │
             │                      │  maintenance   → purge, refresh    │
             ▼                      └──────────────┬─────────────────────┘
      PostgreSQL (Prisma) ◀────────────────────────┘
      Redis (queues, rate limits, budget tokens)
```

**Why two tiers.** BullMQ workers hold blocking Redis reads and must live in a
long-running process. They cannot be a serverless function or a route handler.
The web and worker tiers therefore deploy separately — but build from one
`Dockerfile` with two targets, so their dependencies cannot drift apart.

**Why asynchronous at all.** A five-city, two-category search fans out to hundreds
of paginated provider requests against three third-party rate limits and takes
minutes to tens of minutes. That cannot live in an HTTP request. The queue also
buys retry isolation (one dead website must not fail a search of 4,000),
resumability after a crash, fair provider pacing, and a single place to enforce
spend.

---

## 2. Layering

```
src/
  app/         route handlers and RSC pages — thin, no business logic
  components/  UI primitives and feature components
  modules/     the actual system
    ai/          untrusted-content handling
    analytics/   funnel and campaign roll-ups
    api/         handler wrapper: auth, CSRF, Zod, rate limit, error mapping
    auth/        sessions, passwords, CSRF, tenancy
    database/    Prisma client, repositories, tenant scoping
    email/       templates, personalization, campaigns, suppression, send, MIME
    enrichment/  pipeline, verification, contacts, website analysis, social
    export/      writers + ExportPolicyService
    jobs/        queue definitions, payload schemas, processors
    leads/       normalization, CSV import
    providers/   contracts + adapters (google-places, firecrawl, groq, gmail, mock)
    scoring/     opportunity score, service recommendations, opportunity flags
    search/      NL → structured query → plan → cost estimate → filters
    security/    SSRF guard, DNS pinning, IP classification
  lib/         env, logger, errors, result, redis, crypto, ids
  schemas/     Zod schemas shared by API, workers, and AI
  types/       domain types — no provider type leaks here
  workers/     entrypoint and graceful shutdown
```

**The rule.** Domain logic never imports a provider SDK. Providers implement
interfaces in `modules/providers/contracts.ts`, and every one has a real adapter
and a mock adapter selected by `MOCK_EXTERNAL_APIS`.

Two consequences follow, and both are load-bearing:

1. A provider can be replaced — Places → Overture/OSM, Firecrawl → another
   crawler, Groq → any OpenAI-compatible endpoint, Gmail → another sender —
   without touching scoring, filtering, or UI code.
2. **The entire product runs with no credentials.** Mock mode is a first-class
   runtime mode, not a test shim. It is rejected in production, so it can never
   be what a paying operator is unknowingly running.

Route handlers are deliberately thin: authenticate → resolve tenant → Zod-parse →
call a module service → serialise. No business logic, no provider calls, no SQL.
That is what lets the interesting logic be tested without HTTP, and what makes the
security controls uniform instead of remembered per route.

---

## 3. The two structural decisions in the schema

### Tenancy

Every business-owned row carries `organizationId`, non-null, as the leading column
of its composite indexes. Every repository function takes an explicit
`TenantContext`, and there is no un-scoped query helper for tenant-owned data — so
"forgot the organizationId filter" is a compile error rather than a cross-tenant
leak.

The organization comes from the **session row**, never from a header, query
parameter, or request body, any of which a client controls and could forge.

### Provenance

Data is separated by _where it came from_, because the three classes carry
different retention and export rules:

| Class                 | Tables                                                                                          | Retention          | Exportable by default |
| --------------------- | ----------------------------------------------------------------------------------------------- | ------------------ | --------------------- |
| Place identity        | `PlaceIdentifier`                                                                               | Indefinite         | Yes                   |
| Google-derived        | `GooglePlaceSnapshot`                                                                           | TTL, purged hourly | **No** — policy-gated |
| Our own crawl         | `WebsiteCandidate`, `WebsiteVerification`, `SocialProfile`, `EmailCandidate`, `WebsiteAnalysis` | Indefinite         | Yes                   |
| Application-generated | `LeadScore`, `ServiceRecommendation`, `AIAnalysis`                                              | Indefinite         | Yes                   |

This makes the compliance boundary a **schema fact rather than a convention**, and
the mandatory refresh loop doubles as change detection — a genuine feature falling
out of a constraint. See [google-maps-compliance.md](google-maps-compliance.md).

The outreach tables add three more structural safeguards, in the schema rather
than in application code, because application care is not a control:

- `CampaignLead` is unique on `(campaignId, businessId)` — a lead cannot be
  enrolled twice, so it cannot be mailed twice.
- `SuppressionEntry` is unique on `(organizationId, emailHash)` and is consulted
  before every send, with no bypass parameter anywhere in the API.
- `EmailMessage` stores the exact rendered body that was sent, so what a recipient
  received stays answerable after the template has changed.

---

## 4. The pipeline

```
natural language
  → StructuredQuery (Zod-validated; the model cannot introduce a field or filter)
  → search plan (adaptive quadtree; a cell is split only when saturated)
  → discovery (one Enterprise Text Search with a minimal field mask)
  → dedupe by Place ID
  → deterministic filters            ← everything dropped here is never paid to enrich
  → website discovery                ← only for survivors
  → deterministic verification       ← settles ~4 in 5 at zero marginal cost
  → AI adjudication                  ← only the genuinely ambiguous band
  → contact extraction + website analysis   ← free: pages are already fetched
  → opportunity flags → opportunity score
  → campaign → human review → send → track
```

Each stage narrows the set before the next, more expensive one runs. The gates are
documented in [CRAWLER.md](CRAWLER.md); the scoring model in
[LEAD_SCORING.md](LEAD_SCORING.md).

**Nothing sends automatically.** Discovery does not enrol; enrolment does not
queue; queueing does not send. Activation is a separate, explicit act requiring a
typed confirmation. There is no code path from a finished search to an outgoing
email.

---

## 5. Workers

Nine queues: `search`, `google-places`, `website-discovery`,
`website-verification`, `firecrawl`, `groq`, `scoring`, `export`, `email`, plus
`maintenance`.

Per-queue policy: bounded concurrency, exponential backoff **with jitter**,
explicit timeouts and attempt counts, retention caps, and a dead-letter queue per
source queue carrying the original payload and failure trail.

**Idempotency is by deterministic job id**, so BullMQ itself dedupes retries and
replays:

```
discover:{searchJobId}:{cellId}:{categoryId}:{pageIndex}
discover-website:{placeIdHash}
score:{businessId}:{signalsVersion}
send:{campaignId}:{businessId}
```

`signalsVersion` in the scoring key means a weights change recomputes every score
while unchanged inputs never re-spend a rupee.

**The email queue runs at concurrency 1, never scaled.** Every other queue fetches
data; this one sends mail from a real person's mailbox. Parallel sending defeats
the inter-message delay that makes a campaign look like correspondence, and is the
fastest way to trip Gmail's per-account limit — which does not merely slow a
campaign, it can suspend sending outright. A campaign advances by scheduling one
message at a time, so "pause" genuinely pauses rather than draining a queue that
is already committed.

**Budget is reserved before the provider call and settled after.** Checking spend
afterwards lets concurrency overshoot, and overshoot is irreversible while a
paused queue is not.

---

## 6. Security

Full threat model in [security.md](security.md). The load-bearing controls:

1. **SSRF** — the primary risk, because the server fetches URLs influenced by
   search results and by a third party's `websiteUri`. DNS resolution followed by
   private/metadata range rejection, connection to the **pinned IP** with an
   explicit `Host` header (which is what defeats DNS rebinding), and full
   re-validation of every redirect hop.
2. **Prompt injection** — scraped pages are untrusted. Page text enters the model
   only in a fenced, sanitised, length-capped data channel. More importantly the
   blast radius is bounded by design: the model may return only a constrained enum
   plus a confidence, Zod-validated. It can never emit a fact, a URL, a score, or
   SQL. **Deterministic code owns every number that reaches the user.**
3. **Fact integrity** — the AI never _emits_ facts, only _classifies_ facts already
   extracted deterministically. This structurally eliminates hallucinated phone
   numbers, addresses, and metrics. In outreach the same rule applies: the sales
   angle is derived from measurements, and any AI rephrasing that introduces a
   number or URL it was not given is discarded.
4. **Email header injection** — a business name scraped from a page title becomes
   a display name in an outgoing message. CR, LF, and NUL are stripped from every
   header value and addresses are rejected outright, at the single place headers
   are constructed.
5. **Secrets at rest** — Gmail refresh tokens are AES-256-GCM encrypted with
   purpose-bound AAD. A database leak must not hand an attacker the ability to
   send as the user, which is materially worse than the leak itself.
6. **Tenant isolation** — `organizationId` required in every repository call;
   integration tests assert cross-tenant reads return zero rows.
7. **CSV injection** — cells beginning `= + - @`, tab, or CR are prefixed with `'`
   in both CSV and XLSX. A spreadsheet executes them otherwise, and business names
   are attacker-influenced free text.
8. **Secrets** — server-only; `env.ts` fails fast at boot; no secret may be
   referenced under `NEXT_PUBLIC_*`, enforced by a guard script against names _and_
   values.

`npm run guard:providers` enforces four project rules in CI: no Anthropic/Claude
SDK as a runtime dependency, no hard-coded model ids, `process.env` read only in
`src/lib/env.ts`, and no secret-shaped `NEXT_PUBLIC_*` variable.

---

## 7. Verification

| Command                    | Proves                                                                                   |
| -------------------------- | ---------------------------------------------------------------------------------------- |
| `npm run check`            | Guard rules, types, lint, and 618 unit tests                                             |
| `npm run test:integration` | 34 tests against real PostgreSQL, including cross-tenant isolation                       |
| `npm run verify:pipeline`  | Discovery → filter → enrich → verify → score, through the real queue and real datastores |
| `npm run verify:outreach`  | Templates → enrolment → guard chain → send → tracking → suppression → unsubscribe, ditto |

The two `verify:*` scripts exist because unit tests prove the logic and these
prove the _system_ — the queue, the transactions, the database constraints, and
the worker actually cooperating. Both found real bugs that unit tests had missed;
one of them had been encoded in a unit test as correct behaviour.

Their most valuable assertions are the negative ones. It is easy to prove an email
was sent. The proof that matters is that a suppressed address was **not** sent to,
that a lead cannot be mailed twice, and that a paused campaign stops immediately.
