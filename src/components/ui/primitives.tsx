/**
 * UI primitives.
 *
 * Small and local rather than a component library: this dashboard needs a handful
 * of consistent pieces, and the interesting design decisions are in the badges —
 * grade and provenance — which are product-specific and could not be imported
 * from anywhere.
 */
import type { ReactNode } from 'react';

import { cn } from '@/lib/cn';

export function Card({
  children,
  className,
  title,
  description,
  actions,
}: {
  children?: ReactNode;
  className?: string;
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <section
      className={cn(
        'rounded-xl border border-[var(--border)] bg-[var(--surface)] shadow-sm',
        className,
      )}
    >
      {(title || actions) && (
        <header className="flex flex-wrap items-start justify-between gap-3 border-b border-[var(--border)] px-5 py-4">
          <div>
            {title && <h2 className="text-sm font-semibold tracking-tight">{title}</h2>}
            {description && (
              <p className="mt-1 text-xs text-[var(--muted)]">{description}</p>
            )}
          </div>
          {actions}
        </header>
      )}
      <div className="px-5 py-4">{children}</div>
    </section>
  );
}

const GRADE_STYLES: Record<string, { bg: string; label: string }> = {
  A_PLUS: { bg: 'var(--grade-a-plus)', label: 'A+' },
  A: { bg: 'var(--grade-a)', label: 'A' },
  B: { bg: 'var(--grade-b)', label: 'B' },
  C: { bg: 'var(--grade-c)', label: 'C' },
  D: { bg: 'var(--grade-d)', label: 'D' },
};

/** Grade badge. Colour is a secondary cue; the letter is always present. */
export function GradeBadge({ priority }: { priority: string | null }) {
  if (!priority) {
    return <span className="text-xs text-[var(--muted)]">—</span>;
  }
  const style = GRADE_STYLES[priority] ?? { bg: 'var(--grade-d)', label: priority };

  return (
    <span
      className="inline-flex min-w-8 items-center justify-center rounded-md px-2 py-0.5 text-xs font-bold text-white"
      style={{ backgroundColor: style.bg }}
    >
      {style.label}
    </span>
  );
}

const PROVENANCE_LABELS: Record<string, { label: string; color: string; title: string }> = {
  GOOGLE_DERIVED: {
    label: 'Google',
    color: 'var(--provenance-google)',
    title:
      'From the Google Places API. Held under a retention limit and excluded from exports by default.',
  },
  PLACE_IDENTIFIER: {
    label: 'Place ID',
    color: 'var(--provenance-google)',
    title: 'A Google Place ID, which provider terms permit storing indefinitely.',
  },
  PUBLIC_WEB: {
    label: 'Public web',
    color: 'var(--provenance-web)',
    title: "Gathered by LeadRadar's own crawl of the business's public website.",
  },
  APPLICATION_GENERATED: {
    label: 'LeadRadar',
    color: 'var(--provenance-derived)',
    title: 'Computed by LeadRadar from the signals above.',
  },
};

/**
 * Provenance label.
 *
 * Present wherever data is shown, because the three sources carry different
 * retention and export rules, and a user who cannot tell them apart cannot use the
 * product safely.
 */
export function ProvenanceBadge({ provenance }: { provenance: string }) {
  const spec = PROVENANCE_LABELS[provenance];
  if (!spec) return null;

  return (
    <span
      className="inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide"
      style={{ color: spec.color, borderColor: spec.color }}
      title={spec.title}
    >
      {spec.label}
    </span>
  );
}

const PRESENCE_ORDER = ['MINIMAL', 'WEAK', 'MODERATE', 'GOOD', 'EXCELLENT'];

/**
 * Digital presence as a five-step meter.
 *
 * Low presence is the opportunity, so the meter is not coloured as "bad" — it
 * simply shows position on a scale.
 */
export function PresenceMeter({ level }: { level: string | null }) {
  if (!level) return <span className="text-xs text-[var(--muted)]">—</span>;
  const index = PRESENCE_ORDER.indexOf(level);

  return (
    <span className="inline-flex items-center gap-1.5" title={`Digital presence: ${level}`}>
      <span className="flex gap-0.5" aria-hidden>
        {PRESENCE_ORDER.map((_, position) => (
          <span
            key={position}
            className="h-3 w-1 rounded-sm"
            style={{
              backgroundColor:
                position <= index ? 'var(--accent)' : 'var(--border)',
            }}
          />
        ))}
      </span>
      <span className="text-xs capitalize">{level.toLowerCase()}</span>
    </span>
  );
}

const WEBSITE_LABELS: Record<string, string> = {
  GOOGLE_WEBSITE_PRESENT: 'Listed on Google',
  GOOGLE_WEBSITE_NOT_LISTED: 'None listed',
  GOOGLE_WEBSITE_IS_THIRD_PARTY_LISTING: 'Directory listing only',
  NOT_CHECKED: 'Not checked',
  INDEPENDENT_WEBSITE_FOUND: 'Verified',
  NO_INDEPENDENT_WEBSITE_FOUND: 'None found',
  WEBSITE_UNVERIFIED: 'Unverified',
  WEBSITE_BROKEN: 'Broken',
  WEBSITE_MISMATCH: 'Mismatch',
};

export function websiteLabel(status: string | null): string {
  if (!status) return '—';
  return WEBSITE_LABELS[status] ?? status;
}

/** Verification confidence, shown as a level rather than a bare number. */
export function ConfidencePill({ value }: { value: number | null }) {
  if (value === null) return <span className="text-xs text-[var(--muted)]">—</span>;

  // Bands mirror the AI confidence routing, so the UI and the pipeline agree on
  // what "confident" means.
  const band = value >= 0.9 ? 'High' : value >= 0.7 ? 'Medium' : 'Low';

  return (
    <span
      className="inline-flex items-center gap-1 text-xs"
      title={`Confidence ${(value * 100).toFixed(0)}%`}
    >
      <span className="font-medium">{band}</span>
      <span className="text-[var(--muted)]">{(value * 100).toFixed(0)}%</span>
    </span>
  );
}

export function Stat({
  label,
  value,
  hint,
}: {
  label: string;
  value: ReactNode;
  hint?: string;
}) {
  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] px-4 py-3">
      <div className="text-[11px] font-medium uppercase tracking-wide text-[var(--muted)]">
        {label}
      </div>
      <div className="mt-1 text-lg font-semibold tabular-nums">{value}</div>
      {hint && <div className="mt-0.5 text-[11px] text-[var(--muted)]">{hint}</div>}
    </div>
  );
}

export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="rounded-lg border border-dashed border-[var(--border)] px-6 py-12 text-center">
      <p className="text-sm font-medium">{title}</p>
      {hint && <p className="mt-1 text-xs text-[var(--muted)]">{hint}</p>}
    </div>
  );
}

export function Banner({
  tone = 'info',
  children,
}: {
  tone?: 'info' | 'warn';
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        'rounded-lg border px-4 py-3 text-xs',
        tone === 'warn'
          ? 'border-[var(--grade-c)] text-[var(--grade-c)]'
          : 'border-[var(--border)] bg-[var(--accent-soft)] text-[var(--foreground)]',
      )}
      role={tone === 'warn' ? 'alert' : undefined}
    >
      {children}
    </div>
  );
}
