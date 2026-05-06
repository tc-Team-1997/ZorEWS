// services/bff/__tests__/ews_rules_executor.test.ts
//
// EWS-2 — pure executor tests.

import {
  deriveAggregateSeverity,
  evaluateRules,
  firingIndicators,
  ruleMatches,
  type EvaluationInput,
  type IndicatorValues,
} from '../src/ews_rules_executor';
import { InMemoryEwsRuleStore, type EwsRule } from '../src/ews_rules';

const NOW = new Date('2026-05-06T10:00:00.000Z');

function mkActiveRule(over: Partial<EwsRule> = {}): EwsRule {
  return {
    rule_id: over.rule_id ?? 'RULE_CREDIT_001',
    tenant_id: 'BIL',
    name: over.name ?? 'High EMI Bounce Risk',
    category: over.category ?? 'credit',
    description: 'd',
    conditions: over.conditions ?? [
      { field: 'emi_bounce_count_90d', operator: '>=', value: 3 },
    ],
    logic: over.logic ?? 'AND',
    action: over.action ?? { alert_severity: 'RED', weight: 25 },
    is_active: true,
    state: 'active',
    version: 1,
    tags: [],
    created_by: 'admin',
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
    deprecated_at: null,
  };
}

// ─── deriveAggregateSeverity ─────────────────────────────────────────

describe('EWS-2 — deriveAggregateSeverity', () => {
  test('thresholds: 75/50/25', () => {
    expect(deriveAggregateSeverity(0)).toBe('GREEN');
    expect(deriveAggregateSeverity(24)).toBe('GREEN');
    expect(deriveAggregateSeverity(25)).toBe('YELLOW');
    expect(deriveAggregateSeverity(49)).toBe('YELLOW');
    expect(deriveAggregateSeverity(50)).toBe('ORANGE');
    expect(deriveAggregateSeverity(74)).toBe('ORANGE');
    expect(deriveAggregateSeverity(75)).toBe('RED');
    expect(deriveAggregateSeverity(100)).toBe('RED');
  });
});

// ─── ruleMatches + firingIndicators ──────────────────────────────────

