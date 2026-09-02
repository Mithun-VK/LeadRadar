# LeadRadar V2 Scope

**Status:** partly built. See the status note below before reading further.

> ## Status update — 2026-08-30
>
> Two items in this document are now **implemented**, and one **decision recorded
> here has been reversed**. This block is the authoritative statement; the sections
> below are kept as the original reasoning, which is still worth reading.
>
> **Built:**
>
> - **V2.1 Email discovery** — stages 1 and 3 (regex over pages already fetched,
>   plus `mailto:` parsing) are implemented in
>   `src/modules/enrichment/contacts.ts`. Stage 2 falls out for free: the pipeline
>   already fetches a contact page when verification is ambiguous, and addresses
>   are mined from it at no extra cost. As predicted here, permutation guessing is
>   **not** implemented, and `EmailSourceDb` has no enum member that would let one
>   be added quietly.
> - **V2.4 Website quality scoring, honest subset** — implemented in
>   `src/modules/enrichment/website-analysis.ts`. Exactly the addable list from
>   §V2.4 below: page count from the link graph, mobile viewport meta tag,
>   structured data, image alt coverage, content volume, mixed content. The section
>   below is right that Core Web Vitals and traffic estimates cannot be measured
>   from one fetch, so `performanceScore` is **null** with a stated reason rather
>   than an invented number.
>
> **Reversed: automated outreach is now in scope and implemented.**
>
> The table at the end of this document lists "Automated outreach
> (email/WhatsApp/LinkedIn sending)" as explicitly out of scope, reasoning that it
> "turns a data product into a sending platform, with deliverability, consent, and
> TRAI/DPDP exposure attached."
>
> **That reasoning was not wrong, and the exposure it describes is real.** The
> repository owner reviewed it on 2026-08-30 and decided to build the feature
> anyway, accepting those tradeoffs. Gmail-based outreach now exists: OAuth
> connection, templates, campaigns, personalization, a send worker, suppression,
> and unsubscribe handling.
>
> Because the original objection stands on its merits, the safeguards it implies
> are treated as **acceptance criteria rather than nice-to-haves**, and are
> enforced structurally rather than by convention:
>
> | Objection from this document | How it is answered                                                                                                                                                                              |
> | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
> | Deliverability               | Plain-text only; `List-Unsubscribe` headers; per-campaign and per-mailbox daily limits; enforced delay between sends; send queue concurrency pinned to 1; hard bounces suppressed automatically |
> | Consent                      | Explicit campaign activation with a typed confirmation; discovery never enrols or sends; suppression checked before every send with no bypass path; unsubscribe is one click and permanent      |
> | Duplicate contact            | Unique constraint on `(campaignId, businessId)`; leads already contacted by another campaign are excluded by default                                                                            |
> | Fabricated claims            | The sales angle is derived from measurements; AI may only rephrase it, and any output introducing a fact it was not given is discarded                                                          |
>
> The scope table below is left unedited so the original position remains legible.
> Where it and this block disagree, **this block is current**. See
> `docs/ARCHITECTURE_AUDIT.md` §8.2 and `docs/GMAIL_SETUP.md`.
>
> **Still not built, and still recommended in this order:** V2.2 (scheduled
> searches and change detection), V2.3 (HubSpot), V2.5 (multi-user organizations).

---

**Original document follows.**

**Sequencing principle:** V2 items are ordered by _how much they increase revenue per
lead_, not by how interesting they are to build. LeadRadar's V1 problem is solved —
it finds good leads. Its V1 _limitation_ is that a lead is a row in a table, and an
agency still has to do all the work of contacting it.

---

## The V1 gap, stated plainly

A V1 lead gives a salesperson: a business name, a phone number, a grade, a
recommended service, and one line of why. What it does not give them:

1. **An email address.** Phone-first outreach does not scale, and agencies run
   email sequences.
2. **A reason to act today.** A lead discovered three months ago looks identical to
   one discovered this morning.
3. **Anywhere to put it.** Export to CSV then manual CRM import is where lead lists
   go to die.

V2 is those three things, in that order.

---

## V2.1 — Email discovery

**Why first:** it is the single change that makes the export usable in an email
sequencing tool, which is how agencies actually work. Everything else in V2 is
worth less without it.

**Approach, in cost order:**

| Stage | Method                                               | Cost                         | Expected hit rate     |
| ----- | ---------------------------------------------------- | ---------------------------- | --------------------- |
| 1     | Regex over pages already fetched during verification | **$0** — we have the content | ~35%                  |
| 2     | Fetch `/contact` if not already fetched              | 1 Firecrawl credit           | +20%                  |
| 3     | Parse `mailto:` links from the stored link set       | **$0**                       | +5%                   |
| 4     | WHOIS / MX inference                                 | provider-dependent           | low value, high noise |

Stages 1 and 3 are nearly free because enrichment already fetched and stored the
page. **Implement those two first and measure before buying anything.** My estimate
is they alone reach ~40% coverage, which may be enough.

**What NOT to do:** email _permutation_ guessing (`first.last@domain`) with SMTP
verification. It generates bounces, damages the customer's sending reputation, and
is the behaviour that gets lead-gen tools blocklisted. If customers demand it, it
belongs behind an explicit opt-in with a written warning.

**Schema:** `EmailCandidate { businessId, email, source, confidence, isRoleAccount,
verifiedAt }`. Role accounts (`info@`, `contact@`) are marked, not discarded — they
are lower-response but entirely legitimate, and for a small clinic they are often
the only address.

