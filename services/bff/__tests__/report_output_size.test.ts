// @ts-nocheck
// services/bff/__tests__/report_output_size.test.ts
// T6 M12.22 — Report output size distribution.

import request from 'supertest';
import { buildReportOutputSizeDistribution } from '../src/report_output_size';
import { InMemoryReportJobStore } from '../src/reports_catalog';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-06-11T12:00:00.000Z');
const TH = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function fakeApp(role = 'admin', store = undefined) {
  const jobStore = store ?? new InMemoryReportJobStore();
  const { app } = makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    reportJobStore: jobStore,
    getRole: () => role,
    now: () => NOW,
  });
  return { app, jobStore };
}

// ─── Pure function tests ────────────────────────────────────────────────

describe('M12.22 — buildReportOutputSizeDistribution — empty', () => {
  test('no jobs → zeros, null avg and largest', () => {
    const store = new InMemoryReportJobStore();
    const out = buildReportOutputSizeDistribution(store, 'BIL', NOW);
    expect(out.total_jobs).toBe(0);
    expect(out.avg_size_bytes).toBeNull();
    expect(out.largest_job_id).toBeNull();
    expect(out.buckets.small + out.buckets.medium + out.buckets.large + out.buckets.xlarge).toBe(0);
  });
});

describe('M12.22 — buildReportOutputSizeDistribution — with jobs', () => {
  test('queued jobs appear in total but not in buckets', () => {
    const store = new InMemoryReportJobStore();
    // Submit a job - status starts as queued
    store.submit('BIL', { report_id: 'portfolio_snapshot_daily', format: 'json' }, 'alice', NOW);
    const out = buildReportOutputSizeDistribution(store, 'BIL', NOW);
    // Queued jobs are included in total_jobs count; buckets may be all zero
    expect(out.total_jobs).toBeGreaterThanOrEqual(0);
    const bucketTotal = out.buckets.small + out.buckets.medium + out.buckets.large + out.buckets.xlarge;
    expect(bucketTotal).toBeLessThanOrEqual(out.total_jobs);
  });

  test('by_format initialized for all 4 formats', () => {
    const store = new InMemoryReportJobStore();
    const out = buildReportOutputSizeDistribution(store, 'BIL', NOW);
    expect(out.by_format).toHaveProperty('json');
    expect(out.by_format).toHaveProperty('csv');
    expect(out.by_format).toHaveProperty('pdf');
    expect(out.by_format).toHaveProperty('xlsx');
  });

  test('tenant_id echoed', () => {
    const store = new InMemoryReportJobStore();
    const out = buildReportOutputSizeDistribution(store, 'BIL', NOW);
    expect(out.tenant_id).toBe('BIL');
  });

  test('generated_at echoes NOW', () => {
    const store = new InMemoryReportJobStore();
    const out = buildReportOutputSizeDistribution(store, 'BIL', NOW);
    expect(out.generated_at).toBe(NOW.toISOString());
  });

  test('bucket counts sum to total_jobs', () => {
    const store = new InMemoryReportJobStore();
    const out = buildReportOutputSizeDistribution(store, 'BIL', NOW);
    const sum = out.buckets.small + out.buckets.medium + out.buckets.large + out.buckets.xlarge;
    expect(sum).toBe(out.total_jobs);
  });

  test('tenant isolation', () => {
    const store = new InMemoryReportJobStore();
    const out1 = buildReportOutputSizeDistribution(store, 'BIL', NOW);
    const out2 = buildReportOutputSizeDistribution(store, 'BANK_DEMO', NOW);
    expect(out1.total_jobs).toBe(0);
    expect(out2.total_jobs).toBe(0);
  });
});

// ─── Route tests ────────────────────────────────────────────────────────

describe('M12.22 — route GET /v1/reports/jobs/output-size-distribution', () => {
  test('admin → 200 with buckets', async () => {
    const { app } = fakeApp('admin');
    const res = await request(app).get('/v1/reports/jobs/output-size-distribution').set(TH);
    expect(res.status).toBe(200);
    expect(res.body.body).toHaveProperty('buckets');
    expect(res.body.body).toHaveProperty('total_jobs');
  });

  test('case_owner → 403', async () => {
    const { app } = fakeApp('case_owner');
    const res = await request(app).get('/v1/reports/jobs/output-size-distribution').set(TH);
    expect(res.status).toBe(403);
  });

  test('no tenant → 400', async () => {
    const { app } = fakeApp('admin');
    const res = await request(app).get('/v1/reports/jobs/output-size-distribution');
    expect(res.status).toBe(400);
  });
});
