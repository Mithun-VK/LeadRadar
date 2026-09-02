import { redirect } from 'next/navigation';

import { Banner, Card } from '@/components/ui/primitives';
import { env } from '@/lib/env';
import { currentSession } from '@/modules/auth/session';
import { db } from '@/modules/database/client';

import { CampaignWizard } from './wizard';

export const metadata = { title: 'New campaign — LeadRadar' };
export const dynamic = 'force-dynamic';

export default async function NewCampaignPage() {
  const session = await currentSession();
  if (!session) redirect('/login?next=/dashboard/campaigns/new');

  const tenant = { organizationId: session.organizationId };
  const config = env();

  const [templates, settings] = await Promise.all([
    db().emailTemplate.findMany({
      where: { organizationId: tenant.organizationId, isArchived: false },
      orderBy: { updatedAt: 'desc' },
      select: { id: true, name: true, subject: true, body: true },
    }),
    db().orgSetting.findMany({
      where: { organizationId: tenant.organizationId },
      select: { key: true, value: true },
    }),
  ]);

  const preference = (key: string): unknown =>
    settings.find((row) => row.key === key)?.value ?? null;

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-lg font-semibold tracking-tight">New campaign</h1>
        <p className="mt-1 text-sm text-[var(--muted)]">
          Set it up, add leads, review the actual emails, then activate. Nothing sends before the
          final step.
        </p>
      </div>

      {templates.length === 0 ? (
        <Card>
          <Banner tone="warn">
            You need an email template first. Create one on the Templates page, then come back.
          </Banner>
        </Card>
      ) : (
        <CampaignWizard
          templates={templates}
          defaults={{
            senderName: (preference('defaultSenderName') as string) ?? session.name ?? '',
            companyName: (preference('defaultCompanyName') as string) ?? '',
            dailyLimit:
              (preference('defaultCampaignDailyLimit') as number) ??
              Math.min(50, config.EMAIL_DAILY_LIMIT),
            delaySeconds:
              (preference('defaultCampaignDelaySeconds') as number) ??
              Math.max(120, config.EMAIL_MIN_DELAY_SECONDS),
            useAiPersonalization: (preference('defaultUseAiPersonalization') as boolean) ?? false,
          }}
          limits={{
            minDelaySeconds: config.EMAIL_MIN_DELAY_SECONDS,
            maxDailyLimit: config.EMAIL_DAILY_LIMIT,
          }}
        />
      )}
    </div>
  );
}
