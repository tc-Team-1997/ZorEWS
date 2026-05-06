// services/bff/__tests__/ews_rules_validation.test.ts
//
// EWS-1 — rule validator tests.

import {
  ALERT_SEVERITIES,
  AGGREGATE_SEVERITY_THRESHOLDS,
  EWS_OPERATORS,
  EWS_RULE_CATEGORIES,
  EWS_RULE_STATES,
  EwsRuleError,
  isAlertSeverity,
  isEwsOperator,
  isEwsRuleCategory,
  isEwsRuleState,
  validateEwsRule,
} from '../src/ews_rules';

const VALID = {
  rule_id: 'RULE_CREDIT_001',
  name: 'High EMI Bounce Risk',
  category: 'credit' as const,
  description: '3+ EMI bounces in 90 days indicates servicing distress.',
  conditions: [
    { field: 'emi_bounce_count_90d', operator: '>=', value: 3 },
  ],
  logic: 'AND' as const,
  action: { alert_severity: 'RED' as const, weight: 25 },
  is_active: true,
};

describe('EWS-1 — guards', () => {
  test('isAlertSeverity', () => {
    for (const s of ALERT_SEVERITIES) expect(isAlertSeverity(s)).toBe(true);
    expect(isAlertSeverity('purple')).toBe(false);
  });

  test('isEwsRuleCategory', () => {
    for (const c of EWS_RULE_CATEGORIES) expect(isEwsRuleCategory(c)).toBe(true);
    expect(isEwsRuleCategory('liquidity')).toBe(false);
  });

  test('isEwsRuleState', () => {
    for (const s of EWS_RULE_STATES) expect(isEwsRuleState(s)).toBe(true);
    expect(isEwsRuleState('approved')).toBe(false); // 6-state vocabulary not adopted
  });

  test('isEwsOperator', () => {
    for (const o of EWS_OPERATORS) expect(isEwsOperator(o)).toBe(true);
    expect(isEwsOperator('LIKE')).toBe(false);
  });

  test('aggregate severity thresholds match RFC', () => {
    expect(AGGREGATE_SEVERITY_THRESHOLDS.RED).toBe(75);
    expect(AGGREGATE_SEVERITY_THRESHOLDS.ORANGE).toBe(50);
    expect(AGGREGATE_SEVERITY_THRESHOLDS.YELLOW).toBe(25);
  });
});

describe('EWS-1 — validateEwsRule happy path', () => {
  test('happy: brief sample rule round-trips', () => {
    const out = validateEwsRule(VALID);
    expect(out.rule_id).toBe('RULE_CREDIT_001');
    expect(out.conditions).toHaveLength(1);
    expect(out.conditions[0]!.field).toBe('emi_bounce_count_90d');
    expect(out.action.alert_severity).toBe('RED');
    expect(out.tags).toEqual([]);
  });

  test('preserves recommended_action', () => {
    const out = validateEwsRule({
      ...VALID,
      action: { ...VALID.action, recommended_action: 'Pause disbursement; call RM' },
    });
    expect(out.action.recommended_action).toBe('Pause disbursement; call RM');
  });

  test('tags supported up to 10', () => {
    const tags = Array.from({ length: 10 }, (_, i) => `t-${i}`);
    const out = validateEwsRule({ ...VALID, tags });
    expect(out.tags).toEqual(tags);
  });
});

