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

**Pass:** `{"status":"ok","checks":{"database":true,"redis":true}}`

Note this endpoint only performs **reads**. On a full disk Postgres blocks writes
while reads keep working, so health can report `ok` while every write hangs. See
§5.

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

**Fix:** free disk, restart Postgres. Keep >10 GB headroom.

**Do not** run `docker system prune -a --volumes` or Docker Desktop's
"Clean / Purge data" — either destroys the `leadradar-pgdata` volume.

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
| Disk free | host | **>10 GB** |
| Bounce rate | Analytics | >2% — stop and clean the list |
| Unsubscribe rate | Analytics | >0.5% — the message is wrong, not the volume |
| Failed sends | Email page | any sustained run |
| Queue depth | worker logs | growing = worker cannot keep up |
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
- **No follow-up sequences.** `CampaignStep` exists in the schema but no code
  references it. Campaigns are **single-send**.
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
