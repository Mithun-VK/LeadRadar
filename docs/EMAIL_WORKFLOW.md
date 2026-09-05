# Email workflow

Outbound sending, inbound reply detection, and the boundaries between them.

> **Verification status.** Everything described here is **MOCK VERIFIED** — 756
> unit tests, 34 integration, and 114 end-to-end assertions, all against a mock
> this repository also wrote. None of it has run against Google.
> **LIVE CERTIFICATION REQUIRED**: `npm run certify:gmail`. See
> [GMAIL_SETUP.md §7](GMAIL_SETUP.md).

---

## 1. Outbound: nothing sends by itself

Four separate acts, each requiring the previous one:

```
discovery  →  enrolment  →  activation  →  sending
             (a person)    (a person,      (the worker)
                            with a typed
                            confirmation)
```

There is no code path from a finished search to an outgoing email. Discovery does
not enrol; enrolment does not queue; queueing does not send.

### The send guard chain

Every check between "a lead is queued" and "an email leaves" lives in one function
(`sendCampaignEmail`), in a fixed order. One function on purpose: a chain spread
across a worker, a service, and a route handler is one where someone eventually
adds a fourth call site that skips two of them.

0. **The outbound kill switch is not thrown** — checked first, applies even to the
   mock provider, and fails *closed* if its state cannot be read
1. Sending is enabled at all
2. The campaign is still `RUNNING`
3. This lead has not already been sent to. For a sequence this is scoped to the
   specific **step**, and the sequence has not been terminated by a reply,
   unsubscribe, or bounce
4. **The address is still not suppressed** — re-checked here, not only at enrolment
5. The address is still syntactically valid
6. The campaign's daily limit has room
7. The mailbox's daily limit has room
8. The template renders completely, with no blanks

Step 4 matters more than it looks. Enrolment already checked suppression, and
checking again costs a query — but a campaign can sit queued for days, and someone
who unsubscribes on Tuesday must not receive Wednesday's message. Re-checking at
the moment of sending is the difference between *honouring* an unsubscribe and
*having honoured it once*.

Sequences sharpen that argument rather than changing it. The gap between step 1
and step 4 is measured in weeks, so **every guard runs again for every step**,
against live state. Nothing is decided once at enrolment and trusted thereafter.

---

## 1a. Follow-up sequences

A campaign may carry an ordered list of `CampaignStep` rows. **A campaign with no
steps is a single send** — which is every campaign created before this feature
existed, and they behave exactly as they always did.

```
Step 1  day 0   initial email
Step 2  +2 days follow-up
Step 3  +3 days follow-up
Step 4  +5 days final
        then stop
```

`delayDays` is relative to the **previous** step, not to enrolment, so inserting a
step does not silently reschedule every later one.

### Scheduling

One step at a time. After a step sends, the lead returns to `QUEUED` with
`nextStepAt` set; the campaign tick wakes when the soonest lead is due.

The engine deliberately does **not** lay the whole sequence out in Redis at
activation. A queue full of scheduled sends is nearly impossible to stop, and
"pause" has to actually pause. With one-at-a-time scheduling, pausing simply means
the chain stops advancing.

A campaign completes only when **no lead has pending work** — not when the first
pass finishes. Otherwise every scheduled follow-up would be silently abandoned.

### What stops a sequence

| Event | Effect | Mechanism |
|---|---|---|
| Reply | Stops permanently | `stopCampaignsForLead` sets the enrolment `REPLIED`; the send path treats it as terminal |
| Unsubscribe | Stops permanently, address suppressed | Suppression re-checked at every step |
| Bounce | Stops permanently, address suppressed | Hard bounce suppresses automatically |
| Campaign paused | Stops until resumed | Guard 2 |
| Outbound kill switch | Stops immediately, org-wide | Guard 0 |
| Steps exhausted | Lead marked `SENT` | `nextStep()` returns null |

Reply termination works without the inbox-sync code knowing sequences exist: a
waiting lead sits at `QUEUED`, and `stopCampaignsForLead` already targets
`PENDING`/`QUEUED`/`SENT`.

### Duplicate sends are impossible by construction

There is **no lock and no `SELECT FOR UPDATE`**. `EmailMessage` carries a unique
constraint on `(campaignId, businessId, campaignStepId)`, and its row is inserted
as `SENDING` **before** the provider is called.

