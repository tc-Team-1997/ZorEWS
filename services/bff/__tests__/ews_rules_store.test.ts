// services/bff/__tests__/ews_rules_store.test.ts
//
// EWS-2 — store + state machine tests.

import {
  EWS_RULES_CAP_PER_TENANT,
  EwsRuleError,
  InMemoryEwsRuleStore,
  isLegalTransition,
} from '../src/ews_rules';

const NOW = new Date('2026-05-06T10:00:00.000Z');

const VALID = {
  rule_id: 'RULE_CREDIT_001',
  name: 'High EMI Bounce Risk',
  category: 'credit' as const,
  description: '3+ EMI bounces in 90 days indicates servicing distress.',
  conditions: [{ field: 'emi_bounce_count_90d', operator: '>=', value: 3 }],
  logic: 'AND' as const,
  action: { alert_severity: 'RED' as const, weight: 25 },
  is_active: true,
};

describe('EWS-2 — isLegalTransition', () => {
  test('draft can go to pending_review or deprecated', () => {
    expect(isLegalTransition('draft', 'pending_review')).toBe(true);
    expect(isLegalTransition('draft', 'deprecated')).toBe(true);
    expect(isLegalTransition('draft', 'active')).toBe(false);
  });

  test('pending_review can go to active, draft, deprecated', () => {
    expect(isLegalTransition('pending_review', 'active')).toBe(true);
    expect(isLegalTransition('pending_review', 'draft')).toBe(true);
    expect(isLegalTransition('pending_review', 'deprecated')).toBe(true);
  });

  test('active can ONLY go to deprecated', () => {
    expect(isLegalTransition('active', 'deprecated')).toBe(true);
    expect(isLegalTransition('active', 'draft')).toBe(false);
    expect(isLegalTransition('active', 'pending_review')).toBe(false);
  });

  test('deprecated is terminal', () => {
    expect(isLegalTransition('deprecated', 'active')).toBe(false);
    expect(isLegalTransition('deprecated', 'draft')).toBe(false);
    expect(isLegalTransition('deprecated', 'pending_review')).toBe(false);
  });
});

