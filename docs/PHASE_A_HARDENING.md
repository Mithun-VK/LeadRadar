# Phase A — engineering and operational hardening

**Branch:** `feat/revenue-engine-production-hardening`
**Baseline:** `8eba63d` (final production certification)
**Head:** `58c8863`
**Date:** 2026-09-06

Standard, unchanged from the previous certification: **nothing is GREEN because
code exists.** Every GREEN below cites a command that was actually run and the
result it produced.

---

## Verdict

```
TECHNICAL:    GREEN
OPERATIONAL:  GREEN — with the external monitor still unconfigured (YELLOW)
SECURITY:     GREEN — no cross-tenant access achieved; 0 critical/high advisories
DEPLOYMENT:   GREEN — worker image builds, boots, works, and drains
COMMERCIAL:   NOT VALIDATED
```

`COMMERCIAL` is unchanged and must stay unchanged: zero real emails have been
sent, so there are no replies, no meetings, no deals, and no revenue. Nothing in
this phase touched that, and nothing in this phase should be read as suggesting
otherwise.

---

## 1. Bugs found and fixed

Seven, and the pattern is worth naming: **five of the seven were invisible to the
existing test suite, and each was found by exercising a path rather than a
function.** The previous certification's own lesson — "test coverage is not path
coverage" — held again.

| #   | Bug                                                              | Impact if shipped                                                                                                                                    | Found by                                         |
| --- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| 1   | **Prisma `startsWith`/`contains` are SQL `LIKE`**                | Searching `_` returned **all 27 leads**; `%` did too. A `deleteMany` guarded by `startsWith: '__pentest__'` could match organizations it did not own | Writing a query that silently matched everything |
| 2   | **Worker never drained on SIGTERM**                              | Every deploy a hard kill; BullMQ locks held until expiry, then duplicate work at another API credit                                                  | `docker stop` on the real image                  |
| 3   | **Heartbeats counted other workers' jobs**                       | With N workers each reports the whole queue's throughput; a **wedged worker still shows a rising `processed` count**                                 | Concurrency test asserting an exact count        |
| 4   | **Scoring transaction expired under load**                       | Job dead-lettered, lead keeps a stale score, nothing surfaces it                                                                                     | Concurrency test, at 5180ms against a 5s default |
| 5   | **Redis health check took 67 seconds**                           | Readiness occupies a request for over a minute; LB sees a timeout, not a 503                                                                         | Stopping the real Redis container                |
| 6   | **`dotenv` was a devDependency**                                 | Production worker image crash-looped on `MODULE_NOT_FOUND`                                                                                           | Running the `--omit=dev` image                   |
| 7   | `/api/leads/:id/activities` returned 200 for another tenant's id | No leak (query was tenant-scoped), but inconsistent with every sibling route                                                                         | Cross-tenant penetration test                    |

### Detail on the two that would have hurt most

**#2 — the drain.** `CMD ["npx", "tsx", "src/workers/index.ts"]` places two
wrapper processes between the init process and node, and neither forwards
SIGTERM. The `STOPSIGNAL SIGTERM` line and the graceful-shutdown handler were
both present and both dead letters. Measured before and after, same command:

```
before:  docker stop -t 40  → 60s, exit 143, no shutdown log at all
after:   docker stop -t 40  →  1s, exit   0, "Shutting down; draining in-flight
                                jobs" → "Shutdown complete", heartbeat removed
```

**#3 — the counter.** `handle.events` is a `QueueEvents` instance: a queue-wide
stream. Every worker counted every other worker's completions. A 30-job batch
across two workers measured 60. The failure mode that matters is not the
arithmetic — it is that a worker which has wedged and is processing nothing keeps
reporting a rising count while its peers work. A liveness counter that cannot go
quiet when the worker stops is not a liveness counter.

---

## 2. Item-by-item results

### 1. Worker production image — **GREEN**

```bash
docker build --target worker -t leadradar-worker:slim .
docker run -d --name leadradar-worker-slim --init \
  --network leadradar_default --env-file .env \
  -e NODE_ENV=development \
  -e DATABASE_URL='postgresql://leadradar:leadradar@postgres:5432/leadradar?schema=public' \
  -e REDIS_URL='redis://redis:6379' \
  leadradar-worker:slim

npm run verify:worker-image -- \
  --container-host=$(docker inspect -f '{{.Config.Hostname}}' leadradar-worker-slim)
```

