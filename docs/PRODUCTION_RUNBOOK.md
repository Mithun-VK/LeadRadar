# Production runbook

Operating LeadRadar against real infrastructure. Everything here describes
**actual behaviour**, verified in the codebase — not intended behaviour.

> **Status:** no step in §2 has ever been performed. LeadRadar has never sent a
> real email. Until §2 is complete, treat every Gmail claim as unproven.

---

## 1. The three modes

Which mode you are in is the single most important operational fact, and the
dashboard states it on every page.

| Mode | Configuration | What happens |
|---|---|---|
| **Mock** | `MOCK_EXTERNAL_APIS=true` | Everything runs. No message leaves the process. Business data is fabricated. **Rejected in production** — the app refuses to boot. |
| **Live, sending off** | `MOCK_EXTERNAL_APIS=false`, `EMAIL_SENDING_ENABLED=false` | Real discovery, crawling, scoring. **No outbound email is possible.** The safe default for a first production deploy. |
| **Live, sending on** | both above plus a connected mailbox | Real email reaches real people. |

Boot fails fast rather than degrading: mock mode in production is refused, and
live mode without credentials is refused. There is no silent fallback — a
deployment that quietly served fabricated leads because a key was missing would be
the worst failure this product can have.

---

## 2. First-run certification

**Do these in order. Do not skip to step 10.**

Each step has an explicit pass condition. If one fails, stop and fix it before
continuing — the later steps assume the earlier ones hold.

### Step 1 — Environment

```bash
cp .env.example .env
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"  # ENCRYPTION_KEY
```

Set `DATABASE_URL`, `REDIS_URL`, `ENCRYPTION_KEY`, `GOOGLE_MAPS_API_KEY`,
`FIRECRAWL_API_KEY`, `GROQ_API_KEY`, `APP_PUBLIC_URL`.

Leave `EMAIL_SENDING_ENABLED=false` for now.

**Pass:** `npm run build` succeeds and the app boots.

### Step 2 — Database

```bash
npx prisma migrate deploy
npx prisma migrate status     # must say: Database schema is up to date!
```

**Pass:** no drift, no pending migrations.

> On Windows with Docker port-forwarding, the first Prisma connection
> intermittently fails with `P1001` and succeeds on retry. Retry once before
> investigating.

### Step 3 — Health

```bash
curl -s http://localhost:3000/api/health
```

**Pass:** `{"status":"ok","checks":{"database":true,"redis":true,"disk":"ok"}}`

The database check is a **read** (`SELECT 1`). On a full disk Postgres blocks
writes while reads keep working, so that check alone would report `ok` while
every write hangs — which is exactly what happened at 0.62 GB free.

`checks.disk` exists because of that incident and is the reason this endpoint can
now detect it. Treat `"critical"` as a failure and `"unknown"` as a gap in
observation, never as `"ok"`. See §2c and §5.

### Step 4 — Small live discovery

One city, one category, low cap. Review the cost estimate **before** confirming —
`/api/search/parse` has no side effects and spends nothing.

**Pass:** leads appear with plausible names, categories, and websites. Cost on the
Usage page is within an order of magnitude of the estimate.

### Step 5 — Gmail OAuth

Follow `docs/GMAIL_SETUP.md`. Set `EMAIL_SENDING_ENABLED=true` and restart.

Dashboard → Email → **Connect Gmail**. Leave the send permission ticked.

**Pass:** the page shows the connected address and `healthy`. If it shows
"granted without permission to send", the scope was unticked — reconnect.

### Step 6 — Test to yourself

Dashboard → Email → **Send a test to yourself**.

This can only send to the connected mailbox's own address. There is no recipient
field, and the API has no recipient parameter.

**Pass:** the message arrives, **and appears in Gmail's Sent folder**. The Sent
folder is the real proof — it confirms Google accepted and sent it, not merely
that the API returned 200.

> **This is the first real email this system will ever have sent.**

