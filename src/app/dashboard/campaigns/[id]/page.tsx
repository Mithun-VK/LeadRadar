import Link from 'next/link';
import { notFound } from 'next/navigation';

import { Banner, Card, EmptyState, GradeBadge, Stat } from '@/components/ui/primitives';
import { currentSession } from '@/modules/auth/session';
import { db } from '@/modules/database/client';
import {
  SKIP_REASON_LABELS,
  assessReadiness,
  campaignStats,
  requireCampaign,
} from '@/modules/email/campaigns';
import { providers } from '@/modules/providers/registry';

import { CampaignControls } from './controls';

export const dynamic = 'force-dynamic';

export default async function CampaignDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await currentSession();
  const tenant = { organizationId: session!.organizationId, userId: session!.userId };

  let campaign;
  try {
    campaign = await requireCampaign(tenant, id);
  } catch {
    notFound();
  }

  const [readiness, stats, leads] = await Promise.all([
    assessReadiness(tenant, campaign.id),
    campaignStats(campaign.id),
    db().campaignLead.findMany({
      where: { campaignId: campaign.id },
      orderBy: [{ status: 'asc' }, { enrolledAt: 'asc' }],
      take: 100,
      include: {
        business: {
          select: {
            id: true,
            displayName: true,
            city: true,
            opportunityScore: true,
            leadPriority: true,
          },
        },
      },
    }),
  ]);

  const registry = providers();
  const deliverable = leads.filter((lead) => lead.status !== 'SKIPPED');
  const skipped = leads.filter((lead) => lead.status === 'SKIPPED');
  const preview = deliverable.find((lead) => lead.previewBody);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link href="/dashboard/campaigns" className="text-xs text-[var(--muted)] hover:underline">
            ← Campaigns
          </Link>
          <h1 className="mt-1 text-lg font-semibold tracking-tight">{campaign.name}</h1>
          <p className="mt-1 text-sm text-[var(--muted)]">
            {campaign.status} · {campaign.dailyLimit}/day · {Math.round(campaign.delaySeconds / 60)}{' '}
            min apart
            {campaign.gmailAccount && <> · from {campaign.gmailAccount.emailAddress}</>}
          </p>
        </div>

        <CampaignControls
          campaignId={campaign.id}
          status={campaign.status}
          ready={readiness.ready}
          deliverableCount={readiness.deliverableCount}
          mocked={registry.email?.isMock ?? false}
        />
      </div>

      {registry.email?.isMock && (
        <Banner tone="warn">
          Mock mode: activating this campaign exercises the entire pipeline, and every message is
          handled by an in-process sender that reaches nobody.
        </Banner>
      )}

      {readiness.blockers.length > 0 && (
        <Banner tone="warn">
          <strong>Not ready to send.</strong>
          <ul className="mt-1 list-disc space-y-0.5 pl-4">
            {readiness.blockers.map((blocker) => (
              <li key={blocker}>{blocker}</li>
            ))}
          </ul>
        </Banner>
      )}

      {readiness.warnings.length > 0 && (
        <Banner>
          <ul className="list-disc space-y-0.5 pl-4">
            {readiness.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </Banner>
      )}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <Stat label="Will send to" value={readiness.deliverableCount} />
        <Stat label="Sent" value={stats.messages.SENT ?? 0} />
        <Stat label="Failed" value={(stats.messages.FAILED ?? 0) + (stats.messages.BOUNCED ?? 0)} />
        <Stat label="Unsubscribed" value={stats.messages.UNSUBSCRIBED ?? 0} />
        <Stat label="Skipped" value={readiness.skippedCount} hint="Leads that cannot be emailed" />
      </div>

      {readiness.estimatedDays > 1 && campaign.status !== 'COMPLETED' && (
        <p className="text-xs text-[var(--muted)]">
          At {campaign.dailyLimit} per day this campaign will take about {readiness.estimatedDays}{' '}
          day(s) to finish.
        </p>
      )}

      {preview?.previewBody && (
        <Card
          title="What will actually be sent"
          description={`Rendered for ${preview.business.displayName}. Every lead gets its own version.`}
        >
          <div className="rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] p-4">
            <p className="text-xs text-[var(--muted)]">To: {preview.resolvedEmail}</p>
            <p className="mt-1 text-sm font-medium">{preview.previewSubject}</p>
            <pre className="mt-3 whitespace-pre-wrap font-sans text-sm leading-relaxed">
              {preview.previewBody}
            </pre>
          </div>
          <p className="mt-3 text-[11px] text-[var(--muted)]">
            An unsubscribe link is appended to every message automatically, and the standard
            unsubscribe headers are set so mail clients show a one-click opt-out.
          </p>
        </Card>
      )}

      <Card title={`Leads (${deliverable.length} deliverable)`}>
        {deliverable.length === 0 ? (
          <EmptyState title="No deliverable leads" hint="Add leads that have a contact address." />
        ) : (
          <div className="table-scroll">
            <table className="w-full min-w-[800px] text-sm">
              <thead>
                <tr className="border-b border-[var(--border)] text-left text-[11px] uppercase tracking-wide text-[var(--muted)]">
                  <th className="px-3 py-2 font-medium">Business</th>
                  <th className="px-3 py-2 font-medium">City</th>
                  <th className="px-3 py-2 font-medium">Grade</th>
                  <th className="px-3 py-2 font-medium">Email</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                  <th className="px-3 py-2 font-medium">Sent</th>
                </tr>
              </thead>
              <tbody>
                {deliverable.map((lead) => (
                  <tr key={lead.id} className="border-b border-[var(--border)] last:border-0">
                    <td className="px-3 py-2">
                      <Link
                        href={`/dashboard/leads/${lead.businessId}`}
                        className="hover:underline"
                      >
                        {lead.business.displayName}
                      </Link>
                    </td>
                    <td className="px-3 py-2 text-[var(--muted)]">{lead.business.city ?? '—'}</td>
                    <td className="px-3 py-2">
                      <GradeBadge priority={lead.business.leadPriority} />
                    </td>
                    <td className="px-3 py-2 text-xs">{lead.resolvedEmail ?? '—'}</td>
                    <td className="px-3 py-2 text-xs">{lead.status}</td>
                    <td className="px-3 py-2 text-[11px] text-[var(--muted)]">
                      {lead.sentAt?.toLocaleString('en-IN') ?? '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {skipped.length > 0 && (
        <Card
          title={`Skipped (${skipped.length})`}
          description="These leads will not be emailed, and why."
        >
          <div className="table-scroll">
            <table className="w-full text-sm">
              <tbody>
                {skipped.map((lead) => (
                  <tr key={lead.id} className="border-b border-[var(--border)] last:border-0">
                    <td className="px-3 py-2">{lead.business.displayName}</td>
                    <td className="px-3 py-2 text-xs text-[var(--muted)]">
                      {lead.skipReason
                        ? (SKIP_REASON_LABELS[lead.skipReason as keyof typeof SKIP_REASON_LABELS] ??
                          lead.skipReason)
                        : 'Not eligible'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}
