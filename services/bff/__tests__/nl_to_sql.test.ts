// services/bff/__tests__/nl_to_sql.test.ts
//
// T2.9 — NL→SQL Copilot stub.

import request from 'supertest';
import {
  NL_TO_SQL_DEFAULT_LIMIT,
  NL_TO_SQL_INTENTS,
  NL_TO_SQL_MAX_LIMIT,
  NlToSqlError,
  translateNlToSql,
} from '../src/copilot/nl_to_sql';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-20T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function makeNlSqlApp(role: string = 'admin') {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
  });
}

// ─── Pure resolver tests ──────────────────────────────────────────────

describe('translateNlToSql intent matching', () => {
  test('high-risk customers', () => {
    const r = translateNlToSql({
      question: 'who are my high-risk customers?',
      tenant_id: 'BIL',
    });
    expect(r.intent).toBe('high_risk_customers');
    expect(r.sql).toContain("risk_level = 'High'");
    expect(r.params.tenant_id).toBe('BIL');
    expect(r.confidence).toBeGreaterThan(0.5);
    expect(r.requires_review).toBe(true);
    expect(r.fallback).toBe(false);
  });

  test('alerts by severity', () => {
    const r = translateNlToSql({
      question: 'show me alerts by severity',
      tenant_id: 'BANK_DEMO',
    });
    expect(r.intent).toBe('alerts_by_severity');
    expect(r.sql).toContain('GROUP BY severity');
    expect(r.params.tenant_id).toBe('BANK_DEMO');
  });

  test('avg DPD by product', () => {
    const r = translateNlToSql({
      question: 'what is the average DPD by product?',
      tenant_id: 'BIL',
    });
    expect(r.intent).toBe('avg_dpd_by_product');
    expect(r.sql).toContain('AVG(worst_dpd)');
    expect(r.sql).toContain('GROUP BY product_code');
  });

  test('top NPA customers', () => {
    const r = translateNlToSql({
      question: 'top NPA customers please',
      tenant_id: 'BIL',
    });
    expect(r.intent).toBe('top_npa_customers');
    expect(r.sql).toContain('has_npa = true');
    expect(r.sql).toContain('JOIN mart.loan_360');
  });

  test('indicator value lookup with id', () => {
    const r = translateNlToSql({
      question: 'value of FIN-001 indicator',
      tenant_id: 'BIL',
    });
    expect(r.intent).toBe('indicator_value_lookup');
    expect(r.params.indicator_id).toBe('FIN-001');
    expect(r.sql).toContain('indicator_id = :indicator_id');
  });

  test('indicator value lookup with hyphen-less id is uppercased', () => {
    const r = translateNlToSql({
      question: 'show me indicator FIN-002',
      tenant_id: 'BIL',
    });
    expect(r.intent).toBe('indicator_value_lookup');
    expect(r.params.indicator_id).toBe('FIN-002');
  });

  test('customer count by segment', () => {
    const r = translateNlToSql({
      question: 'how many customers do I have?',
      tenant_id: 'BIL',
    });
    expect(r.intent).toBe('customer_count_by_segment');
    expect(r.sql).toContain('GROUP BY risk_level');
  });

  test('loan portfolio summary', () => {
    const r = translateNlToSql({
      question: 'give me a loan portfolio summary',
      tenant_id: 'BIL',
    });
    expect(r.intent).toBe('loan_portfolio_summary');
    expect(r.sql).toContain('SUM(outstanding_balance)');
  });

  test('utilization above threshold — decimal form', () => {
    const r = translateNlToSql({
      question: 'customers with utilization above 0.85',
      tenant_id: 'BIL',
    });
    expect(r.intent).toBe('utilization_above_threshold');
    expect(r.params.threshold).toBeCloseTo(0.85, 2);
  });

  test('utilization above threshold — percentage form', () => {
    const r = translateNlToSql({
      question: 'utilization over 80%',
      tenant_id: 'BIL',
    });
    expect(r.intent).toBe('utilization_above_threshold');
    expect(r.params.threshold).toBeCloseTo(0.8, 2);
  });

  test('utilization clamped to [0,1]', () => {
    const r = translateNlToSql({
      question: 'utilization above 150',
      tenant_id: 'BIL',
    });
    expect(r.intent).toBe('utilization_above_threshold');
    expect(r.params.threshold).toBe(1);
  });

  test('transaction volume trend', () => {
    const r = translateNlToSql({
      question: 'show me transaction volume trend',
      tenant_id: 'BIL',
    });
    expect(r.intent).toBe('txn_volume_trend');
    expect(r.sql).toContain('txn_volume_zscore_90d');
  });

  test('alert count last N days extracts the number', () => {
    const r = translateNlToSql({
      question: 'how many alerts in the last 7 days?',
      tenant_id: 'BIL',
    });
    expect(r.intent).toBe('alert_count_last_n_days');
    expect(r.params.days).toBe(7);
  });

  test('alert count last N days clamps days to [1, 365]', () => {
    const r = translateNlToSql({
      question: 'alerts in the last 9999 days',
      tenant_id: 'BIL',
    });
    expect(r.intent).toBe('alert_count_last_n_days');
    expect(r.params.days).toBe(365);
  });
});