### Step 7 — Reply detection

From a **second mailbox you control**, reply to that message.

**Pass:** within ~10 minutes (`inbox-sync` runs `*/10 * * * *`) the reply appears
against the lead, an intent is classified, and a CRM activity exists.

To avoid waiting, trigger the sync job manually rather than editing the schedule.

### Step 8 — Controlled campaign

Build a campaign of **3–5 leads whose addresses you own**. Read the rendered
previews — they are the actual text, per lead.

Activate (type `SEND`).

**Pass:** each message arrives; `List-Unsubscribe` is visible in the client
(Gmail shows an "Unsubscribe" link beside the sender).

### Step 9 — Reply stops the campaign

Reply from one of those addresses.

**Pass:** that lead's status advances and **no further messages are sent to it**.
This is the single most important safety property to confirm by hand.

### Step 10 — Unsubscribe

Click the unsubscribe link in one message.

**Pass:** the address appears on the suppression list, and re-enrolling it in a
new campaign skips it with reason `SUPPRESSED`. Suppression is permanent and
cannot be cleared through the UI.

### Step 11 — Bounce

Send to a known-invalid address on a domain you control.

**Pass:** the message is marked `FAILED`/`BOUNCED` and the address is suppressed
automatically. Re-mailing a hard bounce damages your own sending reputation, so
this must be automatic.

### Step 12 — Kill switch

With a campaign running:

```bash
curl -X POST http://localhost:3000/api/ops/controls \
  -H 'content-type: application/json' -H "x-csrf-token: $CSRF" \
  --cookie "leadradar_session=$SESSION" \
  -d '{"control":"outbound","paused":true,"reason":"runbook drill"}'
```

**Pass:** sending stops immediately. The next send returns `OUTBOUND_PAUSED`.

Then resume with `"paused": false`.

**Pass:** queued leads resume — nothing was lost.

### Step 13 — Raise limits

Only now increase `EMAIL_DAILY_LIMIT` beyond single digits, and only gradually. A
new sending domain that suddenly emits hundreds of messages is the classic
spam-filter trigger.

---

## 2a. Observability — the twelve operator procedures

### Health endpoints

| Endpoint | Auth | Depth | Use |
|---|---|---|---|
| `GET /api/health/live` | public | **none** — no DB, no Redis | Container liveness. Restart on failure. |
| `GET /api/health/ready` | public | DB + Redis | Load-balancer readiness. 503 when degraded. |
| `GET /api/health` | public | DB + Redis | Legacy combined check. |
| `GET /api/ops/status` | **session** | everything | The operator's screen. |

Liveness is deliberately shallow. It answers *"should this container be
restarted?"*, and restarting a healthy web process because Postgres blipped turns
a database wobble into an outage.

`/api/ops/status` is authenticated because it reports queue depths, worker
hostnames, and failure rates — together, the shape of a deployment.

### 1. Start the system

```bash
docker compose up -d          # Postgres + Redis
npm run dev                   # web
npm run worker                # workers — NOT optional
```

Without the worker: no discovery, no sending, no reply detection, no retention.

### 2. Check health

```bash
curl -s localhost:3000/api/health/ready
# then, signed in:
curl -s localhost:3000/api/ops/status | jq '{status, alerts: [.alerts[].code]}'
```

`status` is `ok` / `degraded` / `critical`. Every alert carries an `action`.

### 3. Connect Gmail — see §2 and `docs/GMAIL_SETUP.md`

### 4. Verify outbound

```bash
npm run verify:outreach       # mock-mode proof of the whole send path
npm run certify:gmail         # LIVE proof — refuses to run against the mock
```

### 5. Pause outbound — see §3. Fails **closed**.

### 6. Investigate failed jobs

`/api/ops/status` → `queues[].failed` and `queues[].deadLettered`.

Dead-lettered jobs exhausted their retries and **will not retry on their own**.
Each carries `originalName`, `originalJobId`, `payload`, and `failedReason`.

