// @ts-nocheck
// services/bff/__tests__/report_peak_hours.test.ts
// T6 M12.24 — Report job peak hour analysis tests

import { buildReportPeakHours } from '../src/report_peak_hours';
import { InMemoryReportJobStore } from '../src/reports_catalog';

const NOW = new Date('2026-05-22T12:00:00.000Z');

describe('buildReportPeakHours — pure resolver', () => {
  test('empty store → 24 zero buckets, peak/quietest null', () => {
    const store = new InMemoryReportJobStore();
    const r = buildReportPeakHours(store, 'BANK_DEMO', NOW);
    expect(r.tenant_id).toBe('BANK_DEMO');
    expect(r.by_hour).toHaveLength(24);
    expect(r.by_hour.every((b) => b.job_count === 0)).toBe(true);
    expect(r.peak_hour).toBeNull();
    expect(r.quietest_hour).toBeNull();
    expect(r.recommended_maintenance_window).toBeNull();
  });

  test('by_hour has 24 entries ordered 0-23', () => {
    const store = new InMemoryReportJobStore();
    const r = buildReportPeakHours(store, 'BANK_DEMO', NOW);
    for (let h = 0; h < 24; h++) {
      expect(r.by_hour[h].hour).toBe(h);
    }
  });

  test('job submitted at UTC 10h → bucket 10', () => {
    const store = new InMemoryReportJobStore();
    const ts = new Date('2026-05-22T10:30:00.000Z'); // UTC 10
    store.submit('BANK_DEMO', { report_id: 'portfolio_snapshot_daily', format: 'json' }, 'alice', ts);
    const r = buildReportPeakHours(store, 'BANK_DEMO', NOW);
    expect(r.by_hour[10].job_count).toBe(1);
    expect(r.peak_hour).toBe(10);
  });

  test('avg_per_hour = total / 24', () => {
    const store = new InMemoryReportJobStore();
    const ts = new Date('2026-05-22T10:30:00.000Z');
    store.submit('BANK_DEMO', { report_id: 'portfolio_snapshot_daily', format: 'json' }, 'alice', ts);
    store.submit('BANK_DEMO', { report_id: 'portfolio_snapshot_daily', format: 'json' }, 'alice', ts);
    const r = buildReportPeakHours(store, 'BANK_DEMO', NOW);
    expect(r.avg_per_hour).toBeCloseTo(2 / 24, 2);
  });

  test('format_mix counts format correctly', () => {
    const store = new InMemoryReportJobStore();
    const ts = new Date('2026-05-22T14:00:00.000Z');
    store.submit('BANK_DEMO', { report_id: 'portfolio_snapshot_daily', format: 'csv' }, 'alice', ts);
    const r = buildReportPeakHours(store, 'BANK_DEMO', NOW);
    expect(r.by_hour[14].format_mix.csv).toBe(1);
    expect(r.by_hour[14].format_mix.json).toBe(0);
  });

  test('recommended_maintenance_window present when jobs exist', () => {
    const store = new InMemoryReportJobStore();
    const ts = new Date('2026-05-22T10:00:00.000Z');
    store.submit('BANK_DEMO', { report_id: 'portfolio_snapshot_daily', format: 'json' }, 'alice', ts);
    const r = buildReportPeakHours(store, 'BANK_DEMO', NOW);
    expect(r.recommended_maintenance_window).not.toBeNull();
    expect(typeof r.recommended_maintenance_window.start_hour).toBe('number');
    expect(typeof r.recommended_maintenance_window.end_hour).toBe('number');
  });

  test('tenant scoping: BIL jobs invisible to BANK_DEMO', () => {
    const store = new InMemoryReportJobStore();
    const ts = new Date('2026-05-22T10:00:00.000Z');
    store.submit('BIL', { report_id: 'portfolio_snapshot_daily', format: 'json' }, 'alice', ts);
    const r = buildReportPeakHours(store, 'BANK_DEMO', NOW);
    expect(r.by_hour.every((b) => b.job_count === 0)).toBe(true);
  });

  test('throws on empty tenant_id', () => {
    const store = new InMemoryReportJobStore();
    expect(() => buildReportPeakHours(store, '', NOW)).toThrow();
  });
});

// ─── Route tests ──────────────────────────────────────────────────────

import request from 'supertest';
import { makeApp } from '../src/server';

const HEADERS_ADMIN = {
  'X-Tenant-ID': 'BIL',
  'X-Channel': 'API',
  'X-APEX-USER': 'alice.admin',
  'X-Apex-Role': 'admin',
};

describe('GET /v1/reports/jobs/peak-hours', () => {
  test('admin 200 with envelope', async () => {
    const { app } = makeApp({});
    const r = await request(app)
      .get('/v1/reports/jobs/peak-hours')
      .set(HEADERS_ADMIN);
    expect(r.status).toBe(200);
    expect(r.body.header.status).toBe('SUCCESS');
    expect(r.body.body.by_hour).toHaveLength(24);
  });

  test('403 for field_officer', async () => {
    const { app } = makeApp({});
    const r = await request(app)
      .get('/v1/reports/jobs/peak-hours')
      .set({ ...HEADERS_ADMIN, 'X-Apex-Role': 'field_officer' });
    expect(r.status).toBe(403);
  });

  test('400 missing tenant header', async () => {
    const { app } = makeApp({});
    const r = await request(app)
      .get('/v1/reports/jobs/peak-hours')
      .set({ 'X-Apex-Role': 'admin' });
    expect(r.status).toBe(400);
  });

  test('cross-tenant: BIL admin sees BIL data only', async () => {
    const { app } = makeApp({});
    const r = await request(app)
      .get('/v1/reports/jobs/peak-hours')
      .set(HEADERS_ADMIN);
    expect(r.body.body.tenant_id).toBe('BIL');
  });
});
