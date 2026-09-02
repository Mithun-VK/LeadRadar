# LeadRadar

AI-powered local-business prospecting, digital-opportunity intelligence, and
outreach for agencies. LeadRadar finds businesses that are likely to need website,
SEO, social, branding, or automation work — shows the evidence for **why**, so a
salesperson can open a conversation instead of guessing — and can then send that
conversation from your own Gmail account.

It is deliberately **not** a Google Maps scraper. The pipeline discovers
businesses, then independently verifies whether each one actually has a working
website of its own, measures the gap between its commercial strength and its
digital presence, and ranks the resulting opportunity.

**Full workflow:**

```
discover → dedupe → filter → crawl → extract contacts → analyse website
  → flag opportunities → score → review → campaign → send → track
```

---

## Quick start

The app runs **with no API credentials at all**. Mock mode is a first-class
runtime mode, not a test shim.

```bash
npm install
cp .env.example .env          # defaults are already valid for mock mode
docker compose up -d          # PostgreSQL 17 + Redis 7
npm run db:migrate            # apply schema
npm run db:seed               # default organization, project, budgets
npm run dev                   # http://localhost:3000
npm run worker                # background workers (separate terminal)
```

`MOCK_EXTERNAL_APIS=true` is the default. Google Places, Firecrawl, and Groq are
replaced by deterministic in-process adapters that satisfy the same interfaces
and report realistic usage figures, so the cost-tracking path is exercised rather
than bypassed.

To run against live providers, set `MOCK_EXTERNAL_APIS=false` and supply
`GOOGLE_MAPS_API_KEY`, `GROQ_API_KEY`, and `FIRECRAWL_API_KEY`. Boot fails fast
if any is missing — the app will not silently fall back to mock data.

### Outbound email

Off by default (`EMAIL_SENDING_ENABLED=false`), deliberately: this is the one
subsystem that acts in the world on your behalf and under your sending reputation.
An operator should turn it on knowingly rather than discover it running.

In mock mode the **entire** outreach pipeline still runs end to end — campaigns,
enrolment, suppression, personalization, queueing, rate limiting, retries, status
tracking, analytics — with every message composed in full and handed to an
in-process sender that delivers nowhere. That is the right way to evaluate it.

To send for real, see [docs/GMAIL_SETUP.md](docs/GMAIL_SETUP.md). OAuth 2.0 only;
username/password SMTP is deliberately unsupported.

LeadRadar requests `gmail.send` **and** `gmail.readonly` — the second so it can
detect replies and stop follow-ups automatically. What it does with read access is
narrow and enforced in code: a message is stored **only** if it matches a thread
LeadRadar started, everything else is discarded unwritten, and stored reply text
expires after 90 days. See [docs/DATA_RETENTION.md](docs/DATA_RETENTION.md).

### Docker

```bash
docker compose up -d                          # Postgres + Redis only (default)
docker compose --profile app up -d --build    # + web and worker containers
```

The web and worker tiers build from one `Dockerfile` with two targets. They deploy
separately — BullMQ workers hold blocking Redis reads and need a long-running
process — but share a build so their dependencies cannot drift apart.

## Verification

```bash
npm run check              # provider guard + typecheck + lint + 330 unit tests
npm run test:integration   # 15 tests against real PostgreSQL (needs docker compose up)
npm run verify:pipeline    # drives a real search through the real queue end to end
```

`verify:pipeline` is the one that proves the system rather than the logic: it parses
a natural-language query, prices it, enqueues it, and waits for the worker to run
discovery, filtering, enrichment, verification, and scoring against real PostgreSQL
and Redis with mock providers. Start `npm run worker` first.

`npm run guard:providers` enforces the project's hard rules: no Anthropic/Claude
SDK as a runtime dependency, no hard-coded model ids, `process.env` read only in
`src/lib/env.ts`, and no secret-shaped `NEXT_PUBLIC_*` variables.

## Architecture

Cost-gated staged enrichment. Each stage narrows the set before the next, more
expensive stage runs:

```
natural language → structured query (Zod-validated) → search plan
  → discovery (Google Places, minimal field mask)
  → dedupe by Place ID → deterministic filters
  → website discovery (only for survivors)
  → deterministic verification → AI only for genuine ambiguity
  → contact extraction + website analysis (from pages already fetched)
  → opportunity flags → opportunity score → qualified lead
  → campaign → review → send (Gmail) → track
```

Contact extraction and website analysis are free: they run over documents the
verification stage has already paid to fetch. The expensive act — loading the
business's own pages — was performed to answer a different question, and the
addresses and structural facts are sitting in bytes already bought.

