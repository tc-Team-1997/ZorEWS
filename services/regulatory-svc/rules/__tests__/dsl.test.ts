import { validateRule, evalExpr, firingIndicators, loadCatalogIds } from '../src/dsl';
import { Rule, Expr } from '../../../../rules/types';

describe('DSL schema validation', () => {
  const goodRule: Rule = {
    id: 'RULE-901',
    version: 1,
    status: 'draft',
    severity: 'high',
    description: 'test rule for DSL validation',
    when: {
      and: [
        { indicator: 'FIN-001', op: 'gte', value: 0.4 },
        { indicator: 'FIN-005', op: 'lt', value: 0.5 },
      ],
    },
    then: {
      title: 'Test alert',
      recommended_action: 'Do something',
    },
  };

  test('accepts a well-formed rule', () => {
    const v = validateRule(goodRule);
    expect(v.ok).toBe(true);
    expect(v.errors).toHaveLength(0);
  });

  test('rejects unknown indicator id', () => {
    const bad: Rule = { ...goodRule, id: 'RULE-902', when: { indicator: 'FIN-999', op: 'gt', value: 1 } };
    const v = validateRule(bad);
    expect(v.ok).toBe(false);
    expect(v.errors.join(',')).toMatch(/unknown indicator/);
  });

  test('rejects malformed id', () => {
    const bad = { ...goodRule, id: 'BAD-ID' } as Rule;
    const v = validateRule(bad);
    expect(v.ok).toBe(false);
  });

  test('rejects between without range', () => {
    const bad: Rule = {
      ...goodRule,
      id: 'RULE-903',
      when: { indicator: 'FIN-001', op: 'between', value: 0.5 } as never,
    };
    const v = validateRule(bad);
    expect(v.ok).toBe(false);
  });

  test('rejects op without value', () => {
    const bad: Rule = {
      ...goodRule,
      id: 'RULE-904',
      when: { indicator: 'FIN-001', op: 'gt' } as never,
    };
    const v = validateRule(bad);
    expect(v.ok).toBe(false);
  });

  test('rejects empty `and`', () => {
    const bad: Rule = {
      ...goodRule,
      id: 'RULE-905',
      when: { and: [{ indicator: 'FIN-001', op: 'gt', value: 0 }] } as never,
    };
    const v = validateRule(bad);
    expect(v.ok).toBe(false);
  });

  test('catalog has at least 30 indicators across the 5 BAC families (FIN/BEH/TXN/CRD/FRD)', () => {
    const ids = loadCatalogIds();
    expect(ids.size).toBeGreaterThanOrEqual(30);
    const fams = new Set(Array.from(ids).map((id) => id.split('-')[0]));
    // FRD added per BAC §3.5 — see T2.11 (fraud-suspicion alert type).
    expect(fams).toEqual(new Set(['FIN', 'BEH', 'TXN', 'CRD', 'FRD']));
  });
});

describe('Expression evaluator', () => {
  test('comparators behave correctly', () => {
    expect(evalExpr({ indicator: 'X', op: 'gt', value: 5 }, { X: 6 })).toBe(true);
    expect(evalExpr({ indicator: 'X', op: 'gte', value: 5 }, { X: 5 })).toBe(true);
    expect(evalExpr({ indicator: 'X', op: 'lt', value: 5 }, { X: 4 })).toBe(true);
    expect(evalExpr({ indicator: 'X', op: 'lte', value: 5 }, { X: 5 })).toBe(true);
    expect(evalExpr({ indicator: 'X', op: 'eq', value: 1 }, { X: 1 })).toBe(true);
    expect(evalExpr({ indicator: 'X', op: 'between', range: [0, 10] }, { X: 5 })).toBe(true);
    expect(evalExpr({ indicator: 'X', op: 'gt', value: 5 }, { X: null })).toBe(false);
  });

  test('AND requires all branches', () => {
    const e: Expr = {
      and: [
        { indicator: 'A', op: 'gt', value: 0 },
        { indicator: 'B', op: 'gt', value: 0 },
      ],
    };
    expect(evalExpr(e, { A: 1, B: 1 })).toBe(true);
    expect(evalExpr(e, { A: 1, B: 0 })).toBe(false);
  });

  test('OR fires on any branch', () => {
    const e: Expr = {
      or: [
        { indicator: 'A', op: 'gt', value: 0 },
        { indicator: 'B', op: 'gt', value: 0 },
      ],
    };
    expect(evalExpr(e, { A: 1, B: 0 })).toBe(true);
    expect(evalExpr(e, { A: 0, B: 0 })).toBe(false);
  });

  test('NOT negates', () => {
    const e: Expr = { not: { indicator: 'A', op: 'gt', value: 0 } };
    expect(evalExpr(e, { A: 0 })).toBe(true);
    expect(evalExpr(e, { A: 1 })).toBe(false);
  });

  test('firingIndicators returns the contributing leaves', () => {
    const e: Expr = {
      and: [
        { indicator: 'A', op: 'gt', value: 0 },
        { or: [
          { indicator: 'B', op: 'gt', value: 0 },
          { indicator: 'C', op: 'gt', value: 0 },
        ] },
      ],
    };
    const out = firingIndicators(e, { A: 1, B: 0, C: 1 });
    expect(out.sort()).toEqual(['A', 'C']);
  });
});