describe('EWS-2 — ruleMatches', () => {
  test('AND rule: all conditions must match', () => {
    const rule = mkActiveRule({
      conditions: [
        { field: 'emi_bounce_count_90d', operator: '>=', value: 3 },
        { field: 'internal_dpd_current', operator: '>', value: 30 },
      ],
      logic: 'AND',
    });
    expect(ruleMatches(rule, { emi_bounce_count_90d: 5, internal_dpd_current: 45 })).toBe(true);
    expect(ruleMatches(rule, { emi_bounce_count_90d: 5, internal_dpd_current: 10 })).toBe(false);
    expect(ruleMatches(rule, { emi_bounce_count_90d: 1, internal_dpd_current: 45 })).toBe(false);
  });

  test('OR rule: any condition triggers', () => {
    const rule = mkActiveRule({
      conditions: [
        { field: 'emi_bounce_count_90d', operator: '>=', value: 3 },
        { field: 'internal_dpd_current', operator: '>', value: 60 },
      ],
      logic: 'OR',
    });
    expect(ruleMatches(rule, { emi_bounce_count_90d: 5, internal_dpd_current: 0 })).toBe(true);
    expect(ruleMatches(rule, { emi_bounce_count_90d: 0, internal_dpd_current: 70 })).toBe(true);
    expect(ruleMatches(rule, { emi_bounce_count_90d: 0, internal_dpd_current: 0 })).toBe(false);
  });

  test('missing indicator value → no match (does not throw)', () => {
    const rule = mkActiveRule();
    expect(ruleMatches(rule, {})).toBe(false);
    expect(ruleMatches(rule, { emi_bounce_count_90d: undefined })).toBe(false);
    expect(ruleMatches(rule, { emi_bounce_count_90d: null })).toBe(false);
  });

  test('NaN value → no match', () => {
    const rule = mkActiveRule();
    expect(ruleMatches(rule, { emi_bounce_count_90d: NaN })).toBe(false);
  });

  test('all 9 operators behave correctly', () => {
    const cases: Array<{ op: '>'|'>='|'<'|'<='|'=='|'!='|'in'|'not_in'|'between'; val: number; expect: boolean; cond: { value?: number | (number|string)[]; range?: [number, number] } }> = [
      { op: '>', val: 5, cond: { value: 3 }, expect: true },
      { op: '>=', val: 3, cond: { value: 3 }, expect: true },
      { op: '<', val: 2, cond: { value: 3 }, expect: true },
      { op: '<=', val: 3, cond: { value: 3 }, expect: true },
      { op: '==', val: 3, cond: { value: 3 }, expect: true },
      { op: '!=', val: 4, cond: { value: 3 }, expect: true },
      { op: 'in', val: 3, cond: { value: [1, 3, 5] }, expect: true },
      { op: 'not_in', val: 4, cond: { value: [1, 3, 5] }, expect: true },
      { op: 'between', val: 4, cond: { range: [3, 5] }, expect: true },
      { op: 'between', val: 6, cond: { range: [3, 5] }, expect: false },
    ];
    for (const c of cases) {
      const rule = mkActiveRule({
        conditions: [{ field: 'emi_bounce_count_90d', operator: c.op, ...c.cond }],
      });
      expect(ruleMatches(rule, { emi_bounce_count_90d: c.val })).toBe(c.expect);
    }
  });

  test('enum equality on string value', () => {
    const rule = mkActiveRule({
      conditions: [
        { field: 'ifrs9_stage_movement', operator: '==', value: 'S2_to_S3' },
      ],
    });
    expect(ruleMatches(rule, { ifrs9_stage_movement: 'S2_to_S3' })).toBe(true);
    expect(ruleMatches(rule, { ifrs9_stage_movement: 'S1_to_S2' })).toBe(false);
  });

  test('firingIndicators returns matching condition fields', () => {
    const rule = mkActiveRule({
      conditions: [
        { field: 'emi_bounce_count_90d', operator: '>=', value: 3 },
        { field: 'internal_dpd_current', operator: '>', value: 30 },
      ],
      logic: 'OR',
    });
    expect(
      firingIndicators(rule, { emi_bounce_count_90d: 5, internal_dpd_current: 0 }),
    ).toEqual(['emi_bounce_count_90d']);
    expect(
      firingIndicators(rule, { emi_bounce_count_90d: 5, internal_dpd_current: 50 }).sort(),
    ).toEqual(['emi_bounce_count_90d', 'internal_dpd_current']);
  });

  test('AND rule with one mismatch returns no firing indicators', () => {
    const rule = mkActiveRule({
      conditions: [
        { field: 'emi_bounce_count_90d', operator: '>=', value: 3 },
        { field: 'internal_dpd_current', operator: '>', value: 30 },
      ],
      logic: 'AND',
    });
    expect(
      firingIndicators(rule, { emi_bounce_count_90d: 5, internal_dpd_current: 0 }),
    ).toEqual([]);
  });
});

// ─── evaluateRules envelope ──────────────────────────────────────────

