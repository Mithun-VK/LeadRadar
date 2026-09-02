import { Card } from '@/components/ui/primitives';
import { currentSession } from '@/modules/auth/session';
import { db } from '@/modules/database/client';
import { DEFAULT_TEMPLATE, TEMPLATE_VARIABLES } from '@/modules/email/templates';

import { TemplateEditor } from './editor';

export const metadata = { title: 'Templates — LeadRadar' };
export const dynamic = 'force-dynamic';

export default async function TemplatesPage() {
  const session = await currentSession();

  const templates = await db().emailTemplate.findMany({
    where: { organizationId: session!.organizationId, isArchived: false },
    orderBy: { updatedAt: 'desc' },
    select: {
      id: true,
      name: true,
      description: true,
      subject: true,
      body: true,
      variables: true,
      updatedAt: true,
    },
  });

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-lg font-semibold tracking-tight">Email templates</h1>
        <p className="mt-1 text-sm text-[var(--muted)]">
          Templates are filled in per lead from data LeadRadar actually measured.
        </p>
      </div>

      <TemplateEditor
        templates={templates.map((template) => ({
          ...template,
          updatedAt: template.updatedAt.toISOString(),
        }))}
        variables={Object.entries(TEMPLATE_VARIABLES).map(([name, description]) => ({
          name,
          description,
        }))}
        starter={DEFAULT_TEMPLATE}
      />

      <Card title="Writing an outreach email that does not get ignored">
        <ul className="space-y-2 text-sm">
          <li>
            <strong>Say how you found them.</strong> The recipient will wonder. Answering it up
            front is the difference between a cold email and a suspicious one.
          </li>
          <li>
            <strong>Make one specific, checkable observation.</strong> LeadRadar fills{' '}
            <code>{'{{sales_angle}}'}</code> with something measured on their actual site. That is
            worth more than three paragraphs about your services.
          </li>
          <li>
            <strong>Ask for something small.</strong> A reply is a lower bar than a meeting.
          </li>
          <li>
            <strong>Offer an easy exit.</strong> Every message carries an unsubscribe link
            automatically, and saying so in the body reduces spam complaints.
          </li>
        </ul>

        <p className="mt-4 text-[11px] text-[var(--muted)]">
          A rendering that leaves any placeholder unfilled is refused rather than sent — an email
          reading &ldquo;Hi&nbsp;&nbsp;team,&rdquo; is worse than no email. Leads missing a value
          the template needs are listed as skipped, with the reason.
        </p>
      </Card>
    </div>
  );
}
