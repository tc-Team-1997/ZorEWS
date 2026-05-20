// services/bff/__tests__/dq_engine.test.ts
//
// Phase A.3 — DQ Engine. Tests cover the pure evaluator, store
// lifecycle, run-now composition, dashboard rollup, and routes.

import request from 'supertest';
import {
  ALL_DQ_RULE_KINDS,
  ALL_DQ_SEVERITIES,
  buildDqDashboard,
  DQ_RULE_CAP_PER_TENANT,
  DQ_SAMPLE_FAILURES_CAP,
  DqError,
  evaluateRule,
  InMemoryDqStore,
  isDqRuleKind,
  isDqSeverity,
  runDqRule,
  type DqRule,
} from '../src/dq/dq_engine';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';
import { InMemoryRecoveryStore } from '../src/recovery/store';

const NOW = new Date('2026-05-21T09:00:00.000Z');
const TH = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API', 'X-APEX-USER': 'alice.admin' };
const TH_BANK = { 'X-Tenant-ID': 'BANK_DEMO', 'X-Channel': 'API', 'X-APEX-USER': 'admin' };

function mkRule(over: Partial<DqRule> = {}): DqRule {
  return {
    rule_id: 'cust_email_not_null',
    tenant_id: 'BIL',
    name: 'Customer email not null',
    description: null,
    table_name: 'mart.customer_360',
    column_name: 'email',
    kind: 'not_null',
    config: {},
    severity: 'medium',
    active: true,
    created_at: NOW.toISOString(),
    created_by: 'alice.admin',
    updated_at: NOW.toISOString(),
    updated_by: 'alice.admin',
    deleted_at: null,
    deleted_by: null,
    ...over,
  };
}

function makeDqApp(role: string = 'admin', overrides: {
  dqStore?: InMemoryDqStore;
  recoveryStore?: InMemoryRecoveryStore;
} = {}) {
  const { app } = makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
    dqStore: overrides.dqStore ?? new InMemoryDqStore(),
    recoveryStore: overrides.recoveryStore ?? new InMemoryRecoveryStore(),
  });
  return app;
}

// ─── 1. Enum invariants ────────────────────────────────────────────────

describe('DQ enums', () => {
  test('6 rule kinds', () => {
    expect(ALL_DQ_RULE_KINDS.length).toBe(6);
    expect(new Set(ALL_DQ_RULE_KINDS).size).toBe(6);
  });
  test('3 severities worst-first', () => {
    expect(ALL_DQ_SEVERITIES).toEqual(['high', 'medium', 'low']);
  });
  test('type guards', () => {
    for (const k of ALL_DQ_RULE_KINDS) expect(isDqRuleKind(k)).toBe(true);
    expect(isDqRuleKind('bogus')).toBe(false);
    for (const s of ALL_DQ_SEVERITIES) expect(isDqSeverity(s)).toBe(true);
    expect(isDqSeverity('critical')).toBe(false);
  });
});

// ─── 2. Pure evaluator ────────────────────────────────────────────────

describe('evaluateRule — not_null', () => {
  const rule = mkRule({ kind: 'not_null', config: {}, column_name: 'email' });
  test('all populated → 0 failures', () => {
    const r = evaluateRule(rule, [
      { id: '1', email: 'a@b.com' },
      { id: '2', email: 'c@d.com' },
    ], 'id', NOW);
    expect(r.passed_records).toBe(2);
    expect(r.failed_records).toBe(0);
  });
  test('null / empty string / undefined → failures', () => {
    const r = evaluateRule(rule, [
      { id: '1', email: 'a@b.com' },
      { id: '2', email: null },
      { id: '3', email: '' },
      { id: '4' },
    ], 'id', NOW);
    expect(r.passed_records).toBe(1);
    expect(r.failed_records).toBe(3);
    expect(r.sample_failures.length).toBe(3);
    expect(r.sample_failures[0].record_id).toBe('2');
  });
  test('missing id field falls back to idx:N', () => {
    const r = evaluateRule(rule, [{ email: null }], 'id', NOW);
    expect(r.sample_failures[0].record_id).toBe('idx:0');
  });
});

