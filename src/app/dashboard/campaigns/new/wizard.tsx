'use client';

/**
 * Campaign builder.
 *
 * Two steps rather than the usual nine: name and pace, then who to target. The
 * review step deliberately lives on the campaign's own page instead of here,
 * because reviewing rendered emails is not a step in a creation flow — it is
 * something an operator should be able to come back to, share, and think about
 * before committing. A wizard that ends in "Activate" invites clicking through.
 */
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { api } from '@/lib/api-client';
import { Card } from '@/components/ui/primitives';

interface Template {
  id: string;
  name: string;
  subject: string;
  body: string;
}

interface Defaults {
  senderName: string;
  companyName: string;
  dailyLimit: number;
  delaySeconds: number;
  useAiPersonalization: boolean;
}

interface Limits {
  minDelaySeconds: number;
  maxDailyLimit: number;
}

interface EnrolSummary {
  requested: number;
  enrolled: number;
  skipped: number;
  skipReasons: Record<string, number>;
}

const SKIP_LABELS: Record<string, string> = {
  NO_EMAIL: 'no email address found',
  INVALID_EMAIL: 'address not usable',
  SUPPRESSED: 'on your suppression list',
  ALREADY_CONTACTED: 'already contacted by another campaign',
  TEMPLATE_INCOMPLETE: 'template needs details this lead lacks',
};

