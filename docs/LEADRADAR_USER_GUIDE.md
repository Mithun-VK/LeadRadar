# LeadRadar user guide

The complete operating procedure, from an empty database to a closed client.

---

## Before you start

```bash
docker compose up -d      # PostgreSQL + Redis
npm run db:migrate
npm run db:seed           # prints your sign-in password — save it
npm run dev               # http://localhost:3000
npm run worker            # a second terminal. Nothing happens without this.
```

The worker is not optional. Discovery, enrichment, scoring, sending, and reply
detection all run there. With the web app alone, searches sit at 0% forever.

LeadRadar runs with **no API credentials at all** (`MOCK_EXTERNAL_APIS=true`, the
default). Every screen below works in mock mode; leads are fabricated fixtures and
no email leaves the machine. That is the right way to learn the tool.

---

## Step 1 — Set up what you sell

**Settings → Service offerings.**

LeadRadar ships eleven default offerings with **no prices**, deliberately: a
default price list would be a guess about your business. Set your own, or leave
them null to quote per engagement.

Prices here become defaults on proposals. Nothing is sent using them
automatically.

---

## Step 2 — Discover leads

**Search.** Describe what you want in plain language:

> Dental clinics in Chennai with more than 50 reviews and no website

You will see the parsed criteria and a **cost estimate before anything is spent**.
Review both. If the parse is wrong, rephrase — do not run it and hope.

Press run. The Jobs page shows live progress: discovered → filtered → enriched →
qualified.

**What happens:** businesses are discovered, deduplicated by Place ID, filtered on
your criteria, then — only for survivors — their websites are found and verified,
contact addresses extracted from pages already fetched, the site analysed, and an
opportunity score computed.

---

## Step 3 — Review what came back

**Leads.** Sorted by opportunity score, because the list is a call queue.

The columns that matter:

- **Site score** — quality of their website, 0–100. *Lower is a better prospect.*
- **Opportunity** — what is measurably wrong. This is what you will talk about.
- **Email** — an address found on their own site. Blank means none was found, not
  that none exists.

Filter to the leads worth working:

```
Score > 70   ·   Has email   ·   Site score < 60
```

That is: valuable prospect, reachable, and with something worth fixing.

Open one. The lead page shows every measurement behind the score — the exact
findings, the evidence for each, and where every fact came from. **If a claim is
not backed by a measurement, it is not there.**

---

## Step 4 — Qualify

On the lead page, press **Qualify**. The status moves `NEW → QUALIFIED` and the
change is recorded with your name against it.

Qualifying is a judgement, not a score threshold. You are saying "this is worth my
time".

---

## Step 5 — Write a template

**Templates → Start from the example.**

The shipped template is written to be defensible: it says how you found them,
makes **one** specific checkable observation, and asks a small question. It does
not claim a prior relationship or invent a referral.

`{{sales_angle}}` is filled per lead from what was actually measured on their site.
That is the sentence that makes the email worth reading.

The preview uses obviously fictional values so you never mistake it for a composed
message. A template referencing an unknown placeholder cannot be saved.

---

## Step 6 — Connect Gmail

**Email → Connect Gmail.** OAuth only; no password is ever stored.

LeadRadar requests `gmail.send` and `gmail.readonly`. The second is what lets it
detect replies and stop follow-ups automatically. Only messages on threads it
started are stored; everything else is discarded unread-into-the-database, and
stored reply text expires after 90 days. See [GMAIL_SETUP.md](GMAIL_SETUP.md).

Press **Send a test to yourself** to prove the whole path works before any prospect
is involved.

---

## Step 7 — Build a campaign

**Campaigns → New campaign.**

1. Name it, pick a template, set your name and company.
2. Set the pace. **40–50 per day and 5 minutes apart** is sane for a personal Gmail
   account. Higher gets you rate limited, which does not merely slow the campaign —
   it can suspend sending.
3. Select leads by filter.

You will get an honest count immediately:

```
143 enrolled · 57 skipped
  41  no email address found
   9  on your suppression list
   7  already contacted by another campaign
```

Those 57 are shown **before** you activate, not discovered afterwards.

---

## Step 8 — Review the actual emails

The campaign page shows the **rendered message for a real lead** — not the
template. Read it. Ask whether you would send it to someone whose business you
respect.

A lead whose template cannot be filled completely is skipped rather than sent with
blanks. "Hi  team," is worse than no email.

---

## Step 9 — Activate