Two workers racing the same step therefore resolve in the database: one insert
wins, the other raises a unique violation and never reaches the send. Verified —
`verify:sequence` runs two concurrent sends of the same step and asserts exactly
one message results.

This also covers the nastier case: a worker that sends successfully then dies
before recording the result. The row already exists in `SENDING`, so a retry
collides and refuses. That leaves a message whose delivery is *unknown*, which is
recoverable — a duplicate in a stranger's inbox is not.

### Timezones

`delayDays` is added in **epoch milliseconds**, never via local-date arithmetic.
A follow-up interval must not shift because a worker moved region or a host
observed daylight saving. Asserted across the European DST transition.

### Managing steps

`GET` / `PUT /api/campaigns/{id}/steps`. `PUT` replaces the whole sequence in one
transaction — a sequence is meaningful only as an ordered whole, and per-step
edits would let a client observe it mid-rename with two step-2s or a gap.

The sequence is **frozen while a campaign is `RUNNING`**: leads are mid-flight with
a `currentStepNumber` pointing into this exact list, and rewriting it underneath
them would re-send to some leads and skip for others. Pause first.

Capped at 10 steps. A twelve-touch sequence to a cold prospect is harassment
however it is scheduled.

### Pacing

The email queue runs at **concurrency 1, never scaled**. Every other queue fetches
data; this one sends mail from a real person's mailbox. Parallel sending defeats
the inter-message delay and is the fastest way to trip Gmail's per-account limit —
which does not merely slow a campaign, it can suspend sending outright.

A campaign advances by scheduling **one message at a time**. That is what makes
"pause" genuinely pause, rather than draining a queue already committed to Redis.

---

## 2. Inbound: reply detection

Runs every 10 minutes. Frequent enough that a reply stops the next follow-up in
practice — sequences are spaced in days — without burning Gmail quota.

### The sync cursor

Each mailbox carries `inboxCursor`, advanced after **every successful sync**
including one that stored nothing, and clamped to a 30-day maximum lookback.

Both halves matter. This previously resumed from the newest *stored* inbound
message, which advances only when something matches — so a mailbox receiving no
matching replies never advanced, and its query window grew by a day every day. An
organization whose last reply was six months ago would ask Gmail for a 180-day
window every ten minutes until the quota refused it, and reply detection would
then stop **silently**. The cursor prevents that arising; the clamp bounds it if
the cursor is ever lost or restored from an old backup.

The cursor advances to when the sync **started**, not to now: a message arriving
mid-sync would otherwise fall in the gap and never be read. Re-reading a few
seconds of overlap is free, because storage is idempotent on
`(organizationId, messageId)`.

### Matching, strongest signal first

1. **`In-Reply-To`** matches a `Message-ID` LeadRadar generated. Near-certain.
2. **Thread id** matches a thread it started. Very strong.
3. **Sender address** matches a lead it actually emailed. Strong.

### Provider health

Stored as timestamped **facts** — last auth, last send, last sync, last error,
consecutive failures — with the state *derived* on read. A written status column
would lose what matters during an incident: not "it is broken" but "it last
worked at 14:02 and has failed eleven times since".

| State | Meaning | Sending |
|---|---|---|
| `HEALTHY` | Recent success, no failure streak | continues |
| `DEGRADED` | 1–4 consecutive failures | **continues** — one timeout is weather, not an outage |
| `BLOCKED` | 5+ consecutive failures | stops |
| `AUTH_REQUIRED` | Grant revoked or rejected | stops — retrying cannot fix it |
| `DISCONNECTED` | No mailbox | stops |

`AUTH_REQUIRED` outranks `BLOCKED` even though both are usually present together,
because the remedies differ: retrying fixes one and never fixes the other.
Reporting the fixable-looking state would send an operator to wait instead of to
reconnect.

A **hard bounce does not count against health**. It means that recipient is
undeliverable, not that Gmail is unwell — counting it would drive a mailbox to
`BLOCKED` for doing its job and stop every other campaign.

Health never contains a token, an authorization code, or a raw provider response.
`lastErrorDetail` is an already-safe message, truncated.

### Matching (continued)

There is deliberately **no fuzzy matching** on name or domain. A misattributed
reply moves the wrong lead through the pipeline and stops the wrong campaign;
neither is worth the extra match rate.

### What is stored