Three facts shape every design decision, and all three are counter-intuitive:

1. **One Enterprise Text Search beats Place Details by ~11× per business.** Text
   Search bills per _request_ and returns up to 20 places; Place Details bills
   per _place_. The "free IDs-only search, then fetch details" pattern is a cost
   trap.
2. **A Groq call is the cheapest network operation in the stack** — cheaper than
   one page scrape. AI is not the expensive layer; per-record Google SKUs and
   page fetches are. Rules still come before AI, but for determinism and
   explainability, not cost.
3. **The free tier covers ~13,000 businesses/month on Google.** The caching layer
   exists for compliance and rate-limit headroom, not savings.

## Documentation

| Document                                                                       | Contents                                                                                                    |
| ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| [docs/ARCHITECTURE_AUDIT.md](docs/ARCHITECTURE_AUDIT.md)                       | Audit of the existing system, gap analysis, deviations from the brief and why, migration strategy           |
| [docs/LEADRADAR_IMPLEMENTATION_PLAN.md](docs/LEADRADAR_IMPLEMENTATION_PLAN.md) | Repository assessment, target architecture, verified provider pricing, cost model and scenarios, phase plan |
| [docs/API.md](docs/API.md)                                                     | Every endpoint, its parameters, and its refusals                                                            |
| [docs/LEAD_SCORING.md](docs/LEAD_SCORING.md)                                   | Why scoring is multiplicative, what website analysis measures, and what it deliberately will not claim      |
| [docs/GMAIL_SETUP.md](docs/GMAIL_SETUP.md)                                     | Connecting a sending mailbox, what the grant allows, and troubleshooting                                    |
| [docs/google-maps-compliance.md](docs/google-maps-compliance.md)               | Data-provenance classes, retention design, and the open legal questions                                     |
| [docs/security.md](docs/security.md)                                           | Threat model, why prompt injection is contained rather than filtered, and what is deliberately not claimed  |
| [docs/deployment.md](docs/deployment.md)                                       | Topology, the Redis co-location constraint, scaling path, and the pre-launch checklist                      |
| [docs/roadmap-v2.md](docs/roadmap-v2.md)                                       | V2 scope, with a status block recording what is now built and which decision was reversed                   |

## Stack

Next.js 16 (App Router) · TypeScript · PostgreSQL + Prisma · Redis + BullMQ ·
Tailwind 4 · Zod · Vitest. Groq is the only runtime AI provider; Gmail is the only
sending provider.

## What it will not do

Some of these are the most considered decisions in the codebase, and they are worth
stating before the feature list:

- **No fabricated website metrics.** A single page fetch cannot measure load
  performance, so `performanceScore` is null with a stated reason rather than a
  plausible invented number. One fabricated metric discredits every honest one
  beside it. See [docs/LEAD_SCORING.md](docs/LEAD_SCORING.md).
- **No guessed email addresses.** No `first.last@domain` permutation generator and
  no SMTP probing. Guessed addresses bounce, bounces damage your sending
  reputation, and the cost is not one bad email but every future good one.
- **No fabricated claims in outreach.** The sales angle is derived from
  measurements. AI may only rephrase it, and any rephrasing that introduces a
  number or URL it was not given is discarded.
- **No revenue or ROI figures.** LeadRadar does not observe deal outcomes.
- **No reading beyond what it needs.** Reply detection requires mailbox read
  access, so it is requested — but only messages on threads LeadRadar started are
  ever stored, and their text expires after 90 days.
- **No bypass of the suppression list.** No force flag, no skip parameter, anywhere.

## Status

All phases implemented and verified end to end.

| Check             | Result                       |
| ----------------- | ---------------------------- |
| Provider guard    | pass                         |
| Typecheck         | pass                         |
| Lint              | pass, 0 warnings             |
| Unit tests        | 614 passing                  |
| Integration tests | 15 passing (real PostgreSQL) |
| Production build  | pass                         |
| Runtime pipeline  | all assertions pass          |

Authentication is implemented: server-side sessions with hashed tokens, scrypt
passwords, lockout, CSRF double-submit with HMAC binding, and membership re-checked
on every request.

**Before exposing this to the internet**, read [docs/security.md](docs/security.md)
and [docs/deployment.md](docs/deployment.md), and — if you intend to send email —
the compliance note at the end of [docs/GMAIL_SETUP.md](docs/GMAIL_SETUP.md). The
open legal questions in [docs/legal-review-brief.md](docs/legal-review-brief.md)
are not resolved by any amount of code.
