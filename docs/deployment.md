# LeadRadar Deployment

## The one constraint that shapes everything

BullMQ workers hold **blocking Redis reads**, so they need a long-lived process.
Next.js route handlers do not provide that. The web and worker tiers therefore
deploy separately, and every option below is a variation on where the worker lives.

A second, less obvious constraint: those blocking reads generate **very high Redis
command volume**. On per-command serverless Redis pricing this can exceed the entire
provider API bill for the same workload — a worker idling on `BZPOPMIN` bills
continuously while doing nothing. **Co-locate Redis with the worker.** This is the
single most common way to make a cheap deployment expensive.

---

## Recommended: MVP and early production

| Component | Service | Cost |
|---|---|---|
| Web (Next.js) | Vercel Hobby/Pro | $0–20/mo |
| PostgreSQL | Neon free / Launch | $0–19/mo |
| Redis + worker | **Railway** or **Fly.io**, same region | $5–15/mo |
| Exports | Local disk initially; object storage at scale | $0 |
| **Total** | | **~$5–35/mo** |

Provider APIs on top: effectively **$0** at MVP volume. The 1,000 free Google
Enterprise Text Search calls per month cover roughly 13,000 businesses, and
Firecrawl's free tier covers ~1,300 more.

### Why not all-Vercel

Vercel Functions cap at 300s and are not designed to host a blocking worker loop.
Options if single-platform matters more than portability:

- Replace BullMQ with **Vercel Queues + Workflow**. The `modules/jobs` abstraction
  keeps this viable, but it is a real migration and loses local Docker testability.
- Run the worker as a **Vercel Cron** that drains a batch per invocation. Simpler,
  but adds latency and gives up graceful shutdown.

BullMQ is specified, portable, and testable locally, so it stays.

---

## Deployment steps

### 1. Database

```bash
# Point DATABASE_URL at the managed instance, then:
npm run db:deploy     # migrate deploy — never `migrate dev` in production
npm run db:seed       # creates the default organization (idempotent)
```

Use a **pooled** connection string for the web tier (many short-lived connections)
and a **direct** one for migrations, which need a session-level lock.

### 2. Web tier

```bash
vercel --prod
```

Required environment variables (see `.env.example`):

```
NODE_ENV=production
DATABASE_URL=            # pooled
REDIS_URL=               # same region as the worker
GOOGLE_MAPS_API_KEY=
GROQ_API_KEY=
GROQ_MODEL=openai/gpt-oss-20b
FIRECRAWL_API_KEY=
MOCK_EXTERNAL_APIS=false # boot FAILS if true in production
ENCRYPTION_KEY=          # 64 hex chars; required in production
DAILY_BUDGET_USD=
MONTHLY_BUDGET_USD=
MAX_GOOGLE_REQUESTS_PER_JOB=
MAX_CONCURRENT_JOBS=
LOG_LEVEL=info
```

Boot validates all of this and **fails fast** rather than surfacing a confusing
error mid-job. Two production guards worth knowing: `MOCK_EXTERNAL_APIS=true` is
rejected outright, and a missing `ENCRYPTION_KEY` is rejected.

### 3. Worker tier

```bash
npm run build          # not strictly needed; the worker runs via tsx
npm run worker
```

The worker needs the **same** environment as the web tier. It registers repeatable
maintenance on start:

- `purge-google-snapshots` — hourly at :17. **Compliance-critical**; an unmonitored
  retention job is the same as no retention policy. Alert if it stops reporting.
- `refresh-place-ids` — daily at 03:00. Free on the IDs-only SKU.

Configure the platform to send **SIGTERM** and allow **≥35 s** to drain. The worker
finishes in-flight jobs, then closes queues, database, and Redis. A hard kill leaves
BullMQ locks held and causes a duplicate paid fetch when the lock expires.

### 4. Google Cloud API key restrictions

Non-optional. Restrict the key to **Places API (New)** only, and add an IP
restriction for the worker's egress addresses. An unrestricted key found in a log or
a bundle is a direct, uncapped charge on your account.

Set a Cloud Billing budget alert as a backstop — LeadRadar's own budget guard
protects against its own overspend, not against a leaked key.

---

## Scaling path

| Volume | Change |
|---|---|
| ~10k businesses/mo | Nothing. Free tiers cover it. |
| ~100k/mo | Firecrawl Standard ($83/mo, 100k credits). Google ≈ $234/mo. Worker to 1 GB RAM. |
| ~500k/mo | Separate worker replicas per queue class (discovery vs enrichment have different rate-limit profiles). Postgres read replica for the lead table. Exports to object storage. |
| Multi-region | Shard workers by city registry region; keep one Postgres primary — the workload is write-light and read-heavy. |

Scale the **worker** before the web tier. The bottleneck is provider rate limits and
enrichment throughput, never Next.js rendering.

---

## Monitoring

Minimum viable set:

- `GET /api/health` — dependency liveness, for the platform's health check.
- **Queue depth and dead-letter counts** (`/dashboard/jobs`). A growing DLQ is the
  earliest signal something is systematically broken.
- **Budget utilisation** (`/dashboard/usage`). Alert at 80%, because reaching 100%
  pauses processing.
- **Estimate-vs-actual ratio.** A sustained drift means the funnel assumptions in
  `ProviderPricingConfig` need recalibrating — the numbers most likely to be wrong.
- `SystemEvent` rows at WARN/ERROR: `BUDGET_EXHAUSTED`,
  `CELL_SATURATED_AT_MAX_DEPTH` (incomplete coverage),
  `GOOGLE_SNAPSHOTS_PURGED`, `PLACE_IDS_INVALIDATED`.

Logs are structured JSON (pino) with `requestId`, `jobId`, `provider`, `operation`,
and `durationMs`, so any log platform can group by correlation id.

---

## Before going live

- [ ] **Add authentication.** `resolveTenant` currently returns the seeded
      development organization. Until it is replaced, do not expose the app publicly.
- [ ] Restrict the Google API key by API and IP; set a Cloud Billing alert.
- [ ] Confirm `MOCK_EXTERNAL_APIS=false` and that a real search returns real data.
- [ ] Verify the snapshot purge job runs and is alerted on.
- [ ] Legal review of `google-maps-compliance.md` §4 before any paying customer.
- [ ] Set budgets deliberately; the defaults ($5/day, $50/month) are conservative
      development values.
- [ ] Run `npm run check` and `npm run test:integration` against the release build.
