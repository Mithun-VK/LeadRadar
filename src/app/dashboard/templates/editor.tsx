'use client';

/**
 * Template list and editor.
 *
 * The live preview is the important part. A template is abstract until you see it
 * rendered, and the failure this product most wants to prevent — a message that
 * goes out with a blank where a business name should be — is invisible when you
 * are looking at raw `{{placeholders}}`. The preview uses obviously fictional
 * example values so nobody mistakes it for a real, already-composed message.
 */
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';

import { api } from '@/lib/api-client';
import { Card, EmptyState } from '@/components/ui/primitives';

interface Template {
  id: string;
  name: string;
  description: string | null;
  subject: string;
  body: string;
  variables: string[];
  updatedAt: string;
}

interface Variable {
  name: string;
  description: string;
}

const EXAMPLE: Record<string, string> = {
  business_name: 'Example Dental Care',
  industry: 'dental clinic',
  city: 'Chennai',
  website: 'exampledental.in',
  opportunity: 'no mobile viewport tag',
  sales_angle:
    'Your site loads, but it has no mobile viewport tag, so it renders zoomed out on phones — and most people searching for a dentist nearby are on a phone.',
  recommended_service: 'building websites',
  sender_name: 'Your Name',
  company_name: 'Your Company',
};

function render(text: string, values: Record<string, string>): { text: string; missing: string[] } {
  const missing: string[] = [];
  const rendered = text.replace(/\{\{\s*([a-z][a-z0-9_]*)\s*\}\}/gi, (_match, name: string) => {
    const key = name.toLowerCase();
    const value = values[key];
    if (value === undefined || value.trim() === '') {
      if (!missing.includes(key)) missing.push(key);
      return `{{${key}}}`;
    }
    return value;
  });
  return { text: rendered, missing };
}