describe('EWS-2 — evaluateRules', () => {
  function input(rules: EwsRule[], values: IndicatorValues): EvaluationInput {
    return {
      tenant_id: 'BIL',
      entity_type: 'customer',
      entity_id: 'cust-001',
      values,
      rules,
      now: NOW,
    };
  }

  test('no rules → GREEN, score 0', () => {
    const r = evaluateRules(input([], {}));
    expect(r.matched_count).toBe(0);
    expect(r.cumulative_score).toBe(0);
    expect(r.aggregate_severity).toBe('GREEN');
  });

  test('one match: cumulative_score = rule.weight, severity derived', () => {
    const rule = mkActiveRule({ action: { alert_severity: 'RED', weight: 25 } });
    const r = evaluateRules(input([rule], { emi_bounce_count_90d: 5 }));
    expect(r.matched_count).toBe(1);
    expect(r.cumulative_score).toBe(25);
    expect(r.aggregate_severity).toBe('YELLOW');
  });

  test('multiple matches: weights sum, capped at 100', () => {
    const rules: EwsRule[] = [
      mkActiveRule({ rule_id: 'RULE_CREDIT_001', action: { alert_severity: 'RED', weight: 60 } }),
      mkActiveRule({ rule_id: 'RULE_CREDIT_002', action: { alert_severity: 'ORANGE', weight: 40 } }),
      mkActiveRule({ rule_id: 'RULE_CREDIT_003', action: { alert_severity: 'YELLOW', weight: 30 } }),
    ];
    const r = evaluateRules(input(rules, { emi_bounce_count_90d: 5 }));
    expect(r.matched_count).toBe(3);
    expect(r.cumulative_score).toBe(100); // capped (60+40+30=130)
    expect(r.aggregate_severity).toBe('RED');
  });

  test('aggregate_severity follows cumulative thresholds', () => {
    const lowWeights: EwsRule[] = [
      mkActiveRule({ rule_id: 'RULE_CREDIT_001', action: { alert_severity: 'YELLOW', weight: 10 } }),
      mkActiveRule({ rule_id: 'RULE_CREDIT_002', action: { alert_severity: 'YELLOW', weight: 10 } }),
    ];
    const r = evaluateRules(input(lowWeights, { emi_bounce_count_90d: 5 }));
    expect(r.cumulative_score).toBe(20);
    expect(r.aggregate_severity).toBe('GREEN'); // 20 < YELLOW threshold (25)
  });

  test('matches carry rule_id, name, severity, weight, recommended_action, fired indicators', () => {
    const rule = mkActiveRule({
      action: { alert_severity: 'RED', weight: 25, recommended_action: 'Pause disbursement' },
    });
    const r = evaluateRules(input([rule], { emi_bounce_count_90d: 5 }));
    const m = r.matches[0]!;
    expect(m.rule_id).toBe('RULE_CREDIT_001');
    expect(m.name).toBe('High EMI Bounce Risk');
    expect(m.alert_severity).toBe('RED');
    expect(m.weight).toBe(25);
    expect(m.recommended_action).toBe('Pause disbursement');
    expect(m.matched_indicators).toEqual(['emi_bounce_count_90d']);
  });

  test('non-matching rules excluded from `matches` but counted in rule_count', () => {
    const rules: EwsRule[] = [
      mkActiveRule({ rule_id: 'RULE_CREDIT_001' }), // condition >=3
      mkActiveRule({
        rule_id: 'RULE_CREDIT_002',
        action: { alert_severity: 'YELLOW', weight: 10 },
        conditions: [{ field: 'emi_bounce_count_90d', operator: '>=', value: 99 }],
      }),
    ];
    // Only first matches (value 5 >= 3 but not >= 99).
    const r = evaluateRules(input(rules, { emi_bounce_count_90d: 5 }));
    expect(r.rule_count).toBe(2);
    expect(r.matched_count).toBe(1);
    expect(r.matches.map((m) => m.rule_id)).toEqual(['RULE_CREDIT_001']);
  });

  test('result envelope echoes tenant_id, entity_type, entity_id, evaluated_at', () => {
    const rule = mkActiveRule();
    const r = evaluateRules({
      tenant_id: 'BANK_DEMO',
      entity_type: 'policy',
      entity_id: 'POL-42',
      values: { emi_bounce_count_90d: 5 },
      rules: [rule],
      now: NOW,
    });
    expect(r.tenant_id).toBe('BANK_DEMO');
    expect(r.entity_type).toBe('policy');
    expect(r.entity_id).toBe('POL-42');
    expect(r.evaluated_at).toBe(NOW.toISOString());
  });

  test('duration_us is a non-negative number', () => {
    const rule = mkActiveRule();
    const r = evaluateRules(input([rule], { emi_bounce_count_90d: 5 }));
    expect(r.duration_us).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(r.duration_us)).toBe(true);
  });
});

// ─── Brief sample rules — end-to-end ─────────────────────────────────

