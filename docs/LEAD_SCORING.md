# Lead scoring and website analysis

How LeadRadar decides which leads are worth calling, and what it will and will not
claim about a business's website.

---

## 1. The opportunity score

### Why it is not additive

The obvious design — +30 for "no website", +25 for "no verified website", +15 for
a phone number, +10 for a good rating — is what most tools do, and it mis-ranks
leads badly.

Under additive weights, a clinic rated 4.0 with 20 reviews and no website scores
80, which is grade A. But 20 reviews means almost no customers, which usually means
almost no revenue, which means no budget for a website. The score has confidently
identified a business that cannot buy.

The error is treating **need** and **ability to pay** as interchangeable points on
one axis. They are independent conditions, and commercial opportunity requires all
of them at once:

```
opportunity = need × value × reach
```

| Factor    | What it measures                                                                                                                                                                |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Need**  | How badly the business lacks digital presence. No website at all is maximum need; a thin or parked site is high; a good site is low but non-zero — SEO and ads remain sellable. |
| **Value** | How likely the business can pay. Review volume is the best available proxy for customer throughput; rating adjusts it.                                                          |
| **Reach** | Whether an agency can start a conversation at all. A lead with no phone, no email, and no social presence is not workable however attractive.                                   |

Multiplication makes any near-zero factor dominate, which is the intended
behaviour: a business nobody can contact is not a 90 with a caveat, it is not a
lead.

The UI still renders a per-signal points breakdown, because "+30 no website" is how
salespeople think. That breakdown is a faithful view of the same computation, not a
second model that could disagree with it.

### Caps

Some commercial judgement cannot be expressed as a smooth function:

| Cap                   | Value            | Why                                                                                                                                           |
| --------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Fewer than 10 reviews | max 59 (grade C) | A business with 6 reviews is not an A-grade lead however total its digital absence, and presenting it as one destroys trust in the whole list |
| Chain or franchise    | max 45           | Purchasing decisions happen at head office, not at the location                                                                               |
| Unverified identity   | max 89           | Cannot reach A+ on a lead we could not confirm                                                                                                |
| Permanently closed    | max 5            | —                                                                                                                                             |

### Grades

| Score  | Grade |
| ------ | ----- |
| 90–100 | A+    |
| 75–89  | A     |
| 60–74  | B     |
| 40–59  | C     |
| 0–39   | D     |

### Recalculating without spending

Every score carries a `signalsVersion`. Changing weights bumps it, which
recomputes every lead's score from **stored** signals — no provider is called and
no budget is spent. Scoring re-reads what enrichment measured; it never re-fetches.

---

## 2. Website analysis

### What is measured

A verified website is fetched once and parsed. Five categories, weighted to total
100:

| Category     | Weight | Checks                                                                                                             |
| ------------ | ------ | ------------------------------------------------------------------------------------------------------------------ |
| **SEO**      | 25     | Title present and reasonably sized; meta description present and sized; exactly one H1; Schema.org structured data |
| **Content**  | 25     | Content volume; image alt-text coverage; internal link count as a proxy for real site depth                        |
| **Mobile**   | 20     | Mobile viewport meta tag; responsive image markup or media queries                                                 |
| **Trust**    | 15     | Contact page linked; booking or enquiry call to action; own domain rather than free subdomain hosting              |
| **Security** | 15     | HTTPS; insecure subresources on a secure page (mixed content)                                                      |

Every check produces a finding with the points awarded, the maximum, and a
rationale phrased for a non-technical reader. The lead detail page renders those
verbatim rather than re-deriving the reasoning.

### What is NOT measured, and why

**There is no performance score.** `performanceScore` is null, always, from this
analyzer.

A single server-side page fetch cannot measure load performance. It cannot measure
Core Web Vitals, time to interactive, render-blocking cost, or what a phone on a
4G connection actually experiences. It sees one HTML document, fetched once, from a
datacentre.

The tempting move is to synthesise a plausible number from document size and script
count and label it "Performance: 62". That number would be fiction, and a
salesperson would repeat it to a prospect who may well have real analytics open in
another tab. **One fabricated metric discredits every honest one beside it** —
including the alt-text count that was true.

So the UI shows "Not measured" with the reason. Page weight and script count _are_
reported, as the raw observations they are.

Also not claimed:

