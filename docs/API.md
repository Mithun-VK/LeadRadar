# API reference

All endpoints are Next.js App Router route handlers under `/api`. Every one is
authenticated by session cookie, tenant-scoped, Zod-validated, and rate limited,
except where marked public.

## Conventions

**Authentication.** A session cookie (`leadradar_session`). The organization comes
from the _session row_, never from a header, query parameter, or body — any of
which a client controls and could forge to read another tenant's leads.

**CSRF.** Every mutating request needs the `x-csrf-token` header, double-submitted
from the `leadradar_csrf` cookie and HMAC-bound to the session. `src/lib/api-client.ts`
handles this; use it rather than raw `fetch`.

**Errors** are uniform:

```json
{
  "error": { "code": "VALIDATION_FAILED", "message": "A safe, actionable message." },
  "requestId": "req_..."
}
```

Stack traces and internal messages are never returned. The `message` is a
deliberately safe string; full detail goes to the logs under the same `requestId`.

| Status | Meaning                                                                                   |
| ------ | ----------------------------------------------------------------------------------------- |
| 400    | Validation failed, unparseable query, rejected URL                                        |
| 401    | No valid session                                                                          |
| 402    | Budget or job limit exceeded — well-formed and authorised, but a spending limit blocks it |
| 403    | Forbidden, tenant mismatch, SSRF blocked                                                  |
| 404    | Not found                                                                                 |
| 429    | Rate limited                                                                              |
| 501    | Not implemented                                                                           |
| 503    | Provider unavailable or timed out                                                         |

---

## Health

### `GET /api/health`

Public. Liveness plus dependency checks (PostgreSQL, Redis).

---

## Search and discovery

### `POST /api/search/parse`

Natural language → validated `StructuredQuery` plus a cost estimate. **No side
effects and no billable calls** — the user reviews the parsed criteria and the
estimate before anything is spent.

### `POST /api/search`

Creates a `SearchJob` and enqueues it. Returns `{ id }`. Does not block.

### `GET /api/search/{id}`

Job status, progress, and running counts (discovered, filtered, enriched,
qualified).

---

## Leads

### `GET /api/leads`

Paginated, filtered, sorted list.

| Parameter                                                            | Type              | Notes                                                                                                                                                      |
| -------------------------------------------------------------------- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `city`, `category`, `priority`, `service`                            | CSV               | Repeatable values, comma-separated                                                                                                                         |
| `googleWebsiteStatus`, `independentWebsiteStatus`, `digitalPresence` | CSV               | Enum values                                                                                                                                                |
| `flags`                                                              | CSV               | Opportunity flags. A lead must carry **every** listed flag                                                                                                 |
| `minRating`, `minReviews`, `minScore`                                | number            | Lower bounds                                                                                                                                               |
| `maxWebsiteScore`                                                    | number            | Upper bound on website quality — the weak sites worth pitching to                                                                                          |
| `hasEmail`                                                           | `true` \| `false` | Whether a contact address was found                                                                                                                        |
| `excludeChains`                                                      | `true`            | Hide franchise outlets                                                                                                                                     |
| `search`                                                             | string            | Substring match on the business name                                                                                                                       |
| `sortBy`                                                             | enum              | `opportunityScore` (default), `rating`, `reviewCount`, `createdAt`, `displayName` — constrained to an enum so it cannot become an ORDER BY injection point |
| `sortDir`                                                            | `asc` \| `desc`   |                                                                                                                                                            |
| `page`, `pageSize`                                                   | number            | `pageSize` max 200                                                                                                                                         |

### `GET /api/leads/{id}`

Full profile with provenance labels: website candidates considered (including
rejected ones), verification evidence, social profiles, email candidates, website
analysis with per-check findings, score breakdown, and outreach history.

### `POST /api/leads/import`

CSV import with flexible column mapping.

```json
{ "csv": "Company Name,Email\nAcme Dental,info@acme.in", "updateExisting": false }
```

Accepts common header spellings (`company`, `company_name`, `email_address`,
`Phone Number`, …). Parsing is RFC 4180-correct, so a comma inside a quoted
business name does not shift every subsequent column.

Returns a summary:

```json
{
  "total": 120,
  "created": 98,
  "updated": 0,
  "duplicates": 18,
  "invalid": 4,
  "errors": [{ "line": 12, "reason": "\"n/a\" is not a usable email address" }],
  "mapping": { "businessName": "Company Name", "email": "Email" },
  "unmappedHeaders": ["Internal Ref"]
}
```

Error line numbers count the header as line 1, matching what the operator sees in a
spreadsheet. Imported leads are marked as imported — no Place ID, no verified
website, no score — and are never laundered into looking like pipeline output.

---

## Templates

### `GET /api/templates`

Templates plus the closed variable vocabulary and the starter template.

### `POST /api/templates` · `PATCH /api/templates/{id}`

```json
{ "name": "…", "subject": "Quick note about {{business_name}}", "body": "…" }
```

Placeholders are validated **at save time**. An unknown variable is a 400 with the
offending names, so a typo surfaces while the operator is looking at the template
rather than when a campaign refuses every one of its leads an hour later.

Supported variables: `business_name`, `industry`, `city`, `website`,
`opportunity`, `sales_angle`, `recommended_service`, `sender_name`,
`company_name`.

### `DELETE /api/templates/{id}`

Archives. Never hard-deletes — a sent campaign still references the template, and
deleting it would break the record of what was sent.

---

## Campaigns

### `GET /api/campaigns` · `POST /api/campaigns`

