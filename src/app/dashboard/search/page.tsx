import { SearchForm } from '@/components/search/search-form';

export const metadata = { title: 'Search — LeadRadar' };

export default function SearchPage() {
  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-lg font-semibold tracking-tight">New search</h1>
        <p className="mt-1 text-sm text-[var(--muted)]">
          Describe the businesses you want. LeadRadar interprets the request, shows you the filters
          and the cost, and only spends once you confirm.
        </p>
      </div>
      <SearchForm />
    </div>
  );
}