describe('translateNlToSql fallback', () => {
  test('unmatched question falls back to comment + tables list', () => {
    const r = translateNlToSql({
      question: 'what is the meaning of life?',
      tenant_id: 'BIL',
    });
    expect(r.intent).toBe('unknown');
    expect(r.fallback).toBe(true);
    expect(r.confidence).toBe(0);
    expect(r.sql).toContain('mart.customer_360');
    expect(r.sql).toContain('-- No matching pattern.');
  });
});

describe('translateNlToSql validation', () => {
  test('non-object input throws invalid_input', () => {
    expect(() => translateNlToSql(null as unknown as never)).toThrow(NlToSqlError);
  });

  test('empty question throws invalid_input', () => {
    expect(() =>
      translateNlToSql({ question: '', tenant_id: 'BIL' }),
    ).toThrow(NlToSqlError);
  });

  test('whitespace-only question throws invalid_input', () => {
    expect(() =>
      translateNlToSql({ question: '   ', tenant_id: 'BIL' }),
    ).toThrow(NlToSqlError);
  });

  test('question > 1000 chars throws invalid_input', () => {
    expect(() =>
      translateNlToSql({ question: 'x'.repeat(1001), tenant_id: 'BIL' }),
    ).toThrow(NlToSqlError);
  });

  test('missing tenant_id throws', () => {
    expect(() =>
      translateNlToSql({ question: 'hi', tenant_id: '' }),
    ).toThrow(NlToSqlError);
  });

  test('non-integer limit throws', () => {
    expect(() =>
      translateNlToSql({ question: 'high-risk customers', tenant_id: 'BIL', limit: 3.14 }),
    ).toThrow(NlToSqlError);
  });

  test('limit clamped to MAX_LIMIT', () => {
    const r = translateNlToSql({
      question: 'high-risk customers',
      tenant_id: 'BIL',
      limit: 999999,
    });
    expect(r.params.limit).toBe(NL_TO_SQL_MAX_LIMIT);
  });

  test('limit clamped to min 1', () => {
    const r = translateNlToSql({
      question: 'high-risk customers',
      tenant_id: 'BIL',
      limit: 0,
    });
    expect(r.params.limit).toBe(1);
  });

  test('default limit applied when not supplied', () => {
    const r = translateNlToSql({
      question: 'high-risk customers',
      tenant_id: 'BIL',
    });
    expect(r.params.limit).toBe(NL_TO_SQL_DEFAULT_LIMIT);
  });
});

describe('translateNlToSql safety', () => {
  test('every generated SQL starts with SELECT or comment', () => {
    const questions = [
      'high-risk customers',
      'alerts by severity',
      'avg DPD by product',
      'top NPA customers',
      'indicator FIN-001 value',
      'how many customers do I have?',
      'loan portfolio summary',
      'utilization above 0.8',
      'transaction volume trend',
      'alerts in the last 30 days',
    ];
    for (const q of questions) {
      const r = translateNlToSql({ question: q, tenant_id: 'BIL' });
      const firstNonCommentLine = r.sql
        .split('\n')
        .map((s) => s.trim())
        .find((s) => s.length > 0 && !s.startsWith('--'));
      expect(firstNonCommentLine?.toUpperCase()).toMatch(/^(SELECT|WITH)/);
    }
  });

  test('every SQL queries only mart.* schema', () => {
    const questions = [
      'high-risk customers',
      'alerts by severity',
      'avg DPD by product',
      'top NPA customers',
      'utilization above 0.5',
    ];
    for (const q of questions) {
      const r = translateNlToSql({ question: q, tenant_id: 'BIL' });
      // Must reference mart.* schema, not raw.* or app_*.
      expect(r.sql).toMatch(/mart\.\w+/);
      expect(r.sql).not.toMatch(/raw\.\w+/);
      expect(r.sql).not.toMatch(/app_\w+\./);
    }
  });

  test('every SQL tenant-scoped via parameter', () => {
    const questions = [
      'high-risk customers',
      'alerts by severity',
      'avg DPD by product',
    ];
    for (const q of questions) {
      const r = translateNlToSql({ question: q, tenant_id: 'BIL' });
      expect(r.sql).toContain('tenant_id = :tenant_id');
      expect(r.params.tenant_id).toBe('BIL');
    }
  });

  test('requires_review always true in stub mode', () => {
    const r = translateNlToSql({
      question: 'high-risk customers',
      tenant_id: 'BIL',
    });
    expect(r.requires_review).toBe(true);
  });

  test('intent enum is closed', () => {
    expect(NL_TO_SQL_INTENTS).toContain('unknown');
    expect(NL_TO_SQL_INTENTS.length).toBeGreaterThanOrEqual(10);
  });
});

