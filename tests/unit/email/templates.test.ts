import { describe, expect, it } from 'vitest';

import {
  ALL_TEMPLATE_VARIABLES,
  DEFAULT_TEMPLATE,
  PREVIEW_VALUES,
  TEMPLATE_VARIABLES,
  extractVariables,
  previewEmail,
  renderEmail,
  renderTemplate,
  validateTemplate,
} from '@/modules/email/templates';

describe('extractVariables', () => {
  it('finds every placeholder in order of first use', () => {
    expect(extractVariables('Hi {{business_name}}, in {{city}}')).toEqual([
      'business_name',
      'city',
    ]);
  });

  it('deduplicates repeated placeholders', () => {
    expect(extractVariables('{{city}} and {{city}}')).toEqual(['city']);
  });

  it('tolerates whitespace inside the braces', () => {
    expect(extractVariables('{{  business_name  }}')).toEqual(['business_name']);
  });

  it('ignores single braces, which are ordinary text', () => {
    expect(extractVariables('{business_name}')).toEqual([]);
  });
});

describe('validateTemplate', () => {
  it('accepts a template using only supported variables', () => {
    const result = validateTemplate('Hi {{business_name}}', 'Regards {{sender_name}}');
    expect(result.valid).toBe(true);
    expect(result.unknownVariables).toEqual([]);
  });

  it('rejects a misspelled variable at save time rather than at send time', () => {
    const result = validateTemplate('Hi {{buisness_name}}', 'body text here');
    expect(result.valid).toBe(false);
    expect(result.unknownVariables).toEqual(['buisness_name']);
  });

  it('validates the shipped starter template', () => {
    const result = validateTemplate(DEFAULT_TEMPLATE.subject, DEFAULT_TEMPLATE.body);
    expect(result.valid).toBe(true);
  });
});

describe('renderTemplate', () => {
  it('substitutes provided values', () => {
    const result = renderTemplate('Hi {{business_name}}', { business_name: 'Acme Dental' });
    expect(result.text).toBe('Hi Acme Dental');
    expect(result.missing).toEqual([]);
  });

  it('reports a missing value rather than blanking it', () => {
    const result = renderTemplate('Hi {{business_name}} in {{city}}', {
      business_name: 'Acme',
    });

    expect(result.missing).toEqual(['city']);
    // The placeholder stays visible so a partial render is obviously incomplete.
    expect(result.text).toContain('{{city}}');
  });

  it('treats an empty string as missing, not as satisfied', () => {
    // This is the "Hi  team," failure. An empty value must not count as present.
    const result = renderTemplate('Hi {{business_name}} team', { business_name: '   ' });
    expect(result.missing).toEqual(['business_name']);
  });
});

describe('renderEmail', () => {
  const template = { subject: 'Note for {{business_name}}', body: 'Hi, {{sales_angle}}' };

  it('renders when every variable has a value', () => {
    const result = renderEmail(template, {
      business_name: 'Acme Dental',
      sales_angle: 'Your site has no HTTPS.',
    });

    expect(result.subject).toBe('Note for Acme Dental');
    expect(result.body).toBe('Hi, Your site has no HTTPS.');
  });

  it('throws rather than sending an email containing blanks', () => {
    expect(() => renderEmail(template, { business_name: 'Acme Dental' })).toThrow(/sales_angle/);
  });

  it('names every missing variable so the operator can fix them at once', () => {
    expect(() => renderEmail(template, {})).toThrow(/business_name.*sales_angle|sales_angle/);
  });

  it('never emits a literal placeholder in a successful render', () => {
    const result = renderEmail(DEFAULT_TEMPLATE, PREVIEW_VALUES);
    expect(result.subject).not.toMatch(/\{\{/);
    expect(result.body).not.toMatch(/\{\{/);
  });
});

describe('previewEmail', () => {
  it('returns a partial render plus the missing list, for an editor', () => {
    const result = previewEmail(
      { subject: '{{business_name}}', body: '{{city}}' },
      { business_name: 'Acme' },
    );

    expect(result.subject).toBe('Acme');
    expect(result.missing).toEqual(['city']);
  });

  it('does not throw on an incomplete template', () => {
    expect(() => previewEmail({ subject: '{{city}}', body: 'x' }, {})).not.toThrow();
  });
});

describe('the template vocabulary is closed', () => {
  it('exposes a description for every variable', () => {
    for (const name of ALL_TEMPLATE_VARIABLES) {
      expect(TEMPLATE_VARIABLES[name]).toBeTruthy();
    }
  });

  it('supplies a preview value for every variable, so previews never show blanks', () => {
    for (const name of ALL_TEMPLATE_VARIABLES) {
      expect(PREVIEW_VALUES[name]).toBeTruthy();
    }
  });

  it('has no variable that would leak a Google-derived rating or review count', () => {
    // Those fields carry provider display and attribution terms that an outbound
    // email cannot satisfy, so they are deliberately not offered to templates.
    for (const name of ALL_TEMPLATE_VARIABLES) {
      expect(name).not.toMatch(/rating|review/i);
    }
  });
});

describe('the starter template is honest', () => {
  it('does not claim a prior relationship or referral', () => {
    expect(DEFAULT_TEMPLATE.body).not.toMatch(
      /as (we )?discussed|following up on our|you asked|referred by|per our (call|conversation)/i,
    );
  });

  it('says how the sender found the business', () => {
    expect(DEFAULT_TEMPLATE.body).toMatch(/came across|researching/i);
  });

  it('offers a way out without requiring a reply', () => {
    expect(DEFAULT_TEMPLATE.body).toMatch(/ignore this email|won't follow up/i);
  });

  it('does not fake a reply thread', () => {
    expect(DEFAULT_TEMPLATE.subject).not.toMatch(/^re:|^fwd:/i);
  });
});