A newly created campaign is **always** `DRAFT` and always empty. There is no
parameter that creates one already running, and none that enrols leads at creation.

```json
{
  "name": "Chennai dental clinics — Q3",
  "templateId": "…",
  "senderName": "Priya",
  "companyName": "Acme Agency",
  "dailyLimit": 40,
  "delaySeconds": 300,
  "useAiPersonalization": false
}
```

### `GET /api/campaigns/{id}`

Detail, plus the readiness report and per-lead **rendered previews** — the actual
text that will be sent, not the template.

### `PATCH /api/campaigns/{id}`

Edit settings. A `COMPLETED` or `CANCELLED` campaign is immutable: editing one
would silently rewrite the record of what was sent to real people.

### `POST /api/campaigns/{id}/leads`

Enrol, by explicit ids or by filter:

```json
{ "filters": { "minScore": 70, "maxWebsiteScore": 60, "hasEmail": true }, "limit": 200 }
```

Capped at 1,000 per call so a campaign stays reviewable by a human. Every check the
send path will later run is run **here**, so the review screen shows the true
deliverable count rather than an optimistic one that shrinks later:

```json
{
  "requested": 200,
  "enrolled": 143,
  "skipped": 57,
  "skipReasons": { "NO_EMAIL": 41, "SUPPRESSED": 9, "ALREADY_CONTACTED": 7 }
}
```

### `DELETE /api/campaigns/{id}/leads`

Removes uncontacted leads. **Sent leads are never removed** — the message exists
and the recipient received it; deleting the record would make the history a lie.

### `POST /api/campaigns/{id}/status`

```json
{ "action": "start", "acknowledgeSending": true }
```

Actions: `start`, `pause`, `resume`, `cancel`, `complete`.

`start` and `resume` **require** `acknowledgeSending: true`. Without it the request
is refused with the deliverable count in the message. A campaign activation sends
real email to real strangers under the operator's own address; a request that
merely arrives is not enough.

Transitions are governed by an explicit table. `COMPLETED` and `CANCELLED` are
terminal — restarting would re-send to leads already contacted.

---

## Email

### `GET /api/email/gmail/status`

Whether sending is possible, whether a mailbox is connected, and its health.
Returns a summary type **with no token fields**, so there is no path by which a
token can be serialised into a response even by mistake.

### `GET /api/email/gmail/connect`

Redirects to Google with a signed `state` bound to the caller's organization.
Requires `OWNER` or `ADMIN`. The state check is what prevents an attacker
completing the flow with _their_ authorization code against a victim's session,
which would silently attach an attacker-controlled mailbox.

### `GET /api/email/gmail/callback`

Completes the flow. Verifies the state against the current session's organization
**before** redeeming the code, then redirects to `/dashboard/email`.

### `DELETE /api/email/gmail/account?id=…`

Disconnects and pauses running campaigns. Does **not** revoke the grant at Google —
that is the user's own action, and the UI says so.

### `POST /api/email/test`

Sends one message **to the connected mailbox's own address**. There is deliberately
no recipient parameter: an arbitrary-recipient test endpoint is an open relay with
a friendly name.

### `GET` · `POST` · `DELETE /api/email/suppression`

Read, add (`MANUAL` only), and remove. An `UNSUBSCRIBED` or `BOUNCED` entry cannot
be removed — an operator must not be able to undo a recipient's decision, and
re-mailing a hard bounce damages their own sending reputation.

---

## Analytics

### `GET /api/analytics/overview`

Lead counts, email counts, campaign counts, conversion funnel, opportunity
distribution, and per-campaign performance.

The funnel counts **distinct businesses**, not events: counting messages would let
a lead mailed by two campaigns appear twice and produce a conversion rate above
100%.

The payload carries a `notes` object stating which figures are not measurements —
replies are manually recorded (the `gmail.send` scope cannot read a mailbox), and
no revenue or ROI is reported at all. Those caveats travel _with_ the numbers so
they cannot be lost when the data is read somewhere other than the dashboard.

---

## Settings

### `GET /api/settings`

Editable preferences, plus read-only effective runtime configuration (no secret
values — only whether each credential is present), scoring weights, and analysis
weights.

### `PATCH /api/settings`

Writes only: `defaultSenderName`, `defaultCompanyName`,
`defaultCampaignDailyLimit`, `defaultCampaignDelaySeconds`,
`defaultUseAiPersonalization`.

**Spending limits, provider mode, and crawl ceilings are deliberately not
writable.** Putting the budget guard behind a web form would place the strongest
cost control in the system behind its weakest boundary.

---

## Export

### `POST /api/export` · `GET /api/export/{id}`

Creates an export job (CSV or XLSX) and downloads it when ready. Google-derived
columns are excluded unless explicitly acknowledged, and that opt-in is recorded on
the job and in the audit log. Cells beginning `=`, `+`, `-`, `@`, tab, or CR are
prefixed with `'` — a spreadsheet executes them otherwise, and business names are
attacker-influenced free text.

---

## Usage

### `GET /api/usage`

Provider call counts, units, and cost. Mocked calls are counted separately and
excluded from spend, so development activity never inflates a real cost report.

---

## Public

### `GET /unsubscribe/{token}`

Unauthenticated, one click, no confirmation step. A recipient who wants out must
not be asked to sign in or find anything — friction here converts an unsubscribe
into a spam complaint, which is far worse for the sender.

An unknown token still reports success: telling a visitor "that token is invalid"
is unhelpful, and confirming which tokens exist would let someone enumerate them.