export function TemplateEditor({
  templates,
  variables,
  starter,
}: {
  templates: Template[];
  variables: Variable[];
  starter: { name: string; description: string; subject: string; body: string };
}) {
  const router = useRouter();

  const [editing, setEditing] = useState<Template | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const known = useMemo(() => new Set(variables.map((v) => v.name)), [variables]);

  const preview = useMemo(() => {
    const subjectResult = render(subject, EXAMPLE);
    const bodyResult = render(body, EXAMPLE);
    return {
      subject: subjectResult.text,
      body: bodyResult.text,
      missing: [...new Set([...subjectResult.missing, ...bodyResult.missing])],
    };
  }, [subject, body]);

  const unknownVariables = preview.missing.filter((name) => !known.has(name));

  function startCreate(withStarter: boolean): void {
    setCreating(true);
    setEditing(null);
    setError(null);
    setName(withStarter ? starter.name : '');
    setSubject(withStarter ? starter.subject : '');
    setBody(withStarter ? starter.body : '');
  }

  function startEdit(template: Template): void {
    setEditing(template);
    setCreating(false);
    setError(null);
    setName(template.name);
    setSubject(template.subject);
    setBody(template.body);
  }

  function cancel(): void {
    setCreating(false);
    setEditing(null);
    setError(null);
  }

  async function save(): Promise<void> {
    setBusy(true);
    setError(null);

    const payload = { name: name.trim(), subject: subject.trim(), body: body.trim() };
    const response = editing
      ? await api.patch<{ id: string }>(`/api/templates/${editing.id}`, payload)
      : await api.post<{ id: string }>('/api/templates', payload);

    if (response.ok) {
      cancel();
      router.refresh();
    } else {
      setError(response.error?.message ?? 'Could not save the template.');
    }

    setBusy(false);
  }

  async function archive(id: string): Promise<void> {
    setBusy(true);
    const response = await api.delete(`/api/templates/${id}`);
    if (response.ok) router.refresh();
    else setError(response.error?.message ?? 'Could not archive the template.');
    setBusy(false);
  }

  const editorOpen = creating || editing !== null;

  return (
    <div className="space-y-5">
      {!editorOpen && (
        <Card
          title="Your templates"
          actions={
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => startCreate(true)}
                className="rounded-lg border border-[var(--border)] px-3 py-1.5 text-sm"
              >
                Start from the example
              </button>
              <button
                type="button"
                onClick={() => startCreate(false)}
                className="rounded-lg bg-[var(--accent)] px-3 py-1.5 text-sm font-medium text-white"
              >
                New template
              </button>
            </div>
          }
        >
          {templates.length === 0 ? (
            <EmptyState
              title="No templates yet"
              hint="Start from the example — it is written to be honest and short."
            />
          ) : (
            <ul className="divide-y divide-[var(--border)]">
              {templates.map((template) => (
                <li key={template.id} className="flex items-start justify-between gap-4 py-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium">{template.name}</p>
                    <p className="mt-0.5 truncate text-xs text-[var(--muted)]">
                      {template.subject}
                    </p>
                    <p className="mt-1 text-[11px] text-[var(--muted)]">
                      Uses: {template.variables.join(', ') || 'no variables'}
                    </p>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <button
                      type="button"
                      onClick={() => startEdit(template)}
                      className="rounded-md border border-[var(--border)] px-2 py-1 text-xs"
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void archive(template.id)}
                      className="rounded-md border border-[var(--border)] px-2 py-1 text-xs text-[var(--muted)]"
                    >
                      Archive
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}

      {editorOpen && (
        <div className="grid gap-5 lg:grid-cols-2">
          <Card title={editing ? `Editing ${editing.name}` : 'New template'}>
            <div className="space-y-3">
              <label className="block">
                <span className="text-[11px] font-medium uppercase tracking-wide text-[var(--muted)]">
                  Name
                </span>
                <input
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  className="mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-sm"
                />
              </label>

              <label className="block">
                <span className="text-[11px] font-medium uppercase tracking-wide text-[var(--muted)]">
                  Subject
                </span>
                <input
                  value={subject}
                  onChange={(event) => setSubject(event.target.value)}
                  className="mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-sm"
                />
              </label>

              <label className="block">
                <span className="text-[11px] font-medium uppercase tracking-wide text-[var(--muted)]">
                  Body
                </span>
                <textarea
                  value={body}
                  onChange={(event) => setBody(event.target.value)}
                  rows={16}
                  className="mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 font-mono text-xs leading-relaxed"
                />
              </label>
            </div>

            {unknownVariables.length > 0 && (
              <p className="mt-3 text-xs text-[var(--grade-d)]" role="alert">
                Unknown placeholder(s): {unknownVariables.map((v) => `{{${v}}}`).join(', ')}. These
                will not resolve and the template cannot be saved.
              </p>
            )}

            {error && (
              <p className="mt-3 text-xs text-[var(--grade-d)]" role="alert">
                {error}
              </p>
            )}

            <div className="mt-4 flex gap-2">
              <button
                type="button"
                disabled={busy || name.trim() === '' || unknownVariables.length > 0}
                onClick={() => void save()}
                className="rounded-lg bg-[var(--accent)] px-4 py-1.5 text-sm font-medium text-white disabled:opacity-50"
              >
                {busy ? 'Saving…' : 'Save'}
              </button>
              <button
                type="button"
                onClick={cancel}
                className="text-sm text-[var(--muted)] underline"
              >
                Cancel
              </button>
            </div>

            <div className="mt-5 border-t border-[var(--border)] pt-4">
              <p className="text-[11px] font-medium uppercase tracking-wide text-[var(--muted)]">
                Available placeholders
              </p>
              <ul className="mt-2 space-y-1 text-xs">
                {variables.map((variable) => (
                  <li key={variable.name}>
                    <button
                      type="button"
                      onClick={() => setBody((current) => `${current}{{${variable.name}}}`)}
                      className="font-mono text-[var(--accent)] hover:underline"
                    >
                      {`{{${variable.name}}}`}
                    </button>
                    <span className="ml-2 text-[var(--muted)]">{variable.description}</span>
                  </li>
                ))}
              </ul>
            </div>
          </Card>

          <Card
            title="Preview"
            description="Filled with obviously fictional example values, not a real lead."
          >
            <div className="rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] p-4">
              <p className="text-sm font-medium">{preview.subject || '(no subject)'}</p>
              <pre className="mt-3 whitespace-pre-wrap font-sans text-sm leading-relaxed">
                {preview.body || '(no body)'}
              </pre>
              <p className="mt-4 border-t border-[var(--border)] pt-3 text-[11px] text-[var(--muted)]">
                ---
                <br />
                To stop receiving these emails, open: https://…/unsubscribe/…
                <br />
                <span className="italic">
                  (appended automatically to every message, along with one-click unsubscribe
                  headers)
                </span>
              </p>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}