describe('EWS-1 — validateEwsRule rejects', () => {
  test('missing rule_id → invalid_input', () => {
    const { rule_id, ...rest } = VALID;
    void rule_id;
    expect(() => validateEwsRule(rest)).toThrow(/rule_id/);
  });

  test('rule_id pattern enforced (must be RULE_*)', () => {
    expect(() => validateEwsRule({ ...VALID, rule_id: 'rule-001' })).toThrow(/rule_id/);
    expect(() => validateEwsRule({ ...VALID, rule_id: 'RULE_x' })).toThrow(/rule_id/);
  });

  test('empty name → invalid_input', () => {
    expect(() => validateEwsRule({ ...VALID, name: '' })).toThrow(/name/);
  });

  test('name > 80 chars → invalid_input', () => {
    expect(() => validateEwsRule({ ...VALID, name: 'x'.repeat(81) })).toThrow(/80/);
  });

  test('bad category → invalid_input', () => {
    expect(() => validateEwsRule({ ...VALID, category: 'liquidity' as never })).toThrow(/category/);
  });

  test('empty description → invalid_input', () => {
    expect(() => validateEwsRule({ ...VALID, description: '' })).toThrow(/description/);
  });

  test('description > 500 → invalid_input', () => {
    expect(() => validateEwsRule({ ...VALID, description: 'x'.repeat(501) })).toThrow(
      /500/,
    );
  });

  test('empty conditions[] → invalid_input', () => {
    expect(() => validateEwsRule({ ...VALID, conditions: [] })).toThrow(/conditions/);
  });

  test('> 12 conditions → invalid_input', () => {
    const conditions = Array.from({ length: 13 }, () => VALID.conditions[0]!);
    expect(() => validateEwsRule({ ...VALID, conditions })).toThrow(/at most 12/);
  });

  test('unknown indicator → unknown_indicator', () => {
    expect(() =>
      validateEwsRule({
        ...VALID,
        conditions: [{ field: 'no_such_indicator', operator: '>=', value: 3 }],
      }),
    ).toThrow(/no_such_indicator/);
  });

  test('non-numeric value on numeric indicator → invalid_input', () => {
    expect(() =>
      validateEwsRule({
        ...VALID,
        conditions: [{ field: 'emi_bounce_count_90d', operator: '>=', value: 'three' as never }],
      }),
    ).toThrow(/finite number/);
  });

  test('value outside indicator range → invalid_input', () => {
    expect(() =>
      validateEwsRule({
        ...VALID,
        conditions: [{ field: 'emi_bounce_count_90d', operator: '>=', value: 999 }],
      }),
    ).toThrow(/outside indicator range/);
  });

  test('between requires range (not value)', () => {
    expect(() =>
      validateEwsRule({
        ...VALID,
        conditions: [{ field: 'emi_bounce_count_90d', operator: 'between', value: 3 }],
      }),
    ).toThrow(/between/);
  });

  test('between with min > max rejected', () => {
    expect(() =>
      validateEwsRule({
        ...VALID,
        conditions: [
          { field: 'emi_bounce_count_90d', operator: 'between', range: [10, 1] },
        ],
      }),
    ).toThrow(/min ≤ max/);
  });

  test('in/not_in requires non-empty array', () => {
    expect(() =>
      validateEwsRule({
        ...VALID,
        conditions: [{ field: 'emi_bounce_count_90d', operator: 'in', value: [] }],
      }),
    ).toThrow(/non-empty array/);
  });

  test('in/not_in items validated against indicator range', () => {
    expect(() =>
      validateEwsRule({
        ...VALID,
        conditions: [{ field: 'emi_bounce_count_90d', operator: 'in', value: [3, 999] }],
      }),
    ).toThrow(/outside indicator range/);
  });

  test('enum indicator only supports ==/!=/in/not_in', () => {
    expect(() =>
      validateEwsRule({
        ...VALID,
        conditions: [{ field: 'ifrs9_stage_movement', operator: '>', value: 'S2_to_S3' as never }],
      }),
    ).toThrow(/enum indicator/);
  });

  test('enum value must be in indicator enum_values', () => {
    expect(() =>
      validateEwsRule({
        ...VALID,
        conditions: [{ field: 'ifrs9_stage_movement', operator: '==', value: 'S99' }],
      }),
    ).toThrow(/not in enum/);
  });

  test('enum value with == accepted', () => {
    const out = validateEwsRule({
      ...VALID,
      conditions: [{ field: 'ifrs9_stage_movement', operator: '==', value: 'S2_to_S3' }],
    });
    expect(out.conditions[0]!.value).toBe('S2_to_S3');
  });

  test('bad logic → invalid_input', () => {
    expect(() => validateEwsRule({ ...VALID, logic: 'XOR' as never })).toThrow(/logic/);
  });

  test('missing action → invalid_input', () => {
    const { action, ...rest } = VALID;
    void action;
    expect(() => validateEwsRule(rest)).toThrow(/action/);
  });

  test('bad alert_severity → invalid_input', () => {
    expect(() =>
      validateEwsRule({
        ...VALID,
        action: { ...VALID.action, alert_severity: 'PURPLE' as never },
      }),
    ).toThrow(/alert_severity/);
  });

  test('weight out of [1, 100] → invalid_input', () => {
    expect(() =>
      validateEwsRule({ ...VALID, action: { ...VALID.action, weight: 0 } }),
    ).toThrow(/weight/);
    expect(() =>
      validateEwsRule({ ...VALID, action: { ...VALID.action, weight: 101 } }),
    ).toThrow(/weight/);
    expect(() =>
      validateEwsRule({ ...VALID, action: { ...VALID.action, weight: 1.5 } }),
    ).toThrow(/weight/);
  });

  test('weight = 1 and weight = 100 accepted', () => {
    const a1 = validateEwsRule({ ...VALID, action: { ...VALID.action, weight: 1 } });
    expect(a1.action.weight).toBe(1);
    const a2 = validateEwsRule({ ...VALID, action: { ...VALID.action, weight: 100 } });
    expect(a2.action.weight).toBe(100);
  });

  test('recommended_action > 280 chars rejected', () => {
    expect(() =>
      validateEwsRule({
        ...VALID,
        action: { ...VALID.action, recommended_action: 'x'.repeat(281) },
      }),
    ).toThrow(/280/);
  });

  test('non-boolean is_active rejected', () => {
    expect(() => validateEwsRule({ ...VALID, is_active: 'yes' as never })).toThrow(/is_active/);
  });

  test('> 10 tags rejected', () => {
    const tags = Array.from({ length: 11 }, (_, i) => `t-${i}`);
    expect(() => validateEwsRule({ ...VALID, tags })).toThrow(/at most 10/);
  });

  test('non-string tag rejected', () => {
    expect(() => validateEwsRule({ ...VALID, tags: ['ok', 7] as never })).toThrow(/tag/);
  });
});

