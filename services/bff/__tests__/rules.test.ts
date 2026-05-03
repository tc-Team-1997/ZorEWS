import request from 'supertest';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';
import { RuleStore } from '../src/rules/store';
import { SEED_RULES } from '../src/rules/seed';
import {
  applyTransition,
  IllegalTransition,
  InvalidPayload,
  legalTransitions,
} from '../src/rules/state_machine';
import { backtest } from '../src/rules/backtest';
import { performanceFor } from '../src/rules/performance';
import { findVariable, VARIABLE_LIBRARY, variablesByCategory } from '../src/rules/variables';
import type { RuleV2 } from '../src/rules/types';

const NOW = new Date('2026-04-29T12:00:00.000Z');

function makeRulesApp(role: string = 'admin', store?: RuleStore) {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    ruleStore: store ?? new RuleStore(),
    now: () => NOW,
    getRole: () => role,
  });
}

function fixture(overrides: Partial<RuleV2> = {}): RuleV2 {
  return {
    id: 'r-test',
    name: 'Test rule',
    family: 'Behavioural',
    applicable_products: [],
    state: 'draft',
    version: '0.1.0',
    owner_id: 'risk.maker.alpha',
    conditions: {
      kind: 'group',
      op: 'AND',
      children: [
        { kind: 'leaf', condition: { variable_id: 'current_dpd', op: '>=', value: 30 } },
      ],
    },
    outcome: { severity: 'medium', alert_priority: 'P3', notify_roles: ['risk_analyst'] },
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
    audit: [],
    ...overrides,
  };
}

// ── Variable library ───────────────────────────────────────────────────

describe('variable library', () => {
  test('catalog has 30 variables across 5 categories', () => {
    expect(VARIABLE_LIBRARY.length).toBe(30);
    const cats = new Set(VARIABLE_LIBRARY.map((v) => v.category));
    expect(cats).toEqual(new Set(['account', 'loan', 'customer', 'transaction', 'external']));
  });

  test('every variable has id, label, description, refresh', () => {
    for (const v of VARIABLE_LIBRARY) {
      expect(v.id).toMatch(/^[a-z0-9_]+$/);
      expect(v.label.length).toBeGreaterThan(0);
      expect(v.description.length).toBeGreaterThan(0);
      expect(['realtime', 'daily', 'monthly', 'quarterly']).toContain(v.refresh);
    }
  });

  test('variablesByCategory groups correctly', () => {
    const grouped = variablesByCategory();
    expect(grouped.account.length + grouped.loan.length + grouped.customer.length +
           grouped.transaction.length + grouped.external.length).toBe(30);
  });

  test('findVariable returns by id', () => {
    expect(findVariable('current_dpd')?.label).toBe('Current DPD');
    expect(findVariable('does_not_exist')).toBeUndefined();
  });
});

// ── State machine ──────────────────────────────────────────────────────

describe('state machine — applyTransition()', () => {
  const ctx = { actor_id: 'alice', actor_role: 'risk_analyst', ts: NOW.toISOString() };

  test('draft → submit → pending_review', () => {
    const r = fixture({ state: 'draft' });
    const next = applyTransition(r, 'submit', ctx);
    expect(next.state).toBe('pending_review');
    expect(next.submitted_by).toBe('alice');
    expect(next.audit[0].kind).toBe('submitted');
  });

  test('pending_review → approve → approved', () => {
    const r = fixture({ state: 'pending_review' });
    const next = applyTransition(r, 'approve', ctx);
    expect(next.state).toBe('approved');
    expect(next.approved_by).toBe('alice');
  });

  test('pending_review → reject (with comment) → draft + clears bookkeeping', () => {
    const r = fixture({ state: 'pending_review', submitted_by: 'bob' });
    const next = applyTransition(r, 'reject', { ...ctx, comment: 'Threshold too loose' });
    expect(next.state).toBe('draft');
    expect(next.submitted_by).toBeNull();
    expect(next.audit[0].comment).toBe('Threshold too loose');
  });

  test('reject without a comment throws InvalidPayload', () => {
    const r = fixture({ state: 'pending_review' });
    expect(() => applyTransition(r, 'reject', ctx)).toThrow(InvalidPayload);
  });

  test('approved → activate → active', () => {
    const r = fixture({ state: 'approved' });
    const next = applyTransition(r, 'activate', ctx);
    expect(next.state).toBe('active');
    expect(next.audit[0].kind).toBe('activated');
  });

  test('active → deprecate → deprecated', () => {
    const r = fixture({ state: 'active' });
    const next = applyTransition(r, 'deprecate', ctx);
    expect(next.state).toBe('deprecated');
  });

  test('illegal transitions throw IllegalTransition', () => {
    expect(() => applyTransition(fixture({ state: 'draft' }), 'approve', ctx)).toThrow(
      IllegalTransition,
    );
    expect(() => applyTransition(fixture({ state: 'deprecated' }), 'activate', ctx)).toThrow(
      IllegalTransition,
    );
  });

  test('legalTransitions surface what UI buttons should be enabled', () => {
    expect(legalTransitions('draft').sort()).toEqual(['edit', 'submit']);
    expect(legalTransitions('pending_review').sort()).toEqual(['approve', 'reject']);
    expect(legalTransitions('approved').sort()).toEqual(['activate', 'deprecate']);
    expect(legalTransitions('active').sort()).toEqual(['deprecate', 'edit']);
    expect(legalTransitions('deprecated')).toEqual([]);
  });
});

