# Crawling and extraction

How LeadRadar fetches pages, what it refuses to do, and why it fetches so few.

---

## 1. It is not a crawler

There is deliberately **no whole-site crawl method** on the web provider
interface. `WebDiscoveryProvider` exposes exactly two operations:

```ts
search(request: WebSearchRequest): Promise<Result<WithUsage<WebSearchResult[]>>>
fetchPage(request: PageFetchRequest): Promise<Result<WithUsage<FetchedPage>>>
```

Crawling a whole site to answer "does this domain belong to this business?" is the
single most expensive mistake available in this pipeline. At one credit per page, a
15-page crawl costs 15× a homepage fetch and answers the same question. Ownership
is established by a homepage and, at most, one contact or about page.

The absence is structural: adding a crawl would mean adding a method to the
interface, which is a visible change rather than a quiet loop.

**Hard ceiling: two page fetches per business.** One homepage, plus one secondary
page — and only when the first left the verdict genuinely ambiguous.

---

## 2. The cost gates

Each stage narrows the set before the next, more expensive one runs. Every gate is
a spending decision:

| #   | Gate                                                  | Effect                                                                                                         |
| --- | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| 1   | Candidates assembled from data already held           | Free. For the ~65% of businesses with a listed website, removes the need for a search entirely                 |
| 2   | Web search only when no owned-domain candidate exists | Skips the search for the majority                                                                              |
| 3   | Only the single best candidate is fetched             | Scraping three plausible domains to pick one triples the bill for a decision the top candidate usually settles |
| 4   | A second page only when the verdict is ambiguous      | ~30% of fetches                                                                                                |
| 5   | AI only for the inconclusive band                     | ~20% of filtered businesses                                                                                    |

Gate 5 is worth stating carefully, because the usual instinct is backwards. **A
Groq call is cheaper than a single page fetch** — roughly 3× cheaper, and 6× cheaper
than a web search. So where one AI call replaces a fetch, calling the model is both
the more accurate _and_ the cheaper choice.

The operative principle is not "avoid AI":

> Avoid **network** calls. Among network calls, avoid the ones billed **per
> business record** (Google Enterprise details) and **per page fetched** long
> before you worry about tokens.

"Don't use AI when rules will do" still holds — but for determinism and
explainability, not for cost.

---

## 3. What is fetched

`fetchPage` requests markdown, links, and — when analysis needs it — the raw HTML.

Formats are billed **per page, not per format**, so requesting HTML alongside
markdown costs no extra credits. It is opt-in only because of bandwidth.

The raw document is necessary rather than nice to have: viewport meta tags,
canonical links, `alt` attributes, and structured data simply do not survive
conversion to markdown, and scoring them from markdown would mean inventing
measurements. When HTML is requested the provider is also told not to strip to main
content, because `<head>` is precisely where those facts live.

**Caps:** 40,000 characters of markdown, 400,000 characters of HTML, 300 links, 3 MB
of response body enforced _while streaming_. Checking `content-length` is not
protection — it is attacker-controlled, and a chunked response has none.

---

## 4. SSRF defence

The primary risk in this product, because the server fetches URLs influenced by
search results and by a third party's `websiteUri` field. Neither is trustworthy.

`validateExternalUrl()` enforces, before any fetch:

- `https`/`http` only; ports 80 and 443 only
- DNS resolution, then rejection of: loopback, private IPv4 (RFC 1918), CGNAT
  (100.64/10), link-local (169.254/16, fe80::), unique-local IPv6 (fc00::/7),
  `::1`, `0.0.0.0`, and cloud metadata endpoints (`169.254.169.254`,
  `metadata.google.internal`)
- **Connection to the resolved-and-pinned IP with an explicit `Host` header**,
  which is what defeats DNS rebinding — validating a hostname and then letting the
  HTTP client resolve it again leaves a window between the two lookups
- At most 2 redirects, each hop **fully re-validated**
- 5-second timeout

The guard runs before spending a credit, and before the provider is asked to fetch
anything on our behalf — cheaper and safer in that order.

---

## 5. Untrusted content

Every fetched page is **untrusted input**, and treated as such at two boundaries:

**Toward the AI.** Page text enters the model only in a data channel: sanitised,
fenced with explicit markers, and length-capped, with an in-band statement that
content between the markers is data rather than instructions.

