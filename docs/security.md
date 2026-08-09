# LeadRadar Security Model

**Status:** engineering documentation. Reviewed against the code as of the Phase 11
audit; re-audit on any change to the crawler, the AI layer, or the export path.

---

## 1. Threat model

LeadRadar's unusual risk profile comes from one fact: **it deliberately fetches and
processes content from arbitrary third-party websites, chosen by third parties.**
Neither the URLs nor the page contents are trustworthy, and both flow into a server
that holds API credentials and a multi-tenant database.

| # | Threat | Exposure | Control | Verified by |
|---|---|---|---|---|
| 1 | **SSRF** | Highest. URLs come from Firecrawl search results and Google's `websiteUri`. | `validateExternalUrl` — scheme/port allow-list, DNS resolution + full IP classification, IP pinning, per-hop redirect revalidation. Fail-closed. | `tests/unit/security/url-guard.test.ts` (44), `ip.test.ts` (55) |
| 2 | **DNS rebinding** | High. A hostname can resolve differently between check and fetch. | The guard returns a **pinned IP**; callers connect to that address with an explicit `Host` header rather than re-resolving. Any private address in the answer set condemns the name. | `url-guard.test.ts` — mixed-answer and rebinding cases |
| 3 | **Cloud metadata access** | High. `169.254.169.254` yields instance credentials. | Blocked by IP (own audit reason), by hostname (`metadata.google.internal`, `instance-data`), and by link-local range. | `ip.test.ts`, `url-guard.test.ts` |
| 4 | **Prompt injection** | High. Scraped pages are fed to a model by design. | Layered: content fenced in a data channel, injection patterns neutralised, hidden/zero-width text stripped, fence forgery blocked. **Blast radius bounded by output schemas** — see §2. | `tests/unit/security/untrusted.test.ts` |
| 5 | **LLM hallucination** | Medium. A fabricated phone number would poison a lead. | The model never *emits* facts — only classifies facts extracted deterministically. Every output is a constrained enum + confidence, `.strict()`-validated. Low confidence routes to manual review. | `untrusted.test.ts` schema cases |
| 6 | **SQL injection** | Low. Prisma parameterises; no raw SQL from input. | No string-built queries. Sort fields are enum-constrained (an arbitrary `ORDER BY` would be the injection point). LLM output can never reach a query. | `src/app/api/leads/route.ts` schema |
| 7 | **CSV/formula injection** | Medium. Exports open in Excel; business names are third-party text. | Cells beginning `= + - @` tab CR are prefixed with `'`, in **both** CSV and XLSX. | `tests/unit/export/policy.test.ts` |
| 8 | **Cross-tenant data access** | High. Lead lists are the product. | `organizationId` non-null on every owned row and required in every repository call. No un-scoped read helper exists. | `tests/integration/database.test.ts` |
| 9 | **Credential leakage** | High. Three provider keys. | Server-only; boot fails on a secret-shaped `NEXT_PUBLIC_*` **or** a public var holding a real secret value. Logger redacts by field path, by actual secret value, and by URL query stripping. | `tests/unit/lib/env.test.ts` |
| 10 | **Budget exhaustion / cost attack** | Medium. Job flooding costs real money. | Redis Lua reserve-before-call across job/daily/monthly scopes; per-tenant API rate limits; per-job hard ceilings; queue pause on exhaustion. Fail-closed if Redis is unreachable. | `src/modules/providers/rate-limit.ts` |
| 11 | **Response-size exhaustion** | Medium. A hostile page could be gigabytes. | Byte cap enforced **while streaming**, not from `content-length` (attacker-controlled, absent when chunked). Content further truncated before the AI layer. | `src/modules/providers/http.ts` |
| 12 | **XSS** | Low. React escapes by default. | No `dangerouslySetInnerHTML` anywhere. Scraped content is rendered as text only. | Code review; grep-enforced |
| 13 | **Queue poisoning** | Low. Payloads survive deploys. | Every payload re-validated on read; a schema failure is non-retryable and dead-letters immediately rather than looping. | `src/modules/jobs/schemas.ts` |
| 14 | **Export file enumeration** | Medium. Files hold lead lists. | Served through an authenticated route with a tenant check, never from a public directory. Filenames carry only the job id. | `src/app/api/export/[id]/route.ts` |
| 15 | **Provider terms violation** | High (commercial). | Provenance split in the schema, TTL purge job, export policy gate. See `google-maps-compliance.md`. | `tests/integration/database.test.ts` retention cases |

---

## 2. Why prompt injection is contained rather than merely filtered

