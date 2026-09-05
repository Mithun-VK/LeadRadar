# Load test results

**Date:** 2026-09-06
**Harness:** `npm run load-test` (`scripts/load-test.ts`)
**Verdict: 10K VERIFIED** — see §5 for exactly what that does and does not mean.

---

## 1. Method

Deterministic synthetic datasets at 1K / 5K / 10K leads, each in a **dedicated
organization** (`__loadtest__<scale>`) so real data is never read, written, or
counted, and cleanup is one cascade delete rather than a pile of hopeful
`deleteMany` calls that could match production rows.

A seeded PRNG, not `Math.random`. Two runs at the same scale produce identical
data, so a latency change between runs is a real change rather than a different
data shape.

Each operation runs 5–10 times; **the first run is discarded** because it pays
for connection setup and Postgres's cold plan cache — a number no user
experiences after the first page load of the day.

**No email is sent and no provider is called.** The generator writes rows
directly, because what is under test is the query layer at volume. Routing 10,000
leads through the real pipeline would measure the mock provider's sleep timers
rather than the database; that path is already covered by `verify:pipeline` and
`verify:outreach`.

### Dataset shape at 10K

| | Rows |
|---|---|
| Leads | 10,000 |
| Website analyses | 10,000 |
| Email messages | 3,919 |
| Deals | 1,200 (20% deliberately unvalued) |
| Sales activities | 2,500 |
| Campaigns | 10 |

Build time 25s. Six cities, six categories, eight opportunity flags, all nine
lead statuses, all seven deal stages.

---

## 2. Results at 10,000 leads

| Operation | p50 | p95 | p99 |
|---|---|---|---|
| leads: first page (50) | 108ms | 144ms | 144ms |
| **leads: deep page (offset ~80%)** | **215ms** | **408ms** | **408ms** |
| leads: filtered (score≥70, hasEmail, flags) | 55ms | 84ms | 84ms |
| leads: name search | 110ms | 141ms | 141ms |
| leads: count only | 11ms | 12ms | 12ms |
| analytics: overview | 140ms | 146ms | 146ms |
| analytics: revenue metrics | 68ms | 83ms | 83ms |
| analytics: campaign revenue | 20ms | 22ms | 22ms |
| analytics: source attribution | 25ms | 30ms | 30ms |
| crm: work queue | 56ms | 89ms | 89ms |
| crm: deals by stage (kanban) | 8ms | 8ms | 8ms |
| crm: pipeline totals (all deals) | 21ms | 22ms | 22ms |
| crm: list deals | 217ms | 328ms | 328ms |
| lead detail: full profile | 29ms | 35ms | 35ms |

**Worst p95 across every operation: 408ms.** Nothing approaches one second.

Memory: heap 24 MB, RSS 141 MB. Flat across scales — no operation loads the
dataset into Node.

### Scaling 1K → 10K

| Operation | 1K p95 | 5K p95 | 10K p95 |
|---|---|---|---|
| leads: first page | 45ms | 139ms | 144ms |
| leads: filtered | 34ms | 61ms | 84ms |
| analytics: overview *(after fix)* | 285ms → | 163ms → | **146ms** |
| lead detail | 27ms | 32ms | 35ms |

Sub-linear almost everywhere — the composite indexes are doing their job.

---

## 3. Bottleneck found and fixed

### `analytics: overview` — 655ms p95, the dashboard landing page

The opportunity-flag distribution read **up to 20,000 lead rows** (the array
column for every lead) and counted them in a JavaScript loop:

```ts
db().business.findMany({
  where: { ...org, opportunityFlags: { isEmpty: false } },
  select: { opportunityFlags: true },
  take: 20_000,
})
```

At 10K leads that made the overview **5–25× slower than any other query on the
dashboard**, and it was the first screen an operator sees.

**Fix:** aggregate in Postgres with `unnest` + `GROUP BY`, returning a handful of
rows instead of ten thousand.

| | Before | After |
|---|---|---|
| p50 | 255ms | **57–140ms** |
| p95 | **655ms** | **70–146ms** |

**4.5–9× faster**, and it stopped being the slowest operation on the page.

It also fixed a quiet correctness bug: `take: 20_000` silently truncated beyond
20,000 leads, so the distribution was simply wrong past that point with nothing
to indicate it. The SQL version has no cap.

