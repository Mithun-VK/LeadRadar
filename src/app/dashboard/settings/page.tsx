/**
 * Settings.
 *
 * Read-only, and deliberately so: these values are environment configuration, and
 * letting a web form rewrite a spending limit or a provider mode would put the
 * budget guard behind the least trustworthy boundary in the system. The page's job
 * is to make the effective configuration visible.
 *
 * No secret is displayed — only whether each credential is present.
 */
import { DEFAULT_PRICING, FIRECRAWL_PLANS, GOOGLE_SKUS, formatMicros, usdToMicros } from '@/config/pricing';
import { env } from '@/lib/env';
import { Banner, Card } from '@/components/ui/primitives';
import { DEFAULT_CAPS, DEFAULT_WEIGHTS, SIGNALS_VERSION } from '@/modules/scoring/config';
import { knownCityNames } from '@/modules/search/geography';

export const metadata = { title: 'Settings — LeadRadar' };
export const dynamic = 'force-dynamic';

export default function SettingsPage() {
  const config = env();
  const sku = GOOGLE_SKUS[DEFAULT_PRICING.googleTextSearchSku];
  const plan = FIRECRAWL_PLANS[DEFAULT_PRICING.firecrawlPlan];

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-lg font-semibold tracking-tight">Settings</h1>
        <p className="mt-1 text-sm text-[var(--muted)]">
          Effective configuration. Change these through environment variables and redeploy —
          spending limits are not editable from the web.
        </p>
      </div>

      <Card title="Providers">
        <dl className="space-y-2 text-sm">
          <Row
            label="Mode"
            value={config.isMockMode ? 'Mock (no external calls)' : 'Live'}
            tone={config.isMockMode ? 'warn' : undefined}
          />
          <Row label="Google Maps key" value={config.GOOGLE_MAPS_API_KEY ? 'configured' : 'not set'} />
          <Row label="Firecrawl key" value={config.FIRECRAWL_API_KEY ? 'configured' : 'not set'} />
          <Row label="Groq key" value={config.GROQ_API_KEY ? 'configured' : 'not set'} />
          <Row label="Groq model" value={config.GROQ_MODEL} />
        </dl>
        {config.isMockMode && (
          <div className="mt-3">
            <Banner tone="warn">
              Mock mode returns fabricated businesses. It cannot be enabled in production — boot
              fails if it is.
            </Banner>
          </div>
        )}
      </Card>

      <Card
        title="Cost model"
        description="Verified against provider documentation on 2026-08-08. Re-verify before relying on cost reports."
      >
        <dl className="space-y-2 text-sm">
          <Row label="Google discovery SKU" value={`${sku.label} — $${(sku.per1000Micros / 1_000_000).toFixed(2)} / 1,000`} />
          <Row
            label="Google free tier"
            value={`${sku.freeMonthlyEvents.toLocaleString('en-IN')} requests/month (~${(sku.freeMonthlyEvents * DEFAULT_PRICING.funnel.businessesPerSearchRequest).toLocaleString('en-IN')} businesses)`}
          />
          <Row label="Firecrawl plan" value={`${plan.label} — ${plan.includedCredits.toLocaleString('en-IN')} credits`} />
          <Row label="Daily budget" value={formatMicros(usdToMicros(config.DAILY_BUDGET_USD))} />
          <Row label="Monthly budget" value={formatMicros(usdToMicros(config.MONTHLY_BUDGET_USD))} />
        </dl>
        <p className="mt-3 text-[11px] text-[var(--muted)]">
          One Enterprise Text Search returns up to 20 places, making it roughly 11× cheaper per
          business than Place Details. A Groq classification costs less than a single page scrape, so
          AI is not the expensive layer here — per-record Google SKUs and page fetches are.
        </p>
      </Card>

      <Card title="Per-job limits" description="Hard ceilings enforced before each provider call.">
        <dl className="space-y-2 text-sm">
          <Row label="Max results per search" value={config.MAX_RESULTS_PER_SEARCH.toLocaleString('en-IN')} />
          <Row label="Max Google requests" value={config.MAX_GOOGLE_REQUESTS_PER_JOB.toLocaleString('en-IN')} />
          <Row label="Max Firecrawl requests" value={config.MAX_FIRECRAWL_REQUESTS_PER_JOB.toLocaleString('en-IN')} />
          <Row label="Max Groq requests" value={config.MAX_GROQ_REQUESTS_PER_JOB.toLocaleString('en-IN')} />
          <Row label="Max concurrent jobs" value={String(config.MAX_CONCURRENT_JOBS)} />
        </dl>
      </Card>

      <Card
        title="Scoring model"
        description={`Signals version ${SIGNALS_VERSION}. Changing weights recomputes every score without re-spending API budget.`}
      >
        <p className="text-sm">
          Opportunity is <strong>need × value × reach</strong>, not a sum. A purely additive model
          rates a 4.0-star clinic with 20 reviews as grade A on website-absence alone, when low
          review volume usually means no budget. Multiplication lets any weak factor dominate, which
          is the intended behaviour.
        </p>

        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div>
            <h3 className="text-[11px] font-semibold uppercase tracking-wide text-[var(--muted)]">
              Need weights
            </h3>
            <dl className="mt-1 space-y-1 text-xs">
              <Row label="No website at all" value={DEFAULT_WEIGHTS.need.noWebsiteAtAll.toFixed(2)} />
              <Row label="Directory listing only" value={DEFAULT_WEIGHTS.need.onlyThirdPartyListing.toFixed(2)} />
              <Row label="Website broken" value={DEFAULT_WEIGHTS.need.websiteBroken.toFixed(2)} />
              <Row label="Website parked" value={DEFAULT_WEIGHTS.need.websiteParked.toFixed(2)} />
              <Row label="Website thin" value={DEFAULT_WEIGHTS.need.websiteThin.toFixed(2)} />
              <Row label="Good website" value={DEFAULT_WEIGHTS.need.goodWebsite.toFixed(2)} />
            </dl>
          </div>

          <div>
            <h3 className="text-[11px] font-semibold uppercase tracking-wide text-[var(--muted)]">
              Caps
            </h3>
            <dl className="mt-1 space-y-1 text-xs">
              <Row
                label={`Under ${DEFAULT_CAPS.lowReviewThreshold} reviews`}
                value={`max score ${DEFAULT_CAPS.lowReviewMaxScore} (grade C)`}
              />
              <Row label="Chain or franchise" value={`max score ${DEFAULT_CAPS.chainMaxScore}`} />
              <Row label="Unverified identity" value={`max score ${DEFAULT_CAPS.unverifiedMaxScore}`} />
              <Row label="Permanently closed" value={`max score ${DEFAULT_CAPS.closedMaxScore}`} />
            </dl>
          </div>
        </div>
      </Card>

      <Card
        title="Geographic coverage"
        description="Cities are data, not code. Adding one is a registry entry with a bounding box."
      >
        <p className="text-sm">{knownCityNames().join(' · ')}</p>
        <p className="mt-2 text-[11px] text-[var(--muted)]">
          Searches subdivide a city only where a cell returns the provider&apos;s result ceiling.
          Subdividing everywhere would pay full price for near-empty pages and raise cost per
          business.
        </p>
      </Card>

      <Card title="Data handling">
        <ul className="space-y-2 text-sm">
          <li>
            <strong>Place IDs</strong> are retained indefinitely, which provider terms permit.
          </li>
          <li>
            <strong>Google-derived fields</strong> are held in a separate table with an expiry and
            purged hourly. They are excluded from exports unless explicitly acknowledged.
          </li>
          <li>
            <strong>Independently crawled data</strong> and <strong>LeadRadar intelligence</strong>{' '}
            are durable and freely exportable.
          </li>
        </ul>
        <p className="mt-3 text-[11px] text-[var(--muted)]">
          See docs/google-maps-compliance.md, including the open questions that still need legal
          review before commercial launch.
        </p>
      </Card>
    </div>
  );
}

function Row({ label, value, tone }: { label: string; value: string; tone?: 'warn' }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-[var(--muted)]">{label}</dt>
      <dd
        className="text-right font-medium"
        style={tone === 'warn' ? { color: 'var(--grade-c)' } : undefined}
      >
        {value}
      </dd>
    </div>
  );
}