A cluster of identical `failedReason` values is one bug, not many — that is
exactly how the `Custom Id cannot contain :` defect was found (89 identical
failures from a scheduler failing every 15 minutes).

### 7. Recover workers

```bash
# Is one alive?
curl -s localhost:3000/api/ops/status | jq '.workers'
npm run worker                # queued jobs resume automatically
```

Workers heartbeat into Redis every 15s with a 45s TTL. **No heartbeat = no
worker**, not merely an idle one. A stale heartbeat (>90s) usually means wedged
on a long job.

Jobs are not lost on a crash: BullMQ re-delivers anything in flight, and the
campaign scheduler re-wakes running campaigns every 15 minutes.

### 8. Handle Gmail failure

`/api/ops/status` → `gmail.state`:

| State | Do |
|---|---|
| `DEGRADED` | Nothing. Still sending; watch it clear. |
| `BLOCKED` | Check `lastErrorCode`. If rate limited, lower the campaign daily limit. |
| `AUTH_REQUIRED` | **Reconnect.** Retrying cannot fix a revoked grant. |
| `DISCONNECTED` | Connect a mailbox. |

### 9. Roll back a deployment

Migrations are **additive only** — no column has been dropped or repurposed — so
the previous release runs against the current schema. Roll back the application;
leave the database alone.

Never `prisma migrate reset`: it drops everything.

### 10. Verify the database

```bash
npx prisma migrate status     # must say: Database schema is up to date!
curl -s localhost:3000/api/ops/status | jq '.infrastructure'
```

`databaseLatencyMs` above ~500ms consistently means disk or connection pressure.

### 11. Verify the queue

```bash
curl -s localhost:3000/api/ops/status | jq '.queues'
```

`waiting` is normal after a large search and should drain. Growing with a live
worker means it cannot keep up. `paused: true` stops that queue entirely.

### 12. Emergency shutdown

```bash
# 1. Stop outbound first — the only irreversible thing.
curl -X POST localhost:3000/api/ops/controls -H 'content-type: application/json' \
  -H "x-csrf-token: $CSRF" --cookie "leadradar_session=$SESSION" \
  -d '{"control":"outbound","paused":true,"reason":"incident"}'

# 2. Then stop processes. SIGTERM drains in-flight jobs; SIGKILL does not.
kill -TERM <worker-pid>
```

Order matters. Killing the worker first leaves campaigns able to resume the
moment it restarts; pausing outbound first means they cannot.

---

## 2b. Alert thresholds

Evaluated on read at `/api/ops/status`. No alerting platform — an endpoint an
uptime monitor already polls is the simplest mechanism that cannot itself fail
silently.

| Alert | Severity | Threshold | Why that number |
|---|---|---|---|
| `NO_WORKER` | critical | no heartbeat | Everything asynchronous is stopped |
| `WORKER_STALE` | warning | >90s | 3 missed beats; one missed beat is a GC pause |
| `DATABASE_DOWN` / `REDIS_DOWN` | critical | health check fails | — |
| `QUEUE_BACKLOG` | warning / critical | 500 / 5,000 waiting | Normal after a search; 5,000 means it cannot keep up |
| `DEAD_LETTER` | warning | ≥10 | Exhausted retries; will not self-heal |
| `QUEUE_PAUSED` | warning | any | Often left over from an incident |
| `GMAIL_AUTH_REQUIRED` | critical | grant revoked | Only a human can fix it |
| `GMAIL_BLOCKED` | critical | 5 consecutive failures | — |
| `GMAIL_DEGRADED` | warning | 1–4 failures | Still sending |
| `HIGH_SEND_FAILURE_RATE` | critical | ≥20% of ≥10 sends | 1% would fire constantly; 1-in-5 is a provider problem |
| `INBOX_SYNC_STALE` | warning | >45min | Sync runs every 10min; replies not being detected |
| `STUCK_CAMPAIGN` | warning | RUNNING, nothing sent 26h | >24h so a daily limit is not mistaken for a stall |
| `QUEUE_STALLED` | warning | oldest waiting job >15min | Depth alone misses a wedged queue with three old jobs in it |
| `DISK_LOW` | warning / critical | <10 GB / <2 GB free | See §2c — this is the failure that looked healthy |
| `OUTBOUND_PAUSED` | warning | switch thrown | So a pause is never forgotten |

