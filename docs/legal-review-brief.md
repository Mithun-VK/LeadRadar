# LeadRadar — Briefing for Legal Review

**Purpose:** give counsel everything needed to answer five specific questions,
without requiring them to read the codebase.

**Prepared by:** engineering. **Status:** not legal advice; this document asks
questions, it does not answer them.

**Read alongside:** `docs/google-maps-compliance.md` (the technical design that
implements whatever answer you give).

---

## 1. What to review, in one paragraph

LeadRadar uses the Google Places API to *discover* local businesses, then
independently crawls each business's own public website to verify and enrich the
record, then computes its own scores. It sells access to the resulting lead list to
marketing agencies. **The question is whether that use — and specifically the
export of lead data to a paying customer — is permitted under the Google Maps
Platform terms, and if not, what would make it permitted.**

We have deliberately built the system so the answer can be "no, tighten it"
without a rewrite. Section 6 lists the levers.

---

## 2. What the product actually does with Google data

Concretely, per business discovered:

| Step | Data touched | Where it goes |
|---|---|---|
| 1. Discovery | One Places Text Search returns id, name, address, location, types, business status, Maps URI, rating, review count, website URL, phone | Written to `GooglePlaceSnapshot` |
| 2. Retention split | The **Place ID** is copied to `PlaceIdentifier` | Retained indefinitely |
| 3. TTL | Everything else in the snapshot gets `expiresAt = now + 30 days` | Deleted by an hourly purge job |
| 4. Independent crawl | We fetch the business's **own website** and extract name, phone, address, social links | Retained indefinitely, separate tables |
| 5. Scoring | We compute an opportunity score from both | Retained indefinitely |
| 6. Export | Customer downloads CSV/XLSX | **Google-derived columns excluded by default** |

We never request or store review *text*, editorial summaries, or photos.

We do display Google attribution wherever Google-derived data appears.

---

## 3. The five questions

### Q1. Does the 30-day retention window make this permissible at all?

The Places policies prohibit pre-fetching, caching, indexing, or storing Places
content outside limited exceptions, with a commonly cited 30-day temporary caching
allowance, and permit indefinite storage of Place IDs.

**We have implemented the 30-day window.** But there is a separate prohibition on
using Content to create a database or a substitute service, and a lead-generation
product arguably *is* a derived database regardless of how long any individual
field is held.

**What we need:** is a compliant 30-day cache still impermissible here because of
what the system is *for*? If so, does that change if Google-derived fields never
leave our servers (see Q3)?

### Q2. Is the independently crawled record "clean"?

After enrichment, a lead record contains facts we obtained by fetching the
business's own public website: its name, its phone number, its address, its social
links. Those facts are also present in the Places response.

Two readings:

- **Permissive:** the stored fact came from the business's own site. Google was the
  mechanism that told us the business existed, but a Place ID is expressly
  storable, and a fact independently obtained from a public source is ours.
- **Strict:** the pipeline is derived from Google content end to end; independent
  re-grounding is a formality.

**What we need:** which reading holds, and does anything in our implementation
(e.g. the fact that verification *compares against* the Google-derived name and
phone) undermine the permissive reading?

### Q3. Can we export to a customer's CRM?

Our export defaults to excluding every Google-derived column. That default file
contains: verified domain, social profiles, opportunity score, grade, recommended
services, an opening pitch, and the Place ID.

**It does not contain the business name**, which makes the safe export close to
unusable in practice. That tension is real and we have not hidden it — the UI says
so at the point of export.

**What we need:**
- (a) Is the safe export permissible? (We assume yes.)
- (b) Is including Google-derived fields permissible with attribution and an
  explicit customer acknowledgement, which we have built and audit?
- (c) Does the attribution obligation travel with the file into a customer's CRM,
  and if so, how is that discharged?
- (d) Would including only the business **name** (not rating/reviews/phone) change
  the analysis? Name alone would make the export usable.

### Q4. Territory and tier

Pricing and some terms vary by region, and the EEA has separate service-specific
terms. Our initial market is India; customers may be elsewhere.

**What we need:** does serving Indian business data to, say, an EEA-based agency
customer bring the EEA terms into scope? Any India-specific considerations
(including whether scraped business contact data engages the DPDP Act — see §5)?

### Q5. Volume

The geographic strategy subdivides a city and issues repeated searches until
coverage saturates. This is per-request compliant and rate-limited, but it is
systematic enumeration of an area's businesses.

**What we need:** does systematic enumeration constitute prohibited bulk
downloading even when every individual request is compliant? Is there a volume or
methodology threshold we should stay under?

---

## 4. What we have already done to reduce risk

So counsel can see the starting position is not "we ignored this":

1. **Provenance is structural, not conventional.** Google-derived data lives in its
   own table with a mandatory `expiresAt`; it is physically separate from durable
   records, and feature code cannot read it without going through a policy service.
2. **Retention is enforced by a monitored job**, not by policy documents.
3. **Export excludes Google-derived data by default**, and the opt-in is recorded
   in an audit log with the acknowledging user and timestamp.
4. **Attribution is rendered** wherever Google-derived data is displayed.
5. **We never request review text, editorial summaries, or photos**, avoiding the
   author-attribution obligations entirely.
6. **Place IDs are refreshed** rather than left to rot, using the free IDs-only
   request, so we are not holding stale identifiers indefinitely.

---

## 5. Adjacent question worth raising while you are here

**India's Digital Personal Data Protection Act.** LeadRadar stores business contact
details, some of which are personal data where the business is a sole
proprietorship or the phone number is an individual's. Our customers use these to
make unsolicited sales contact.

We have not analysed this and it is not covered by the Google questions. Worth
scoping: whether DPDP consent/notice obligations attach, whether "publicly
available personal data" exemptions apply, and what our customers must be told
they are responsible for.

There is a similar question about TRAI's unsolicited-commercial-communication
regulations for the customers who call or SMS these leads. That is primarily their
exposure, not ours, but it may affect what we should put in our terms.

---

## 6. Levers we can pull, ranked by cost to implement

If any answer comes back unfavourable, these are already-viable responses. Knowing
which you would recommend saves a second consultation.

| Lever | Effect | Engineering cost |
|---|---|---|
| Shorten the retention TTL | Configurable constant | Trivial (one value) |
| Remove specific fields from export | Config table entry | Trivial |
| Never persist Google-derived data at all; hold it only in memory during a job | Loses review velocity and change detection, both of which are product features | Moderate |
| Require per-export legal acknowledgement rather than per-account | UI + audit change | Small |
| **Swap the discovery provider to Overture Maps / OpenStreetMap** | Permissive licence allows permanent storage and redistribution. Costs coverage, and loses rating and review count entirely — which are the ability-to-pay signal the scoring model depends on | Moderate — the provider interface exists precisely for this |
| Hybrid: openly licensed base layer for durable records, Places only for live commercial signals shown in-app and never exported | Probably the strongest long-term posture | Significant |

The provider abstraction was built in the first phase specifically so the last two
rows remain possible. We are not locked in.

---

## 7. What we would like back

1. A yes/no/conditional on Q1–Q5.
2. If conditional: which lever from §6, and what wording we need in our customer
   terms.
3. Whether §5 (DPDP) needs its own engagement.
4. A re-review trigger — e.g. "re-check if Google changes the Places terms" or a
   fixed interval.

**Commercial context for prioritisation:** we cannot onboard a paying customer
until Q3 is answered, because Q3 determines what the product can actually deliver.
Q1, Q2, Q4, and Q5 affect architecture but not launch.
