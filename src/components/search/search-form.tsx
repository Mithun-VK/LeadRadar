'use client';

/**
 * Natural-language search.
 *
 * Two explicit steps: parse, then run. Parsing is free of side effects and shows
 * the user exactly which filters were inferred and what the search will cost. Only
 * then does a second, deliberate click commit spend.
 *
 * Fusing the two would make a typo — "Chenai" instead of "Chennai", or a missing
 * review threshold — into a bill. The extra click is the point.
 */
import { useState } from 'react';
import { useRouter } from 'next/navigation';

import { Banner, Card } from '@/components/ui/primitives';

interface ParsedQuery {
  categories: string[];
  locations: string[];
  minimumRating: number | null;
  minimumReviews: number | null;
  websiteStatus: string;
  excludeChains: boolean;
  requireSocialPresence: boolean | null;
  maxResults: number | null;
}

interface Estimate {
  estimatedBusinesses: number;
  estimatedQualifiedLeads: number;
  googleRequests: number;
  firecrawlCredits: number;
  groqCalls: number;
  totalCostMicros: number;
  costPerQualifiedLeadMicros: number;
  estimatedDurationSeconds: number;
  warnings: string[];
}

interface ParseResponse {
  query: ParsedQuery;
  confidence: number;
  band: string;
  estimate: Estimate;
  unresolvedLocations: string[];
  knownCities: string[];
  error?: { code: string; message: string };
}

const EXAMPLES = [
  'Find dental clinics in Chennai with no website and more than 50 reviews',
  'Independent cafes in Mumbai and Bangalore with 4.2+ rating and active Instagram',
  'High-rated dental clinics in Hyderabad with no verified website',
];

function formatMicros(micros: number): string {
  const usd = micros / 1_000_000;
  if (usd === 0) return '$0.00';
  return usd < 0.01 ? `$${usd.toFixed(6)}` : `$${usd.toFixed(2)}`;
}

function websiteLabel(status: string): string {
  switch (status) {
    case 'GOOGLE_WEBSITE_NOT_LISTED':
      return 'No website listed (includes directory-only listings)';
    case 'GOOGLE_WEBSITE_PRESENT':
      return 'Has a website listed';
    case 'GOOGLE_WEBSITE_IS_THIRD_PARTY_LISTING':
      return 'Only a directory or social listing';
    default:
      return 'Any';
  }
}