More importantly, the blast radius is bounded by design. The model may only return
a constrained enum plus a confidence number, Zod-validated. It cannot emit a fact, a
URL, a score, or SQL. **Deterministic code owns every number that reaches the user.**
A successful prompt injection buys an attacker one wrong verdict on one lead.

**Toward email headers.** A business name scraped from a page title becomes a
display name in an outgoing message. A CR or LF smuggled into it would let an
attacker terminate a header and inject their own — a `Bcc:` to a thousand
recipients, or a replacement body. `sanitizeHeaderValue()` strips CR, LF, and NUL
from every header value, and addresses are rejected outright rather than cleaned.
This is the email equivalent of the CSV-injection defence in the exporter.

---

## 6. Rate limiting and politeness

- Per-provider token buckets in Redis, applied before every call
- Exponential backoff **with jitter** — without it, a batch of workers that hit the
  same 429 retry in lockstep and reproduce the burst that caused it
- A provider's own `Retry-After` always wins over our computed delay; it is
  authoritative and ignoring it invites a longer ban
- Bounded worker concurrency everywhere. An unbounded pool would defeat the rate
  limiter by queueing thousands of simultaneous waiters, and would spend the budget
  faster than the guard can observe it

Fetching is delegated to Firecrawl, which owns rendering and robots handling. Only
publicly accessible pages are fetched. There is no CAPTCHA solving, no anti-bot
evasion, no authentication bypass, and no paywall circumvention — and no code path
that could grow one, because the adapter exposes a single-page fetch and nothing
else.

---

## 7. Extraction

From documents already fetched, at no marginal cost:

| Extracted                         | How                                                                                                                                                     |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Emails                            | `mailto:` hrefs and page text, normalised, role accounts marked, infrastructure addresses (`noreply@`, `postmaster@`) and platform boilerplate excluded |
| Phones                            | Digit-normalised, matched against the business's known number                                                                                           |
| Social profiles                   | Platform URL patterns, with confidence inherited from whether the page was verified                                                                     |
| Title, meta description, headings | Parsed from the document                                                                                                                                |
| Structural facts                  | Viewport, canonical, structured data, image alt coverage, link graph, mixed content                                                                     |

Extraction runs **only on a site accepted as belonging to the business.** Harvesting
from an unverified candidate would attach some other company's address to this
lead, and a campaign would then mail a stranger about a website that is not theirs —
the failure mode that costs credibility across the whole list, not just one row.

---

## 8. Configuration

| Variable                                  | Default | Effect                                                  |
| ----------------------------------------- | ------- | ------------------------------------------------------- |
| `MAX_FIRECRAWL_REQUESTS_PER_JOB`          | 1500    | Hard ceiling on page fetches per job                    |
| `MAX_GOOGLE_REQUESTS_PER_JOB`             | 200     | Hard ceiling on discovery requests                      |
| `MAX_GROQ_REQUESTS_PER_JOB`               | 500     | Hard ceiling on AI calls                                |
| `MAX_CONCURRENT_JOBS`                     | 5       | Global concurrency dial; per-queue values scale from it |
| `MAX_RESULTS_PER_SEARCH`                  | 2000    | Ceiling on businesses discovered per search             |
| `DAILY_BUDGET_USD` / `MONTHLY_BUDGET_USD` | 5 / 50  | Enforced in a Redis token bucket **before** each call   |

Budget is reserved _before_ the provider call and settled after. Checking spend
afterwards — or in application code — lets concurrency overshoot the limit, and
overshoot is irreversible while a paused queue is not. Exhaustion pauses the queue
and emits a `BUDGET_EXHAUSTED` event rather than failing in-flight jobs.

Per-business limits are enforced independently of these, so one pathological
business cannot consume a whole job's budget: at most 2 searches and 2 page fetches.

---

## 9. Testing without a network

`MOCK_EXTERNAL_APIS=true` replaces all providers with deterministic in-process
adapters satisfying the same interfaces. The mock pages carry **real markup** —
one modern and well-formed, one dated and insecure, one parked — because the
analyzer measures structural facts that text cannot express. A fixture without
markup would let the analyzer pass its tests while being untested on the thing it
actually does.

Mock adapters report realistic usage figures, so the cost-tracking path is
exercised rather than bypassed.
