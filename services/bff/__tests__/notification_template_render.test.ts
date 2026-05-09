// Pure-function tests for the M14.24 mustache renderer.

import { renderTemplate } from '../src/admin/notification_template_render';
import type { NotificationTemplate } from '../src/admin/case_scenarios_types';

const NOW = new Date('2026-05-09T12:00:00Z').toISOString();

function tpl(overrides: Partial<NotificationTemplate>): NotificationTemplate {
  return {
    template_id: 't-1',
    tenant_id: 'BANK_DEMO',
    name: 'Test',
    channel: 'EMAIL',
    subject: 'Hello {{customer_name}}',
    body: 'Hi {{rm_name}}, case {{case_number}} for {{customer_name}}.',
    locale: 'en-IN',
    status: 'ACTIVE',
    created_by: 'system:seed',
    updated_by: null,
    created_at: NOW,
    updated_at: NOW,
    deleted_at: null,
    ...overrides,
  };
}

describe('renderTemplate (M14.24)', () => {
  it('substitutes referenced vars in subject + body', () => {
    const r = renderTemplate(tpl({}), {
      tenant_id: 'BANK_DEMO',
      vars: { customer_name: 'Alice', rm_name: 'Bob', case_number: 'C-001' },
    });
    expect(r.subject).toBe('Hello Alice');
    expect(r.body).toBe('Hi Bob, case C-001 for Alice.');
    expect(r.missing_vars).toEqual([]);
    expect(r.used_vars).toEqual(['case_number', 'customer_name', 'rm_name']);
  });

  it('flags missing vars + leaves visible {{var}} placeholder', () => {
    const r = renderTemplate(tpl({}), {
      tenant_id: 'BANK_DEMO',
      vars: { customer_name: 'Alice' },
    });
    expect(r.subject).toBe('Hello Alice');
    expect(r.body).toBe('Hi {{rm_name}}, case {{case_number}} for Alice.');
    expect(r.missing_vars).toEqual(['case_number', 'rm_name']);
  });

  it('treats null + undefined + empty string as "missing"', () => {
    const r = renderTemplate(
      tpl({ subject: '{{a}} {{b}} {{c}}', body: '{{a}}+{{b}}+{{c}}' }),
      { tenant_id: 'BANK_DEMO', vars: { a: null, b: undefined, c: '' } },
    );
    expect(r.missing_vars).toEqual(['a', 'b', 'c']);
  });

  it('honours `| default: "fallback"` for missing vars', () => {
    const t = tpl({
      subject: 'Subject',
      body: 'Hi {{rm_name | default: "team"}}, case {{case_number | default: "n/a"}}.',
    });
    const r = renderTemplate(t, { tenant_id: 'BANK_DEMO', vars: {} });
    expect(r.body).toBe('Hi team, case n/a.');
    expect(r.missing_vars).toEqual([]);
  });

  it('default is overridden when the var is provided', () => {
    const t = tpl({
      body: 'Hi {{rm_name | default: "team"}}',
    });
    const r = renderTemplate(t, {
      tenant_id: 'BANK_DEMO',
      vars: { rm_name: 'Alice' },
    });
    expect(r.body).toBe('Hi Alice');
  });

  it('null subject (SMS) is preserved as null', () => {
    const r = renderTemplate(
      tpl({ channel: 'SMS', subject: null, body: 'lapse alert {{policy}}' }),
      { tenant_id: 'BANK_DEMO', vars: { policy: 'P-7' } },
    );
    expect(r.subject).toBeNull();
    expect(r.body).toBe('lapse alert P-7');
    expect(r.channel).toBe('SMS');
  });

  it('coerces non-string values via String()', () => {
    const r = renderTemplate(
      tpl({ subject: '{{n}} alerts in {{days}}d', body: 'count={{n}}' }),
      { tenant_id: 'BANK_DEMO', vars: { n: 7, days: 30 } },
    );
    expect(r.subject).toBe('7 alerts in 30d');
    expect(r.body).toBe('count=7');
  });

  it('used_vars only contains vars referenced by the template (not all provided vars)', () => {
    const r = renderTemplate(
      tpl({ subject: 'Subject', body: '{{a}}' }),
      { tenant_id: 'BANK_DEMO', vars: { a: 'x', unused: 'y' } },
    );
    expect(r.used_vars).toEqual(['a']);
  });

  it('repeated references count once in used_vars + still substitute every occurrence', () => {
    const r = renderTemplate(
      tpl({ subject: '{{a}} {{a}} {{a}}', body: '{{a}}-{{a}}' }),
      { tenant_id: 'BANK_DEMO', vars: { a: 'X' } },
    );
    expect(r.subject).toBe('X X X');
    expect(r.body).toBe('X-X');
    expect(r.used_vars).toEqual(['a']);
  });

  it('ignores literal {{ … }} that does not match the variable pattern', () => {
    const r = renderTemplate(
      tpl({ subject: '{{ space }}', body: '{{1number}} {{ok-dash}}' }),
      { tenant_id: 'BANK_DEMO', vars: {} },
    );
    // {{ space }} matches (allows whitespace + valid identifier "space")
    expect(r.subject).toBe('{{ space }}');
    // {{1number}} — starts with digit, no match. {{ok-dash}} — has dash, no match.
    expect(r.body).toBe('{{1number}} {{ok-dash}}');
    // Only "space" was attempted as a substitution
    expect(r.missing_vars).toEqual(['space']);
  });
});