Only matched messages. An unmatched message is read in memory, matched against
nothing, and discarded — never written. Bodies expire after 90 days. See
[DATA_RETENTION.md](DATA_RETENTION.md).

---

## 3. Intent classification

**Deterministic evidence beats AI. Always.**

Explicit signals are matched by rule first, and a rule match short-circuits — the
model is never consulted and its opinion cannot override the result.

Rules are ordered by **consequence, not likelihood**:

| Order | Intent | Why here |
|---|---|---|
| 1 | `UNSUBSCRIBE` | Acting wrongly on an opt-out is the worst outcome available |
| 2 | `BOUNCE` | A delivery fact, checked before anything interpretive |
| 3 | `OUT_OF_OFFICE` | Before positive signals: auto-replies are full of warm boilerplate |
| 4 | `NOT_INTERESTED` | An explicit decline |
| 5 | `MEETING_REQUEST` | Before price: "what's the cost, and can we talk Tuesday?" is a meeting |
| 6 | `PRICE_REQUEST` | |
| 7 | `POSITIVE_INTEREST` | |

Anything no rule recognises goes to the model, which may return **only** a member
of the closed enum plus a confidence. It cannot emit a fact, an address, or an
action. A prompt-injected reply buys an attacker one wrong label on one message.

### The confidence cap

An AI verdict is capped **below** the action threshold (0.9). The model may label a
reply, and that label drives the work queue — but it can never, alone, cross the
bar that triggers an irreversible action.

---

## 4. What happens on a reply

| Intent | Stops sequence | Suppresses | Lead event | Task raised |
|---|---|---|---|---|
| `UNSUBSCRIBE` (deterministic) | ✓ | **✓ permanently** | `UNSUBSCRIBED` | — |
| `UNSUBSCRIBE` (AI-inferred) | ✓ | **✗** | — | Confirm the request |
| `BOUNCE` | ✓ | ✗ (marks address invalid) | `BOUNCED` | — |
| `OUT_OF_OFFICE` | **✗** | ✗ | — | — |
| `NOT_INTERESTED` | ✓ | ✗ | `REPLY_RECEIVED` | Close or park |
| `MEETING_REQUEST` | ✓ | ✗ | `REPLY_RECEIVED` | Schedule a meeting |
| `PRICE_REQUEST` | ✓ | ✗ | `REPLY_RECEIVED` | Respond to pricing |
| `POSITIVE_INTEREST` / `QUESTION` | ✓ | ✗ | `REPLY_RECEIVED` | Reply |
| `UNKNOWN` | ✓ | ✗ | `REPLY_RECEIVED` | Read it |

Three rows deserve explanation.

**AI unsubscribe does not suppress.** Suppression is permanent and cannot be undone
by the operator; a false positive silently destroys a real prospect. The AI path
stops sending and asks a human — the recipient gets the same outcome, but the
mistake stays recoverable.

**Out-of-office does not stop the sequence.** An auto-responder is not a person
answering. Treating it as a reply would move a lead to `REPLIED` and halt outreach
to someone who was simply on holiday.

**`UNKNOWN` still stops the sequence.** Failing safe in the direction of *not*
sending: a human replied something unparseable, and continuing to send scheduled
follow-ups at them is the rudest possible outcome.

---

## 5. Stopping is per-lead, not per-campaign

A reply marks that lead's enrolments `REPLIED`. It does **not** pause the campaign
— one person replying must not stop outreach to the other 400 businesses.

But it stops **every** campaign for that lead, not just the one that produced the
reply. Someone who replies to one campaign should not keep receiving another.

---

## 6. What never happens automatically

- Sending a price, a proposal, or a contract
- Accepting or closing a deal
- Negotiating
- Making a claim not supported by measured data
- Emailing someone who opted out

Automation produces **work** and **stops** things. Commitments stay human.

---

## 7. Where to look

| Concern | File |
|---|---|
| Send guard chain | `src/modules/email/send.ts` |
| Campaign lifecycle | `src/modules/email/campaigns.ts` |
| Queue and pacing | `src/modules/email/worker.ts`, `src/modules/jobs/queues.ts` |
| MIME and header safety | `src/modules/email/mime.ts` |
| Inbox sync and matching | `src/modules/email/inbox-sync.ts` |
| Intent rules and actions | `src/modules/email/intent.ts` |
| Suppression | `src/modules/email/suppression.ts` |