| Check                                | Result                                                                                                                                                                                    |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Image builds                         | **yes** — 1.35GB (was 1.54GB)                                                                                                                                                             |
| Worker starts                        | **yes**, 10s to "workers started"                                                                                                                                                         |
| Connects to PostgreSQL and Redis     | **yes** — startup gate fails closed, so booting proves both                                                                                                                               |
| Processes a representative job       | **yes** — `processed` counter 5 → 15 over 20 enqueued scoring jobs                                                                                                                        |
| Heartbeat functions                  | **yes** — key present, TTL 40/45, refreshed                                                                                                                                               |
| Idempotent across the queue boundary | **yes** — re-enqueueing 20 identical job ids added 0 work                                                                                                                                 |
| Graceful SIGTERM drain               | **yes** — 1s, exit 0, full drain log                                                                                                                                                      |
| Secrets baked in                     | **none** — `.env` excluded by `.dockerignore`, absent from the image, no secret-shaped string in any build instruction; image env is `PATH`/`NODE_VERSION`/`YARN_VERSION`/`NODE_ENV` only |
| Runs as non-root                     | **yes** — `uid=1001(worker) gid=1001(nodejs)`                                                                                                                                             |
| Dev dependencies leaked              | **fixed** — vitest, eslint, prettier now absent                                                                                                                                           |

**Result: 6/6 verification assertions passed.**

Two honest caveats:

- The image has **never booted in true production mode**, because production mode
  requires real provider credentials and this phase does not use them. It was
  verified with `NODE_ENV=development` and mock providers.
- That the production-mode guard _works_ was verified, incidentally and
  emphatically: `docker compose --profile app up -d worker` crash-looped with
  `MOCK_EXTERNAL_APIS must be false in production` and `ENCRYPTION_KEY is
required in production`. The dev `.env` has mock mode on and an empty
  `ENCRYPTION_KEY`, and compose forces `NODE_ENV=production`. **The documented
  command `docker compose --profile app up -d --build` will always crash-loop
  against a development `.env`** — that is the env guard doing its job, not a
  defect, but an operator meeting it for the first time will not know that.

`next` (201MB) remains the bulk of the image. It is a genuine production
dependency; separating it from the worker would mean a second `package.json`,
which is more architectural churn than the saving justifies.

### 2. Concurrency testing — **GREEN**

```bash
npm run test:concurrency          # 25 concurrent
npm run test:concurrency -- --concurrency=50
```

**30/30 assertions, 0 invariant violations.**

| Scenario                   | Concurrency          | Result                                                                                              |
| -------------------------- | -------------------- | --------------------------------------------------------------------------------------------------- |
| A. Lead reads              | 25                   | 0 errors; all 25 observed the same row count                                                        |
| B. Lead writes to one row  | 25                   | 6 correctly rejected; **no illegal transition recorded**, no self-transition                        |
| C. Scoring the same lead   | 25                   | Collapsed to **exactly 1 job**                                                                      |
| D. Campaign job enqueueing | 30                   | 3 enqueues per lead → **1 job per lead**                                                            |
| E. **Same-step sends**     | 25                   | **Exactly ONE message.** 1 caller saw SENT, 24 blocked `ALREADY_SENT`                               |
| F. Suppression             | 25                   | 1 row, 1 caller told it added; **0 sends against committed suppressions**, all blocked `SUPPRESSED` |
| G. CRM transitions         | 25                   | 4 correctly rejected as illegal; **no illegal stage recorded**                                      |
| H. Queue workers           | 30 jobs, 1–2 workers | All completed, 0 added failures, counters rose by **exactly 30**                                    |
| I. Two tenants interleaved | 50                   | **No row crossed**; each tenant's count stable                                                      |

Latency, for shape only:

