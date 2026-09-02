# CRM

The lead lifecycle, deals, activities, meetings, and proposals.

---

## 1. Four status fields, and why

LeadRadar has four status-shaped fields on or near a lead. They are not redundant,
and collapsing any two loses information a salesperson uses.

| Field | Answers | Example |
|---|---|---|
| `leadPriority` | How **good** is this prospect? | `A_PLUS` |
| `leadStatus` | Where is this **relationship**? | `NEGOTIATION` |
| `CampaignLead.status` | Where did one **enrolment** get to? | `SENT` |
| `Deal.stage` | Where is this **opportunity**? | `PROPOSAL` |

A lead can be grade `A_PLUS` and status `LOST`. It can be grade `C` and status
`WON`. It can be enrolled in one campaign as `SENT` and another as `SKIPPED`. Each
of those is a real, useful state.

---

## 2. Lead lifecycle

```
NEW → QUALIFIED → CONTACTED → REPLIED → SQL → MEETING → PROPOSAL → NEGOTIATION → WON
                                                                               ↘ LOST
   (any status) → UNSUBSCRIBED
```

Transitions are validated by a table in `src/modules/crm/lead-status.ts`. Every
change writes a `LeadStatusHistory` row **in the same transaction** as the status
update, so the two cannot diverge.

### What the table deliberately permits

- **Skipping ahead.** A lead who replies to the first email asking to meet goes
  `CONTACTED → MEETING`. Reality skips; forcing intermediate steps would mean
  fabricating them.
- **Moving backwards.** A stalled proposal returns to `SQL`. Forcing an operator to
  mark it `LOST` to represent "went quiet" would corrupt the win rate.
- **Re-engaging a lost lead.** `LOST → QUALIFIED`, and directly to `MEETING` or
  `PROPOSAL`. A lost deal is a lead worth approaching next year — they already know
  who you are, which is precisely why they are worth re-approaching.
- **Starting mid-funnel.** `NEW → MEETING`. Not every relationship begins with an
  email; a referral walks in.

### What it forbids

- **`WON` without contact.** Closing a deal with a business nobody ever spoke to is
  incoherent, and permitting it would let a mis-click corrupt the win-rate
  denominator.
- **Leaving `UNSUBSCRIBED`.** The one true dead end. A system must never move a
  lead out of it on its own.

### Sources

Every history row records what caused it: `SYSTEM`, `USER`, `EMAIL`, `AI`, or
`IMPORT`. "The system moved this to CONTACTED" and "a human did" are different
claims, and an operator reviewing a pipeline needs to know which they are reading.

---

## 3. Events, not direct writes

Workers do not set statuses directly. They call `applyLeadEvent`, which:

1. Asks `statusForEvent` what the event implies for the lead's **current** status.
2. Drops the change if the transition is not legal.
3. Otherwise records it.

That indirection is what makes out-of-order events safe. A follow-up firing after
someone replied does not drag them back to `CONTACTED`; a reply landing on a lead
already at `PROPOSAL` does not regress them.

| Event | Effect |
|---|---|
| `EMAIL_SENT` | `NEW`/`QUALIFIED` → `CONTACTED`. Otherwise nothing. |
| `REPLY_RECEIVED` | Anything before `REPLIED` → `REPLIED`. Otherwise nothing. |
| `MEETING_BOOKED` | → `MEETING`, unless already at `PROPOSAL` or beyond. |
| `PROPOSAL_SENT` | → `PROPOSAL`, unless already negotiating or won. |
| `UNSUBSCRIBED` | Always → `UNSUBSCRIBED`. |
| `BOUNCED` | **No status change.** Sets `emailInvalid` instead. |

That last row matters. A bounce says the *address* is wrong, not that the prospect
said no. Treating a typo as a rejection would discard a real lead.

---

## 4. Deals

A lead is a business; a deal is a commercial opportunity with that business. One
business can produce two deals a year apart, and a lost deal does not make the lead
worthless.

```
QUALIFICATION → DISCOVERY → MEETING → PROPOSAL → NEGOTIATION → WON
                                                             ↘ LOST
```