describe('evaluateRule — unique', () => {
  const rule = mkRule({ kind: 'unique', column_name: 'phone' });
  test('all unique → 0 failures', () => {
    const r = evaluateRule(rule, [
      { id: '1', phone: '111' },
      { id: '2', phone: '222' },
    ], 'id', NOW);
    expect(r.failed_records).toBe(0);
  });
  test('duplicates flagged as failures (subsequent occurrences)', () => {
    const r = evaluateRule(rule, [
      { id: '1', phone: '111' },
      { id: '2', phone: '111' },
      { id: '3', phone: '222' },
      { id: '4', phone: '222' },
    ], 'id', NOW);
    expect(r.failed_records).toBe(2);
    expect(r.passed_records).toBe(2);
  });
  test('null values pass (SQL semantics)', () => {
    const r = evaluateRule(rule, [
      { id: '1', phone: null },
      { id: '2', phone: null },
    ], 'id', NOW);
    expect(r.failed_records).toBe(0);
  });
});

describe('evaluateRule — range', () => {
  test('respects min + max', () => {
    const rule = mkRule({ kind: 'range', column_name: 'age', config: { min: 18, max: 65 } });
    const r = evaluateRule(rule, [
      { id: '1', age: 25 },
      { id: '2', age: 17 },
      { id: '3', age: 70 },
      { id: '4', age: 65 }, // boundary inclusive
      { id: '5', age: 18 }, // boundary inclusive
    ], 'id', NOW);
    expect(r.passed_records).toBe(3);
    expect(r.failed_records).toBe(2);
  });
  test('non-finite values fail', () => {
    const rule = mkRule({ kind: 'range', column_name: 'age', config: { min: 0 } });
    const r = evaluateRule(rule, [
      { id: '1', age: 'twenty' },
      { id: '2', age: NaN },
    ], 'id', NOW);
    expect(r.failed_records).toBe(2);
  });
});

describe('evaluateRule — regex', () => {
  test('matches/non-matches', () => {
    const rule = mkRule({ kind: 'regex', column_name: 'email', config: { pattern: '^[^@]+@[^@]+$' } });
    const r = evaluateRule(rule, [
      { id: '1', email: 'a@b.com' },
      { id: '2', email: 'invalid' },
    ], 'id', NOW);
    expect(r.passed_records).toBe(1);
    expect(r.failed_records).toBe(1);
  });
});

describe('evaluateRule — enum', () => {
  test('membership check', () => {
    const rule = mkRule({ kind: 'enum', column_name: 'status', config: { values: ['active', 'closed'] } });
    const r = evaluateRule(rule, [
      { id: '1', status: 'active' },
      { id: '2', status: 'pending' },
    ], 'id', NOW);
    expect(r.passed_records).toBe(1);
    expect(r.failed_records).toBe(1);
  });
});

describe('evaluateRule — freshness', () => {
  test('newest within window → whole batch passes', () => {
    const rule = mkRule({ kind: 'freshness', column_name: 'irrelevant', config: { max_age_hours: 24 } });
    const recent = new Date(NOW.getTime() - 2 * 3_600_000).toISOString();
    const old = new Date(NOW.getTime() - 48 * 3_600_000).toISOString();
    const r = evaluateRule(rule, [{ id: '1', record_ts: old }, { id: '2', record_ts: recent }], 'id', NOW);
    expect(r.failed_records).toBe(0);
    expect(r.passed_records).toBe(2);
  });
  test('newest stale → batch fails with aggregate failure', () => {
    const rule = mkRule({ kind: 'freshness', column_name: 'irrelevant', config: { max_age_hours: 1 } });
    const stale = new Date(NOW.getTime() - 5 * 3_600_000).toISOString();
    const r = evaluateRule(rule, [{ id: '1', record_ts: stale }], 'id', NOW);
    expect(r.failed_records).toBe(1);
    expect(r.sample_failures[0].record_id).toBe('aggregate');
  });
  test('no record_ts on any record → aggregate failure', () => {
    const rule = mkRule({ kind: 'freshness', column_name: 'irrelevant', config: { max_age_hours: 1 } });
    const r = evaluateRule(rule, [{ id: '1' }], 'id', NOW);
    expect(r.failed_records).toBe(1);
    expect(r.sample_failures[0].reason).toMatch(/no record_ts/);
  });
});

