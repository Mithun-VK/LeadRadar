# Google Maps Platform Compliance

**Status:** engineering guidance, not legal advice.

This document records what the Google Maps Platform documentation says, how
LeadRadar is built in response, and — importantly — where genuine uncertainty
remains. It makes no claim that LeadRadar is compliant. That determination
requires a lawyer reading the binding terms against your specific commercial
use, and it should happen before you sell access to anyone.

Last researched: **2026-08-08**. Google changes both pricing and terms without
notice; re-verify before launch and on a schedule after it.

---

## 1. What the documentation says

### 1.1 Place IDs are the exception

The Places API documentation states that the place ID *"is exempt from the
caching restrictions"* in the Google Maps Platform Terms of Service, and that
place ID values may be stored indefinitely.

Google also recommends refreshing place IDs older than roughly **12 months**,
and notes this refresh is **free**: a Place Details request asking for only the
`id` field carries no charge. A place ID that has become invalid returns
`NOT_FOUND`.

### 1.2 Everything else is restricted

The Places API policies state that you *"must not pre-fetch, cache, index, or
store Places content except under the limited conditions stated in the terms."*
The commonly cited allowance for other content is **temporary caching of up to
30 consecutive calendar days**, after which the cached values must be deleted.

Attribution is required when Places data is displayed: the Google Maps logo
where possible, or the text "Google Maps" where space is limited. Reviews and
photos carry additional author-attribution obligations.

### 1.3 What this means for a lead-generation product

This is the uncomfortable part, and it should be stated plainly rather than
engineered around quietly.

A lead-generation product whose deliverable is a permanent, exportable CSV of
business names, addresses, phone numbers, ratings, and review counts obtained
from the Places API is in direct tension with the no-caching and no-database
provisions. "We stored it in Postgres instead of a cache" is not a meaningful
distinction to a terms review.

**LeadRadar is therefore architected so that Google Places is a discovery
index, not the product's data asset.** A lead becomes a durable, exportable
record only after LeadRadar has independently re-grounded it from the
business's own public web presence.

---

## 2. The three data classes

The schema separates these physically, not by convention, because a convention
is something a future contributor forgets.

| Class | Examples | Storage | Retention | Export default |
|---|---|---|---|---|
| **Place identifier** | `googlePlaceId` | `PlaceIdentifier` | Indefinite; refreshed if older than 12 months | Allowed |
| **Google-derived** | `displayName`, `formattedAddress`, `rating`, `userRatingCount`, `nationalPhoneNumber`, `websiteUri`, `googleMapsUri` | `GooglePlaceSnapshot`, with `expiresAt` | TTL (default 30 days), then purged; re-fetched on demand | **Excluded** |
| **Independently discovered** | Name, phone, address, emails, social links scraped from the business's own site; search-result metadata | `WebsiteCandidate`, `WebsiteVerification`, `SocialProfile`, `WebFact` | Indefinite | Allowed |
| **Application-generated** | Opportunity score, lead score, digital-presence level, verification verdict, service recommendations, score breakdowns | `LeadScore`, `DigitalPresence`, `ServiceRecommendation`, `AIAnalysis` | Indefinite | Allowed |

### Why the split earns its keep

The TTL is a constraint, but it produces two things worth having:

1. **Change detection for free.** Because Google-derived fields must be
   refreshed rather than accumulated, LeadRadar necessarily sees the *previous*
   and *current* values of rating and review count. Review velocity — a much
   better commercial signal than review total — is a by-product. So is
   "this business just closed" and "this business just launched a website".
   Competitors that hoard a static scrape cannot compute any of it.
2. **A defensible data asset.** The independently verified layer is genuinely
   LeadRadar's own. It is what makes the export defensible and the product more
   than a scraper wrapper.

---

## 3. How the code enforces this

- **`GoogleDataPolicyService`** is the only way feature code reads Google-derived
  fields. It returns a value together with its `expiresAt`, and refuses to serve
  an expired snapshot — forcing a refresh instead of silently returning stale
  data that should have been deleted.
- **`GooglePlaceSnapshot.expiresAt`** is set on write, indexed, and swept by a
  scheduled purge job. Retention is enforced by a job, not by good intentions.
- **`ExportPolicyService`** classifies every column by provenance and excludes
  the Google-derived class by default. Including it requires an explicit,
  audited opt-in that records who chose it and when.
- **Attribution** is rendered wherever Google-derived data is displayed, and lead
  detail pages label every field with its source class. The UI never mixes the
  three classes in an unlabelled table.
- **`reviews` and `editorialSummary` are never requested.** This avoids the
  Enterprise + Atmosphere SKU, and it avoids the review-author attribution
  obligations entirely. LeadRadar needs review *counts*, not review *text*.

---

## 4. Open questions for legal review

These are unresolved and should not be presented as settled:

1. **Does a 30-day TTL satisfy the terms for a lead-gen use case at all**, or
   does the "no database / no substitute service" provision apply regardless of
   retention period?
2. **Is the independently re-grounded record genuinely clean**, given that
   Google Places was the mechanism that discovered the business? A reasonable
   reading says yes — the stored facts come from the business's own website. A
   stricter reading may treat the pipeline as derived from Google content.
3. **Does exporting even the independently verified record to a customer's CRM**
   constitute a permitted use, and does attribution follow it there?
4. **Territory and tier.** Pricing and some terms vary by region; the EEA has
   separate service-specific terms.
5. **Volume.** Systematic enumeration of a city's businesses may be read as bulk
   downloading regardless of per-request compliance.

---

## 5. Risk mitigation: provider substitutability

Because question 1 above may be answered unfavourably, the discovery layer sits
behind the `BusinessDiscoveryProvider` interface. If Google Places becomes
untenable for this use case — by terms change, price change, or legal advice —
an **Overture Maps** or **OpenStreetMap** discovery adapter can replace it
without touching filtering, enrichment, scoring, or the UI. Those sources carry
permissive licences that allow permanent storage and redistribution, at the cost
of lower coverage and no rating or review data.

The realistic long-term shape may well be a hybrid: an openly licensed base
layer for durable records, with Places used sparingly for the commercial signals
only it has. Keeping that option open is deliberate, and it is the main reason
the provider abstraction exists in Phase 1 rather than being retrofitted later.

---

## 6. Operational checklist

- [ ] Legal review of the questions in §4 before any paid customer.
- [ ] Confirm the current caching allowance in the binding Maps Service Specific
      Terms (the archived versions are useful for tracking changes).
- [ ] Verify attribution rendering in the dashboard, lead detail, and any
      white-label report.
- [ ] Confirm the snapshot purge job runs and is monitored — an unmonitored
      retention job is the same as no retention policy.
- [ ] Re-verify pricing and SKU tiers quarterly; record the date in
      `src/config/pricing.ts`.
- [ ] Document the export opt-in flow and who is authorised to enable it.