**Compliance:** business email addresses are personal data under DPDP where the
business is a sole proprietor. Blocked on the §5 question in
`docs/legal-review-brief.md`.

**Estimated effort:** 3–4 days for stages 1–3 including tests.

---

## V2.2 — Scheduled searches and change detection

**Why second:** it converts LeadRadar from a tool you use once into one you keep
paying for, and the mechanism already exists.

The Google-derived TTL forces periodic refresh, which means successive snapshots of
rating and review count already exist. `reviewVelocity()` is implemented and
unused. This feature is largely _surfacing work already being done_.

**Alerts worth sending:**

| Trigger                                          | Why an agency cares                   |
| ------------------------------------------------ | ------------------------------------- |
| A tracked business **launched a website**        | The opportunity closed — stop calling |
| A tracked business's site **went down**          | Highest-urgency call available        |
| Review count **jumped**                          | Growing, newly able to spend          |
| Business **closed permanently**                  | Remove from every sequence            |
| **New** business appears matching a saved search | First-mover advantage on a fresh lead |

The last row is the commercially strongest: an agency that calls a new clinic in
its first month faces no competition.

**Cost:** a saved search re-run weekly across five cities costs roughly what the
original did. This needs a **per-saved-search budget** and a default cadence no
tighter than weekly, or a customer will set fifty daily searches and generate a
four-figure bill.

**Schema:** `SavedSearch { organizationId, structuredQuery, cadence, budgetMicros,
lastRunAt, nextRunAt }`, `LeadChange { businessId, field, before, after,
detectedAt }`, `AlertSubscription`.

**Estimated effort:** 5–6 days. The BullMQ repeatable-job infrastructure exists.

---

## V2.3 — CRM integration

**Why third:** it removes the last manual step, but it is worthless before V2.1
(a CRM contact with no email is not a contact).

**Do not build a generic integration framework.** Build HubSpot first, alone, end
to end. HubSpot has the largest share among the small agencies this product targets
and a genuinely workable free tier. Salesforce is a heavier lift for a customer
segment less likely to be on it — do it second, on evidence of demand.

**Hard requirements:**

- **Idempotent upsert keyed on our Place ID**, stored as a custom property. Without
  it, a re-run duplicates every contact in the customer's CRM, which is worse than
  no integration.
- **Field mapping honours `ExportPolicyService`.** Pushing a Google-derived field
  into a customer's CRM is the same act as exporting it, and must be gated the same
  way. Blocked on Q3 in the legal brief.
- **One-way, LeadRadar → CRM, initially.** Bidirectional sync means conflict
  resolution, and that is a project rather than a feature.

**Estimated effort:** 6–8 days for HubSpot including OAuth, mapping UI, and
idempotency tests.

---

## V2.4 — Website quality scoring

Deliberately _not_ an "SEO audit". V1 already measures what one or two page fetches
can honestly support: HTTPS, thin/parked, contact funnel, booking indicator. The
prompts explicitly forbid inferring traffic or rankings.

**Genuinely addable without new dependencies:** page count from the link graph,
mobile viewport meta tag, presence of structured data, last-modified freshness,
image weight.

**Not addable honestly:** Core Web Vitals, keyword rankings, traffic estimates,
backlink profiles. Each needs a real data source, and _presenting a guess as a
measurement is the thing that destroys trust in a lead list._ If customers want
these, integrate a source and label it.

**Estimated effort:** 2–3 days for the honest subset.

---

## V2.5 — Multi-user organizations

Membership and roles already exist in the schema with a `MemberRole` enum, and
session validation already re-checks membership on every request. What is missing is
the surface: invitations, a member list, role enforcement in the UI, and per-user
audit attribution (the audit log already records `userId`).

**Role semantics worth deciding early:** should a VIEWER be able to _export_?
Export is the act with compliance weight, so my recommendation is no — export
requires ADMIN or above, and that is enforced server-side.

**Estimated effort:** 4–5 days.

---

## Explicitly out of scope for V2

| Item                                                 | Why not                                                                                                                                                       |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Automated outreach (email/WhatsApp/LinkedIn sending) | Turns a data product into a sending platform, with deliverability, consent, and TRAI/DPDP exposure attached. Integrate with the tools agencies already use.   |
| Public API                                           | Premature. It freezes a data model that is still moving, and no customer has asked.                                                                           |
| Usage billing                                        | Needs stable unit economics first, which needs `npm run calibrate` run against real data.                                                                     |
| Additional countries                                 | The city registry generalises, but category taxonomies, phone formats, and directory hosts are all India-tuned. One country done well beats five done poorly. |
| White-label reports                                  | Real demand, but it is presentation work that adds nothing to lead quality. After V2.1–V2.3.                                                                  |

---

## Suggested order and rough timeline

| Phase                                      | Weeks | Gating dependency                     |
| ------------------------------------------ | ----- | ------------------------------------- |
| V2.1 Email discovery (stages 1 and 3 only) | 1     | DPDP question (§5 of the legal brief) |
| V2.2 Scheduled searches + change alerts    | 1.5   | Per-search budget enforcement         |
| V2.3 HubSpot integration                   | 2     | V2.1, and Q3 of the legal brief       |
| V2.4 Website quality (honest subset)       | 0.5   | —                                     |
| V2.5 Multi-user organizations              | 1     | —                                     |

**~6 weeks** for all five, one engineer. V2.1 and V2.4 are the fastest paths to
visible value if you want something shippable in the first fortnight.

**Before any of it:** run `npm run calibrate` against real searches. Every estimate
above assumes the V1 funnel behaves roughly as documented, and that assumption is
currently untested against live provider data.
