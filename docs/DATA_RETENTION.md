# Data retention

What LeadRadar keeps, for how long, and why.

The organising principle: **retention is justified by continuing need, not by
convenience.** Data that drives the product is durable; data that was needed once
and has served its purpose expires. Where those conflict, the narrower answer wins.

---

## 1. Retention classes

| Class | Tables | Retention | Purged by |
|---|---|---|---|
| Place identity | `place_identifiers` | Indefinite | — |
| Google-derived snapshot | `google_place_snapshots` | **30 days** | `purge-google-snapshots`, hourly |
| Independently crawled | `website_candidates`, `website_verifications`, `social_profiles`, `email_candidates`, `website_analyses` | Indefinite | — |
| Application intelligence | `lead_scores`, `service_recommendations`, `ai_analyses` | Indefinite | — |
| CRM records | `businesses`, `deals`, `sales_activities`, `meetings`, `proposals`, history tables | Indefinite | — |
| **Inbound email bodies** | `email_conversations.body` | **90 days** | `purge-email-bodies`, daily |
| Inbound email metadata | `email_conversations` (row) | Indefinite | — |
| Outbound message bodies | `email_messages.body` | Indefinite | — |
| Suppression | `suppression_entries` | **Indefinite, by design** | Never |
| Sessions | `sessions` | 30 days absolute, 7 days idle | `purgeExpiredSessions` |
| Operational | `api_usage`, `system_events`, `audit_logs` | Indefinite | — |

---

## 2. Inbound email — the tightest constraint

Reading a mailbox means seeing messages that have nothing to do with LeadRadar.
Three rules bound what survives, and all three are enforced in code rather than by
policy:

**Only matched messages are stored at all.** `syncInbox` matches each message
against threads LeadRadar started — by `In-Reply-To`, thread id, or a sender
address it actually emailed. An unmatched message is read in memory, matched
against nothing, and discarded. It is never written. The operator's accountant,
family, and other customers never enter the database.

**Bodies expire after 90 days.** `bodyExpiresAt` is set on write; a daily job nulls
the body and leaves the row. Ninety days is chosen because it comfortably covers a
sales cycle — long enough that "what did they actually say in March?" is still
answerable while a deal is live, short enough that a dead lead's words do not
accumulate for years.

**The row survives the body.** The conversation record still answers "this lead
replied on the 3rd, classified as a price request", which is what drives the funnel
and the work queue. That metadata contains no third-party prose.

### Why outbound bodies are kept and inbound bodies are not

An asymmetry worth stating, because it looks inconsistent.

**Outbound** message bodies (`email_messages.body`) are retained indefinitely.
They are the operator's own words, sent under their own name, and "what did we
actually send this person?" must remain answerable after the template has changed —
including if the recipient complains or disputes what was said. Deleting them
destroys the operator's own record of their own conduct.

**Inbound** bodies are someone else's words, written to the operator, about
themselves. The continuing need for them ends when the deal does.

---

## 3. Suppression is never purged

`suppression_entries` has no expiry and no purge job, deliberately.

An expiring suppression list is not a suppression list. If someone unsubscribes and
the record ages out, they are re-discovered by a later search and emailed again —
and the system will have forgotten it was ever told not to. Retaining a hashed and
plaintext address indefinitely is the *narrower* choice here: the alternative is
contacting someone who asked not to be.

The plaintext address is kept alongside the hash so an operator can read and manage
their own list. A list you cannot read is one you cannot honour when someone writes
to ask whether they are on it.

---

## 4. Google-derived data

Governed by provider terms rather than by preference. `google_place_snapshots`
carries `expiresAt`, set to 30 days on write, and is purged hourly. See
[google-maps-compliance.md](google-maps-compliance.md).

The refresh loop this forces is also what makes review-velocity change detection
possible — a constraint that produced a feature.

---

## 5. Configuring retention

| Constant | Location | Default |
|---|---|---|
| `BODY_RETENTION_DAYS` | `src/modules/email/inbox-sync.ts` | 90 |
| `GOOGLE_SNAPSHOT_TTL_DAYS` | `src/modules/database/repositories.ts` | 30 |
| `SESSION_ABSOLUTE_TTL_MS` | `src/modules/auth/session.ts` | 30 days |
| `SESSION_IDLE_TTL_MS` | `src/modules/auth/session.ts` | 7 days |

Shortening a window takes effect on the next purge run; rows already past the new
threshold are caught on the following pass.

---

## 6. Deleting a lead

Deleting a `businesses` row cascades to its candidates, verifications, analyses,
scores, recommendations, activities, status history, deals, meetings, proposals,
and conversations.

Two things deliberately survive:

- **`suppression_entries`**, keyed on the address rather than the lead. Deleting a
  lead must not resurrect the ability to email someone who opted out.
- **`place_identifiers`**, which are provider identity shared across tenants and
  contain no personal data.

---

## 7. What is not implemented

Stated plainly rather than left to be discovered:

- **No automated subject-access export.** Assembling everything held about one
  business is currently a manual database query.
- **No per-organization retention configuration.** The constants above are
  global. An operator needing a shorter window must change them and redeploy.
- **No hard-delete scheduler.** Nothing automatically removes old *leads* — only
  the specific fields above expire. A lead discovered three years ago is still
  there.

These are gaps, not decisions, and they matter more the moment LeadRadar is used
on people in a jurisdiction with erasure rights. See
[legal-review-brief.md](legal-review-brief.md).