**Verified identical**, not just faster — compared against the old JS counting
across 4,992 flag instances: zero mismatches, ordering preserved.

### `listDeals` — unbounded

328ms p95 at 1,200 deals: acceptable today, unbounded tomorrow. Capped at 500
rows. `pipelineTotals` stays uncapped so the headline numbers remain accurate
even when the board is truncated — it reads three columns and measures 21ms.

---

## 4. Investigated and deliberately NOT changed

Discipline matters as much here as the fixes: three suspects were measured and
left alone.

| Suspect | Measured | Verdict |
|---|---|---|
| `pipelineTotals` reads every deal, aggregates in JS | **21ms** | Same anti-pattern as the flag bug, but 1,200 three-column rows is trivial. No change. |
| `revenueMetrics` reads all open + won deals | **83ms** | Same reasoning. |
| Deep-page OFFSET pagination | 408ms | Inherent to OFFSET. Keyset pagination would fix it, but 408ms on a page few operators visit does not justify changing the pagination contract. |

No index was added. The existing composite indexes — tenant-first, and
`(organizationId, status, dueAt)` matching the work-queue query exactly —
already cover every measured path.

---

## 5. What "10K VERIFIED" means

**Verified:** every measured read operation stays under 410ms at p95 with 10,000
leads and proportional CRM data, on the hardware described below, with memory
flat.

**NOT verified:**

- **Concurrency.** Every measurement is single-client. Ten operators hitting the
  dashboard simultaneously was not tested.
- **Write throughput under load.** The generator writes in batches; sustained
  concurrent writes from workers plus API traffic was not measured.
- **Worker behaviour at 10K.** Queue depth, retry storms, and poison-job handling
  under volume were not exercised — the harness measures queries, not the queue.
- **Beyond 10K.** 50K and 100K are untested and the deep-page OFFSET cost grows
  linearly.
- **Real provider latency.** No Google, Firecrawl, Groq, or Gmail call is
  involved. At real volume those dominate wall-clock time, not these queries.

---

## 6. Infrastructure findings

### Intermittent Prisma `P1001` — environment, not application

**Not reproducible in a healthy environment.** Six fresh processes cold-connected
in **101–290ms with zero failures**.

Ruled out:

- **Connection exhaustion.** 24 of 100 connections in use with dev server,
  worker, and scripts all running.
- **Application configuration.** No pool or timeout override; Prisma defaults.

Every observed `P1001` coincided with Docker Desktop being degraded or
restarting, while raw TCP to 5433 still reported open — consistent with Docker
Desktop's WSL2 port-forwarding proxy accepting the socket but stalling the
handshake past Prisma's default connect timeout.

**Classification: infrastructure/environment.** Retrying succeeds. If it becomes
disruptive, `?connect_timeout=15` in `DATABASE_URL` is the mitigation — not
applied, because there is currently nothing to mitigate.

### Docker instability — environment

Two distinct failures, both external:

1. **Disk exhaustion** (0.62 GB free). Postgres blocked writes while reads kept
   working — which is why `/api/health` returned 200 while login hung for 317
   seconds. Resolved by freeing space; now 33 GB.
2. **Daemon wedged.** `docker ps` hung indefinitely (exit 124) or returned HTTP
   500 while the containers kept serving on their ports. Resolved by restarting
   Docker Desktop.

Neither is an application defect. Both are visible rather than hidden.

**Requirement: keep >10 GB free.** The failure mode is silent — health checks
pass while writes hang.

---

## 7. Environment

| | |
|---|---|
| Postgres | 16-alpine in Docker Desktop (WSL2), `shared_buffers` 128MB, `work_mem` 4MB, `max_connections` 100 — **all defaults** |
| Redis | 7-alpine |
| Host | Windows 11, D: 33 GB free |
| Node | 22 |

Worth noting the numbers above were achieved on **stock Postgres tuning** through
a Windows port-forwarding proxy. Dedicated hardware with tuned `shared_buffers`
would be faster, not slower.

---

## 8. Reproducing

```bash
npm run load-test              # 1K, 5K, 10K
npm run load-test -- 10000     # one scale
npm run load-test -- 1000 --keep
```

Safe to run against a development database: data is isolated in its own
organization and removed afterwards unless `--keep` is passed.
