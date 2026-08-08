'use client';

/**
 * Lead table.
 *
 * Sorted by opportunity score descending by default, because that is the only
 * ordering an agency actually works: the list is a call queue, not a database
 * browser.
 *
 * The "Why" column carries the generated pitch. It is the most valuable cell in
 * the table — a score tells someone which lead to call, the pitch tells them what
 * to say — so it gets real width rather than being hidden behind a detail click.
 */
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';

import {
  ConfidencePill,
  EmptyState,
  GradeBadge,
  PresenceMeter,
  websiteLabel,
} from '@/components/ui/primitives';

interface LeadRow {
  id: string;
  displayName: string;
  primaryCategory: string | null;
  city: string | null;
  rating: number | null;
  reviewCount: number | null;
  phone: string | null;
  googleWebsiteStatus: string;
  independentWebsiteStatus: string;
  verifiedDomain: string | null;
  digitalPresence: string | null;
  opportunityScore: number | null;
  leadPriority: string | null;
  priorityLabel: string | null;
  identityVerification: string;
  isChain: boolean;
  recommendedServices: string[];
  topPitch: string | null;
  verificationConfidence: number | null;
  socialPlatforms: string[];
}

interface LeadsResponse {
  rows: LeadRow[];
  total: number;
  page: number;
  pageCount: number;
}

const SORTABLE = [
  { key: 'opportunityScore', label: 'Score' },
  { key: 'reviewCount', label: 'Reviews' },
  { key: 'rating', label: 'Rating' },
  { key: 'displayName', label: 'Name' },
] as const;

const PRIORITIES = ['A_PLUS', 'A', 'B', 'C', 'D'];
const WEBSITE_FILTERS = [
  { value: 'GOOGLE_WEBSITE_NOT_LISTED', label: 'No website listed' },
  { value: 'GOOGLE_WEBSITE_IS_THIRD_PARTY_LISTING', label: 'Directory only' },
  { value: 'GOOGLE_WEBSITE_PRESENT', label: 'Has a website' },
];