describe('EWS-1 — example rules from brief', () => {
  test('RULE_KYC_001 (kyc category, YELLOW, KYC > 30 days)', () => {
    const out = validateEwsRule({
      rule_id: 'RULE_KYC_001',
      name: 'KYC document expired',
      category: 'kyc',
      description: 'KYC document overdue beyond 30 days requires re-verification.',
      conditions: [{ field: 'kyc_doc_expiry_days', operator: '>', value: 30 }],
      logic: 'AND',
      action: { alert_severity: 'YELLOW', weight: 10 },
      is_active: true,
    });
    expect(out.action.alert_severity).toBe('YELLOW');
  });

  test('RULE_FRAUD_001 (composite condition, RED)', () => {
    const out = validateEwsRule({
      rule_id: 'RULE_FRAUD_001',
      name: 'High-claim early-policy fraud signal',
      category: 'fraud',
      description:
        'Claim more than 3× customer’s average AND filed within 30 days of policy inception.',
      conditions: [
        { field: 'claim_to_avg_ratio', operator: '>', value: 3 },
        { field: 'policy_age_days_at_claim', operator: '<', value: 30 },
      ],
      logic: 'AND',
      action: { alert_severity: 'RED', weight: 30 },
      is_active: true,
    });
    expect(out.conditions).toHaveLength(2);
    expect(out.logic).toBe('AND');
  });

  test('RULE_OPS_001 (flag indicator)', () => {
    const out = validateEwsRule({
      rule_id: 'RULE_OPS_001',
      name: 'Login from new country',
      category: 'ops',
      description: 'First-time login from a country not seen before.',
      conditions: [{ field: 'login_new_country_24h', operator: '==', value: 1 }],
      logic: 'AND',
      action: { alert_severity: 'YELLOW', weight: 15 },
      is_active: true,
    });
    expect(out.conditions[0]!.value).toBe(1);
  });
});

describe('EWS-1 — error code surfaces', () => {
  test('EwsRuleError carries code', () => {
    try {
      validateEwsRule({});
      fail('expected throw');
    } catch (e) {
      expect((e as EwsRuleError).code).toBe('invalid_input');
    }
  });

  test('unknown_indicator code distinct from invalid_input', () => {
    try {
      validateEwsRule({
        ...VALID,
        conditions: [{ field: 'totally_made_up', operator: '>=', value: 1 }],
      });
      fail('expected throw');
    } catch (e) {
      expect((e as EwsRuleError).code).toBe('unknown_indicator');
    }
  });
});