---

## 2c. External monitoring — how to poll this system

**Status: no external monitor is running.** Nothing polls these endpoints today.
Everything below is the contract an operator should wire a monitor to; until they
do, the alerts exist and nobody is watching them.

### Which endpoint, and why they are different

| Endpoint | Auth | Codes | Poll every | Use it for |
|---|---|---|---|---|
| `/api/health/live` | none | always 200 | 10s | **Restart decisions only.** Shallow by design |
| `/api/health/ready` | none | 200 / **503** | 15s | **Load-balancer routing.** DB, Redis, disk |
| `/api/health` | none | 200 / **503** | 30s | **Uptime monitoring.** Same checks, plus mock-mode |
| `/api/ops/status` | session | always 200 | 60s | **Human dashboard.** Alerts, queues, Gmail, campaigns |

The split is not cosmetic. **Never restart a container on a `/api/health/ready`
failure**: readiness fails when PostgreSQL is unavailable, and restarting a
healthy web process because its database blinked converts a two-second blip into
a rolling outage. Restart on `/api/health/live` alone — and that endpoint only
fails when the process cannot respond at all.

### `/api/ops/status` is NOT suitable for a simple uptime monitor

Two reasons, both deliberate:

1. **It requires a session.** It reports queue depths, worker hostnames, campaign
   counts and failure rates — the shape of a deployment. That belongs behind
   authentication, so a monitor would need to hold credentials.
2. **It always returns 200.** The status lives in the body (`status`, and
   `alerts[]` with `severity`), not the status code, because the dashboard
   consumes the same response and a 503 would render as an error page instead of
   showing the operator the alerts they need.

So: a monitor that only understands status codes should poll `/api/health`. A
monitor that can authenticate and parse JSON should poll `/api/ops/status` and
alert on `alerts[].severity == "critical"`.

### What should page someone

| Condition | Where to see it | Severity |
|---|---|---|
| `/api/health` returns 503 for 2 consecutive polls | status code | page |
| `/api/health` unreachable for 60s | connection | page |
| any `alerts[].severity == "critical"` | `/api/ops/status` | page |
| `checks.disk == "critical"` | `/api/health` | page — see §2c note below |
| any `alerts[].severity == "warning"` | `/api/ops/status` | ticket, not a page |
| `checks.disk == "unknown"` | `/api/health` | ticket — the disk is unmeasurable, which is not the same as fine |

**Two consecutive polls, not one.** A single failed poll during a deploy or a
connection reset is noise, and a monitor that pages on noise stops being read.

### Why disk is on the unauthenticated endpoint

`/api/health` reports `checks.disk` because **this is the endpoint that lied.**
At 0.62 GB free, PostgreSQL blocked writes while reads kept working. The database
check here is `SELECT 1` — a read — so it returned 200 for the entire incident
while every login hung for 317 seconds. A monitor watching it would have reported
the system healthy throughout.

Only the disk *state* is exposed, never the free-byte figure: this endpoint is
unauthenticated, and a capacity number is reconnaissance where a three-word state
is not.

### Expected behaviour during a failure

Measured in `npm run drill:containers`, by stopping the real containers:

| Failure | `live` | `ready` | `health` | Recovery |
|---|---|---|---|---|
| PostgreSQL stopped | 200 | **503** | **503** | Pool recovers in ~31s, no app restart |
| Redis stopped | 200 | **503** | **503** | Client reconnects, no app restart |
| Disk critical | 200 | **503** | **503** | Operator must free space |
| Worker dead | 200 | 200 | 200 | **Not visible here** — only `/api/ops/status` |

