/**
 * Lead detail.
 *
 * Organised by DATA SOURCE rather than by topic. That is unusual for a detail page
 * and it is deliberate: the three sources carry different retention rules, different
 * export rules, and very different reliability. A salesperson needs to know that
 * "4.8 rating" came from Google under a retention limit while "verified website"
 * came from our own crawl and can be quoted freely.
 *
 * The score breakdown shows every contributing signal with its rationale, because a
 * grade nobody can interrogate is a grade nobody trusts.
 */
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { Card, GradeBadge, PresenceMeter, ProvenanceBadge, Stat, websiteLabel } from '@/components/ui/primitives';
import { getBusiness } from '@/modules/database/repositories';
import { requireTenant } from '@/modules/auth/tenant';
import { priorityLabel } from '@/modules/scoring/config';
import { isAppError } from '@/lib/errors';

interface ScoreSignalShape {
  key: string;
  label: string;
  points: number;
  factor: string;
  rationale: string;
  provenance: string;
}

interface EvidenceShape {
  field: string;
  matched: boolean;
  points: number;
  detail: string;
}

export default async function LeadDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // Server component, so this runs with the same tenant resolution as the API.
  const tenant = await requireTenant();

  let lead;
  try {
    lead = await getBusiness(tenant, id);
  } catch (error) {
    if (isAppError(error) && error.code === 'NOT_FOUND') notFound();
    throw error;
  }

  const score = lead.leadScores[0];
  const signals = (score?.breakdown ?? []) as unknown as ScoreSignalShape[];
  const verification = lead.verifications[0];
  const narrative = lead.aiAnalyses.find((analysis) => analysis.taskType === 'LEAD_NARRATIVE');

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link href="/dashboard/leads" className="text-xs text-[var(--muted)] hover:underline">
            ← All leads
          </Link>
          <h1 className="mt-1 flex flex-wrap items-center gap-2 text-xl font-semibold tracking-tight">
            {lead.displayName}
            <ProvenanceBadge provenance="GOOGLE_DERIVED" />
            {lead.isChain && (
              <span className="rounded border border-[var(--grade-c)] px-1.5 py-0.5 text-[10px] uppercase text-[var(--grade-c)]">
                Chain
              </span>
            )}
          </h1>
          <p className="mt-1 text-sm text-[var(--muted)]">
            {[lead.primaryCategory, lead.city, lead.state].filter(Boolean).join(' · ')}
          </p>
        </div>

        <div className="flex items-center gap-3">
          <GradeBadge priority={lead.leadPriority} />
          <div className="text-right">
            <div className="text-2xl font-semibold tabular-nums">{lead.opportunityScore ?? '—'}</div>
            <div className="text-[11px] text-[var(--muted)]">
              {lead.leadPriority ? `Grade ${priorityLabel(lead.leadPriority)}` : 'Not scored'}
            </div>
          </div>
        </div>
      </div>

      {narrative && (
        <Card
          title="Why this is a lead"
          description="Generated from LeadRadar's own signals. Display only — it never influences the score."
        >
          <p className="text-sm">{(narrative.result as { summary?: string }).summary ?? ''}</p>
        </Card>
      )}

      <div className="grid gap-4 lg:grid-cols-3">
        <Card
          title={
            <span className="flex items-center gap-2">
              Business identity <ProvenanceBadge provenance="GOOGLE_DERIVED" />
            </span>
          }
          description="From the Places API. Held under a retention limit and excluded from exports by default."
        >
          <dl className="space-y-2 text-sm">
            <Row label="Address" value={lead.formattedAddress} />
            <Row label="Phone" value={lead.phone} />
            <Row label="Rating" value={lead.rating?.toFixed(1) ?? null} />
            <Row label="Reviews" value={lead.reviewCount?.toLocaleString('en-IN') ?? null} />
            <Row label="Status" value={lead.businessStatus} />
            <Row label="Website listed" value={websiteLabel(lead.googleWebsiteStatus)} />
          </dl>
          <p className="mt-3 text-[10px] text-[var(--muted)]">Powered by Google</p>
        </Card>

        <Card
          title={
            <span className="flex items-center gap-2">
              Web presence <ProvenanceBadge provenance="PUBLIC_WEB" />
            </span>
          }
          description="Gathered by LeadRadar's own crawl of public pages."
        >
          <dl className="space-y-2 text-sm">
            <Row label="Verified website" value={lead.verifiedDomain} />
            <Row label="Status" value={websiteLabel(lead.independentWebsiteStatus)} />
            <Row label="Identity" value={lead.identityVerification} />
          </dl>

          {lead.socialProfiles.length > 0 && (
            <div className="mt-3">
              <div className="text-[11px] font-medium uppercase tracking-wide text-[var(--muted)]">
                Social profiles
              </div>
              <ul className="mt-1 space-y-1 text-xs">
                {lead.socialProfiles.map((profile) => (
                  <li key={profile.id} className="flex items-center justify-between gap-2">
                    <span>{profile.platform}</span>
                    <span className="text-[var(--muted)]">{profile.status.toLowerCase()}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Card>

        <Card
          title={
            <span className="flex items-center gap-2">
              Assessment <ProvenanceBadge provenance="APPLICATION_GENERATED" />
            </span>
          }
          description="Computed by LeadRadar from the signals on this page."
        >
          <div className="space-y-3">
            <div>
              <div className="text-[11px] font-medium uppercase tracking-wide text-[var(--muted)]">
                Digital presence
              </div>
              <div className="mt-1">
                <PresenceMeter level={lead.digitalPresence} />
              </div>
            </div>

            {score && (
              <div className="grid grid-cols-3 gap-2">
                <Stat label="Need" value={score.needFactor.toFixed(2)} />
                <Stat label="Value" value={score.valueFactor.toFixed(2)} />
                <Stat label="Reach" value={score.reachFactor.toFixed(2)} />
              </div>
            )}
            <p className="text-[11px] text-[var(--muted)]">
              Score is need × value × reach, so a near-zero factor dominates. A business with no way
              to contact it is not a strong lead however large the website gap.
            </p>
          </div>
        </Card>
      </div>

      {lead.recommendations.length > 0 && (
        <Card title="What to sell" description="Deterministic rules, ranked by fit and deal size.">
          <ul className="space-y-3">
            {lead.recommendations.map((rec) => (
              <li key={rec.id} className="rounded-lg border border-[var(--border)] px-4 py-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-sm font-medium">{rec.service.replace(/_/g, ' ')}</span>
                  <span className="text-xs tabular-nums text-[var(--muted)]">
                    strength {rec.strength}
                  </span>
                </div>
                <p className="mt-1 text-sm text-[var(--muted)]">{rec.reasons.at(-1)}</p>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {score && (
        <Card
          title="Score breakdown"
          description={`Every contributing signal. Signals version ${score.signalsVersion}.`}
        >
          <div className="table-scroll">
            <table className="w-full min-w-[720px] text-sm">
              <thead>
                <tr className="border-b border-[var(--border)] text-left text-[11px] uppercase tracking-wide text-[var(--muted)]">
                  <th className="px-2 py-2 font-medium">Signal</th>
                  <th className="px-2 py-2 font-medium">Factor</th>
                  <th className="px-2 py-2 font-medium">Points</th>
                  <th className="px-2 py-2 font-medium">Why</th>
                  <th className="px-2 py-2 font-medium">Source</th>
                </tr>
              </thead>
              <tbody>
                {signals.map((signal) => (
                  <tr key={signal.key} className="border-b border-[var(--border)] last:border-0">
                    <td className="px-2 py-2">{signal.label}</td>
                    <td className="px-2 py-2 text-[var(--muted)]">{signal.factor}</td>
                    <td className="px-2 py-2 tabular-nums">
                      {signal.points > 0 ? `+${signal.points}` : signal.points}
                    </td>
                    <td className="px-2 py-2 text-xs text-[var(--muted)]">{signal.rationale}</td>
                    <td className="px-2 py-2">
                      <ProvenanceBadge provenance={signal.provenance} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {score.appliedCaps.length > 0 && (
            <div className="mt-4 rounded-lg border border-[var(--grade-c)] px-4 py-3">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-[var(--grade-c)]">
                Caps applied
              </div>
              <ul className="mt-1 space-y-1 text-xs text-[var(--muted)]">
                {score.appliedCaps.map((cap) => (
                  <li key={cap}>{cap}</li>
                ))}
              </ul>
            </div>
          )}
        </Card>
      )}

      {verification && (
        <Card
          title="Website verification evidence"
          description={`${verification.status} at ${(verification.confidence * 100).toFixed(0)}% confidence · rule score ${verification.deterministicScore}/100${verification.usedAi ? ' · AI adjudicated' : ' · rules only'}`}
        >
          <ul className="space-y-2 text-sm">
            {((verification.evidence ?? []) as unknown as EvidenceShape[]).map((item, index) => (
              <li key={`${item.field}-${index}`} className="flex flex-wrap items-baseline gap-2">
                <span
                  className="w-16 shrink-0 text-[11px] uppercase tracking-wide"
                  style={{ color: item.matched ? 'var(--grade-a)' : 'var(--muted)' }}
                >
                  {item.field}
                </span>
                <span className="tabular-nums text-xs text-[var(--muted)]">
                  {item.points > 0 ? `+${item.points}` : item.points}
                </span>
                <span className="text-xs">{item.detail}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {lead.websiteCandidates.length > 0 && (
        <Card
          title="Website candidates considered"
          description="Every domain examined, including the ones rejected. Rejections matter as much as matches."
        >
          <ul className="space-y-2 text-sm">
            {lead.websiteCandidates.map((candidate) => (
              <li
                key={candidate.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[var(--border)] px-3 py-2"
              >
                <span className="font-mono text-xs">{candidate.domain}</span>
                <span className="flex items-center gap-2 text-[11px] text-[var(--muted)]">
                  {candidate.isThirdPartyListing && (
                    <span className="text-[var(--grade-c)]">directory listing</span>
                  )}
                  <span>{candidate.source.replace(/_/g, ' ').toLowerCase()}</span>
                  <span>{candidate.status.toLowerCase()}</span>
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-[11px] font-medium uppercase tracking-wide text-[var(--muted)]">{label}</dt>
      <dd className="text-right">{value ?? '—'}</dd>
    </div>
  );
}