| Operation               | p50    | p95    | p99    | Rejected                                    |
| ----------------------- | ------ | ------ | ------ | ------------------------------------------- |
| Lead reads              | 561ms  | 615ms  | 617ms  | 0%                                          |
| Lead writes (contended) | 880ms  | 1436ms | 1441ms | 24% (correct — lost races)                  |
| Same-step sends         | 2638ms | 2731ms | 2964ms | 0%                                          |
| Suppression             | 141ms  | 170ms  | 171ms  | 96% (correct — 1 winner)                    |
| Deal moves              | 2180ms | 2948ms | 2953ms | 16% (correct — illegal from observed stage) |
| Interleaved tenants     | 397ms  | 984ms  | 996ms  | 0%                                          |

Heap 36.8MB → 41.8MB, RSS 146MB.

**No capacity claim is made from these numbers.** They come from one Node process
on a developer laptop against a containerised database, with a Docker image build
competing for the same CPU. They are evidence of _correctness under contention_
and nothing else.

The rejection rates are the point, not a defect: under contention most writers
_must_ lose. A suite where all 25 suppressions reported `added: true` would be
reporting a bug.

### 3–4. PostgreSQL and Redis failure drills — **GREEN**

```bash
npm run drill:containers
```

**25/25 assertions.** These stop the actual containers — `docker stop` / `docker
start`, never `rm`, never `down`, never `volume rm`. The previous certification
simulated outages with an unreachable port and said so; a simulated outage cannot
answer the question that matters, which is whether the system comes back without
a restart.