describe('EWS-2 — brief sample rules round-trip', () => {
  function buildBriefRules(): EwsRule[] {
    return [
      mkActiveRule({
        rule_id: 'RULE_CREDIT_001',
        category: 'credit',
        conditions: [{ field: 'emi_bounce_count_90d', operator: '>=', value: 3 }],
        action: { alert_severity: 'RED', weight: 25 },
      }),
      mkActiveRule({
        rule_id: 'RULE_LAPSE_001',
        category: 'lapse',
        conditions: [{ field: 'premium_overdue_days', operator: '>', value: 15 }],
        action: { alert_severity: 'ORANGE', weight: 20 },
      }),
      mkActiveRule({
        rule_id: 'RULE_FRAUD_001',
        category: 'fraud',
        conditions: [
          { field: 'claim_to_avg_ratio', operator: '>', value: 3 },
          { field: 'policy_age_days_at_claim', operator: '<', value: 30 },
        ],
        logic: 'AND',
        action: { alert_severity: 'RED', weight: 30 },
      }),
      mkActiveRule({
        rule_id: 'RULE_KYC_001',
        category: 'kyc',
        conditions: [{ field: 'kyc_doc_expiry_days', operator: '>', value: 30 }],
        action: { alert_severity: 'YELLOW', weight: 10 },
      }),
    ];
  }

  test('high-risk customer triggers credit + KYC, score 35 → YELLOW', () => {
    const rules = buildBriefRules();
    const r = evaluateRules({
      tenant_id: 'BIL',
      entity_type: 'customer',
      entity_id: 'cust-001',
      values: {
        emi_bounce_count_90d: 5,
        kyc_doc_expiry_days: 60,
        premium_overdue_days: 0,
        claim_to_avg_ratio: 0,
        policy_age_days_at_claim: 999,
      },
      rules,
      now: NOW,
    });
    expect(r.matched_count).toBe(2);
    expect(r.cumulative_score).toBe(35);
    expect(r.aggregate_severity).toBe('YELLOW');
  });

  test('fraud signal compound: > 3× claim AND policy < 30 days', () => {
    const rules = buildBriefRules();
    const r = evaluateRules({
      tenant_id: 'BIL',
      entity_type: 'claim',
      entity_id: 'CLM-1',
      values: {
        claim_to_avg_ratio: 4,
        policy_age_days_at_claim: 15,
      },
      rules,
      now: NOW,
    });
    const fraud = r.matches.find((m) => m.rule_id === 'RULE_FRAUD_001');
    expect(fraud).toBeDefined();
    expect(fraud!.matched_indicators.sort()).toEqual([
      'claim_to_avg_ratio',
      'policy_age_days_at_claim',
    ]);
  });

  test('only ratio without policy-age: AND rule does NOT fire', () => {
    const rules = buildBriefRules();
    const r = evaluateRules({
      tenant_id: 'BIL',
      entity_type: 'claim',
      entity_id: 'CLM-1',
      values: {
        claim_to_avg_ratio: 4,
        policy_age_days_at_claim: 200,
      },
      rules,
      now: NOW,
    });
    expect(r.matches.find((m) => m.rule_id === 'RULE_FRAUD_001')).toBeUndefined();
  });

  test('1000 rules × single entity → completes well under 500ms perf budget', () => {
    // Synthesize 1000 simple AND rules, half will match.
    const rules: EwsRule[] = [];
    for (let i = 0; i < 1000; i++) {
      rules.push(
        mkActiveRule({
          rule_id: `RULE_CREDIT_${String(i).padStart(4, '0')}`,
          name: `Synth ${i}`,
          conditions: [
            { field: 'emi_bounce_count_90d', operator: '>=', value: i % 2 === 0 ? 3 : 99 },
          ],
          action: { alert_severity: 'YELLOW', weight: 1 },
        }),
      );
    }
    const t0 = Date.now();
    const r = evaluateRules({
      tenant_id: 'BIL',
      entity_type: 'customer',
      entity_id: 'cust-001',
      values: { emi_bounce_count_90d: 5 },
      rules,
      now: NOW,
    });
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(500);
    expect(r.rule_count).toBe(1000);
    expect(r.matched_count).toBe(500); // every other rule
    expect(r.cumulative_score).toBe(100); // 500 × weight 1, capped
  });
});

// ─── Integration with the store ──────────────────────────────────────

describe('EWS-2 — store + executor end-to-end', () => {
  test('fetch rules from store → evaluate → record telemetry', () => {
    const s = new InMemoryEwsRuleStore();
    s.create('BIL', {
      rule_id: 'RULE_CREDIT_001',
      name: 'High EMI Bounce Risk',
      category: 'credit',
      description: 'd',
      conditions: [{ field: 'emi_bounce_count_90d', operator: '>=', value: 3 }],
      logic: 'AND',
      action: { alert_severity: 'RED', weight: 25 },
    }, 'admin', NOW);
    s.submit('BIL', 'RULE_CREDIT_001', NOW);
    s.activate('BIL', 'RULE_CREDIT_001', NOW);

    const activeRules = s.list('BIL', { state: 'active', is_active: true });
    expect(activeRules).toHaveLength(1);

    const result = evaluateRules({
      tenant_id: 'BIL',
      entity_type: 'customer',
      entity_id: 'cust-001',
      values: { emi_bounce_count_90d: 5 },
      rules: activeRules,
      now: NOW,
    });
    expect(result.matched_count).toBe(1);

    // Record an execution telemetry row per match.
    for (const m of result.matches) {
      s.recordExecution('BIL', {
        rule_id: m.rule_id,
        entity_type: 'customer',
        entity_id: 'cust-001',
        matched: true,
        matched_indicators: m.matched_indicators,
        score_impact: m.weight,
        alert_id: null,
        evaluated_at: NOW.toISOString(),
        duration_us: result.duration_us,
      });
    }

    const hits = s.listExecutionsForRule('BIL', 'RULE_CREDIT_001', 50);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.matched).toBe(true);
    expect(hits[0]!.score_impact).toBe(25);
  });
});