describe('evaluateRule — sample cap', () => {
  test('failures capped at DQ_SAMPLE_FAILURES_CAP', () => {
    const rule = mkRule({ kind: 'not_null', column_name: 'x' });
    const records = Array.from({ length: 100 }, (_, i) => ({ id: String(i), x: null }));
    const r = evaluateRule(rule, records, 'id', NOW);
    expect(r.failed_records).toBe(100);
    expect(r.sample_failures.length).toBe(DQ_SAMPLE_FAILURES_CAP);
  });
});

// ─── 3. Store lifecycle ────────────────────────────────────────────────

describe('InMemoryDqStore — rules CRUD', () => {
  test('create + get + list', () => {
    const s = new InMemoryDqStore();
    const r = s.createRule(
      'BIL',
      { rule_id: 'rule_alpha', name: 'rule_alpha', table_name: 'mart.customer_360', column_name: 'email', kind: 'not_null', config: {} },
      'a',
      NOW,
    );
    expect(r.rule_id).toBe('rule_alpha');
    expect(r.severity).toBe('medium');
    expect(s.getRule('BIL', 'rule_alpha')?.rule_id).toBe('rule_alpha');
    expect(s.listRules('BIL').length).toBe(1);
  });

  test('invalid rule_id format → invalid_rule_id', () => {
    const s = new InMemoryDqStore();
    expect(() =>
      s.createRule(
        'BIL',
        { rule_id: 'Bad-Caps', name: 'x', table_name: 't.a', column_name: 'c', kind: 'not_null', config: {} },
        'a',
        NOW,
      ),
    ).toThrow(DqError);
  });

  test('range needs at least one bound', () => {
    const s = new InMemoryDqStore();
    expect(() =>
      s.createRule(
        'BIL',
        { rule_id: 'rule_alpha', name: 'x', table_name: 't.a', column_name: 'c', kind: 'range', config: {} },
        'a',
        NOW,
      ),
    ).toThrow(DqError);
  });

  test('range min > max rejected', () => {
    const s = new InMemoryDqStore();
    expect(() =>
      s.createRule(
        'BIL',
        { rule_id: 'rule_alpha', name: 'x', table_name: 't.a', column_name: 'c', kind: 'range', config: { min: 10, max: 5 } },
        'a',
        NOW,
      ),
    ).toThrow(DqError);
  });

  test('regex with invalid pattern rejected', () => {
    const s = new InMemoryDqStore();
    expect(() =>
      s.createRule(
        'BIL',
        { rule_id: 'rule_alpha', name: 'x', table_name: 't.a', column_name: 'c', kind: 'regex', config: { pattern: '[' } },
        'a',
        NOW,
      ),
    ).toThrow(DqError);
  });

  test('enum needs non-empty string array', () => {
    const s = new InMemoryDqStore();
    expect(() =>
      s.createRule(
        'BIL',
        { rule_id: 'rule_alpha', name: 'x', table_name: 't.a', column_name: 'c', kind: 'enum', config: { values: [] } },
        'a',
        NOW,
      ),
    ).toThrow(DqError);
  });

  test('freshness needs positive max_age_hours', () => {
    const s = new InMemoryDqStore();
    expect(() =>
      s.createRule(
        'BIL',
        { rule_id: 'rule_alpha', name: 'x', table_name: 't.a', column_name: 'c', kind: 'freshness', config: { max_age_hours: -1 } },
        'a',
        NOW,
      ),
    ).toThrow(DqError);
  });

  test('duplicate rule_id rejected', () => {
    const s = new InMemoryDqStore();
    s.createRule('BIL', { rule_id: 'rule_alpha', name: 'rule_alpha', table_name: 't.a', column_name: 'c', kind: 'not_null', config: {} }, 'a', NOW);
    expect(() =>
      s.createRule('BIL', { rule_id: 'rule_alpha', name: 'rule_beta', table_name: 't.a', column_name: 'c', kind: 'not_null', config: {} }, 'a', NOW),
    ).toThrow(DqError);
  });

  test('cap_reached', () => {
    const s = new InMemoryDqStore();
    for (let i = 0; i < DQ_RULE_CAP_PER_TENANT; i++) {
      s.createRule(
        'BIL',
        { rule_id: `r_${i}`, name: `n${i}`, table_name: 't.a', column_name: 'c', kind: 'not_null', config: {} },
        'a',
        NOW,
      );
    }
    expect(() =>
      s.createRule(
        'BIL',
        { rule_id: 'r_overflow', name: 'overflow', table_name: 't.a', column_name: 'c', kind: 'not_null', config: {} },
        'a',
        NOW,
      ),
    ).toThrow(DqError);
  });

  test('update applies patch + validates config against new kind', () => {
    const s = new InMemoryDqStore();
    s.createRule('BIL', { rule_id: 'rule_alpha', name: 'x', table_name: 't.a', column_name: 'c', kind: 'not_null', config: {} }, 'a', NOW);
    const u = s.updateRule('BIL', 'rule_alpha', { kind: 'range', config: { min: 0, max: 100 } }, 'b', new Date(NOW.getTime() + 1000));
    expect(u.kind).toBe('range');
    expect(u.config.min).toBe(0);
    expect(u.updated_by).toBe('b');
    // Mismatched: switching to range without config fails validation.
    expect(() => s.updateRule('BIL', 'rule_alpha', { kind: 'regex' }, 'b', NOW)).toThrow(DqError);
  });

  test('soft-delete + restore round-trip', () => {
    const s = new InMemoryDqStore();
    s.createRule('BIL', { rule_id: 'rule_alpha', name: 'x', table_name: 't.a', column_name: 'c', kind: 'not_null', config: {} }, 'a', NOW);
    const t = s.softDeleteRule('BIL', 'rule_alpha', 'b', NOW);
    expect(t.deleted_at).toBe(NOW.toISOString());
    expect(s.getRule('BIL', 'rule_alpha')).toBeNull();
    expect(s.restoreRule(t)).toBe(true);
    expect(s.getRule('BIL', 'rule_alpha')?.deleted_at).toBeNull();
  });

  test('tenant scoping', () => {
    const s = new InMemoryDqStore();
    s.createRule('BIL', { rule_id: 'rule_alpha', name: 'BIL rule', table_name: 't.a', column_name: 'c', kind: 'not_null', config: {} }, 'a', NOW);
    s.createRule('BANK_DEMO', { rule_id: 'rule_alpha', name: 'BANK rule', table_name: 't.a', column_name: 'c', kind: 'not_null', config: {} }, 'a', NOW);
    expect(s.getRule('BIL', 'rule_alpha')?.name).toBe('BIL rule');
    expect(s.getRule('BANK_DEMO', 'rule_alpha')?.name).toBe('BANK rule');
  });
});

