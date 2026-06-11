// @ts-nocheck
import { describe, it, expect } from '@jest/globals';
import { makeApp } from '../src/server';
import supertest from 'supertest';
import { buildReportConsumerBehavior } from '../src/report_consumer_behavior';
import { InMemoryReportJobStore } from '../src/reports_catalog';

const NOW = new Date('2026-06-11T12:00:00Z');

describe('buildReportConsumerBehavior', () => {
  it('returns zero stats for empty store', () => {
    const store = new InMemoryReportJobStore();
    const out = buildReportConsumerBehavior(store, 'BIL', NOW);
    expect(out.total_jobs).toBe(0);
    expect(out.unique_requesters).toBe(0);
    expect(out.repeat_requesters).toBe(0);
  });

  it('has required envelope fields', () => {
    const store = new InMemoryReportJobStore();
    const out = buildReportConsumerBehavior(store, 'BIL', NOW);
    expect(out.tenant_id).toBe('BIL');
    expect(out.generated_at).toBeDefined();
    expect(typeof out.engagement_score).toBe('number');
    expect(['high', 'medium', 'low']).toContain(out.engagement_tier);
    expect(typeof out.peak_request_day).toBe('string');
    expect(Array.isArray(out.format_preference)).toBe(true);
    expect(Array.isArray(out.top_requesters)).toBe(true);
  });

  it('counts unique requesters correctly', () => {
    const store = new InMemoryReportJobStore();
    store.submit('BIL', { report_id: 'portfolio_snapshot_daily', format: 'json', parameters: {} }, 'alice', NOW);
    store.submit('BIL', { report_id: 'portfolio_snapshot_daily', format: 'csv', parameters: {} }, 'bob', NOW);
    const out = buildReportConsumerBehavior(store, 'BIL', NOW);
    expect(out.unique_requesters).toBe(2);
  });

  it('counts repeat requesters (more than 1 request)', () => {
    const store = new InMemoryReportJobStore();
    store.submit('BIL', { report_id: 'portfolio_snapshot_daily', format: 'json', parameters: {} }, 'alice', NOW);
    store.submit('BIL', { report_id: 'portfolio_snapshot_daily', format: 'csv', parameters: {} }, 'alice', NOW);
    const out = buildReportConsumerBehavior(store, 'BIL', NOW);
    expect(out.repeat_requesters).toBe(1);
  });

  it('engagement_score is in [0, 100]', () => {
    const store = new InMemoryReportJobStore();
    const out = buildReportConsumerBehavior(store, 'BIL', NOW);
    expect(out.engagement_score).toBeGreaterThanOrEqual(0);
    expect(out.engagement_score).toBeLessThanOrEqual(100);
  });

  it('is tenant-isolated', () => {
    const store = new InMemoryReportJobStore();
    store.submit('BIL', { report_id: 'portfolio_snapshot_daily', format: 'json', parameters: {} }, 'alice', NOW);
    const outBil = buildReportConsumerBehavior(store, 'BIL', NOW);
    const outBank = buildReportConsumerBehavior(store, 'BANK_DEMO', NOW);
    expect(outBil.total_jobs).toBe(1);
    expect(outBank.total_jobs).toBe(0);
  });
});

describe('GET /v1/reports/jobs/consumer-behavior', () => {
  it('returns 200 for admin', async () => {
    const { app } = makeApp({});
    const res = await supertest(app)
      .get('/v1/reports/jobs/consumer-behavior')
      .set('X-Tenant-ID', 'BIL').set('X-Channel', 'API').set('x-apex-role', 'admin');
    expect(res.status).toBe(200);
    expect(typeof res.body.body.total_jobs).toBe('number');
  });

  it('returns 403 for field_officer', async () => {
    const { app } = makeApp({});
    const res = await supertest(app)
      .get('/v1/reports/jobs/consumer-behavior')
      .set('X-Tenant-ID', 'BIL').set('X-Channel', 'API').set('x-apex-role', 'field_officer');
    expect(res.status).toBe(403);
  });
});