Press **Activate**, then type `SEND` to confirm.

The friction is deliberate and proportionate: this is the one button that puts
messages in strangers' inboxes under your name, and it cannot be undone once a
message is delivered. Pausing is one click, because the safe direction should
always be the easy one.

The worker now sends one message at a time, honouring your delay and daily limit.

---

## Step 10 — Work your replies

**Sales.** This is your daily screen.

Every 10 minutes LeadRadar reads your mailbox, matches replies to threads it
started, and classifies what each one wants. When someone replies:

- **Follow-ups stop immediately** — for every campaign, not just this one
- The lead moves to `REPLIED`
- A task is raised with the recipient's own words attached

```
URGENT

ABC Dental — asked about pricing
"Sounds interesting. What would this cost?"          [ Send a price ]

XYZ Jewellers — asked to meet
"Can we talk Tuesday?"                                [ Schedule ]

DEF Restaurant — proposal sent 6 days ago, no response [ Follow up ]
```

**LeadRadar never sends a price, a proposal, or a contract.** It tells you someone
asked and gets out of the way.

An out-of-office is recognised and does **not** stop the sequence — someone on
holiday has not declined.

---

## Step 11 — Open a deal

On the lead, press **Create Deal**. Name it, set a value.

The value is what you expect to charge. Leave it blank if you genuinely do not know
yet — an unvalued deal is reported as *unvalued*, never counted as ₹0.

The deal inherits campaign attribution automatically, which is what makes
"campaign → revenue" answerable later.

---

## Step 12 — Meeting

**Schedule Meeting.** Paste your own meeting link.

There is no calendar integration, deliberately — a fake one that silently fails to
send an invite is worse than none. You send the invite; LeadRadar tracks the
outcome.

Booking advances the lead and the deal to `MEETING`.

---

## Step 13 — Proposal

**Create Proposal.** Scope lines, amount, timeline, terms.

Created as a `DRAFT`. Mark it `SENT` when you have actually sent it — that advances
the pipeline and schedules a follow-up in five working days, which is where live
deals most often die quietly.

**This is not a contract.** No signature, no legal binding. `ACCEPTED` means "they
told me yes", and it raises a task rather than closing the deal for you.

---

## Step 14 — Close

**Pipeline.** Drag the deal to **Won**.

Losing requires a reason, always. It is the most useful field in the whole system
and nobody ever fills it in later.

---

## Step 15 — Read the numbers

**Analytics.**

```
Discovered → Qualified → Contacted → Replied → Meeting → Proposal → Won
```

Plus reply rate, meeting rate, win rate, pipeline, weighted pipeline, and revenue.

Two things to understand about these numbers:

- **A rate showing "—" means no data**, not zero. Different facts.
- **Unvalued deals are excluded and counted separately.** The total is honest about
  what it does not include.

Nothing here is projected. Revenue is what closed.

### Is the score working?

The calibration view buckets leads by score and shows what actually happened to
each bucket:

```
80–100:  reply rate 18%
60–79:   reply rate 11%
40–59:   reply rate  4%
```

If higher buckets do not reply more often, the score is not predicting anything and
the weights need work. LeadRadar tells you; it does not rewrite them, because
deciding whether a sample is representative is your call.

---

## Daily routine

**Morning:** open **Sales**. Work the urgent band top to bottom. It is short by
design.

**Weekly:** check **Pipeline** for deals that have not moved, and **Analytics** for
whether the funnel is narrowing anywhere new.

**Monthly:** review calibration. Check the suppression list is being honoured.

---

## What LeadRadar will not do

Worth knowing before you look for the button:

- Quote a price, send a proposal, or accept a deal
- Negotiate
- Email anyone who opted out — permanently, with no override
- Guess an email address from a name pattern
- Claim a website problem it did not measure
- Report revenue it did not observe
- Tell you a page is slow (it cannot measure that from one fetch)

Automation produces **work** and **stops** things. Commitments stay yours.

---

## When something looks wrong

| Symptom | Cause |
|---|---|
| Search stuck at 0% | The worker is not running |
| Leads have no email | None was published on their site. Normal — roughly 60%. |
| Campaign will not activate | Readiness blockers are listed on the campaign page |
| No replies detected | Account connected before read access was added — reconnect Gmail |
| Sending stopped mid-campaign | A daily limit. Resumes after midnight UTC. |
| "Not measured" on performance | Correct. It cannot be measured from one page fetch. |