// ─── 4. runDqRule composition ──────────────────────────────────────────

describe('runDqRule', () => {
  function setup() {
    const s = new InMemoryDqStore();
    s.createRule(
      'BIL',
      { rule_id: 'rule_alpha', name: 'rule_alpha', table_name: 't.a', column_name: 'email', kind: 'not_null', config: {} },
      'admin',
      NOW,
    );
    return s;
  }

  test('all passing → status=passed', () => {
    const s = setup();
    const e = runDqRule(s, 'BIL', {
      rule_id: 'rule_alpha',
      records: [{ id: '1', email: 'a@b.com' }],
      triggered_by: 'admin',
    }, NOW);
    expect(e.status).toBe('passed');
    expect(e.failed_records).toBe(0);
    expect(e.execution_id).toMatch(/^dqe-/);
  });

  test('some failing → status=failed', () => {
    const s = setup();
    const e = runDqRule(s, 'BIL', {
      rule_id: 'rule_alpha',
      records: [{ id: '1', email: null }],
      triggered_by: 'admin',
    }, NOW);
    expect(e.status).toBe('failed');
    expect(e.failed_records).toBe(1);
  });

  test('unknown rule → DqError', () => {
    const s = setup();
    expect(() => runDqRule(s, 'BIL', { rule_id: 'ghost', records: [], triggered_by: 'admin' }, NOW)).toThrow(
      DqError,
    );
  });

  test('inactive rule → DqError rule_inactive', () => {
    const s = setup();
    s.updateRule('BIL', 'rule_alpha', { active: false }, 'a', NOW);
    expect(() => runDqRule(s, 'BIL', { rule_id: 'rule_alpha', records: [], triggered_by: 'admin' }, NOW)).toThrow(
      DqError,
    );
  });

  test('execution gets recorded', () => {
    const s = setup();
    const e = runDqRule(s, 'BIL', {
      rule_id: 'rule_alpha',
      records: [{ id: '1', email: 'a@b.com' }],
      triggered_by: 'admin',
    }, NOW);
    expect(s.getExecution('BIL', e.execution_id)?.execution_id).toBe(e.execution_id);
    expect(s.listExecutions('BIL').length).toBe(1);
  });
});