**Money is an integer.** `valueMinor` is paise (or cents), stored as `Int`,
everywhere. Never a float — summing floating-point money across a pipeline drifts
visibly, and a total that disagrees with the sum of its rows is the fastest way to
lose trust in a revenue dashboard.

**`null` means "not estimated", never zero.** An unvalued deal is excluded from
money sums and reported separately as `unvaluedCount`, so the UI can say "₹4.2L
across 12 deals, 3 not yet valued" rather than implying the total is complete.

**Losing requires a reason.** `moveDealStage` refuses `LOST` without one. Not
bureaucracy: "why did we lose?" is the most useful field in a CRM and is never
filled in retrospectively.

**Stage changes propagate to the lead, best-effort.** `MEETING`, `PROPOSAL`,
`NEGOTIATION`, `WON`, and `LOST` imply a lead status; `QUALIFICATION` and
`DISCOVERY` imply nothing. If the lead cannot legally follow — it is
`UNSUBSCRIBED`, say — the deal still moves and the lead is left alone.

---

## 5. Activities

One model covers both what happened and what is due, because the lead timeline
shows them interleaved.

`EMAIL` and `NOTE` are created `COMPLETED` — "an email was sent" is not a task
anyone needs to tick off. Everything else starts `OPEN`.

**The system creates activities too.** A classified pricing request raises "Respond
to pricing enquiry" rather than sending a price. That is the human-in-the-loop
boundary made concrete: **automation produces work, people produce commitments.**

`ensureSystemActivity` deduplicates on (lead, type, title) so a lead who sends three
messages about price gets one task, not three. A work queue full of duplicates is
one people stop reading.

**Completed activities are cancelled, not deleted.** Deleting the record that a call
happened rewrites the past, and the timeline is what an operator uses to remember
what was said.

---

## 6. Meetings

Deliberately **not** integrated with any calendar. A fake integration is worse than
none: an operator who believes an invite was sent, when it was not, misses the
meeting.

So a meeting stores a time, a duration, and whatever link the operator pastes.
`externalEventId` exists on the model, unused, so a real Google Calendar sync can be
added later without a migration.

A `NO_SHOW` records the outcome and raises a follow-up task, but does **not** move
the lead backwards. Someone who missed a call is still further along than someone
who never booked one.

---

## 7. Proposals

**Not a contract system.** No signature, no acceptance token, no legal binding.
`ACCEPTED` records that a human told LeadRadar the client accepted — a CRM note, not
an executed agreement. Building a signature flow would create the appearance of a
binding agreement without identity verification, a tamper-evident record, or
enforceable terms.

`VIEWED` exists in the enum but **nothing sets it automatically**. View tracking
needs a tracking pixel or a hosted proposal page, and neither exists. It is an
operator-settable state — "the client told me they'd read it" — not a measurement.

Sending a proposal advances the lead and the deal. **Accepting one does not close
the deal**; it raises a task. Closing a deal is revenue-affecting and irreversible
enough to deserve a deliberate click.

---

## 8. Service offerings

The commercial catalogue sits on top of the scoring engine rather than replacing it.
`ServiceOpportunityDb` remains the taxonomy scoring reasons about; `ServiceOffering`
is what the operator actually sells, at what price.

Default offerings ship with **null prices**. A default price list would be a guess
about someone else's business, and an operator who never revisited it would send
proposals at numbers this software invented.

`reasoning` is assembled from flags that were **actually detected**. There is no
template sentence that fires when no evidence exists. If nothing was detected, the
recommendation returns `insufficientEvidence: true` and the UI says so.

---

## 9. Where to look

| Concern | File |
|---|---|
| Lifecycle rules | `src/modules/crm/lead-status.ts` |
| Status changes and history | `src/modules/crm/leads.ts` |
| Activities | `src/modules/crm/activities.ts` |
| Deals and pipeline totals | `src/modules/crm/deals.ts` |
| Meetings | `src/modules/crm/meetings.ts` |
| Proposals | `src/modules/crm/proposals.ts` |
| Service catalogue | `src/modules/crm/service-offerings.ts` |
| Work queue | `src/modules/crm/work-queue.ts` |