describe('InMemoryEwsRuleStore — CRUD', () => {
  test('create returns rule with state=draft, version=1, is_active=false', () => {
    const s = new InMemoryEwsRuleStore();
    const r = s.create('BIL', VALID, 'admin', NOW);
    expect(r.rule_id).toBe('RULE_CREDIT_001');
    expect(r.tenant_id).toBe('BIL');
    expect(r.state).toBe('draft');
    expect(r.version).toBe(1);
    expect(r.is_active).toBe(false); // newly created — not active until activated
    expect(r.created_at).toBe(NOW.toISOString());
    expect(r.deprecated_at).toBeNull();
  });

  test('duplicate rule_id within tenant → duplicate_rule_id', () => {
    const s = new InMemoryEwsRuleStore();
    s.create('BIL', VALID, 'admin', NOW);
    try {
      s.create('BIL', VALID, 'admin', NOW);
      fail('expected throw');
    } catch (e) {
      expect((e as EwsRuleError).code).toBe('duplicate_rule_id');
    }
  });

  test('same rule_id allowed across tenants', () => {
    const s = new InMemoryEwsRuleStore();
    expect(() => s.create('BIL', VALID, 'admin', NOW)).not.toThrow();
    expect(() => s.create('BANK_DEMO', VALID, 'admin', NOW)).not.toThrow();
  });

  test('cap_reached after 200 rules', () => {
    const s = new InMemoryEwsRuleStore();
    for (let i = 0; i < EWS_RULES_CAP_PER_TENANT; i++) {
      const id = `RULE_CREDIT_${String(i + 1).padStart(3, '0')}`;
      s.create('BIL', { ...VALID, rule_id: id, name: `Rule ${i}` }, 'admin', NOW);
    }
    try {
      s.create('BIL', { ...VALID, rule_id: 'RULE_CREDIT_999' }, 'admin', NOW);
      fail('expected throw');
    } catch (e) {
      expect((e as EwsRuleError).code).toBe('cap_reached');
    }
  });

  test('list with category filter', () => {
    const s = new InMemoryEwsRuleStore();
    s.create('BIL', VALID, 'admin', NOW);
    s.create(
      'BIL',
      { ...VALID, rule_id: 'RULE_KYC_001', category: 'kyc', conditions: [{ field: 'kyc_doc_expiry_days', operator: '>', value: 30 }] },
      'admin',
      NOW,
    );
    expect(s.list('BIL', { category: 'credit' })).toHaveLength(1);
    expect(s.list('BIL', { category: 'kyc' })).toHaveLength(1);
    expect(s.list('BIL')).toHaveLength(2);
  });

  test('list with state filter', () => {
    const s = new InMemoryEwsRuleStore();
    s.create('BIL', VALID, 'admin', NOW);
    expect(s.list('BIL', { state: 'draft' })).toHaveLength(1);
    expect(s.list('BIL', { state: 'active' })).toHaveLength(0);
  });

  test('list with is_active filter', () => {
    const s = new InMemoryEwsRuleStore();
    s.create('BIL', VALID, 'admin', NOW);
    expect(s.list('BIL', { is_active: false })).toHaveLength(1);
    expect(s.list('BIL', { is_active: true })).toHaveLength(0);
  });

  test('list cross-tenant isolation', () => {
    const s = new InMemoryEwsRuleStore();
    s.create('BIL', VALID, 'admin', NOW);
    expect(s.list('BANK_DEMO')).toEqual([]);
    expect(s.get('BANK_DEMO', VALID.rule_id)).toBeNull();
  });

  test('replace bumps version + updated_at, preserves rule_id + created_at', () => {
    const s = new InMemoryEwsRuleStore();
    const r = s.create('BIL', VALID, 'admin', NOW);
    const later = new Date(NOW.getTime() + 60_000);
    const r2 = s.replace('BIL', r.rule_id, { ...VALID, name: 'Renamed' }, 'admin', later);
    expect(r2.rule_id).toBe(r.rule_id);
    expect(r2.created_at).toBe(r.created_at);
    expect(r2.version).toBe(2);
    expect(r2.name).toBe('Renamed');
    expect(r2.updated_at).toBe(later.toISOString());
  });

  test('replace deprecated rule → illegal_state', () => {
    const s = new InMemoryEwsRuleStore();
    const r = s.create('BIL', VALID, 'admin', NOW);
    s.deprecate('BIL', r.rule_id, NOW);
    try {
      s.replace('BIL', r.rule_id, VALID, 'admin', NOW);
      fail('expected throw');
    } catch (e) {
      expect((e as EwsRuleError).code).toBe('illegal_state');
    }
  });

  test('replace unknown rule → unknown_rule', () => {
    const s = new InMemoryEwsRuleStore();
    expect(() => s.replace('BIL', 'RULE_NONE', VALID, 'admin', NOW)).toThrow(/not found/);
  });

  test('list/get return defensive copies', () => {
    const s = new InMemoryEwsRuleStore();
    const r = s.create('BIL', VALID, 'admin', NOW);
    const fetched = s.get('BIL', r.rule_id)!;
    fetched.name = 'TAMPERED';
    fetched.conditions[0]!.value = 999;
    expect(s.get('BIL', r.rule_id)!.name).toBe(VALID.name);
    expect(s.get('BIL', r.rule_id)!.conditions[0]!.value).toBe(3);
  });
});

describe('InMemoryEwsRuleStore — state transitions', () => {
  test('draft → pending_review via submit()', () => {
    const s = new InMemoryEwsRuleStore();
    const r = s.create('BIL', VALID, 'admin', NOW);
    const r2 = s.submit('BIL', r.rule_id, NOW);
    expect(r2.state).toBe('pending_review');
    expect(r2.is_active).toBe(false);
  });

  test('pending_review → active via activate(); flips is_active=true', () => {
    const s = new InMemoryEwsRuleStore();
    const r = s.create('BIL', VALID, 'admin', NOW);
    s.submit('BIL', r.rule_id, NOW);
    const r2 = s.activate('BIL', r.rule_id, NOW);
    expect(r2.state).toBe('active');
    expect(r2.is_active).toBe(true);
  });

  test('active → deprecated; flips is_active=false; sets deprecated_at', () => {
    const s = new InMemoryEwsRuleStore();
    const r = s.create('BIL', VALID, 'admin', NOW);
    s.submit('BIL', r.rule_id, NOW);
    s.activate('BIL', r.rule_id, NOW);
    const later = new Date(NOW.getTime() + 60_000);
    const r2 = s.deprecate('BIL', r.rule_id, later);
    expect(r2.state).toBe('deprecated');
    expect(r2.is_active).toBe(false);
    expect(r2.deprecated_at).toBe(later.toISOString());
  });

  test('cannot activate from draft (must submit first)', () => {
    const s = new InMemoryEwsRuleStore();
    const r = s.create('BIL', VALID, 'admin', NOW);
    try {
      s.activate('BIL', r.rule_id, NOW);
      fail('expected throw');
    } catch (e) {
      expect((e as EwsRuleError).code).toBe('illegal_transition');
    }
  });

  test('cannot transition from deprecated', () => {
    const s = new InMemoryEwsRuleStore();
    const r = s.create('BIL', VALID, 'admin', NOW);
    s.deprecate('BIL', r.rule_id, NOW);
    try {
      s.activate('BIL', r.rule_id, NOW);
      fail('expected throw');
    } catch (e) {
      expect((e as EwsRuleError).code).toBe('illegal_transition');
    }
    try {
      s.submit('BIL', r.rule_id, NOW);
      fail('expected throw');
    } catch (e) {
      expect((e as EwsRuleError).code).toBe('illegal_transition');
    }
  });

  test('transitions on unknown rule → unknown_rule', () => {
    const s = new InMemoryEwsRuleStore();
    expect(() => s.submit('BIL', 'RULE_NONE', NOW)).toThrow(/not found/);
    expect(() => s.activate('BIL', 'RULE_NONE', NOW)).toThrow(/not found/);
    expect(() => s.deprecate('BIL', 'RULE_NONE', NOW)).toThrow(/not found/);
  });
});