// ─── 5. Dashboard rollup ──────────────────────────────────────────────

describe('buildDqDashboard', () => {
  test('zero state', () => {
    const s = new InMemoryDqStore();
    const d = buildDqDashboard(s, 'BIL', NOW);
    expect(d.total_rules).toBe(0);
    expect(d.total_executions).toBe(0);
    expect(d.rules_status).toEqual([]);
    expect(d.by_severity.high.rules).toBe(0);
  });

  test('rollup with mixed pass/fail executions', () => {
    const s = new InMemoryDqStore();
    s.createRule('BIL', { rule_id: 'rule_alpha', name: 'rule_alpha', table_name: 't.a', column_name: 'email', kind: 'not_null', config: {}, severity: 'high' }, 'a', NOW);
    s.createRule('BIL', { rule_id: 'rule_beta', name: 'rule_beta', table_name: 't.b', column_name: 'phone', kind: 'unique', config: {}, severity: 'low' }, 'a', NOW);
    runDqRule(s, 'BIL', { rule_id: 'rule_alpha', records: [{ id: '1', email: 'a@b.com' }, { id: '2', email: null }], triggered_by: 'admin' }, NOW);
    runDqRule(s, 'BIL', { rule_id: 'rule_beta', records: [{ id: '1', phone: '111' }, { id: '2', phone: '222' }], triggered_by: 'admin' }, NOW);
    const d = buildDqDashboard(s, 'BIL', NOW);
    expect(d.total_rules).toBe(2);
    expect(d.active_rules).toBe(2);
    expect(d.total_executions).toBe(2);
    expect(d.total_passed).toBe(1);
    expect(d.total_failed).toBe(1);
    expect(d.by_severity.high.rules).toBe(1);
    expect(d.by_severity.high.failures_24h).toBe(1);
    expect(d.by_severity.low.rules).toBe(1);
    expect(d.by_severity.low.failures_24h).toBe(0);
    expect(d.by_kind.not_null.rules).toBe(1);
    expect(d.by_kind.unique.rules).toBe(1);
    // Failing rule sorts first (worst pass rate).
    expect(d.rules_status[0].rule_id).toBe('rule_alpha');
    expect(d.rules_status[0].latest_pass_rate).toBe(0.5);
    expect(d.rules_status[1].rule_id).toBe('rule_beta');
    expect(d.rules_status[1].latest_pass_rate).toBe(1);
  });

  test('rules with no execution rank last', () => {
    const s = new InMemoryDqStore();
    s.createRule('BIL', { rule_id: 'r_unused', name: 'unused', table_name: 't.a', column_name: 'c', kind: 'not_null', config: {} }, 'a', NOW);
    s.createRule('BIL', { rule_id: 'r_used', name: 'used', table_name: 't.a', column_name: 'c', kind: 'not_null', config: {} }, 'a', NOW);
    runDqRule(s, 'BIL', { rule_id: 'r_used', records: [{ id: '1', c: null }], triggered_by: 'admin' }, NOW);
    const d = buildDqDashboard(s, 'BIL', NOW);
    expect(d.rules_status[0].rule_id).toBe('r_used');
    expect(d.rules_status[1].rule_id).toBe('r_unused');
    expect(d.rules_status[1].latest_status).toBeNull();
  });
});

