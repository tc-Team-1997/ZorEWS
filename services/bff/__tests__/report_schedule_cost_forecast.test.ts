// @ts-nocheck
import request from 'supertest';
import { buildReportScheduleCostForecast } from '../src/report_schedule_cost_forecast';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-06-11T12:00:00Z');
const H = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function fakeApp(role = 'admin') {
  const { app } = makeApp({ source: new StaticSource([]), evaluator: new StubEvaluator(), riskProfile: new StubRiskProfileSource(), caseAction: new UnavailableCaseActionSink(), getRole: () => role, now: () => NOW });
  return app;
}

describe('buildReportScheduleCostForecast', () => {
  test('returns report with expected fields', () => {
    const r = buildReportScheduleCostForecast('SCHED_COST_1', NOW);
    expect(r.tenant_id).toBe('SCHED_COST_1');
    expect(typeof r.monthly_cost_forecast_usd).toBe('number');
    expect(r.monthly_cost_forecast_usd).toBeGreaterThanOrEqual(0);
  });
  test('by_format breakdown present', () => {
    const r = buildReportScheduleCostForecast('SCHED_COST_2', NOW);
    expect(r.by_format).toBeDefined();
  });
  test('by_cadence breakdown present', () => {
    const r = buildReportScheduleCostForecast('SCHED_COST_3', NOW);
    expect(r.by_cadence).toBeDefined();
  });
  test('generated_at echoed', () => {
    const r = buildReportScheduleCostForecast('SCHED_COST_4', NOW);
    expect(r.generated_at).toBe(NOW.toISOString());
  });
  test('total_enabled_schedules is non-negative', () => {
    const r = buildReportScheduleCostForecast('SCHED_COST_5', NOW);
    expect(r.total_enabled_schedules).toBeGreaterThanOrEqual(0);
  });
  test('deterministic', () => {
    const a = buildReportScheduleCostForecast('SCHED_COST_DET', NOW);
    const b = buildReportScheduleCostForecast('SCHED_COST_DET', NOW);
    expect(a.monthly_cost_forecast_usd).toBe(b.monthly_cost_forecast_usd);
  });
});

describe('GET /v1/reports/schedules/cost-forecast', () => {
  test('admin → 200', async () => {
    const res = await request(fakeApp()).get('/v1/reports/schedules/cost-forecast').set(H);
    expect(res.status).toBe(200);
    expect(res.body.body).toHaveProperty('monthly_cost_forecast_usd');
    expect(res.body.body).toHaveProperty('by_cadence');
  });
  test('field_officer → 403', async () => {
    const res = await request(fakeApp('field_officer')).get('/v1/reports/schedules/cost-forecast').set(H);
    expect(res.status).toBe(403);
  });
  test('no tenant → 400', async () => {
    const res = await request(fakeApp()).get('/v1/reports/schedules/cost-forecast').set('X-Channel','API');
    expect(res.status).toBe(400);
  });
});
