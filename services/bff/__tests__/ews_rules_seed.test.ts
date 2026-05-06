// services/bff/__tests__/ews_rules_seed.test.ts
//
// EWS-4 — verifies all 10 default rules pass validateEwsRule, install
// cleanly via seedDefaultEwsRules, and fire when their target indicator
// crosses the rule's threshold.

import {
  EWS_DEFAULT_RULES,
  seedDefaultEwsRules,
  seedToInput,
} from '../src/ews_rules_seed';
import {
  InMemoryEwsRuleStore,
  validateEwsRule,
} from '../src/ews_rules';
import { evaluateRules } from '../src/ews_rules_executor';

const NOW = new Date('2026-05-06T10:00:00.000Z');

describe('EWS-4 — seed catalog', () => {
  test('exactly 10 default rules', () => {
    expect(EWS_DEFAULT_RULES).toHaveLength(10);
  });

  test('every default rule has a unique rule_id', () => {
    const ids = EWS_DEFAULT_RULES.map((r) => r.rule_id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('every brief-mandated rule_id is present', () => {
    const expected = [
      'RULE_CREDIT_001',
      'RULE_LAPSE_001',
      'RULE_FRAUD_001',
      'RULE_KYC_001',
      'RULE_TXN_001',
      'RULE_AGENT_001',
      'RULE_OPS_001',
      'RULE_CONC_001',
      'RULE_BEHAV_001',
      'RULE_SCORE_001',
    ];
    const ids = EWS_DEFAULT_RULES.map((r) => r.rule_id).sort();
    expect(ids).toEqual(expected.sort());
  });

  test('every default rule passes validateEwsRule', () => {
    for (const def of EWS_DEFAULT_RULES) {
      expect(() => validateEwsRule(seedToInput(def))).not.toThrow();
    }
  });

  test('every default rule has a recommended_action', () => {
    for (const def of EWS_DEFAULT_RULES) {
      expect(def.recommended_action.length).toBeGreaterThan(8);
    }
  });

  test('weights sum within budget (≤ 250 across all 10 — leaves headroom for cumulative cap)', () => {
    const total = EWS_DEFAULT_RULES.reduce((s, r) => s + r.weight, 0);
    expect(total).toBeLessThanOrEqual(250);
    expect(total).toBeGreaterThanOrEqual(150);
  });

  test('severity distribution: at least 1 RED, 1 ORANGE, 1 YELLOW (covers full spectrum)', () => {
    const severities = EWS_DEFAULT_RULES.map((r) => r.alert_severity);
    expect(severities).toContain('RED');
    expect(severities).toContain('ORANGE');
    expect(severities).toContain('YELLOW');
  });

  test('every category from the EwsRuleCategory enum is represented', () => {
    const present = new Set(EWS_DEFAULT_RULES.map((r) => r.category));
    expect(present.size).toBe(10);
  });
});

describe('EWS-4 — seedDefaultEwsRules', () => {
  test('happy: creates 10 rules in a clean store', () => {
    const s = new InMemoryEwsRuleStore();
    const out = seedDefaultEwsRules(s, 'BIL', 'system', NOW);
    expect(out).toHaveLength(10);
    expect(out.every((r) => r.status === 'created')).toBe(true);
    expect(s.list('BIL')).toHaveLength(10);
  });

  test('idempotent: re-seeding skips existing', () => {
    const s = new InMemoryEwsRuleStore();
    seedDefaultEwsRules(s, 'BIL', 'system', NOW);
    const out = seedDefaultEwsRules(s, 'BIL', 'system', NOW);
    expect(out.every((r) => r.status === 'skipped_exists')).toBe(true);
    expect(s.list('BIL')).toHaveLength(10);
  });

  test('cross-tenant: BANK_DEMO seed independent of BIL', () => {
    const s = new InMemoryEwsRuleStore();
    seedDefaultEwsRules(s, 'BIL', 'system', NOW);
    const bankOut = seedDefaultEwsRules(s, 'BANK_DEMO', 'system', NOW);
    expect(bankOut.every((r) => r.status === 'created')).toBe(true);
    expect(s.list('BIL')).toHaveLength(10);
    expect(s.list('BANK_DEMO')).toHaveLength(10);
  });

  test('seeded rules are draft + is_active=false', () => {
    const s = new InMemoryEwsRuleStore();
    seedDefaultEwsRules(s, 'BIL', 'system', NOW);
    for (const rule of s.list('BIL')) {
      expect(rule.state).toBe('draft');
      expect(rule.is_active).toBe(false);
    }
  });
});

describe('EWS-4 — each default rule fires when its trigger crosses threshold', () => {
  function activateAll(s: InMemoryEwsRuleStore) {
    for (const rule of s.list('BIL')) {
      s.submit('BIL', rule.rule_id, NOW);
      s.activate('BIL', rule.rule_id, NOW);
    }
  }

  test('RULE_CREDIT_001 fires on emi_bounce_count_90d=4', () => {
    const s = new InMemoryEwsRuleStore();
    seedDefaultEwsRules(s, 'BIL', 'system', NOW);
    activateAll(s);
    const r = evaluateRules({
      tenant_id: 'BIL',
      entity_type: 'customer',
      entity_id: 'cust-1',
      values: { emi_bounce_count_90d: 4 },
      rules: s.list('BIL', { state: 'active', is_active: true }),
      now: NOW,
    });
    const m = r.matches.find((x) => x.rule_id === 'RULE_CREDIT_001');
    expect(m).toBeDefined();
    expect(m!.alert_severity).toBe('RED');
  });

  test('RULE_LAPSE_001 fires on premium_overdue_days=20', () => {
    const s = new InMemoryEwsRuleStore();
    seedDefaultEwsRules(s, 'BIL', 'system', NOW);
    activateAll(s);
    const r = evaluateRules({
      tenant_id: 'BIL',
      entity_type: 'policy',
      entity_id: 'pol-1',
      values: { premium_overdue_days: 20 },
      rules: s.list('BIL', { state: 'active', is_active: true }),
      now: NOW,
    });
    expect(r.matches.find((x) => x.rule_id === 'RULE_LAPSE_001')).toBeDefined();
  });

  test('RULE_FRAUD_001 fires on (claim_ratio=4, policy_age=15)', () => {
    const s = new InMemoryEwsRuleStore();
    seedDefaultEwsRules(s, 'BIL', 'system', NOW);
    activateAll(s);
    const r = evaluateRules({
      tenant_id: 'BIL',
      entity_type: 'claim',
      entity_id: 'CLM-1',
      values: { claim_to_avg_ratio: 4, policy_age_days_at_claim: 15 },
      rules: s.list('BIL', { state: 'active', is_active: true }),
      now: NOW,
    });
    expect(r.matches.find((x) => x.rule_id === 'RULE_FRAUD_001')).toBeDefined();
  });

  test('RULE_FRAUD_001 does NOT fire when only one half of the AND matches', () => {
    const s = new InMemoryEwsRuleStore();
    seedDefaultEwsRules(s, 'BIL', 'system', NOW);
    activateAll(s);
    const r = evaluateRules({
      tenant_id: 'BIL',
      entity_type: 'claim',
      entity_id: 'CLM-1',
      values: { claim_to_avg_ratio: 4, policy_age_days_at_claim: 200 }, // policy too old
      rules: s.list('BIL', { state: 'active', is_active: true }),
      now: NOW,
    });
    expect(r.matches.find((x) => x.rule_id === 'RULE_FRAUD_001')).toBeUndefined();
  });

  test('RULE_KYC_001 fires on kyc_doc_expiry_days=45', () => {
    const s = new InMemoryEwsRuleStore();
    seedDefaultEwsRules(s, 'BIL', 'system', NOW);
    activateAll(s);
    const r = evaluateRules({
      tenant_id: 'BIL',
      entity_type: 'customer',
      entity_id: 'c1',
      values: { kyc_doc_expiry_days: 45 },
      rules: s.list('BIL', { state: 'active', is_active: true }),
      now: NOW,
    });
    expect(r.matches.find((x) => x.rule_id === 'RULE_KYC_001')).toBeDefined();
  });

  test('RULE_TXN_001 fires on txn_amount_to_avg_ratio=12', () => {
    const s = new InMemoryEwsRuleStore();
    seedDefaultEwsRules(s, 'BIL', 'system', NOW);
    activateAll(s);
    const r = evaluateRules({
      tenant_id: 'BIL',
      entity_type: 'customer',
      entity_id: 'c1',
      values: { txn_amount_to_avg_ratio: 12 },
      rules: s.list('BIL', { state: 'active', is_active: true }),
      now: NOW,
    });
    expect(r.matches.find((x) => x.rule_id === 'RULE_TXN_001')).toBeDefined();
  });

  test('RULE_AGENT_001 fires on agent_portfolio_lapse_pct=25', () => {
    const s = new InMemoryEwsRuleStore();
    seedDefaultEwsRules(s, 'BIL', 'system', NOW);
    activateAll(s);
    const r = evaluateRules({
      tenant_id: 'BIL',
      entity_type: 'customer',
      entity_id: 'agt-1',
      values: { agent_portfolio_lapse_pct: 25 },
      rules: s.list('BIL', { state: 'active', is_active: true }),
      now: NOW,
    });
    expect(r.matches.find((x) => x.rule_id === 'RULE_AGENT_001')).toBeDefined();
  });

  test('RULE_OPS_001 fires on login_new_country_24h=1', () => {
    const s = new InMemoryEwsRuleStore();
    seedDefaultEwsRules(s, 'BIL', 'system', NOW);
    activateAll(s);
    const r = evaluateRules({
      tenant_id: 'BIL',
      entity_type: 'customer',
      entity_id: 'c1',
      values: { login_new_country_24h: 1 },
      rules: s.list('BIL', { state: 'active', is_active: true }),
      now: NOW,
    });
    expect(r.matches.find((x) => x.rule_id === 'RULE_OPS_001')).toBeDefined();
  });

  test('RULE_CONC_001 fires on customer_exposure_pct_of_portfolio=35', () => {
    const s = new InMemoryEwsRuleStore();
    seedDefaultEwsRules(s, 'BIL', 'system', NOW);
    activateAll(s);
    const r = evaluateRules({
      tenant_id: 'BIL',
      entity_type: 'customer',
      entity_id: 'whale',
      values: { customer_exposure_pct_of_portfolio: 35 },
      rules: s.list('BIL', { state: 'active', is_active: true }),
      now: NOW,
    });
    expect(r.matches.find((x) => x.rule_id === 'RULE_CONC_001')).toBeDefined();
  });

  test('RULE_BEHAV_001 fires on txn_freq_drop_30d_pct=60', () => {
    const s = new InMemoryEwsRuleStore();
    seedDefaultEwsRules(s, 'BIL', 'system', NOW);
    activateAll(s);
    const r = evaluateRules({
      tenant_id: 'BIL',
      entity_type: 'customer',
      entity_id: 'c1',
      values: { txn_freq_drop_30d_pct: 60 },
      rules: s.list('BIL', { state: 'active', is_active: true }),
      now: NOW,
    });
    expect(r.matches.find((x) => x.rule_id === 'RULE_BEHAV_001')).toBeDefined();
  });

  test('RULE_SCORE_001 fires on risk_score_delta_7d=35', () => {
    const s = new InMemoryEwsRuleStore();
    seedDefaultEwsRules(s, 'BIL', 'system', NOW);
    activateAll(s);
    const r = evaluateRules({
      tenant_id: 'BIL',
      entity_type: 'customer',
      entity_id: 'c1',
      values: { risk_score_delta_7d: 35 },
      rules: s.list('BIL', { state: 'active', is_active: true }),
      now: NOW,
    });
    expect(r.matches.find((x) => x.rule_id === 'RULE_SCORE_001')).toBeDefined();
  });

  test('all 10 firing simultaneously: cumulative_score caps at 100, aggregate=RED', () => {
    const s = new InMemoryEwsRuleStore();
    seedDefaultEwsRules(s, 'BIL', 'system', NOW);
    activateAll(s);
    const r = evaluateRules({
      tenant_id: 'BIL',
      entity_type: 'customer',
      entity_id: 'worst-case',
      values: {
        emi_bounce_count_90d: 5,
        premium_overdue_days: 30,
        claim_to_avg_ratio: 5,
        policy_age_days_at_claim: 10,
        kyc_doc_expiry_days: 60,
        txn_amount_to_avg_ratio: 15,
        agent_portfolio_lapse_pct: 30,
        login_new_country_24h: 1,
        customer_exposure_pct_of_portfolio: 40,
        txn_freq_drop_30d_pct: 70,
        risk_score_delta_7d: 35,
      },
      rules: s.list('BIL', { state: 'active', is_active: true }),
      now: NOW,
    });
    expect(r.matched_count).toBe(10);
    expect(r.cumulative_score).toBe(100); // capped (raw sum is 210)
    expect(r.aggregate_severity).toBe('RED');
  });
});