// ─── 6. Routes ─────────────────────────────────────────────────────────

describe('routes — rule-kinds', () => {
  test('admin happy', async () => {
    const app = makeDqApp('admin');
    const r = await request(app).get('/v1/dq/rule-kinds').set(TH);
    expect(r.status).toBe(200);
    expect(r.body.body.kinds).toEqual([...ALL_DQ_RULE_KINDS]);
    expect(r.body.body.severities).toEqual([...ALL_DQ_SEVERITIES]);
  });
  test('non-admin → 403', async () => {
    const app = makeDqApp('field_officer');
    const r = await request(app).get('/v1/dq/rule-kinds').set(TH);
    expect(r.status).toBe(403);
  });
});

describe('routes — rules CRUD', () => {
  const validRule = {
    rule_id: 'cust_email',
    name: 'Customer email not null',
    table_name: 'mart.customer_360',
    column_name: 'email',
    kind: 'not_null',
    config: {},
  };

  test('POST → 201 with envelope', async () => {
    const app = makeDqApp('admin');
    const r = await request(app).post('/v1/dq/rules').set(TH).send(validRule);
    expect(r.status).toBe(201);
    expect(r.body.body.rule_id).toBe('cust_email');
    expect(r.body.body.created_by).toBe('alice.admin');
  });

  test('POST duplicate → 409', async () => {
    const store = new InMemoryDqStore();
    const app = makeDqApp('admin', { dqStore: store });
    await request(app).post('/v1/dq/rules').set(TH).send(validRule);
    const r = await request(app).post('/v1/dq/rules').set(TH).send(validRule);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('EWS_409_duplicate_rule_id');
  });

  test('POST invalid kind → 400', async () => {
    const app = makeDqApp('admin');
    const r = await request(app)
      .post('/v1/dq/rules')
      .set(TH)
      .send({ ...validRule, kind: 'bogus' });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_kind');
  });

  test('GET list with kind filter', async () => {
    const store = new InMemoryDqStore();
    const app = makeDqApp('admin', { dqStore: store });
    await request(app).post('/v1/dq/rules').set(TH).send(validRule);
    await request(app)
      .post('/v1/dq/rules')
      .set(TH)
      .send({ ...validRule, rule_id: 'r_unique', kind: 'unique', config: {} });
    const r = await request(app).get('/v1/dq/rules?kind=not_null').set(TH);
    expect(r.body.body.total).toBe(1);
    expect(r.body.body.items[0].rule_id).toBe('cust_email');
  });

  test('GET list invalid kind → 400', async () => {
    const app = makeDqApp('admin');
    const r = await request(app).get('/v1/dq/rules?kind=bogus').set(TH);
    expect(r.status).toBe(400);
  });

  test('GET /:id 404 unknown', async () => {
    const app = makeDqApp('admin');
    const r = await request(app).get('/v1/dq/rules/ghost').set(TH);
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('EWS_404_unknown_rule');
  });

  test('PATCH applies patch', async () => {
    const store = new InMemoryDqStore();
    const app = makeDqApp('admin', { dqStore: store });
    await request(app).post('/v1/dq/rules').set(TH).send(validRule);
    const r = await request(app)
      .patch('/v1/dq/rules/cust_email')
      .set(TH)
      .send({ severity: 'high', active: false });
    expect(r.status).toBe(200);
    expect(r.body.body.severity).toBe('high');
    expect(r.body.body.active).toBe(false);
  });

  test('DELETE soft-deletes + archives to Recovery', async () => {
    const store = new InMemoryDqStore();
    const recovery = new InMemoryRecoveryStore();
    const app = makeDqApp('admin', { dqStore: store, recoveryStore: recovery });
    await request(app).post('/v1/dq/rules').set(TH).send(validRule);
    const r = await request(app).delete('/v1/dq/rules/cust_email').set(TH);
    expect(r.status).toBe(204);
    const archived = await recovery.list({ tenant_id: 'BIL', entity_type: 'dq_rule' });
    expect(archived.items.length).toBe(1);
    expect(archived.items[0].original_id).toBe('cust_email');
    expect(archived.items[0].original_table).toBe('app_dq.rules');
  });

  test('DELETE unknown → 404', async () => {
    const app = makeDqApp('admin');
    const r = await request(app).delete('/v1/dq/rules/ghost').set(TH);
    expect(r.status).toBe(404);
  });

  test('tenant scoping — BIL invisible to BANK_DEMO', async () => {
    const store = new InMemoryDqStore();
    const app = makeDqApp('admin', { dqStore: store });
    await request(app).post('/v1/dq/rules').set(TH).send(validRule);
    const r = await request(app).get('/v1/dq/rules').set(TH_BANK);
    expect(r.body.body.total).toBe(0);
  });
});