// ── Backtest ──────────────────────────────────────────────────────────

describe('backtest()', () => {
  test('produces 12 monthly buckets ending at the anchor date', () => {
    const r = SEED_RULES.find((r) => r.id === 'r-22')!;
    const bt = backtest(r, NOW);
    expect(bt.monthly_volume).toHaveLength(12);
    expect(bt.window_end).toBe(NOW.toISOString().slice(0, 10));
  });

  test('TP + FP add up to total_alerts', () => {
    const r = SEED_RULES.find((r) => r.id === 'r-09')!;
    const bt = backtest(r, NOW);
    expect(bt.true_positives + bt.false_positives).toBe(bt.total_alerts);
  });

  test('precision and coverage are within [0,100]', () => {
    for (const r of SEED_RULES) {
      const bt = backtest(r, NOW);
      expect(bt.precision_pct).toBeGreaterThanOrEqual(0);
      expect(bt.precision_pct).toBeLessThanOrEqual(100);
      expect(bt.coverage_pct).toBeGreaterThanOrEqual(0);
      expect(bt.coverage_pct).toBeLessThanOrEqual(100);
    }
  });

  test('deterministic — same rule + same date → identical result', () => {
    const r = SEED_RULES[0];
    expect(backtest(r, NOW)).toEqual(backtest(r, NOW));
  });

  test('critical rules are tighter (lower volume) than low rules', () => {
    const critical = backtest(fixture({ outcome: { ...fixture().outcome, severity: 'critical' } }), NOW);
    const low = backtest(fixture({ outcome: { ...fixture().outcome, severity: 'low' } }), NOW);
    expect(critical.total_alerts).toBeLessThan(low.total_alerts);
  });
});

// ── Performance ───────────────────────────────────────────────────────

describe('performanceFor()', () => {
  test('active rule with reasonable precision → performing', () => {
    const r = fixture({ state: 'active', outcome: { ...fixture().outcome, severity: 'critical' } });
    expect(performanceFor(r, NOW).status).toBe('performing');
  });

  test('deprecated rule → status deprecated', () => {
    const r = fixture({ state: 'deprecated' });
    expect(performanceFor(r, NOW).status).toBe('deprecated');
  });

  test('non-active states → no_data', () => {
    expect(performanceFor(fixture({ state: 'draft' }), NOW).status).toBe('no_data');
    expect(performanceFor(fixture({ state: 'pending_review' }), NOW).status).toBe('no_data');
  });
});

// ── Routes ────────────────────────────────────────────────────────────

const TH = { 'X-Tenant-ID': 'BANK_DEMO', 'X-Channel': 'API' };

describe('GET /v1/rules/variables', () => {
  test('returns the catalog grouped by category', async () => {
    const { app } = makeRulesApp();
    const r = await request(app).get('/v1/rules/variables').set(TH);
    expect(r.status).toBe(200);
    expect(Object.keys(r.body.categories).sort()).toEqual([
      'account', 'customer', 'external', 'loan', 'transaction',
    ]);
  });

  test('field_officer can read the variable library (rules:list is read-only)', async () => {
    const { app } = makeRulesApp('field_officer');
    const r = await request(app).get('/v1/rules/variables').set(TH);
    expect(r.status).toBe(200);
  });

  test('role-less request 403', async () => {
    const app = makeApp({
      source: new StaticSource([]),
      evaluator: new StubEvaluator(),
      riskProfile: new StubRiskProfileSource(),
      caseAction: new UnavailableCaseActionSink(),
      ruleStore: new RuleStore(),
      now: () => NOW,
      getRole: () => null,
    });
    const r = await request(app.app).get('/v1/rules/variables').set(TH);
    expect([401, 403]).toContain(r.status);
  });
});

