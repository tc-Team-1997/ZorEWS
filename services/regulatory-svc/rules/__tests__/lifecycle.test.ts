import { RuleStore } from '../src/lifecycle';
import { Rule } from '../../../../rules/types';

const baseRule: Rule = {
  id: 'RULE-801',
  version: 1,
  status: 'draft',
  severity: 'medium',
  description: 'lifecycle test rule',
  when: { indicator: 'FIN-001', op: 'gt', value: 0.5 },
  then: { title: 'Test alert', recommended_action: 'Test action' },
};

describe('RuleStore lifecycle', () => {
  test('create requires schema-valid rule', () => {
    const store = new RuleStore();
    expect(() =>
      store.create({ ...baseRule, id: 'BAD-FORMAT' as Rule['id'] }),
    ).toThrow();
  });

  test('create draft, then sim, then promote', () => {
    const store = new RuleStore();
    const r = store.create({ ...baseRule, id: 'RULE-810' });
    expect(r.status).toBe('draft');

    store.recordSimulation('RULE-810', {
      rule_id: 'RULE-810',
      total_firings: 100,
      fp_rate: 0.1,
      median_lead_time_days: 30,
    });
    expect(store.get('RULE-810')!.status).toBe('simulate');

    store.promote('RULE-810');
    expect(store.get('RULE-810')!.status).toBe('live');
  });

  test('promote without simulate is rejected', () => {
    const store = new RuleStore();
    store.create({ ...baseRule, id: 'RULE-811' });
    expect(() => store.promote('RULE-811')).toThrow(/promote requires status=simulate/);
  });

  test('promote when sim FP rate exceeds threshold is rejected', () => {
    const store = new RuleStore();
    store.create({ ...baseRule, id: 'RULE-812' });
    store.recordSimulation('RULE-812', {
      rule_id: 'RULE-812',
      total_firings: 100,
      fp_rate: 0.5,
      median_lead_time_days: 10,
    });
    expect(() => store.promote('RULE-812')).toThrow(/FP rate/);
    expect(store.get('RULE-812')!.status).toBe('simulate');
  });

  test('retire works from any non-retired state', () => {
    const store = new RuleStore();
    store.create({ ...baseRule, id: 'RULE-813' });
    store.retire('RULE-813', 'agent-rule', 'superseded');
    expect(store.get('RULE-813')!.status).toBe('retired');
    expect(() => store.retire('RULE-813')).toThrow(/already retired/);
  });

  test('audit log records every transition', () => {
    const store = new RuleStore();
    store.create({ ...baseRule, id: 'RULE-814' });
    store.recordSimulation('RULE-814', {
      rule_id: 'RULE-814',
      total_firings: 100,
      fp_rate: 0.1,
      median_lead_time_days: 20,
    });
    store.promote('RULE-814');
    store.retire('RULE-814');
    const auditForRule = store.audit.filter((a) => a.rule_id === 'RULE-814');
    expect(auditForRule.map((a) => a.to)).toEqual(['draft', 'simulate', 'live', 'retired']);
  });

  test('duplicate id is rejected', () => {
    const store = new RuleStore();
    store.create({ ...baseRule, id: 'RULE-815' });
    expect(() => store.create({ ...baseRule, id: 'RULE-815' })).toThrow(/already exists/);
  });
});