export function LeadTable({ searchJobId }: { searchJobId?: string }) {
  const [data, setData] = useState<LeadsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [sortBy, setSortBy] = useState<string>('opportunityScore');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [priority, setPriority] = useState<string[]>([]);
  const [website, setWebsite] = useState<string[]>([]);
  const [excludeChains, setExcludeChains] = useState(false);
  const [search, setSearch] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    const params = new URLSearchParams({ page: String(page), pageSize: '50', sortBy, sortDir });

    if (priority.length > 0) params.set('priority', priority.join(','));
    if (website.length > 0) params.set('googleWebsiteStatus', website.join(','));
    if (excludeChains) params.set('excludeChains', 'true');
    if (search.trim() !== '') params.set('search', search.trim());
    if (searchJobId) params.set('searchJobId', searchJobId);

    try {
      const response = await fetch(`/api/leads?${params.toString()}`);
      if (response.ok) setData((await response.json()) as LeadsResponse);
    } finally {
      setLoading(false);
    }
  }, [page, sortBy, sortDir, priority, website, excludeChains, search, searchJobId]);

  useEffect(() => {
    // Debounced so typing in the search box does not fire a request per keystroke.
    const timer = setTimeout(() => void load(), 250);
    return () => clearTimeout(timer);
  }, [load]);

  function toggle(list: string[], value: string, setter: (next: string[]) => void) {
    setter(list.includes(value) ? list.filter((entry) => entry !== value) : [...list, value]);
    setPage(1);
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={search}
          onChange={(event) => {
            setSearch(event.target.value);
            setPage(1);
          }}
          placeholder="Filter by name…"
          className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-sm outline-none focus:border-[var(--accent)]"
        />

        <div className="flex items-center gap-1">
          {PRIORITIES.map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => toggle(priority, value, setPriority)}
              aria-pressed={priority.includes(value)}
              className={`rounded-md border px-2 py-1 text-xs ${
                priority.includes(value)
                  ? 'border-[var(--accent)] text-[var(--accent)]'
                  : 'border-[var(--border)] text-[var(--muted)]'
              }`}
            >
              {value === 'A_PLUS' ? 'A+' : value}
            </button>
          ))}
        </div>

        {WEBSITE_FILTERS.map((filter) => (
          <button
            key={filter.value}
            type="button"
            onClick={() => toggle(website, filter.value, setWebsite)}
            aria-pressed={website.includes(filter.value)}
            className={`rounded-md border px-2 py-1 text-xs ${
              website.includes(filter.value)
                ? 'border-[var(--accent)] text-[var(--accent)]'
                : 'border-[var(--border)] text-[var(--muted)]'
            }`}
          >
            {filter.label}
          </button>
        ))}

        <label className="flex items-center gap-1.5 text-xs text-[var(--muted)]">
          <input
            type="checkbox"
            checked={excludeChains}
            onChange={(event) => {
              setExcludeChains(event.target.checked);
              setPage(1);
            }}
          />
          Hide chains
        </label>

        <span className="ml-auto text-xs text-[var(--muted)]">
          {data ? `${data.total.toLocaleString('en-IN')} leads` : ''}
        </span>
      </div>

      {loading && !data ? (
        <EmptyState title="Loading leads…" />
      ) : !data || data.rows.length === 0 ? (
        <EmptyState
          title="No leads yet"
          hint="Run a search to discover businesses, or relax the filters above."
        />
      ) : (
        <div className="table-scroll rounded-xl border border-[var(--border)] bg-[var(--surface)]">
          <table className="w-full min-w-[1100px] text-sm">
            <thead>
              <tr className="border-b border-[var(--border)] text-left text-[11px] uppercase tracking-wide text-[var(--muted)]">
                <Th>Business</Th>
                <Th>City</Th>
                {SORTABLE.filter((column) => column.key !== 'displayName').map((column) => (
                  <th key={column.key} className="px-3 py-2 font-medium">
                    <button
                      type="button"
                      onClick={() => {
                        if (sortBy === column.key) {
                          setSortDir(sortDir === 'desc' ? 'asc' : 'desc');
                        } else {
                          setSortBy(column.key);
                          setSortDir('desc');
                        }
                      }}
                      className="inline-flex items-center gap-1 uppercase"
                    >
                      {column.label}
                      {sortBy === column.key && <span>{sortDir === 'desc' ? '↓' : '↑'}</span>}
                    </button>
                  </th>
                ))}
                <Th>Website</Th>
                <Th>Presence</Th>
                <Th>Grade</Th>
                <Th>Confidence</Th>
                <Th>Why this lead</Th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((row) => (
                <tr
                  key={row.id}
                  className="border-b border-[var(--border)] last:border-0 hover:bg-[var(--surface-muted)]"
                >
                  <td className="px-3 py-2">
                    <Link href={`/dashboard/leads/${row.id}`} className="font-medium hover:underline">
                      {row.displayName}
                    </Link>
                    <div className="text-[11px] text-[var(--muted)]">
                      {row.primaryCategory ?? '—'}
                      {row.isChain && (
                        <span className="ml-1 text-[var(--grade-c)]" title="Chain or franchise: decisions are made at head office">
                          · chain
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-[var(--muted)]">{row.city ?? '—'}</td>
                  <td className="px-3 py-2 tabular-nums">
                    {row.reviewCount?.toLocaleString('en-IN') ?? '—'}
                  </td>
                  <td className="px-3 py-2 tabular-nums">{row.rating?.toFixed(1) ?? '—'}</td>
                  <td className="px-3 py-2">
                    <div>{websiteLabel(row.independentWebsiteStatus)}</div>
                    {row.verifiedDomain && (
                      <div className="text-[11px] text-[var(--muted)]">{row.verifiedDomain}</div>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <PresenceMeter level={row.digitalPresence} />
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-2">
                      <GradeBadge priority={row.leadPriority} />
                      <span className="tabular-nums text-[var(--muted)]">
                        {row.opportunityScore ?? '—'}
                      </span>
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    <ConfidencePill value={row.verificationConfidence} />
                  </td>
                  <td className="max-w-[26rem] px-3 py-2 text-xs text-[var(--muted)]">
                    {row.topPitch ?? '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {data && data.pageCount > 1 && (
        <div className="flex items-center justify-between text-xs">
          <button
            type="button"
            onClick={() => setPage((current) => Math.max(1, current - 1))}
            disabled={page <= 1}
            className="rounded-md border border-[var(--border)] px-3 py-1 disabled:opacity-40"
          >
            Previous
          </button>
          <span className="text-[var(--muted)]">
            Page {data.page} of {data.pageCount}
          </span>
          <button
            type="button"
            onClick={() => setPage((current) => Math.min(data.pageCount, current + 1))}
            disabled={page >= data.pageCount}
            className="rounded-md border border-[var(--border)] px-3 py-1 disabled:opacity-40"
          >
            Next
          </button>
        </div>
      )}
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return <th className="px-3 py-2 font-medium">{children}</th>;
}
