# LeadRadar

AI-powered local-business prospecting and digital-opportunity intelligence for
agencies. LeadRadar finds businesses that are likely to need website, SEO,
social, branding, or automation work — and shows the evidence for **why**, so a
salesperson can open a conversation instead of guessing.

It is deliberately **not** a Google Maps scraper. The pipeline discovers
businesses, then independently verifies whether each one actually has a working
website of its own, measures the gap between its commercial strength and its
digital presence, and ranks the resulting opportunity.

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

## Verification

```bash
npm run check        # provider guard + typecheck + lint + test
npm run test:coverage
```

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
  → digital presence → opportunity score → qualified lead → export
```

Three facts shape every design decision, and all three are counter-intuitive:

1. **One Enterprise Text Search beats Place Details by ~11× per business.** Text
   Search bills per *request* and returns up to 20 places; Place Details bills
   per *place*. The "free IDs-only search, then fetch details" pattern is a cost
   trap.
2. **A Groq call is the cheapest network operation in the stack** — cheaper than
   one page scrape. AI is not the expensive layer; per-record Google SKUs and
   page fetches are. Rules still come before AI, but for determinism and
   explainability, not cost.
3. **The free tier covers ~13,000 businesses/month on Google.** The caching layer
   exists for compliance and rate-limit headroom, not savings.

## Documentation

| Document | Contents |
|---|---|
| [docs/LEADRADAR_IMPLEMENTATION_PLAN.md](docs/LEADRADAR_IMPLEMENTATION_PLAN.md) | Repository assessment, target architecture, verified provider pricing, cost model and scenarios, phase plan |
| [docs/google-maps-compliance.md](docs/google-maps-compliance.md) | Data-provenance classes, retention design, and the open legal questions |

## Stack

Next.js 16 (App Router) · TypeScript · PostgreSQL 17 + Prisma · Redis + BullMQ ·
Tailwind 4 · Zod · Vitest. Groq is the only runtime AI provider.

## Status

Phase 1 (foundation) in progress. See the phase table in the implementation plan
for what is built and what is next.