Sanitising prompts is necessary but is **not** the control that matters. Anyone
relying on pattern-matching alone has already lost, because the attacker writes the
page and can always find a phrasing the filter misses.

The real containment is architectural:

1. **The model receives no secrets.** Prompts contain business facts from our own
   database and page text. No credentials, no configuration, no other tenant's data.
2. **The model has no tools.** No function calling, no code execution, no network,
   no database. A page instructing it to "call the API" is asking for a capability
   it does not have.
3. **The model cannot emit a fact.** Every schema returns a constrained enum plus a
   confidence and quoted evidence. There is no field in which a phone number, URL,
   address, or score could be returned. Facts are extracted deterministically; the
   model only judges them.
4. **The model cannot influence a score.** Scoring is deterministic and consumes
   only validated enums.
5. **Injection is detected and penalised.** When a pattern fires, the resulting
   confidence is capped at 0.6 — below the auto-accept threshold — so the verdict
   routes to review rather than being applied.

**Maximum blast radius of a fully successful injection: one incorrect website-match
verdict on one lead, flagged for manual review.** Not exfiltration, not spend, not
execution.

---

## 3. SSRF guard specifics

Rejected outright:

- Schemes other than `http`/`https`; ports other than 80/443; embedded credentials;
  control characters; single-label hostnames.
- Hostnames: `localhost`, `*.localhost`, `*.internal`, `*.local`, `*.corp`,
  `*.lan`, `metadata.google.internal`, `instance-data`, and similar.
- IPv4: `0.0.0.0/8`, `10/8`, `100.64/10` (CGNAT), `127/8`, `169.254/16` (with
  `169.254.169.254/32` called out separately), `172.16/12`, `192.0.0/24`,
  `192.0.2/24`, `192.88.99/24`, `192.168/16`, `198.18/15`, `198.51.100/24`,
  `203.0.113/24`, `224/4`, `240/4`, `255.255.255.255/32`.
- IPv6: `::`, `::1`, `fe80::/10`, `fc00::/7`, `ff00::/8`, `2001:db8::/32`,
  `100::/64`; **IPv4-mapped (`::ffff:…`) and NAT64 (`64:ff9b::…`) are unwrapped and
  re-checked against the IPv4 rules**, since those are the classic bypasses.
- Octal-style octets (`0177.0.0.1`) and any unparseable address — unparseable is
  treated as blocked, because "unparseable" and "safe" are unrelated.

Fail-closed: a DNS error or an empty answer rejects the URL.

---

## 4. What is deliberately NOT claimed

Honesty here is more useful than a longer control list:

- **No authentication yet.** `resolveTenant` returns the seeded development
  organization. Tenancy is enforced everywhere *below* that function, so adding
  auth means replacing one function — but until it exists, **this application must
  not be exposed to the public internet.**
- **No CSRF protection**, because there are no cookie-authenticated mutations yet.
  Required at the same time as auth.
- **No encryption-at-rest for tenant secrets.** `ENCRYPTION_KEY` is validated and
  reserved; nothing uses it yet, because no tenant-supplied secrets are stored.
- **No SEO or performance auditing.** The digital-presence classification measures
  what it can observe from one or two pages. It does not measure traffic, rankings,
  or Core Web Vitals, and the prompts explicitly forbid inferring them.
- **No rate limiting on `/api/health`.** It performs two cheap liveness checks and
  discloses no configuration beyond mock-mode status.
- **Compliance is not certified.** See `google-maps-compliance.md` §4.

---

## 5. Logging rules

Never logged: API keys, `DATABASE_URL`, `REDIS_URL`, `ENCRYPTION_KEY`,
authorization headers, cookies, passwords.

Three redaction layers, because any one can be bypassed by an unusual call site:
field-path redaction, **actual secret value** replacement (catches a key embedded in
a provider error message — the common real-world leak), and URL query stripping
(Google keys travel as `?key=…`).

Provider error bodies pass through `redactSecrets()` before entering an `AppError`.

---

## 6. Audit checklist for future changes

- [ ] Any new outbound fetch goes through `validateExternalUrl` **and** connects to
      the pinned IP.
- [ ] Any new AI task has a `.strict()` schema returning enums/numbers only — never
      a fact, URL, or score.
- [ ] Any new repository function takes `TenantContext` explicitly.
- [ ] Any new export column is classified by provenance in `EXPORT_COLUMNS`.
- [ ] Any new provider call reserves budget before the call and reports usage.
- [ ] Any new queue payload has a Zod schema and is validated on read.
- [ ] `npm run guard:providers` passes (no Anthropic SDK, no hard-coded models, no
      direct `process.env`, no public secrets).