describe('InMemoryEwsRuleStore — execution telemetry', () => {
  function rec(s: InMemoryEwsRuleStore, over: Partial<{ rule_id: string; matched: boolean }> = {}) {
    return s.recordExecution('BIL', {
      rule_id: over.rule_id ?? 'RULE_CREDIT_001',
      entity_type: 'customer',
      entity_id: 'cust-001',
      matched: over.matched ?? true,
      matched_indicators: ['emi_bounce_count_90d'],
      score_impact: 25,
      alert_id: null,
      evaluated_at: NOW.toISOString(),
      duration_us: 50,
    });
  }

  test('recordExecution returns row with monotonic sequence_no', () => {
    const s = new InMemoryEwsRuleStore();
    const a = rec(s);
    const b = rec(s);
    expect(a.sequence_no).toBe(1);
    expect(b.sequence_no).toBe(2);
    expect(a.execution_id).toMatch(/^exe-/);
  });

  test('sequence_no namespace is per-tenant', () => {
    const s = new InMemoryEwsRuleStore();
    rec(s);
    const other = s.recordExecution('BANK_DEMO', {
      rule_id: 'RULE_CREDIT_001',
      entity_type: 'customer',
      entity_id: 'cust-001',
      matched: true,
      matched_indicators: [],
      score_impact: 25,
      alert_id: null,
      evaluated_at: NOW.toISOString(),
      duration_us: 0,
    });
    expect(other.sequence_no).toBe(1);
  });

  test('listExecutionsForRule returns newest-first, scoped to that rule', () => {
    const s = new InMemoryEwsRuleStore();
    rec(s, { rule_id: 'RULE_CREDIT_001' });
    rec(s, { rule_id: 'RULE_KYC_001' });
    rec(s, { rule_id: 'RULE_CREDIT_001' });
    const items = s.listExecutionsForRule('BIL', 'RULE_CREDIT_001', 50);
    expect(items).toHaveLength(2);
    expect(items[0]!.sequence_no).toBeGreaterThan(items[1]!.sequence_no);
  });

  test('listExecutionsForRule respects limit', () => {
    const s = new InMemoryEwsRuleStore();
    for (let i = 0; i < 5; i++) rec(s);
    expect(s.listExecutionsForRule('BIL', 'RULE_CREDIT_001', 3)).toHaveLength(3);
  });

  test('listExecutionsForRule rejects invalid limit', () => {
    const s = new InMemoryEwsRuleStore();
    expect(() => s.listExecutionsForRule('BIL', 'RULE_CREDIT_001', 0)).toThrow(/limit/);
    expect(() => s.listExecutionsForRule('BIL', 'RULE_CREDIT_001', 1.5)).toThrow(/limit/);
    expect(() => s.listExecutionsForRule('BIL', 'RULE_CREDIT_001', 1001)).toThrow(/limit/);
  });

  test('execution telemetry has FIFO retention at the cap', () => {
    const s = new InMemoryEwsRuleStore();
    for (let i = 0; i < 5005; i++) rec(s);
    // Cap is 5000 — listExecutionsForRule should never exceed it for one rule
    const items = s.listExecutionsForRule('BIL', 'RULE_CREDIT_001', 1000);
    expect(items.length).toBeLessThanOrEqual(1000);
    // First (newest) entry is one of the latest few, sequence_no > 5000
    expect(items[0]!.sequence_no).toBeGreaterThan(5000);
  });

  test('matched_indicators are deep-copied', () => {
    const s = new InMemoryEwsRuleStore();
    const e = rec(s);
    e.matched_indicators.push('LEAKED');
    const items = s.listExecutionsForRule('BIL', 'RULE_CREDIT_001', 10);
    expect(items[0]!.matched_indicators).toEqual(['emi_bounce_count_90d']);
  });
});
