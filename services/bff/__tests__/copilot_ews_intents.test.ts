// services/bff/__tests__/copilot_ews_intents.test.ts
//
// Copilot-2 — EWS-specific intent classifier + renderer tests.

import {
  classifyEwsIntent,
  tryHandleEwsIntent,
} from '../src/copilot/ews_intents';

describe('Copilot-2 — classifyEwsIntent', () => {
  test('why_flagged variants', () => {
    expect(classifyEwsIntent('Why is cust-001 flagged as high risk?')).toBe('why_flagged');
    expect(classifyEwsIntent('why high risk')).toBe('why_flagged');
    expect(classifyEwsIntent('explain the risk for this customer')).toBe('why_flagged');
  });

  test('summarize_alert variants', () => {
    expect(classifyEwsIntent('Summarize this alert in 2 lines')).toBe('summarize_alert');
    expect(classifyEwsIntent('alert summary please')).toBe('summarize_alert');
    expect(classifyEwsIntent('tldr the alert')).toBe('summarize_alert');
  });

  test('suggest_case_steps variants', () => {
    expect(classifyEwsIntent('What should I do next for this case?')).toBe('suggest_case_steps');
    expect(classifyEwsIntent('next steps for case CAS-001')).toBe('suggest_case_steps');
    expect(classifyEwsIntent('recommended actions for the case')).toBe('suggest_case_steps');
  });

  test('explain_kri variants', () => {
    expect(classifyEwsIntent('Explain the KRI breakdown')).toBe('explain_kri');
    expect(classifyEwsIntent('what KRIs drove this?')).toBe('explain_kri');
    expect(classifyEwsIntent('breakdown of the score')).toBe('explain_kri');
  });

  test('non-matching messages → null', () => {
    expect(classifyEwsIntent('Hello there')).toBeNull();
    expect(classifyEwsIntent('thanks!')).toBeNull();
    expect(classifyEwsIntent('what is the weather')).toBeNull();
    expect(classifyEwsIntent('')).toBeNull();
  });
});

describe('Copilot-2 — tryHandleEwsIntent', () => {
  test('why_flagged with full context surfaces drivers + recommendation', () => {
    const r = tryHandleEwsIntent('why is the customer high risk', {
      page: 'customer',
      entity: {
        type: 'customer',
        id: 'cust-001',
        label: 'Acme Pvt Ltd',
        facts: {
          pd: 0.72,
          dpd_max_90d: 60,
          utilization: 0.95,
          top_driver: 'dpd_max_90d',
        },
      },
    });
    expect(r).not.toBeNull();
    expect(r!.intent).toBe('why_flagged');
    expect(r!.reply).toContain('Acme Pvt Ltd');
    expect(r!.reply).toContain('high risk');
    expect(r!.reply).toContain('PD = 72%');
    expect(r!.reply).toContain('escalate');
    expect(r!.suggestions.length).toBeGreaterThan(0);
  });

  test('why_flagged for medium PD recommends soft-touch outreach', () => {
    const r = tryHandleEwsIntent('explain the risk', {
      entity: { type: 'customer', id: 'c1', facts: { pd: 0.4 } },
    });
    expect(r!.reply).toContain('medium risk');
    expect(r!.reply).toMatch(/soft-touch|monitor/i);
  });

  test('why_flagged with no entity returns guidance', () => {
    const r = tryHandleEwsIntent('why high risk', {});
    expect(r!.reply).toContain('Customers');
  });

  test('summarize_alert builds 2-line summary from facts', () => {
    const r = tryHandleEwsIntent('summarize this alert', {
      entity: {
        type: 'alert',
        id: 'alrt-001',
        label: 'EMI bounce alert',
        facts: {
          severity: 'high',
          customer_id: 'cust-001',
          rule_name: 'High EMI Bounce',
          reason_summary: '5 bounces in 90 days',
        },
      },
    });
    expect(r!.intent).toBe('summarize_alert');
    expect(r!.reply.split('\n')).toHaveLength(2);
    expect(r!.reply).toContain('EMI bounce alert');
    expect(r!.reply).toContain('high');
    expect(r!.reply).toContain('5 bounces');
  });

  test('summarize_alert without alert entity returns guidance', () => {
    const r = tryHandleEwsIntent('summarize the alert', { entity: { type: 'customer', id: 'c1' } });
    expect(r!.reply).toContain('Alerts');
  });

  test('suggest_case_steps OPEN state suggests assignment', () => {
    const r = tryHandleEwsIntent('next steps for this case', {
      entity: {
        type: 'case',
        id: 'CAS-1',
        label: 'EWS-2026-00001',
        facts: { status: 'OPEN', priority: 'P1' },
      },
    });
    expect(r!.intent).toBe('suggest_case_steps');
    expect(r!.reply).toContain('EWS-2026-00001');
    expect(r!.reply).toMatch(/Assign|assign/);
  });

  test('suggest_case_steps INVESTIGATING suggests notes + approval', () => {
    const r = tryHandleEwsIntent('what should I do next for this case', {
      entity: { type: 'case', id: 'c1', facts: { status: 'INVESTIGATING' } },
    });
    expect(r!.reply).toContain('PENDING_APPROVAL');
  });

  test('suggest_case_steps CLOSED case mentions lock', () => {
    const r = tryHandleEwsIntent('next steps for this case', {
      entity: { type: 'case', id: 'c1', facts: { status: 'CLOSED' } },
    });
    expect(r!.reply).toContain('locked');
  });

  test('suggest_case_steps SLA breach surfaces warning', () => {
    const r = tryHandleEwsIntent('next steps for case', {
      entity: {
        type: 'case',
        id: 'c1',
        facts: { status: 'INVESTIGATING', sla_breached: 'true' },
      },
    });
    expect(r!.reply).toContain('SLA breached');
  });

  test('suggest_case_steps non-case entity returns guidance', () => {
    const r = tryHandleEwsIntent('next steps for this case', {
      entity: { type: 'customer', id: 'c1' },
    });
    expect(r!.reply).toContain('Case Management');
  });

  test('explain_kri renders breach class tally', () => {
    const r = tryHandleEwsIntent('explain the kri breakdown', {
      entity: {
        type: 'customer',
        id: 'c1',
        label: 'Acme',
        facts: { red_count: 3, orange_count: 5, top_driver: 'FIN-001' },
      },
    });
    expect(r!.intent).toBe('explain_kri');
    expect(r!.reply).toContain('Acme');
    expect(r!.reply).toContain('red 3');
    expect(r!.reply).toContain('orange 5');
    expect(r!.reply).toContain('FIN-001');
  });

  test('explain_kri scans kri_<id>=<v> facts (up to 5)', () => {
    const r = tryHandleEwsIntent('what kris drove this', {
      entity: {
        type: 'customer',
        id: 'c1',
        facts: {
          kri_FIN_001: 0.6,
          kri_BEH_001: 0.5,
          kri_TXN_001: 0.4,
          unrelated: 'ignored',
        },
      },
    });
    expect(r!.reply).toMatch(/FIN_001=0\.6/);
  });

  test('explain_kri empty facts → guidance', () => {
    const r = tryHandleEwsIntent('explain kri', {
      entity: { type: 'customer', id: 'c1' },
    });
    expect(r!.reply).toMatch(/I don't have KRI facts|scan-customer/);
  });

  test('non-matching message → null (caller falls through)', () => {
    expect(tryHandleEwsIntent('hello there', {})).toBeNull();
    expect(tryHandleEwsIntent('thanks!', {})).toBeNull();
  });
});