|                              | PostgreSQL                       | Redis                                      |
| ---------------------------- | -------------------------------- | ------------------------------------------ |
| Failure detected in          | 69ms                             | **2.4s** (was 67s — bug #5)                |
| Liveness during outage       | 200 (correct)                    | 200 (correct)                              |
| Readiness during outage      | **503**, names `database`        | **503**, names `redis`                     |
| Other datastore unaffected   | Redis accepted work in 85ms      | PostgreSQL served in 5ms                   |
| Recovery without app restart | **yes, 1s**                      | **yes, 1s**                                |
| Readiness back to ok         | 5ms later                        | 4ms later                                  |
| Workers recovered            | yes, 0s                          | yes, 0s; heartbeats rewritten              |
| Data survived                | **yes** — 27 businesses          | **yes** — queued + delayed unchanged (AOF) |
| Idempotency after recovery   | duplicate job id still collapsed | same                                       |

One finding worth carrying into the runbook: the **queue** connection recovers
_after_ the cache connection, because it runs `enableOfflineQueue: false` so
BullMQ fails fast rather than buffering against a dead socket. Measured at 2ms
behind — but it means `/api/health` can read green for a moment while the queue
still refuses commands.

### 5. Disk safety — **GREEN**

The incident this closes: at **0.62 GB free**, PostgreSQL blocked _writes_ while
_reads_ kept working. `/api/health` checks the database with `SELECT 1` — a read
— so it returned **200 for the entire incident** while every login hung for 317
seconds. Every monitor said healthy while the application was unusable.

| Threshold         | Value                     | Reasoning                                                                                      |
| ----------------- | ------------------------- | ---------------------------------------------------------------------------------------------- |
| Operational floor | **10 GB**                 | Where there is still comfortable time to react                                                 |
| Critical          | **2 GB**                  | Observed failure was 0.62 GB; a build or log rotation eats a gigabyte unnoticed                |
| Unmeasurable      | `unknown`, **never `ok`** | "We could not look" must not be recorded as "it is fine" — that conflation is the whole lesson |

Wired into three places:

- `/api/health` — unauthenticated, **503 when critical**. This is the endpoint
  that lied, and the one an external monitor can actually poll. Exposes the
  _state_ only, never the free-byte figure: a capacity number is reconnaissance,
  a three-word state is not.
- `/api/health/ready` — 503 when critical, so a load balancer stops routing.
- `/api/ops/status` — `DISK_LOW`, placed **ahead of** `DATABASE_DOWN` so that
  when both fire the operator reads the cause before the symptom.

```bash
$ curl -s localhost:3100/api/health
{"status":"ok","checks":{"database":true,"redis":true,"disk":"ok"},"mockMode":true}

$ curl -s localhost:3100/api/health/ready
{"status":"ok","checks":{"database":true,"redis":true,"disk":"ok"},
 "disk":{"freeGb":23.23,"summary":"23.23 GB free."}}
```

**Tests:** 9 unit tests in `tests/unit/ops/disk.test.ts`, including the 0.62 GB
case, `bavail`-not-`bfree` (reading `bfree` would have reported 5.5 GB where 0.5
GB was true), and that an unmeasurable disk never reports `ok`.

**No automatic deletion of anything.** The runbook's remediation is ordered and
manual — `docker image prune` and `docker builder prune` are safe and usually
recover the most; `docker system prune -a --volumes` and Docker Desktop's
"Purge data" are called out as destroying `leadradar-pgdata`. A disk-pressure
response that deletes business records trades a recoverable outage for an
unrecoverable one.

**Stated limitation:** this measures the filesystem of the _application process_.
In a deployment where PostgreSQL is on another host, it can read `ok` while the
database's disk is full. That is in the payload and in the runbook, because a
monitoring signal whose scope is misunderstood is how the incident happened.

### 6. External monitoring readiness — **YELLOW**

**Nothing polls these endpoints. No external monitor is running.** The contract
is documented (`PRODUCTION_RUNBOOK.md` §2c); wiring it up is a manual step.

Verified semantics:

| Endpoint            | Auth        | Codes          | Suitable for               |
| ------------------- | ----------- | -------------- | -------------------------- |
| `/api/health/live`  | none        | always 200     | **Restart decisions only** |
| `/api/health/ready` | none        | 200 / 503      | Load-balancer routing      |
| `/api/health`       | none        | 200 / 503      | Uptime monitoring          |
| `/api/ops/status`   | **session** | **always 200** | Human dashboard            |

**`/api/ops/status` is NOT suitable for a simple uptime monitor**, and this is
the honest answer to the question rather than a workaround: it needs a session
(it reports queue depths, worker hostnames and campaign counts — the shape of a
deployment), and it always returns 200 because the dashboard consumes the same
response and a 503 would render an error page instead of showing the operator the
alerts. A monitor that understands only status codes polls `/api/health`; one
that can authenticate polls `/api/ops/status` and alerts on
`alerts[].severity == "critical"`.

The gap an operator must understand: **a dead worker does not affect any health
endpoint.** The web tier is genuinely healthy. Discovery, campaigns and reply
detection are all stopped and only `NO_WORKER` on `/api/ops/status` says so.

### 7. Dependency security audit — **GREEN**

```bash
npm audit            # full tree
npm audit --omit=dev # production only
```

**Before:** 3 high, 2 moderate. **After:** **0 critical, 0 high**, 2 moderate.

| Advisory                                                                  | Severity    | Path                                         | Production impact                                    | Action                                                |
| ------------------------------------------------------------------------- | ----------- | -------------------------------------------- | ---------------------------------------------------- | ----------------------------------------------------- |
| GHSA-ggr8-5vv4-36mx — `deepmerge-ts` stack exhaustion on recursive graphs | HIGH ×3     | `prisma` → `@prisma/config` → `deepmerge-ts` | Build/migrate only, input is our own `schema.prisma` | **Fixed** — `overrides: { "deepmerge-ts": "^8.0.0" }` |
| GHSA-w5hq-g745-h8pq — `uuid` missing buffer bounds check                  | MODERATE ×2 | `exceljs` → `uuid@8.3.2`                     | **Not reachable**                                    | **Accepted**                                          |

On the fix: no released Prisma carries a patched `deepmerge-ts` — even
`@prisma/config@7.10.0` still pins 7.1.5 — and npm's suggested "fix" was
`prisma@6.12.0`, a **downgrade** from 6.19.3 that would not have resolved it. The
override was verified rather than assumed: `prisma validate` → _"The schema is
valid"_, `prisma migrate status` → _"Database schema is up to date!"_.

On the acceptance: the advisory affects uuid v3/v5/v6 **when `buf` is provided**.
exceljs calls `uuidv4()` at two sites and passes no buffer, so the vulnerable
code path is unreachable. npm's only offered fix is `exceljs@3.4.0` — a downgrade
from 4.4.0, and a regression rather than a fix.

Docker base image `node:22-alpine`; no image scanner (trivy/grype) is available
in this environment, so **base-image CVEs are UNKNOWN** and remain so.

### 8. Cross-tenant penetration test — **GREEN**

```bash
npx next dev -p 3100
npm run pentest:tenancy
```

**74/74 passed. No cross-tenant access was achieved.**

Two throwaway organizations, both users **OWNER** — so a rejection can only come
from the tenant boundary, never from a role gate — with valid session cookies,
matching CSRF tokens and same-origin headers, so no layer above tenancy can
produce a false pass.

| Attack                                                    | Result                                             |
| --------------------------------------------------------- | -------------------------------------------------- |
| A's OWNER session against 17 of B's id-addressable routes | **all denied**, 404                                |
| B's objects in A's 7 collections                          | **absent from every one**                          |
| `organizationId` in query string                          | ignored — tenancy from the session row             |
| `organizationId` in a create body                         | **rejected outright** (strict schema)              |
| Deal created against another org's lead                   | refused                                            |
| Another org's lead attached to caller's campaign          | refused, 0 attached                                |
| B's CSRF token with A's session                           | refused                                            |
| B's CSRF cookie attached to A's session                   | refused                                            |
| Tampered session token                                    | 401                                                |
| 16 unauthenticated routes                                 | **all 401**                                        |
| Aggregate leakage via analytics                           | neither tenant saw the global count                |
| B's objects after A's attacks                             | **byte-for-byte unchanged**, including `updatedAt` |

**The corrections to this test matter more than its passes.** Its first run
reported 8 breaches. Seven were the test's own bugs:

- It sent `?limit=100` to routes whose query schemas are `.strict()` and take
  `pageSize`. Four 400s were scored as tenant breaches.
- It sent `status: 'DONE'`, not in the enum, so that attack never reached the
  tenant check it existed to test.
- Its tamper checks compared against pristine values while the **control run had
  legitimately mutated the same fixtures as their owner** — reporting org B's own
  writes as tampering by org A.

A security report whose findings cannot be believed is worse than no report, so
the fixture handling was reworked: it now snapshots B's state the instant before
A begins, which is both correct and stricter (it compares `updatedAt` too).

The one real finding was #7: `/api/leads/:id/activities` answered **200** with an
empty list for another tenant's lead id, where every sibling route 404s. Nothing
leaked — the query was tenant-scoped, and an empty list is indistinguishable from
"this lead has no activities", so it is not even an enumeration oracle. Fixed for
consistency: "success, no rows" is a different claim from "no such lead".

Not covered, and stated rather than glossed: meetings and proposals have no
id-addressable API routes yet, so they were not attacked through HTTP. Their
data access goes through the same `TenantContext` as everything else, but that is
a reading, not evidence.

### 9. Deep-offset pagination — **GREEN (measured, and deliberately not changed)**

```bash
npm run bench:pagination -- --rows=50000
```

At 50,000 rows — the export's own `MAX_ROWS` ceiling, so the worst case this code
can meet:

```
OFFSET walk: 74,585ms for 50,000 rows
keyset walk: 71,517ms for 50,000 rows      1.04×, inside the noise
both walks returned exactly 50,000 rows — keyset loses nothing
```

Per-page at 10,000 rows, page 1 → page 200: 635ms → 1258ms (1.98×), and the
intermediate points are not monotonic — page 100 measured slower than page 200 —
so even that ratio is mostly noise.

**Keyset was also slower per page at depth** (5434ms vs 537ms at page 10). The
reason is structural: the sort leads with `opportunityScore DESC NULLS LAST`,
nullable and non-unique, so a cursor cannot become an index seek and both plans
sort. The walk's cost is dominated by the `include` joins at ~1.5ms/row, not by
the offset scan.

**An earlier commit on this branch had switched the export to keyset on the
theoretical argument. The measurement did not support it and the change was
reverted.** The reasoning was sound and the conclusion was wrong, which is
exactly why the instruction "do not optimize based solely on theoretical
concerns" is a good one. `scripts/bench-pagination.ts` is the regression guard.

### 10. Queue metrics — **GREEN, with history deliberately not built**

| Metric                | Status                                            |
| --------------------- | ------------------------------------------------- |
| Queue depth (waiting) | present                                           |
| Active jobs           | present                                           |
| Delayed               | present                                           |
| Failed                | present                                           |
| Completed             | present                                           |
| DLQ count             | present                                           |
| Paused                | present                                           |
| Worker heartbeat      | present — **and now correct per worker** (bug #3) |
| **Job age**           | **added** — `oldestWaitingAgeMs`                  |
| Processing latency    | **not present** — see below                       |

`oldestWaitingAgeMs` was the real gap. Depth alone cannot distinguish a deep
queue draining quickly from a shallow one stuck for an hour, and those have
opposite remedies. Worse, a depth threshold of 500 never fires for three jobs
that have sat for two hours — which is the shape a wedged queue actually has. New
alert `QUEUE_STALLED` at 15 minutes.

**Historical metrics are deliberately not stored.** The endpoint is a snapshot
and an external monitor scraping it on an interval _is_ the history. Storing time
series in PostgreSQL would be building a time-series database badly, and the
instruction was explicitly not to build an analytics subsystem for this. Per-job
processing latency is available in BullMQ's own job records for a specific
investigation; aggregating it continuously is the same trade and the same answer.

---

## 3. Complete regression results

Every command below was run at `58c8863`.

| Gate                     | Command                                    | Result                                      |
| ------------------------ | ------------------------------------------ | ------------------------------------------- |
| Provider guard           | `npm run guard:providers`                  | **pass** — 219 files, 6 rules               |
| Typecheck                | `npx tsc --noEmit`                         | **pass**                                    |
| Lint                     | `npx eslint .`                             | **pass**, 0 warnings                        |
| Prisma schema            | `npx prisma validate`                      | **valid**                                   |
| Schema drift             | `npx prisma migrate status`                | **none** — "up to date"                     |
| Unit tests               | `npx vitest run tests/unit`                | **791 passed**, 35 files                    |
| Integration              | `npm run test:integration`                 | **34 passed**, real PostgreSQL              |
| Pipeline                 | `npm run verify:pipeline`                  | **9/9**                                     |
| Outreach                 | `npm run verify:outreach`                  | **29/29**                                   |
| Sequence                 | `npm run verify:sequence`                  | **38/38**                                   |
| Revenue                  | `npm run verify:revenue`                   | **47/47**                                   |
| Recovery                 | `npm run verify:recovery`                  | **27/27**                                   |
| Production build         | `npm run build`                            | **pass** — compiled in 11.1s, 30 pages      |
| Dependency audit         | `npm audit`                                | **0 critical, 0 high**, 2 accepted moderate |
| **Concurrency**          | `npm run test:concurrency`                 | **30/30**, 0 invariant violations           |
| **Container drills**     | `npm run drill:containers`                 | **25/25**                                   |
| **Cross-tenant pentest** | `npm run pentest:tenancy`                  | **74/74**, no access achieved               |
| **Worker image**         | `npm run verify:worker-image`              | **6/6**                                     |
| **Pagination benchmark** | `npm run bench:pagination -- --rows=50000` | measured; no change warranted               |

**Totals: 825 automated tests. 285 end-to-end assertions** (was 809 / 150).

`verify:pipeline` failed 5/9 on its first run **because no worker was running** —
a documented precondition of that script, not a defect. 9/9 with a worker up.

---

## 4. Files changed

**New modules**

- `src/modules/ops/disk.ts` — disk headroom, `ok`/`warning`/`critical`/`unknown`

**Changed**

- `src/lib/redis.ts` — bounded health check (bug #5)
- `src/lib/logger.ts` — `pino-pretty` optional at runtime
- `src/workers/index.ts` — count jobs from the worker, not `QueueEvents` (bug #3)
- `src/modules/jobs/processors.ts` — `createMany` + 20s transaction (bug #4)
- `src/modules/jobs/queues.ts` — `oldestWaitingAgeMs`
- `src/modules/ops/status.ts` — disk in readiness and `opsStatus`, `DISK_LOW`, `QUEUE_STALLED`
- `src/modules/database/repositories.ts` — `escapeLike()` (bug #1)
- `src/modules/crm/activities.ts` — lead existence check (bug #7)
- `src/app/api/health/route.ts` — disk state, 503 when critical
- `Dockerfile` — `deps-prod` stage; `node --import tsx` instead of `npx tsx` (bug #2)
- `package.json` — `tsx` and `dotenv` to `dependencies` (bug #6); `deepmerge-ts` override

**New scripts**

| Script                           | Command                       | Assertions |
| -------------------------------- | ----------------------------- | ---------- |
| `scripts/concurrency-test.ts`    | `npm run test:concurrency`    | 30         |
| `scripts/drill-containers.ts`    | `npm run drill:containers`    | 25         |
| `scripts/pentest-tenancy.ts`     | `npm run pentest:tenancy`     | 74         |
| `scripts/verify-worker-image.ts` | `npm run verify:worker-image` | 6          |
| `scripts/bench-pagination.ts`    | `npm run bench:pagination`    | benchmark  |

**New tests**

- `tests/unit/security/like-escape.test.ts` — 7 tests
- `tests/unit/ops/disk.test.ts` — 9 tests

**Docs**

- `docs/PRODUCTION_RUNBOOK.md` — §2c external monitoring contract; disk
  remediation; stale "no follow-up sequences" claim corrected (they shipped in
  Phase 1)
- `docs/PHASE_A_HARDENING.md` — this document

---

## 5. Remaining risks

| #   | Risk                                                          | Severity | Why it remains                                                     |
| --- | ------------------------------------------------------------- | -------- | ------------------------------------------------------------------ |
| 1   | **No external monitor**                                       | **HIGH** | Alerts exist; nothing polls them. Manual step, contract documented |
| 2   | Docker base image CVEs **UNKNOWN**                            | MEDIUM   | No scanner available here                                          |
| 3   | Image never booted in true production mode                    | MEDIUM   | Requires real credentials — out of scope by instruction            |
| 4   | `docker compose --profile app up` crash-loops on a dev `.env` | MEDIUM   | Correct guard behaviour; documented, but surprising                |
| 5   | Disk check measures the app's filesystem, not the DB host's   | MEDIUM   | Stated in payload and runbook; monitor DB host separately          |
| 6   | Meetings/proposals not attacked over HTTP                     | LOW      | No id-addressable routes yet                                       |
| 7   | `uuid` advisory via `exceljs`                                 | LOW      | Unreachable; only "fix" is a downgrade                             |
| 8   | Concurrency figures are single-machine                        | LOW      | Correctness evidence only, never capacity                          |
| 9   | Refresh tokens expire in 7 days                               | MEDIUM   | OAuth app in Testing mode — publish it                             |
| 10  | Queue connection green-gap after Redis recovery               | LOW      | 2ms measured; `/api/health` can lead it briefly                    |

**Environmental, not defects, but they cost hours:** the Docker Desktop port
proxy intermittently refused `localhost:5433` (already documented in the runbook);
two image builds died on `npm ci` network timeouts after 31 minutes; and the disk
fell to 12.69 GB free on C: during the phase — inside the warning band the new
monitoring exists to catch.

---

## 6. Remaining manual-only tasks

Unchanged from the previous certification, because nothing in this phase could
change them. Every one requires a human with real credentials.

1. **Certify Gmail against Google** — `npm run certify:gmail`. Everything below
   is blocked on it.
2. **Send one real email to yourself and check the Sent folder.** An API 200
   means Google accepted the request; the Sent folder means it sent.
3. **Run 3–5 leads to addresses you own**, reply from another mailbox, confirm
   the campaign stops. The single most important safety property, never observed
   for real.
4. **Confirm `APP_PUBLIC_URL` is publicly reachable.** A localhost unsubscribe
   link in a real email is a broken legal promise.
5. **DPDP legal review** (`legal-review-brief.md` §5).
6. **Configure an external monitor** against `PRODUCTION_RUNBOOK.md` §2c.
7. **Publish the OAuth app** to end the 7-day refresh-token expiry.

---

## 7. Honest summary

The engineering and operational gaps the previous certification listed are
closed, and closing them found seven real bugs — two of which (the drain and the
counter) would have degraded every deployment quietly, without ever failing a
test.

What did not change: **no real email has been sent.** There is no reply data, no
revenue, and no evidence that the scoring model predicts anything. The gap
between here and a working business is not code, and this phase did not narrow
it.

One result deserves repeating because it cuts against the direction of the work:
the deep-offset pagination concern **did not survive measurement**, and a change
already written to address it was reverted. The theory was sound. The numbers
disagreed. The numbers win.