// ─── Route tests ──────────────────────────────────────────────────────

describe('POST /v1/copilot/nl-to-sql route', () => {
  test('admin → 200 with envelope shape', async () => {
    const { app } = makeNlSqlApp('admin');
    const r = await request(app)
      .post('/v1/copilot/nl-to-sql')
      .set(TH_BIL)
      .send({ question: 'high-risk customers' });
    expect(r.status).toBe(200);
    expect(r.body.body.intent).toBe('high_risk_customers');
    expect(r.body.body.sql).toContain("risk_level = 'High'");
    expect(r.body.body.requires_review).toBe(true);
  });

  test('non-admin → 403', async () => {
    const { app } = makeNlSqlApp('field_officer');
    const r = await request(app)
      .post('/v1/copilot/nl-to-sql')
      .set(TH_BIL)
      .send({ question: 'high-risk customers' });
    expect(r.status).toBe(403);
  });

  test('missing question → 400', async () => {
    const { app } = makeNlSqlApp('admin');
    const r = await request(app)
      .post('/v1/copilot/nl-to-sql')
      .set(TH_BIL)
      .send({});
    expect(r.status).toBe(400);
    expect(r.body.error?.code).toMatch(/EWS_400/);
  });

  test('overlong question → 400', async () => {
    const { app } = makeNlSqlApp('admin');
    const r = await request(app)
      .post('/v1/copilot/nl-to-sql')
      .set(TH_BIL)
      .send({ question: 'x'.repeat(1001) });
    expect(r.status).toBe(400);
  });

  test('tenant injected from header (caller cannot override)', async () => {
    const { app } = makeNlSqlApp('admin');
    const r = await request(app)
      .post('/v1/copilot/nl-to-sql')
      .set(TH_BIL)
      .send({ question: 'high-risk customers', tenant_id: 'BANK_DEMO' });
    // Server should ignore body.tenant_id and use the header's tenant.
    expect(r.status).toBe(200);
    expect(r.body.body.params.tenant_id).toBe('BIL');
  });

  test('limit query param is honoured + clamped', async () => {
    const { app } = makeNlSqlApp('admin');
    const r1 = await request(app)
      .post('/v1/copilot/nl-to-sql')
      .set(TH_BIL)
      .send({ question: 'high-risk customers', limit: 25 });
    expect(r1.body.body.params.limit).toBe(25);

    const r2 = await request(app)
      .post('/v1/copilot/nl-to-sql')
      .set(TH_BIL)
      .send({ question: 'high-risk customers', limit: 99999 });
    expect(r2.body.body.params.limit).toBe(NL_TO_SQL_MAX_LIMIT);
  });

  test('unmatched question returns fallback (200 with intent=unknown)', async () => {
    const { app } = makeNlSqlApp('admin');
    const r = await request(app)
      .post('/v1/copilot/nl-to-sql')
      .set(TH_BIL)
      .send({ question: 'tell me a joke' });
    expect(r.status).toBe(200);
    expect(r.body.body.intent).toBe('unknown');
    expect(r.body.body.fallback).toBe(true);
    expect(r.body.body.confidence).toBe(0);
  });

  test('no tenant header → 400', async () => {
    const { app } = makeNlSqlApp('admin');
    const r = await request(app)
      .post('/v1/copilot/nl-to-sql')
      .send({ question: 'high-risk customers' });
    expect(r.status).toBe(400);
  });
});