export function SearchForm() {
  const router = useRouter();
  const [text, setText] = useState('');
  const [parsing, setParsing] = useState(false);
  const [running, setRunning] = useState(false);
  const [parsed, setParsed] = useState<ParseResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function parse() {
    setParsing(true);
    setError(null);
    setParsed(null);

    try {
      const response = await fetch('/api/search/parse', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: text }),
      });
      const data = (await response.json()) as ParseResponse;

      if (!response.ok) {
        setError(data.error?.message ?? 'That search could not be understood.');
        return;
      }
      setParsed(data);
    } catch {
      setError('Could not reach the server.');
    } finally {
      setParsing(false);
    }
  }

  async function run() {
    if (!parsed) return;
    setRunning(true);
    setError(null);

    try {
      const response = await fetch('/api/search', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          rawQuery: text,
          query: parsed.query,
          // Echo the estimate we showed, so the server can refuse if it has
          // materially changed since.
          acknowledgedCostMicros: parsed.estimate.totalCostMicros,
        }),
      });
      const data = (await response.json()) as { searchJobId?: string; error?: { message: string } };

      if (!response.ok || !data.searchJobId) {
        setError(data.error?.message ?? 'The search could not be started.');
        return;
      }
      router.push(`/dashboard/jobs?highlight=${data.searchJobId}`);
    } catch {
      setError('Could not reach the server.');
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="space-y-4">
      <Card
        title="Describe the businesses you want to find"
        description="Plain English. LeadRadar turns it into filters you can check before anything runs."
      >
        <textarea
          value={text}
          onChange={(event) => setText(event.target.value)}
          rows={3}
          maxLength={1000}
          placeholder="Find dental clinics in Chennai with no website and more than 50 reviews"
          className="w-full resize-y rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2 text-sm outline-none focus:border-[var(--accent)]"
        />

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={parse}
            disabled={parsing || text.trim().length < 3}
            className="rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {parsing ? 'Reading…' : 'Preview filters and cost'}
          </button>
          <span className="text-xs text-[var(--muted)]">No searches run until you confirm.</span>
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          {EXAMPLES.map((example) => (
            <button
              key={example}
              type="button"
              onClick={() => setText(example)}
              className="rounded-full border border-[var(--border)] px-3 py-1 text-[11px] text-[var(--muted)] transition-colors hover:text-[var(--foreground)]"
            >
              {example}
            </button>
          ))}
        </div>
      </Card>

      {error && <Banner tone="warn">{error}</Banner>}

      {parsed && (
        <>
          <Card
            title="Interpreted filters"
            description="Check these before running. Anything wrong here is cheaper to fix now."
            actions={
              parsed.band !== 'accept' ? (
                <span className="rounded border border-[var(--grade-c)] px-2 py-0.5 text-[11px] text-[var(--grade-c)]">
                  Low confidence — review carefully
                </span>
              ) : undefined
            }
          >
            <dl className="grid gap-x-8 gap-y-3 sm:grid-cols-2">
              <Field label="Categories" value={parsed.query.categories.join(', ') || '—'} />
              <Field label="Locations" value={parsed.query.locations.join(', ') || '—'} />
              <Field
                label="Minimum rating"
                value={parsed.query.minimumRating?.toFixed(1) ?? 'Any'}
              />
              <Field
                label="Minimum reviews"
                value={parsed.query.minimumReviews?.toLocaleString('en-IN') ?? 'Any'}
              />
              <Field label="Website" value={websiteLabel(parsed.query.websiteStatus)} />
              <Field
                label="Chains"
                value={parsed.query.excludeChains ? 'Excluded' : 'Included'}
              />
            </dl>

            {parsed.unresolvedLocations.length > 0 && (
              <div className="mt-4">
                <Banner tone="warn">
                  Not yet supported and will be skipped:{' '}
                  <strong>{parsed.unresolvedLocations.join(', ')}</strong>. Available cities:{' '}
                  {parsed.knownCities.join(', ')}.
                </Banner>
              </div>
            )}
          </Card>

          <Card
            title="Estimated cost"
            description="Based on configurable funnel assumptions, not a guarantee. Actual spend is tracked per job."
          >
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <EstimateTile
                label="Businesses"
                value={parsed.estimate.estimatedBusinesses.toLocaleString('en-IN')}
                hint="before filtering"
              />
              <EstimateTile
                label="Qualified leads"
                value={parsed.estimate.estimatedQualifiedLeads.toLocaleString('en-IN')}
                hint="grade A/B expected"
              />
              <EstimateTile
                label="Total cost"
                value={formatMicros(parsed.estimate.totalCostMicros)}
                hint="all three providers"
              />
              <EstimateTile
                label="Per qualified lead"
                value={formatMicros(parsed.estimate.costPerQualifiedLeadMicros)}
                hint="the metric that matters"
              />
            </div>

            <div className="mt-4 grid gap-3 text-xs text-[var(--muted)] sm:grid-cols-3">
              <div>Google requests: {parsed.estimate.googleRequests.toLocaleString('en-IN')}</div>
              <div>Firecrawl credits: {parsed.estimate.firecrawlCredits.toLocaleString('en-IN')}</div>
              <div>Groq calls: {parsed.estimate.groqCalls.toLocaleString('en-IN')}</div>
            </div>

            <p className="mt-3 text-xs text-[var(--muted)]">
              Estimated duration: about{' '}
              {Math.max(1, Math.round(parsed.estimate.estimatedDurationSeconds / 60))} minute(s),
              limited by provider rate limits rather than compute.
            </p>

            {parsed.estimate.warnings.length > 0 && (
              <ul className="mt-4 space-y-2">
                {parsed.estimate.warnings.map((warning) => (
                  <li key={warning}>
                    <Banner tone="warn">{warning}</Banner>
                  </li>
                ))}
              </ul>
            )}

            <div className="mt-5 flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={run}
                disabled={running}
                className="rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
              >
                {running ? 'Starting…' : 'Run search'}
              </button>
              <span className="text-xs text-[var(--muted)]">
                Runs in the background; you can leave this page.
              </span>
            </div>
          </Card>
        </>
      )}
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[11px] font-medium uppercase tracking-wide text-[var(--muted)]">
        {label}
      </dt>
      <dd className="mt-0.5 text-sm">{value}</dd>
    </div>
  );
}

function EstimateTile({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] px-4 py-3">
      <div className="text-[11px] font-medium uppercase tracking-wide text-[var(--muted)]">
        {label}
      </div>
      <div className="mt-1 text-lg font-semibold tabular-nums">{value}</div>
      <div className="mt-0.5 text-[11px] text-[var(--muted)]">{hint}</div>
    </div>
  );
}