describe('GET /v1/rules', () => {
  test('returns enriched rules with performance + legal_transitions', async () => {
    const { app } = makeRulesApp();
    const r = await request(app).get('/v1/rules').set(TH);
    expect(r.status).toBe(200);
    expect(r.body.items.length).toBeGreaterThan(0);
    const first = r.body.items[0];
    expect(first.performance).toBeDefined();
    expect(Array.isArray(first.legal_transitions)).toBe(true);
  });

  test('filters by state', async () => {
    const { app } = makeRulesApp();
    const r = await request(app).get('/v1/rules?state=active').set(TH);
    expect(r.status).toBe(200);
    for (const item of r.body.items) expect(item.state).toBe('active');
  });

  test('filters by product (rules with empty applicable_products always match)', async () => {
    const { app } = makeRulesApp();
    const r = await request(app).get('/v1/rules?product=credit_card').set(TH);
    expect(r.status).toBe(200);
    for (const item of r.body.items) {
      const ok =
        item.applicable_products.length === 0 ||
        item.applicable_products.includes('credit_card');
      expect(ok).toBe(true);
    }
  });

  test('400 on bogus state', async () => {
    const { app } = makeRulesApp();
    const r = await request(app).get('/v1/rules?state=bogus').set(TH);
    expect(r.status).toBe(400);
  });
});

describe('GET /v1/rules/:id', () => {
  test('returns the rule + performance + legal_transitions', async () => {
    const { app } = makeRulesApp();
    const r = await request(app).get('/v1/rules/r-22').set(TH);
    expect(r.status).toBe(200);
    expect(r.body.rule.id).toBe('r-22');
    expect(r.body.performance.rule_id).toBe('r-22');
  });

  test('404 when missing', async () => {
    const { app } = makeRulesApp();
    expect((await request(app).get('/v1/rules/r-nope').set(TH)).status).toBe(404);
  });
});

describe('POST /v1/rules/:id/transition', () => {
  test('admin submits a draft rule → pending_review', async () => {
    const store = new RuleStore();
    const { app } = makeRulesApp('admin', store);
    const r = await request(app).post('/v1/rules/r-03/transition').set(TH).send({ transition: 'submit' });
    expect(r.status).toBe(200);
    expect(r.body.rule.state).toBe('pending_review');
    expect(store.get('r-03')!.state).toBe('pending_review');
  });

  test('supervisor approves a pending_review rule', async () => {
    const store = new RuleStore();
    const { app } = makeRulesApp('supervisor', store);
    const r = await request(app).post('/v1/rules/r-14/transition').set(TH).send({ transition: 'approve' });
    expect(r.status).toBe(200);
    expect(r.body.rule.state).toBe('approved');
    expect(r.body.rule.approved_by).toContain('supervisor');
  });

  test('reject without comment → 400 invalid_payload', async () => {
    const store = new RuleStore();
    const { app } = makeRulesApp('supervisor', store);
    const r = await request(app).post('/v1/rules/r-14/transition').set(TH).send({ transition: 'reject' });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('invalid_payload');
  });

  test('illegal transition → 409', async () => {
    const store = new RuleStore();
    const { app } = makeRulesApp('admin', store);
    // r-22 is active; submit is not legal.
    const r = await request(app).post('/v1/rules/r-22/transition').set(TH).send({ transition: 'submit' });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('illegal_transition');
  });

  test('field_officer cannot promote (rejected by RBAC)', async () => {
    const store = new RuleStore();
    const { app } = makeRulesApp('field_officer', store);
    const r = await request(app).post('/v1/rules/r-14/transition').set(TH).send({ transition: 'approve' });
    expect(r.status).toBe(403);
  });

  test('400 on unknown transition', async () => {
    const { app } = makeRulesApp();
    const r = await request(app).post('/v1/rules/r-22/transition').set(TH).send({ transition: 'magic' });
    expect(r.status).toBe(400);
  });

  test('404 when rule missing', async () => {
    const { app } = makeRulesApp();
    const r = await request(app).post('/v1/rules/r-nope/transition').set(TH).send({ transition: 'submit' });
    expect(r.status).toBe(404);
  });
});

describe('POST /v1/rules/:id/backtest', () => {
  test('returns a 12-month backtest envelope', async () => {
    const { app } = makeRulesApp();
    const r = await request(app).post('/v1/rules/r-22/backtest').set(TH);
    expect(r.status).toBe(200);
    expect(r.body.monthly_volume).toHaveLength(12);
    expect(r.body.true_positives + r.body.false_positives).toBe(r.body.total_alerts);
  });

  test('field_officer is forbidden (no rules:simulate)', async () => {
    const { app } = makeRulesApp('field_officer');
    const r = await request(app).post('/v1/rules/r-22/backtest').set(TH);
    expect(r.status).toBe(403);
  });
});

describe('GET /v1/rules/:id/performance', () => {
  test('returns metrics envelope', async () => {
    const { app } = makeRulesApp();
    const r = await request(app).get('/v1/rules/r-22/performance').set(TH);
    expect(r.status).toBe(200);
    expect(r.body.rule_id).toBe('r-22');
    expect(['performing', 'underperforming', 'deprecated', 'no_data']).toContain(r.body.status);
  });
});
