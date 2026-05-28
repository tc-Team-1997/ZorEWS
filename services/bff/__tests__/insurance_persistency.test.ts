// services/bff/__tests__/insurance_persistency.test.ts
//
// Coverage for Insurance EWS Module 5 — Persistency Watch. Pure builders
// (dashboard, root-cause analyze, alerts) + the 3 BFF routes.

import request from 'supertest';
import {
  buildPersistencyDashboard,
  analyzePersistency,
  listPersistencyAlerts,
  bandForShortfall,
  TARGET_BY_PERIOD,
  PERSISTENCY_PERIODS,
  PERSISTENCY_DIMENSIONS,
  PERSISTENCY_BANDS,
  PERSISTENCY_ALERT_SEVERITIES,
  PersistencyError,
} from '../src/insurance_persistency';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-28T12:00:00.000Z');

function makeInsApp(role = 'admin') {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
  });
}

const TH = { 'X-Tenant-ID': 'BANK_DEMO', 'X-Channel': 'API' };
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

// ─── bandForShortfall ─────────────────────────────────────────────────────

describe('bandForShortfall', () => {
  test('boundary mapping', () => {
    expect(bandForShortfall(-0.1)).toBe('healthy');
    expect(bandForShortfall(0)).toBe('healthy');
    expect(bandForShortfall(0.049)).toBe('watch');
    expect(bandForShortfall(0.05)).toBe('concern');
    expect(bandForShortfall(0.11)).toBe('concern');
    expect(bandForShortfall(0.12)).toBe('critical');
    expect(bandForShortfall(0.3)).toBe('critical');
  });
});

// ─── buildPersistencyDashboard ───────────────────────────────────────────

