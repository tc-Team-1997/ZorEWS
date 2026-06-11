// @ts-nocheck
// T6 M12.25 — Report quality metrics tests.

import request from 'supertest';
import { buildReportQualityMetrics } from '../src/report_quality_metrics';
import { InMemoryReportJobStore, defaultReportJobStore } from '../src/reports_catalog';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-06-01T10:00:00.000Z');
const TH = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function makeTestApp(role = 'admin') {
  const { app } = makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
  });
  return app;
}

function submitAndComplete(store, tenant, report_id) {
  // InMemoryReportJobStore sets status='completed' immediately on submit
  const job = store.submit(tenant, { report_id, format: 'json', parameters: {} }, 'alice', NOW);
  return job;
}

describe('M12.25 — buildReportQualityMetrics pure', () => {
  test('empty store returns zero result', () => {
    const store = new InMemoryReportJobStore();
    const result = buildReportQualityMetrics(store, 'BIL', NOW);
    expect(result.total_completed).toBe(0);
    expect(result.by_report).toHaveLength(0);
    expect(result.most_data_rich_report).toBeNull();
    expect(result.reports_count).toBe(0);
  });

  test('single completed job creates one by_report entry', () => {
    const store = new InMemoryReportJobStore();
    submitAndComplete(store, 'BIL', 'portfolio_snapshot_daily');
    const result = buildReportQualityMetrics(store, 'BIL', NOW);
    expect(result.total_completed).toBe(1);
    expect(result.by_report).toHaveLength(1);
    expect(result.by_report[0].report_id).toBe('portfolio_snapshot_daily');
    expect(result.by_report[0].completed_count).toBe(1);
  });

  test('quality_grade follows data_freshness_score thresholds', () => {
    const store = new InMemoryReportJobStore();
    submitAndComplete(store, 'BIL', 'portfolio_snapshot_daily');
    const result = buildReportQualityMetrics(store, 'BIL', NOW);
    const entry = result.by_report[0];
    if (entry.data_freshness_score >= 90) expect(entry.quality_grade).toBe('A');
    else if (entry.data_freshness_score >= 80) expect(entry.quality_grade).toBe('B');
    else expect(entry.quality_grade).toBe('C');
  });

  test('sorted by avg_row_count desc', () => {
    const store = new InMemoryReportJobStore();
    submitAndComplete(store, 'BIL', 'portfolio_snapshot_daily');
    submitAndComplete(store, 'BIL', 'rbi_quarterly_summary');
    const result = buildReportQualityMetrics(store, 'BIL', NOW);
    if (result.by_report.length >= 2) {
      expect(result.by_report[0].avg_row_count).toBeGreaterThanOrEqual(result.by_report[1].avg_row_count);
    }
  });

  test('tenant_id and generated_at echoed', () => {
    const store = new InMemoryReportJobStore();
    const result = buildReportQualityMetrics(store, 'BIL', NOW);
    expect(result.tenant_id).toBe('BIL');
    expect(result.generated_at).toBe(NOW.toISOString());
  });
});

describe('M12.25 — GET /v1/reports/jobs/quality-metrics route', () => {
  test('admin 200 with envelope', async () => {
    const app = makeTestApp();
    const res = await request(app).get('/v1/reports/jobs/quality-metrics').set(TH);
    expect(res.status).toBe(200);
    expect(res.body.body).toBeDefined();
    expect(res.body.body.by_report).toBeInstanceOf(Array);
  });

  test('field_officer 403', async () => {
    const app = makeTestApp('field_officer');
    const res = await request(app).get('/v1/reports/jobs/quality-metrics').set(TH);
    expect(res.status).toBe(403);
  });

  test('no tenant header → 400', async () => {
    const app = makeTestApp();
    const res = await request(app).get('/v1/reports/jobs/quality-metrics');
    expect(res.status).toBe(400);
  });
});