| Not measured               | Why                                                                |
| -------------------------- | ------------------------------------------------------------------ |
| Core Web Vitals, load time | Needs a real browser measurement (Lighthouse) or field data (CrUX) |
| Keyword rankings, traffic  | Needs a search-data provider                                       |
| Backlink profile           | Needs a link-index provider                                        |

Each needs a real data source. If one is integrated later, it should populate
`performanceScore` explicitly and be labelled with its own provenance.

### Degrading honestly

When the raw document is unavailable, the analyzer falls back to the markdown for
the checks that survive conversion (headings, images, links) and reports the
markup-only checks as **not checkable** — awarding partial credit rather than zero.

This matters more than it sounds. "We could not look" is not the same claim as "it
is absent", and scoring an unperformed check as a failure would invent a defect the
business does not have. The same rule governs flags: `NO_STRUCTURED_DATA` is not
raised when the markup could not be read.

---

## 3. Opportunity flags

A score tells a salesperson _how good_ a lead is. A flag tells them _what to say_.

Flags are derived from the same signals that produce the score, at the same time,
so a flag can never contradict the evidence panel beneath it. Each carries the
sentence that justifies it, drawn from a measurement rather than an adjective.

### Website state — exactly one of these

`NO_WEBSITE` · `DIRECTORY_LISTING_ONLY` · `WEBSITE_BROKEN` · `WEBSITE_PARKED`

Mutually exclusive by construction. Emitting `NO_WEBSITE` alongside `POOR_SEO`
would be incoherent, and a salesperson reading both would trust neither.

`DIRECTORY_LISTING_ONLY` is the commercially interesting one: a business on Practo
or Zomato with no site of its own has already demonstrated willingness to pay to be
findable. It is frequently a _better_ prospect than one with no presence at all,
and a naive "has website" filter discards it.

### Measured defects

`NO_HTTPS` · `MIXED_CONTENT` · `POOR_MOBILE` · `POOR_SEO` ·
`MISSING_META_DESCRIPTION` · `MISSING_H1` · `MISSING_ALT_TEXT` ·
`NO_STRUCTURED_DATA` · `LOW_CONTENT_QUALITY` · `THIN_WEBSITE` · `OUTDATED_WEBSITE`
· `FREE_HOSTING`

`OUTDATED_WEBSITE` is claimed only from **converging** structural evidence — no
viewport tag _and_ no structured data, both standard for over a decade. One weak
signal is not enough to call a site outdated.

### Reachability

`NO_CONTACT_EMAIL` · `NO_CONTACT_ROUTE` · `NO_BOOKING_FUNNEL` · `NO_SOCIAL_MEDIA`

### Cautions, not opportunities

`LOW_REVIEW_COUNT` · `DECLINING_RATING`

Rendered differently in the UI, and **never used in outreach copy**. They are shown
so a salesperson understands why an otherwise needy lead is graded down — not as
something to say to the prospect.

### Deliberately absent

There is no `SLOW_WEBSITE`. Load performance is not measured, and a flag asserting
slowness would be a guess printed next to facts.

---

## 4. Contact discovery

Addresses are extracted from pages the pipeline **already fetched** during website
verification, so discovery costs nothing extra.

Confidence is dominated by domain agreement: an address on the domain verified as
the business's own is near-certain, while a `gmail.com` address on the same page
could equally belong to the web designer who built the site. A `mailto:` link
outranks loose page text, because it was marked up as a contact point rather than
merely mentioned.

Role accounts (`info@`, `contact@`) are **marked, not discarded**. For a small
clinic they are frequently the only published address, and they exist precisely so
that people write to them.

**There is no permutation guessing.** No `first.last@domain` generator, no SMTP
probe, and no enum member in `EmailSourceDb` that would let one be added quietly.
Guessed addresses bounce; bounces damage the sender's domain reputation; a damaged
reputation silently degrades every campaign the operator ever runs afterwards. The
cost of a guessed address is not one bad email — it is every future good one.

Extraction runs **only** on a site accepted as belonging to the business. Harvesting
from an unverified candidate would attach some other company's address to this
lead, and a campaign would then mail a stranger about a website that is not theirs.

---

## 5. Tuning

Weights and caps live in `src/modules/scoring/config.ts`; analysis weights in
`src/modules/enrichment/website-analysis.ts`. Both are configuration with
documented rationale, and both carry a version so a change recomputes without
re-spending API budget.

These numbers are **starting estimates**. They are meant to be recalibrated against
real conversion data — run `npm run calibrate` against real searches before
treating any of them as settled.