describe('buildPersistencyDashboard — pure builder', () => {
  test('shape — totals + 4 widgets', () => {
    const d = buildPersistencyDashboard('BANK_DEMO', NOW);
    expect(d.tenant_id).toBe('BANK_DEMO');
    expect(d.generated_at).toBe(NOW.toISOString());
    expect(Array.isArray(d.persistency_trend)).toBe(true);
    expect(Array.isArray(d.product_retention)).toBe(true);
    expect(Array.isArray(d.channel_risk)).toBe(true);
    expect(Array.isArray(d.location_persistency)).toBe(true);
  });

  test('deterministic — same (tenant, day) identical', () => {
    const a = buildPersistencyDashboard('BANK_DEMO', NOW);
    const b = buildPersistencyDashboard('BANK_DEMO', NOW);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  test('tenant divergence — BIL has fewer policies in force', () => {
    const bank = buildPersistencyDashboard('BANK_DEMO', NOW);
    const bil = buildPersistencyDashboard('BIL', NOW);
    const bankPif = bank.product_retention.reduce((a, r) => a + r.policies_in_force, 0);
    const bilPif = bil.product_retention.reduce((a, r) => a + r.policies_in_force, 0);
    expect(bilPif).toBeLessThan(bankPif);
  });

  test('persistency_trend covers the 5 milestones, each with target + band', () => {
    const d = buildPersistencyDashboard('BANK_DEMO', NOW);
    expect(d.persistency_trend.map((t) => t.period_month)).toEqual([13, 25, 37, 49, 61]);
    for (const t of d.persistency_trend) {
      expect(t.target_pct).toBe(TARGET_BY_PERIOD[t.period_month]);
      expect(t.persistency_pct).toBeGreaterThanOrEqual(0);
      expect(t.persistency_pct).toBeLessThanOrEqual(1);
      expect(t.band).toBe(bandForShortfall(t.target_pct - t.persistency_pct));
      expect(t.shortfall).toBeCloseTo(Math.max(0, t.target_pct - t.persistency_pct), 4);
    }
  });

  test('dimension slices sorted worst-first (shortfall desc); band matches', () => {
    const d = buildPersistencyDashboard('BANK_DEMO', NOW);
    for (const rows of [d.product_retention, d.channel_risk, d.location_persistency]) {
      for (let i = 1; i < rows.length; i++) {
        expect(rows[i - 1].shortfall).toBeGreaterThanOrEqual(rows[i].shortfall);
      }
      for (const r of rows) expect(r.band).toBe(bandForShortfall(r.target_pct - r.persistency_pct));
    }
    expect(d.product_retention).toHaveLength(5);
    expect(d.channel_risk).toHaveLength(5);
    expect(d.location_persistency).toHaveLength(5);
  });

  test('worst_dimension points at the largest shortfall cohort', () => {
    const d = buildPersistencyDashboard('BANK_DEMO', NOW);
    if (d.totals.worst_dimension) {
      expect(d.totals.worst_dimension).toMatch(/^(product|channel|region):/);
    }
    expect(d.totals.cohorts_below_target).toBeGreaterThanOrEqual(0);
  });

  test('empty tenant_id throws', () => {
    expect(() => buildPersistencyDashboard('', NOW)).toThrow(PersistencyError);
  });
});

// ─── analyzePersistency ────────────────────────────────────────────────────

describe('analyzePersistency — AI root-cause', () => {
  test('healthy cohort (above target) → healthy band, no shortfall', () => {
    const a = analyzePersistency({ dimension: 'product', dimension_value: 'TERM_LIFE', period_month: 13, persistency_pct: 0.92 }, NOW);
    expect(a.band).toBe('healthy');
    expect(a.shortfall).toBe(0);
  });

  test('weak cohort → shortfall + ranked root_causes summing to ~1', () => {
    const a = analyzePersistency(
      {
        dimension: 'channel',
        dimension_value: 'online',
        period_month: 13,
        persistency_pct: 0.65,
        auto_debit_share: 0.2,
        claims_settlement_delay_days: 30,
        agent_attrition_rate: 0.4,
        complaint_rate: 0.2,
        digital_engagement_score: 0.3,
      },
      NOW,
    );
    expect(a.shortfall).toBeGreaterThan(0);
    expect(a.root_causes.length).toBeGreaterThan(0);
    const sum = a.root_causes.reduce((s, c) => s + c.weight, 0);
    expect(sum).toBeCloseTo(1, 2);
    for (let i = 1; i < a.root_causes.length; i++) {
      expect(a.root_causes[i - 1].weight).toBeGreaterThanOrEqual(a.root_causes[i].weight);
    }
  });

  test('low auto-debit dominates → recommendation mentions auto-debit', () => {
    const a = analyzePersistency(
      { dimension: 'channel', dimension_value: 'direct', persistency_pct: 0.6, auto_debit_share: 0.05, agent_attrition_rate: 0, complaint_rate: 0, digital_engagement_score: 0.9, claims_settlement_delay_days: 2 },
      NOW,
    );
    expect(a.root_causes[0].cause).toBe('low_auto_debit_adoption');
    expect(a.recommendation.toLowerCase()).toContain('auto-debit');
  });

  test('deterministic when pct synthesised', () => {
    const a = analyzePersistency({ dimension: 'region', dimension_value: 'West' }, NOW);
    const b = analyzePersistency({ dimension: 'region', dimension_value: 'West' }, NOW);
    expect(a.persistency_pct).toBe(b.persistency_pct);
  });

  test('target derives from period', () => {
    const a = analyzePersistency({ dimension: 'product', dimension_value: 'ULIP', period_month: 61, persistency_pct: 0.5 }, NOW);
    expect(a.target_pct).toBe(TARGET_BY_PERIOD[61]);
    expect(a.period_month).toBe(61);
  });

  test('critical band escalates recommendation', () => {
    const a = analyzePersistency({ dimension: 'channel', dimension_value: 'online', period_month: 13, persistency_pct: 0.6, auto_debit_share: 0.1 }, NOW);
    expect(a.band).toBe('critical');
    expect(a.recommendation.toLowerCase()).toContain('war-room');
  });

  test('invalid dimension throws', () => {
    expect(() => analyzePersistency({ dimension: 'nonsense', dimension_value: 'x' }, NOW)).toThrow(/dimension/);
  });
  test('missing dimension_value throws', () => {
    expect(() => analyzePersistency({ dimension: 'product' } as never, NOW)).toThrow(PersistencyError);
  });
  test('invalid period throws', () => {
    expect(() => analyzePersistency({ dimension: 'product', dimension_value: 'ULIP', period_month: 99 }, NOW)).toThrow(/period/);
  });
  test('pct out of [0,1] throws', () => {
    expect(() => analyzePersistency({ dimension: 'product', dimension_value: 'ULIP', persistency_pct: 1.5 }, NOW)).toThrow(PersistencyError);
  });
  test('signal out of [0,1] throws', () => {
    expect(() => analyzePersistency({ dimension: 'product', dimension_value: 'ULIP', auto_debit_share: 2 }, NOW)).toThrow(PersistencyError);
  });
  test('negative claims delay throws', () => {
    expect(() => analyzePersistency({ dimension: 'product', dimension_value: 'ULIP', claims_settlement_delay_days: -5 }, NOW)).toThrow(PersistencyError);
  });
});

// ─── listPersistencyAlerts ─────────────────────────────────────────────────

describe('listPersistencyAlerts — pure builder', () => {
  test('alerts carry a dimension + period + shortfall > 0.05', () => {
    const l = listPersistencyAlerts('BANK_DEMO', NOW);
    expect(l.severity_filter).toBe('all');
    for (const a of l.alerts) {
      expect(PERSISTENCY_DIMENSIONS).toContain(a.dimension);
      expect(a.shortfall).toBeGreaterThan(0.05);
    }
  });

  test('severity filter narrows', () => {
    const l = listPersistencyAlerts('BANK_DEMO', NOW, { severity: 'critical' });
    for (const a of l.alerts) expect(a.severity).toBe('critical');
  });

  test('invalid severity throws', () => {
    expect(() => listPersistencyAlerts('BANK_DEMO', NOW, { severity: 'nonsense' })).toThrow(PersistencyError);
  });

  test('sorted by shortfall desc', () => {
    const l = listPersistencyAlerts('BANK_DEMO', NOW);
    for (let i = 1; i < l.alerts.length; i++) {
      expect(l.alerts[i - 1].shortfall).toBeGreaterThanOrEqual(l.alerts[i].shortfall);
    }
  });
});

// ─── enum exports ─────────────────────────────────────────────────────────

describe('exports', () => {
  test('PERSISTENCY_PERIODS canonical', () => {
    expect(PERSISTENCY_PERIODS).toEqual([13, 25, 37, 49, 61]);
  });
  test('PERSISTENCY_BANDS canonical', () => {
    expect(PERSISTENCY_BANDS).toEqual(['healthy', 'watch', 'concern', 'critical']);
  });
  test('alert severities', () => {
    expect(PERSISTENCY_ALERT_SEVERITIES).toEqual(['info', 'warning', 'critical']);
  });
});

// ─── routes ─────────────────────────────────────────────────────────────

describe('GET /v1/insurance/persistency/dashboard', () => {
  test('admin happy path — enveloped', async () => {
    const r = await request(makeInsApp('admin').app).get('/v1/insurance/persistency/dashboard').set(TH);
    expect(r.status).toBe(200);
    expect(r.body.header.status).toBe('SUCCESS');
    expect(r.body.body.persistency_trend).toBeDefined();
    expect(r.body.body.channel_risk).toBeDefined();
  });

  test('field_officer (read) accepted', async () => {
    const r = await request(makeInsApp('field_officer').app).get('/v1/insurance/persistency/dashboard').set(TH);
    expect(r.status).toBe(200);
  });

  test('tenant scoping — BIL diverges', async () => {
    const bank = await request(makeInsApp('admin').app).get('/v1/insurance/persistency/dashboard').set(TH);
    const bil = await request(makeInsApp('admin').app).get('/v1/insurance/persistency/dashboard').set(TH_BIL);
    const bankPif = bank.body.body.product_retention.reduce((a: number, r: { policies_in_force: number }) => a + r.policies_in_force, 0);
    const bilPif = bil.body.body.product_retention.reduce((a: number, r: { policies_in_force: number }) => a + r.policies_in_force, 0);
    expect(bilPif).toBeLessThan(bankPif);
  });

  test('missing tenant header → 400', async () => {
    const r = await request(makeInsApp('admin').app).get('/v1/insurance/persistency/dashboard').set({ 'X-Channel': 'API' });
    expect(r.status).toBe(400);
  });
});

describe('POST /v1/insurance/persistency/analyze', () => {
  test('analyst happy path', async () => {
    const r = await request(makeInsApp('risk_analyst').app)
      .post('/v1/insurance/persistency/analyze')
      .set(TH)
      .send({ dimension: 'channel', dimension_value: 'online', period_month: 13, persistency_pct: 0.65, auto_debit_share: 0.2 });
    expect(r.status).toBe(200);
    expect(r.body.body.root_causes).toBeDefined();
    expect(r.body.body.band).toBeDefined();
  });

  test('enveloped body accepted', async () => {
    const r = await request(makeInsApp('admin').app)
      .post('/v1/insurance/persistency/analyze')
      .set(TH)
      .send({ header: {}, body: { dimension: 'product', dimension_value: 'ULIP', persistency_pct: 0.7 } });
    expect(r.status).toBe(200);
    expect(r.body.body.dimension_value).toBe('ULIP');
  });

  test('invalid dimension → 400', async () => {
    const r = await request(makeInsApp('admin').app)
      .post('/v1/insurance/persistency/analyze')
      .set(TH)
      .send({ dimension: 'nonsense', dimension_value: 'x' });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_dimension');
  });

  test('field_officer lacks analyze scope → 403', async () => {
    const r = await request(makeInsApp('field_officer').app)
      .post('/v1/insurance/persistency/analyze')
      .set(TH)
      .send({ dimension: 'product', dimension_value: 'ULIP' });
    expect(r.status).toBe(403);
  });
});

describe('GET /v1/insurance/persistency/alerts', () => {
  test('happy path', async () => {
    const r = await request(makeInsApp('admin').app).get('/v1/insurance/persistency/alerts').set(TH);
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.body.alerts)).toBe(true);
  });

  test('?severity=critical narrows', async () => {
    const r = await request(makeInsApp('admin').app).get('/v1/insurance/persistency/alerts?severity=critical').set(TH);
    for (const a of r.body.body.alerts) expect(a.severity).toBe('critical');
  });

  test('?severity=bogus → 400', async () => {
    const r = await request(makeInsApp('admin').app).get('/v1/insurance/persistency/alerts?severity=bogus').set(TH);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_input');
  });
});