describe('routes — run + executions + dashboard', () => {
  const validRule = {
    rule_id: 'cust_email',
    name: 'Customer email not null',
    table_name: 'mart.customer_360',
    column_name: 'email',
    kind: 'not_null',
    config: {},
  };

  test('POST /run happy', async () => {
    const store = new InMemoryDqStore();
    const app = makeDqApp('admin', { dqStore: store });
    await request(app).post('/v1/dq/rules').set(TH).send(validRule);
    const r = await request(app)
      .post('/v1/dq/rules/cust_email/run')
      .set(TH)
      .send({ records: [{ id: '1', email: 'a@b.com' }, { id: '2', email: null }] });
    expect(r.status).toBe(200);
    expect(r.body.body.status).toBe('failed');
    expect(r.body.body.failed_records).toBe(1);
    expect(r.body.body.triggered_by).toBe('alice.admin');
  });

  test('POST /run on unknown → 404', async () => {
    const app = makeDqApp('admin');
    const r = await request(app)
      .post('/v1/dq/rules/ghost/run')
      .set(TH)
      .send({ records: [] });
    expect(r.status).toBe(404);
  });

  test('POST /run on inactive → 409', async () => {
    const store = new InMemoryDqStore();
    const app = makeDqApp('admin', { dqStore: store });
    await request(app).post('/v1/dq/rules').set(TH).send({ ...validRule, active: false });
    const r = await request(app)
      .post('/v1/dq/rules/cust_email/run')
      .set(TH)
      .send({ records: [] });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('EWS_409_rule_inactive');
  });

  test('GET /executions lists', async () => {
    const store = new InMemoryDqStore();
    const app = makeDqApp('admin', { dqStore: store });
    await request(app).post('/v1/dq/rules').set(TH).send(validRule);
    await request(app)
      .post('/v1/dq/rules/cust_email/run')
      .set(TH)
      .send({ records: [{ id: '1', email: 'a@b.com' }] });
    const r = await request(app).get('/v1/dq/executions').set(TH);
    expect(r.body.body.items.length).toBe(1);
  });

  test('GET /executions invalid status → 400', async () => {
    const app = makeDqApp('admin');
    const r = await request(app).get('/v1/dq/executions?status=bogus').set(TH);
    expect(r.status).toBe(400);
  });

  test('GET /executions/:id 404', async () => {
    const app = makeDqApp('admin');
    const r = await request(app).get('/v1/dq/executions/ghost').set(TH);
    expect(r.status).toBe(404);
  });

  test('GET /dashboard rollup', async () => {
    const store = new InMemoryDqStore();
    const app = makeDqApp('admin', { dqStore: store });
    await request(app).post('/v1/dq/rules').set(TH).send(validRule);
    await request(app)
      .post('/v1/dq/rules/cust_email/run')
      .set(TH)
      .send({ records: [{ id: '1', email: 'a@b.com' }, { id: '2', email: null }] });
    const r = await request(app).get('/v1/dq/dashboard').set(TH);
    expect(r.status).toBe(200);
    expect(r.body.body.total_rules).toBe(1);
    expect(r.body.body.total_failed).toBe(1);
    expect(r.body.body.rules_status[0].rule_id).toBe('cust_email');
    expect(r.body.body.rules_status[0].latest_pass_rate).toBe(0.5);
  });

  test('GET /dashboard non-admin → 403', async () => {
    const app = makeDqApp('field_officer');
    const r = await request(app).get('/v1/dq/dashboard').set(TH);
    expect(r.status).toBe(403);
  });
});
