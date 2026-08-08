import { LeadTable } from '@/components/leads/lead-table';

export const metadata = { title: 'Leads — LeadRadar' };

export default function LeadsPage() {
  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-lg font-semibold tracking-tight">Leads</h1>
        <p className="mt-1 text-sm text-[var(--muted)]">
          Ordered by opportunity score, so the top of the list is the top of your call queue.
        </p>
      </div>
      <LeadTable />
    </div>
  );
}