export function CampaignWizard({
  templates,
  defaults,
  limits,
}: {
  templates: Template[];
  defaults: Defaults;
  limits: Limits;
}) {
  const router = useRouter();

  const [step, setStep] = useState<1 | 2>(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [campaignId, setCampaignId] = useState<string | null>(null);
  const [summary, setSummary] = useState<EnrolSummary | null>(null);

  const [name, setName] = useState('');
  const [templateId, setTemplateId] = useState(templates[0]?.id ?? '');
  const [senderName, setSenderName] = useState(defaults.senderName);
  const [companyName, setCompanyName] = useState(defaults.companyName);
  const [dailyLimit, setDailyLimit] = useState(defaults.dailyLimit);
  const [delayMinutes, setDelayMinutes] = useState(Math.round(defaults.delaySeconds / 60));
  const [useAi, setUseAi] = useState(defaults.useAiPersonalization);

  // Targeting
  const [minScore, setMinScore] = useState(60);
  const [maxWebsiteScore, setMaxWebsiteScore] = useState(100);
  const [limit, setLimit] = useState(100);

  async function createCampaign(): Promise<void> {
    setBusy(true);
    setError(null);

    const response = await api.post<{ id: string }>('/api/campaigns', {
      name: name.trim(),
      templateId,
      senderName: senderName.trim(),
      companyName: companyName.trim(),
      dailyLimit,
      delaySeconds: Math.max(limits.minDelaySeconds, delayMinutes * 60),
      useAiPersonalization: useAi,
    });

    if (response.ok && response.data) {
      setCampaignId(response.data.id);
      setStep(2);
    } else {
      setError(response.error?.message ?? 'Could not create the campaign.');
    }

    setBusy(false);
  }

  async function addLeads(): Promise<void> {
    if (!campaignId) return;
    setBusy(true);
    setError(null);

    const response = await api.post<EnrolSummary>(`/api/campaigns/${campaignId}/leads`, {
      filters: {
        minScore,
        maxWebsiteScore: maxWebsiteScore < 100 ? maxWebsiteScore : undefined,
        hasEmail: true,
      },
      limit,
    });

    if (response.ok && response.data) setSummary(response.data);
    else setError(response.error?.message ?? 'Could not add leads.');

    setBusy(false);
  }

  return (
    <div className="space-y-5">
      <ol className="flex gap-4 text-xs">
        <Step index={1} current={step} label="Campaign details" />
        <Step index={2} current={step} label="Select leads" />
      </ol>

      {error && (
        <div
          className="rounded-lg border border-[var(--grade-d)] px-4 py-3 text-sm text-[var(--grade-d)]"
          role="alert"
        >
          {error}
        </div>
      )}

      {step === 1 && (
        <Card title="Campaign details">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Campaign name">
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Chennai dental clinics — Q3"
                className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-sm outline-none focus:border-[var(--accent)]"
              />
            </Field>

            <Field label="Template">
              <select
                value={templateId}
                onChange={(event) => setTemplateId(event.target.value)}
                className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-sm"
              >
                {templates.map((template) => (
                  <option key={template.id} value={template.id}>
                    {template.name}
                  </option>
                ))}
              </select>
            </Field>

            <Field label="Your name" hint="Appears as the sender and in {{sender_name}}.">
              <input
                value={senderName}
                onChange={(event) => setSenderName(event.target.value)}
                className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-sm"
              />
            </Field>

            <Field label="Company name" hint="An outreach email must identify who is writing.">
              <input
                value={companyName}
                onChange={(event) => setCompanyName(event.target.value)}
                className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-sm"
              />
            </Field>

            <Field
              label="Emails per day"
              hint={`Server ceiling is ${limits.maxDailyLimit}. Personal Gmail accounts get rate limited well before a few hundred.`}
            >
              <input
                type="number"
                min={1}
                max={500}
                value={dailyLimit}
                onChange={(event) => setDailyLimit(Number(event.target.value))}
                className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-sm tabular-nums"
              />
            </Field>

            <Field
              label="Minutes between emails"
              hint={`Minimum ${Math.ceil(limits.minDelaySeconds / 60)}. A burst of identical messages reads as spam.`}
            >
              <input
                type="number"
                min={Math.ceil(limits.minDelaySeconds / 60)}
                max={1440}
                value={delayMinutes}
                onChange={(event) => setDelayMinutes(Number(event.target.value))}
                className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-sm tabular-nums"
              />
            </Field>
          </div>

          <label className="mt-4 flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              checked={useAi}
              onChange={(event) => setUseAi(event.target.checked)}
              className="mt-1"
            />
            <span>
              Let AI rephrase the opening line
              <span className="mt-0.5 block text-[11px] text-[var(--muted)]">
                The observation itself always comes from what was measured on the site. The model
                may only reword it, and any rephrasing that introduces a fact it was not given is
                discarded.
              </span>
            </span>
          </label>

          <div className="mt-5 flex justify-end">
            <button
              type="button"
              disabled={busy || name.trim() === '' || templateId === ''}
              onClick={() => void createCampaign()}
              className="rounded-lg bg-[var(--accent)] px-4 py-1.5 text-sm font-medium text-white disabled:opacity-50"
            >
              {busy ? 'Creating…' : 'Continue'}
            </button>
          </div>
        </Card>
      )}

      {step === 2 && (
        <Card
          title="Select leads"
          description="Only leads with a contact address are enrolled; the rest are listed with a reason."
        >
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Minimum lead score" hint="0–100. Higher means a better prospect.">
              <input
                type="number"
                min={0}
                max={100}
                value={minScore}
                onChange={(event) => setMinScore(Number(event.target.value))}
                className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-sm tabular-nums"
              />
            </Field>

            <Field
              label="Maximum website score"
              hint="Lower means a weaker site — more to talk about. 100 includes everyone."
            >
              <input
                type="number"
                min={0}
                max={100}
                value={maxWebsiteScore}
                onChange={(event) => setMaxWebsiteScore(Number(event.target.value))}
                className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-sm tabular-nums"
              />
            </Field>

            <Field label="How many leads" hint="Capped at 1,000 so the campaign stays reviewable.">
              <input
                type="number"
                min={1}
                max={1000}
                value={limit}
                onChange={(event) => setLimit(Number(event.target.value))}
                className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-sm tabular-nums"
              />
            </Field>
          </div>

          {summary && (
            <div className="mt-4 rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] px-4 py-3 text-sm">
              <p>
                <strong>{summary.enrolled}</strong> lead(s) enrolled
                {summary.skipped > 0 && <> · {summary.skipped} skipped</>}
              </p>
              {Object.entries(summary.skipReasons).length > 0 && (
                <ul className="mt-2 space-y-0.5 text-[11px] text-[var(--muted)]">
                  {Object.entries(summary.skipReasons).map(([reason, count]) => (
                    <li key={reason}>
                      {count} — {SKIP_LABELS[reason] ?? reason}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          <div className="mt-5 flex flex-wrap justify-end gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => void addLeads()}
              className="rounded-lg border border-[var(--border)] px-4 py-1.5 text-sm disabled:opacity-50"
            >
              {busy ? 'Adding…' : summary ? 'Add more' : 'Add leads'}
            </button>

            <button
              type="button"
              disabled={!campaignId}
              onClick={() => router.push(`/dashboard/campaigns/${campaignId}`)}
              className="rounded-lg bg-[var(--accent)] px-4 py-1.5 text-sm font-medium text-white disabled:opacity-50"
            >
              Review the emails
            </button>
          </div>

          <p className="mt-3 text-[11px] text-[var(--muted)]">
            The campaign is still a draft. Nothing sends until you review the generated emails and
            activate it on the next screen.
          </p>
        </Card>
      )}
    </div>
  );
}

function Step({ index, current, label }: { index: number; current: number; label: string }) {
  const active = current === index;
  const done = current > index;

  return (
    <li className="flex items-center gap-2">
      <span
        className="flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-bold"
        style={{
          backgroundColor: active || done ? 'var(--accent)' : 'var(--border)',
          color: active || done ? 'white' : 'var(--muted)',
        }}
      >
        {index}
      </span>
      <span className={active ? 'font-medium' : 'text-[var(--muted)]'}>{label}</span>
    </li>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="text-[11px] font-medium uppercase tracking-wide text-[var(--muted)]">
        {label}
      </span>
      <div className="mt-1">{children}</div>
      {hint && <span className="mt-1 block text-[11px] text-[var(--muted)]">{hint}</span>}
    </label>
  );
}
