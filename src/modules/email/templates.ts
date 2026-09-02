/**
 * Template rendering.
 *
 * Strict by design: an unknown or missing variable is an ERROR, not an empty
 * string. The alternative — silently substituting nothing — produces the
 * signature failure of every bad outreach tool:
 *
 *     Hi  team,
 *     I came across your business while researching  businesses in .
 *
 * That email is worse than no email. It tells the recipient they are one row in
 * a list, it burns the only first impression available, and it is the reason
 * template rendering fails loudly here rather than degrading. A campaign that
 * cannot render is a campaign the operator fixes before it sends.
 *
 * The template language is deliberately tiny: `{{variable}}` substitution and
 * nothing else. No conditionals, no loops, no expressions, no partials. Operators
 * write these in a web form, and every construct beyond substitution is another
 * way to produce mail nobody reviewed — or, with an expression evaluator, another
 * injection surface.
 */
import { AppError } from '@/lib/errors';

/** `{{ variable_name }}`, tolerating surrounding whitespace. */
const PLACEHOLDER = /\{\{\s*([a-z][a-z0-9_]*)\s*\}\}/gi;

/**
 * The complete set of variables a template may reference.
 *
 * A closed vocabulary rather than "whatever the lead object has": it keeps
 * templates decoupled from the database schema, and it means a typo is caught
 * when the template is saved rather than when a thousand emails render.
 *
 * Every value here is either a fact LeadRadar independently verified, a
 * Google-derived field the operator already sees in the dashboard, or text the
 * operator supplied about themselves. Nothing is inferred.
 */
export const TEMPLATE_VARIABLES = {
  business_name: 'The business name',
  industry: 'The business category, e.g. "dental clinic"',
  city: 'The city the business is in',
  website: 'The verified website domain, or "no website"',
  opportunity: 'The single clearest measured gap, in plain words',
  sales_angle: 'A sentence describing the opportunity, generated from measured facts',
  recommended_service: 'The service this lead most needs',
  sender_name: 'Your name, from the campaign settings',
  company_name: 'Your company name, from the campaign settings',
} as const;

export type TemplateVariable = keyof typeof TEMPLATE_VARIABLES;

export const ALL_TEMPLATE_VARIABLES = Object.keys(TEMPLATE_VARIABLES) as TemplateVariable[];

export type TemplateValues = Partial<Record<TemplateVariable, string>>;

/** Variables a template references, deduplicated and in order of first use. */
export function extractVariables(template: string): string[] {
  const found: string[] = [];
  for (const match of template.matchAll(PLACEHOLDER)) {
    const name = (match[1] ?? '').toLowerCase();
    if (name !== '' && !found.includes(name)) found.push(name);
  }
  return found;
}

export interface TemplateValidation {
  readonly valid: boolean;
  /** Referenced names that are not in the supported vocabulary. */
  readonly unknownVariables: readonly string[];
  readonly usedVariables: readonly string[];
}

/**
 * Checks a template at save time.
 *
 * Catching an unknown variable here means the operator sees "there is no
 * {{buisness_name}}" while editing, rather than a campaign that refuses to render
 * for every one of its leads an hour later.
 */
export function validateTemplate(subject: string, body: string): TemplateValidation {
  const used = [...new Set([...extractVariables(subject), ...extractVariables(body)])];
  const unknown = used.filter((name) => !(name in TEMPLATE_VARIABLES));

  return {
    valid: unknown.length === 0,
    unknownVariables: unknown,
    usedVariables: used,
  };
}

export interface RenderResult {
  readonly text: string;
  /** Variables the template needed but for which no value was available. */
  readonly missing: readonly string[];
}

/**
 * Substitutes values, reporting anything missing rather than blanking it.
 *
 * A value that is present but empty counts as missing: an empty
 * `{{business_name}}` produces exactly the "Hi  team," failure described above,
 * and treating it as satisfied would defeat the entire point of strict rendering.
 */
export function renderTemplate(template: string, values: TemplateValues): RenderResult {
  const missing: string[] = [];

  const text = template.replace(PLACEHOLDER, (_match, rawName: string) => {
    const name = rawName.toLowerCase() as TemplateVariable;
    const value = values[name];

    if (value === undefined || value.trim() === '') {
      if (!missing.includes(name)) missing.push(name);
      // Left in place so a partial render is visibly incomplete rather than
      // subtly wrong. It is never sent — callers must check `missing`.
      return `{{${name}}}`;
    }

    return value;
  });

  return { text, missing };
}

export interface RenderedEmail {
  readonly subject: string;
  readonly body: string;
}

/**
 * Renders a complete message, or throws.
 *
 * The throwing variant is what the send path uses: by the time a message is
 * about to leave, "some variables did not resolve" must stop the send, not
 * annotate it.
 */
export function renderEmail(
  template: { subject: string; body: string },
  values: TemplateValues,
): RenderedEmail {
  const subject = renderTemplate(template.subject, values);
  const body = renderTemplate(template.body, values);

  const missing = [...new Set([...subject.missing, ...body.missing])];
  if (missing.length > 0) {
    throw new AppError({
      code: 'VALIDATION_FAILED',
      message: `Template could not be rendered; no value for: ${missing.join(', ')}`,
      safeMessage:
        `This lead is missing ${missing.join(', ')}, which the template needs. ` +
        'It will be skipped rather than sent with blanks.',
      context: { missing },
    });
  }

  return { subject: subject.text.trim(), body: body.text.trim() };
}

/** Non-throwing render, for previews where a partial result is still useful. */
export function previewEmail(
  template: { subject: string; body: string },
  values: TemplateValues,
): { subject: string; body: string; missing: readonly string[] } {
  const subject = renderTemplate(template.subject, values);
  const body = renderTemplate(template.body, values);

  return {
    subject: subject.text,
    body: body.text,
    missing: [...new Set([...subject.missing, ...body.missing])],
  };
}

/**
 * The starter template.
 *
 * Written to be defensible rather than clever. It states plainly how the sender
 * found the business, makes one specific observation drawn from measured facts,
 * and asks a small question. It does not claim a prior relationship, invent a
 * referral, fake a reply thread, or assert anything LeadRadar did not verify —
 * all of which are common in outreach tooling and all of which are deceptive.
 */
export const DEFAULT_TEMPLATE = {
  name: 'Website opportunity — plain',
  description:
    'A short, honest first-contact email. States how you found the business, makes one specific observation, and asks a small question.',
  subject: 'Quick note about {{business_name}}',
  body: `Hi {{business_name}} team,

I came across your business while researching {{industry}} businesses in {{city}}.

{{sales_angle}}

I help local businesses with {{recommended_service}}. If it would be useful, I can send you a short written summary of what I found — no charge and no obligation.

If this isn't relevant, just ignore this email and I won't follow up.

Regards,
{{sender_name}}
{{company_name}}`,
} as const;

/**
 * Example values, used to preview a template before any lead is attached.
 *
 * Obviously fictional on purpose: a preview populated with a real lead's data
 * invites the operator to read it as an already-composed message and send it
 * without reviewing the actual rendering for the actual recipient.
 */
export const PREVIEW_VALUES: Record<TemplateVariable, string> = {
  business_name: 'Example Dental Care',
  industry: 'dental clinic',
  city: 'Chennai',
  website: 'exampledental.in',
  opportunity: 'no mobile viewport tag',
  sales_angle:
    'Your site loads, but it has no mobile viewport tag, so it renders zoomed out on phones — and most people searching for a dentist nearby are on a phone.',
  recommended_service: 'website development',
  sender_name: 'Your Name',
  company_name: 'Your Company',
};