The last row matters: a dead worker does not affect any health endpoint, because
the web tier is genuinely healthy. Discovery, campaigns and reply detection are
all stopped, and only `NO_WORKER` on `/api/ops/status` will say so. **A monitor
that polls only the health endpoints will not notice that every asynchronous
thing in the system has stopped.**

A Redis health check takes up to ~17s to report failure (the client's reconnect
strategy), so allow a 30s timeout on any monitor polling `ready` or `health`.

---

## 3. Emergency controls

`POST /api/ops/controls` — OWNER/ADMIN only, every change audited.

| Control | Effect | Fails |
|---|---|---|
| `outbound` | Stops every campaign send instantly, including mock sends | **CLOSED** |
| `ai` | Stops personalization and intent classification; deterministic fallbacks continue | open |
| `crawler` | Stops discovery and crawling | open |

**Why outbound fails closed:** if the control state cannot be read, sending stops.
An email that should have gone and did not is recoverable; one that should not
have gone and did cannot be recalled. The other two fail open because halting the
pipeline over a transient read error costs more than proceeding.

A reason is **required** when pausing. An unexplained halt wastes the next
person's time.

The switch is read on **every send** and is not cached — a brake with a
30-second cache is a brake that does not work when you press it.

### Other stops

| Situation | Action |
|---|---|
| One campaign misbehaving | Pause that campaign |
| Mailbox compromised | Dashboard → Email → Disconnect. Running campaigns auto-pause. Then revoke at [myaccount.google.com/permissions](https://myaccount.google.com/permissions) |
| Worker misbehaving | Stop the worker process. Queued jobs persist in Redis and resume |
| Everything | `outbound` kill switch first, then investigate |

---

## 4. Routine operations

| Job | Schedule | Purpose |
|---|---|---|
| `purge-google-snapshots` | `17 * * * *` | 30-day retention on Google-derived data |
| `purge-email-bodies` | `23 4 * * *` | 90-day retention on inbound bodies |
| `refresh-place-ids` | `0 3 * * *` | Free existence check |
| `campaign-scheduler` | `*/15 * * * *` | Re-wakes campaigns stalled by a worker restart |
| `inbox-sync` | `*/10 * * * *` | Reply detection |

Off-peak odd minutes are deliberate — avoids a thundering herd on the hour.

**The worker is not optional.** Without it: discovery never progresses, campaigns
never send, replies are never detected, and retention never runs. A search sitting
at 0% is almost always a stopped worker.

---

## 5. Known failure modes

### Disk exhaustion — the silent one

**Symptom:** health returns 200; writes hang indefinitely. Login appears to hang
forever (observed: 317 seconds) because it writes a session row, while
`/api/health` passes because it only reads.

**Cause:** Postgres blocks writes when it cannot extend the WAL.

**Now detected.** `/api/health` and `/api/health/ready` both report
`checks.disk` and return **503** below 2 GB free. `/api/ops/status` raises
`DISK_LOW` — placed ahead of `DATABASE_DOWN` in the alert list on purpose, so
when both fire the operator reads the cause before the symptom.

| Free space | State | What it means |
|---|---|---|
| >10 GB | `ok` | The documented operational floor |
| 2–10 GB | `warning` | Act today. A build or a log rotation eats a gigabyte unnoticed |
| <2 GB | `critical` | Writes are at risk. Health returns 503 |
| unmeasurable | `unknown` | **Not `ok`.** Check `df -h` by hand |

**Fix, in order:**

1. `df -h` to confirm, and find what grew.
2. `docker image prune` — **images only**. Safe: it removes nothing that holds
   data. This usually recovers the most space by far.
3. `docker builder prune` for the build cache. Also safe.
4. Truncate application logs and remove old files under `exports/`.
5. Restart Postgres **after** freeing space: `docker restart leadradar-postgres`.

**Never** run `docker system prune -a --volumes`, `docker volume rm`, or Docker
Desktop's "Clean / Purge data" — each destroys the `leadradar-pgdata` volume and
with it the entire database. There is no automatic cleanup of application or
database data anywhere in this system, and there should not be: a disk-pressure
response that deletes business records trades a recoverable outage for an
unrecoverable one.

**Scope limitation, stated plainly:** `checks.disk` measures the filesystem of
the *application process*. If PostgreSQL runs on a separate host or volume — as
it will in most real deployments — this check can read `ok` while the database's
disk is full. Monitor the database host's disk separately. A monitoring signal
whose scope is misunderstood is how this incident happened in the first place.

### Docker daemon wedged

**Symptom:** `docker ps` hangs indefinitely (exit 124) or returns HTTP 500, while
the containers keep serving on their ports.

**Fix:** `wsl --shutdown`, then restart Docker Desktop. The named volume survives.

**Diagnostic:** if TCP to 5433/6380 is open, your data is fine — only Docker's
management API is sick.

### Gmail token revoked

**Symptom:** account shows "Needs reconnection"; sends stop.

**Cause:** access revoked, password changed, or the 7-day refresh-token expiry
that applies while the OAuth app is in **Testing** mode.

**Fix:** reconnect. Publish the OAuth app to avoid weekly expiry.

The system stops rather than retrying — a revoked grant will not become valid by
being asked again.

### Campaign stuck at RUNNING but not sending

Check in order: worker running? · `outbound` kill switch? · daily limit reached
(resets midnight UTC)? · mailbox healthy? · any deliverable leads left?

---

## 6. What to watch

| Signal | Where | Threshold |
|---|---|---|
| Disk free | `/api/health` `checks.disk`, or `df -h` | **>10 GB** (critical below 2 GB) |
| Bounce rate | Analytics | >2% — stop and clean the list |
| Unsubscribe rate | Analytics | >0.5% — the message is wrong, not the volume |
| Failed sends | Email page | any sustained run |
| Queue depth | `/api/ops/status` `queues[].waiting` | growing = worker cannot keep up |
| Oldest waiting job | `/api/ops/status` `queues[].oldestWaitingAgeMs` | >15min = stalled, whatever the depth |
| Provider spend | Usage | against the configured budget |

Bounce and unsubscribe rates are **sending-reputation** signals, not vanity
metrics. Sustained breaches degrade every future campaign, including good ones.

---

## 7. What is NOT implemented

Stated plainly so nobody plans around a capability that does not exist:

- **No open or click tracking.** Deliberate — it requires tracking pixels and
  link rewriting, both of which hurt deliverability and honesty. "Delivered" is
  not reported because Gmail's API does not confirm it.
- **No automatic reply detection beyond the mailbox we send from.** The
  `gmail.send` scope cannot read a mailbox; inbox sync uses a separate read path.
- ~~No follow-up sequences.~~ **Built.** `CampaignStep` is live: a campaign runs
  a multi-step sequence, and a reply, unsubscribe or suppression terminates it.
  Verified by `npm run verify:sequence` (38 assertions). Campaigns with no steps
  still behave exactly as single-send, so nothing created before this changed.
- **No calendar integration.** Meetings are manually scheduled with a manual URL.
- **No contract generation.** Proposals track a lifecycle; they are not legal
  documents.
- **No revenue forecasting from unvalued deals.** Deals without a value are
  excluded from revenue, never counted as zero.

---

## 8. Compliance gate

**Technical controls are not legal approval.**

LeadRadar implements suppression, unsubscribe, retention windows, and audit
logging. It cannot tell you whether contacting a given business is lawful in your
jurisdiction.

`docs/legal-review-brief.md` §5 — whether business email addresses constitute
personal data under India's DPDP Act where the business is a sole proprietor —
**remains open and is a prerequisite for outreach in India**.

Do not treat the presence of a suppression list as compliance.
