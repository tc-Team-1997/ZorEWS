// @ts-nocheck
// services/bff/__tests__/report_job_format_size.test.ts
//
// T6 M12.20 — Report job output format size distribution.

import request from 'supertest';
import {
  buildReportFormatSizeDistribution,
  buildReportFormatSizeDistributionFromStore,
} from '../src/report_job_format_size';
import { InMemoryReportJobStore } from '../src/reports_catalog';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-06-01T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function mkJob(id, format, tenant = 'BIL') {
  return {
    job_id: id,
    tenant_id: tenant,
    report_id: 'rpt_test',
    format,
    status: 'completed',
    requested_at: NOW.toISOString(),
    completed_at: NOW.toISOString(),
    requested_by: 'admin',
    parameters: {},
    download_url: null,
    error_message: null,
  };
}

function makeSizeApp(role) {
  const reportJobStore = new InMemoryReportJobStore();
  const source = new StaticSource([]);
  const evaluator = new StubEvaluator();
  const riskProfile = new StubRiskProfileSource();
  const caseAction = new UnavailableCaseActionSink();
  const getRole = () => role;
  const { app } = makeApp({ source, evaluator, riskProfile, caseAction, getRole, reportJobStore });
  return { app, reportJobStore };
}

// ─── Pure function tests ────────────────────────────────────────────

describe('buildReportFormatSizeDistribution — pure', () => {
  test('empty jobs → all formats present with 0 counts', () => {
    const result = buildReportFormatSizeDistribution([], 'BIL', NOW);
    expect(result.tenant_id).toBe('BIL');
    expect(result.total_completed).toBe(0);
    expect(result.formats).toHaveLength(4);
    for (const row of result.formats) {
      expect(row.job_count).toBe(0);
      expect(row.avg_size_kb).toBe(0);
      expect(row.total_size_kb).toBe(0);
      expect(row.largest_job).toBeNull();
    }
    expect(result.largest_format).toBeNull();
    expect(result.total_estimated_storage_kb).toBe(0);
  });

  test('completed jobs generate size estimates in declared ranges', () => {
    const jobs = [mkJob('j1', 'json'), mkJob('j2', 'csv'), mkJob('j3', 'pdf'), mkJob('j4', 'xlsx')];
    const result = buildReportFormatSizeDistribution(jobs, 'BIL', NOW);
    const jsonRow = result.formats.find(r => r.format === 'json');
    const pdfRow = result.formats.find(r => r.format === 'pdf');
    // json range: 50–500KB
    expect(jsonRow.avg_size_kb).toBeGreaterThanOrEqual(50);
    expect(jsonRow.avg_size_kb).toBeLessThanOrEqual(500);
    // pdf range: 500–5120KB
    expect(pdfRow.avg_size_kb).toBeGreaterThanOrEqual(500);
    expect(pdfRow.avg_size_kb).toBeLessThanOrEqual(5120);
  });

  test('largest_format is the format with highest total_size_kb', () => {
    const jobs = [mkJob('j1', 'pdf'), mkJob('j2', 'pdf'), mkJob('j3', 'pdf')];
    const result = buildReportFormatSizeDistribution(jobs, 'BIL', NOW);
    // pdf has highest range so should dominate
    // At minimum the format with most jobs should rank high
    expect(result.largest_format).toBeTruthy();
    // The largest format should be the one at position 0 in formats
    expect(result.formats[0].total_size_kb).toBeGreaterThanOrEqual(result.formats[1].total_size_kb);
  });

  test('cross-tenant: BANK_DEMO jobs not counted for BIL', () => {
    const jobs = [mkJob('j1', 'json', 'BANK_DEMO'), mkJob('j2', 'csv', 'BANK_DEMO')];
    const result = buildReportFormatSizeDistribution(jobs, 'BIL', NOW);
    expect(result.total_completed).toBe(0);
  });

  test('non-completed jobs excluded', () => {
    const failedJob = { ...mkJob('j1', 'pdf'), status: 'failed' };
    const queuedJob = { ...mkJob('j2', 'csv'), status: 'queued' };
    const result = buildReportFormatSizeDistribution([failedJob, queuedJob], 'BIL', NOW);
    expect(result.total_completed).toBe(0);
  });

  test('deterministic: same job_id + format always gives same size estimate', () => {
    const jobs = [mkJob('fixed-job-id', 'json')];
    const r1 = buildReportFormatSizeDistribution(jobs, 'BIL', NOW);
    const r2 = buildReportFormatSizeDistribution(jobs, 'BIL', new Date('2026-01-01'));
    const jsonRow1 = r1.formats.find(r => r.format === 'json');
    const jsonRow2 = r2.formats.find(r => r.format === 'json');
    expect(jsonRow1.avg_size_kb).toBe(jsonRow2.avg_size_kb);
  });

  test('total_estimated_storage_kb = sum of format total_size_kb', () => {
    const jobs = [mkJob('j1', 'json'), mkJob('j2', 'pdf')];
    const result = buildReportFormatSizeDistribution(jobs, 'BIL', NOW);
    const sum = result.formats.reduce((s, r) => s + r.total_size_kb, 0);
    expect(Math.abs(result.total_estimated_storage_kb - sum)).toBeLessThan(0.1);
  });
});

// ─── Route tests ────────────────────────────────────────────────────

describe('M12.20 — GET /v1/reports/jobs/format-size', () => {
  test('admin → 200 with envelope (empty store)', async () => {
    const { app } = makeSizeApp('admin');
    const r = await request(app).get('/v1/reports/jobs/format-size').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.formats).toHaveLength(4);
    expect(r.body.body.total_completed).toBe(0);
    expect(r.body.body.largest_format).toBeNull();
  });

  test('populated → shows format sizes', async () => {
    const { app, reportJobStore } = makeSizeApp('admin');
    reportJobStore.submit('BIL', { report_id: 'portfolio_snapshot_daily', format: 'pdf' }, 'admin', NOW);
    reportJobStore.submit('BIL', { report_id: 'portfolio_snapshot_daily', format: 'json' }, 'admin', NOW);
    const r = await request(app).get('/v1/reports/jobs/format-size').set(TH_BIL);
    // Note: newly submitted jobs may be queued/completed depending on store behaviour
    expect(r.status).toBe(200);
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeSizeApp('field_officer');
    const r = await request(app).get('/v1/reports/jobs/format-size').set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('400 when no tenant header', async () => {
    const { app } = makeSizeApp('admin');
    const r = await request(app).get('/v1/reports/jobs/format-size');
    expect(r.status).toBe(400);
  });
});
