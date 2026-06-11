// @ts-nocheck
// T6 M10.26 — Notification retry pattern analysis.

import request from 'supertest';
import { buildNotificationRetryPatterns } from '../src/notification_retry_patterns';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-06-04T12:00:00.000Z');
const TH = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function makeRetryApp(role = 'admin') {
  const { app } = makeApp({ source: new StaticSource([]), evaluator: new StubEvaluator(), riskProfile: new StubRiskProfileSource(), caseAction: new UnavailableCaseActionSink(), now: () => NOW, getRole: () => role });
  return app;
}

describe('M10.26 — retry patterns', () => {
  test('returns all 3 channels', () => {
    const out = buildNotificationRetryPatterns('BIL', NOW);
    expect(out.channels.length).toBe(3);
    const channelNames = out.channels.map((c) => c.channel);
    expect(channelNames).toContain('email');
    expect(channelNames).toContain('sms');
    expect(channelNames).toContain('push');
  });

  test('all field values are in valid ranges', () => {
    const out = buildNotificationRetryPatterns('BIL', NOW);
    for (const c of out.channels) {
      expect(c.retry_rate).toBeGreaterThanOrEqual(0);
      expect(c.retry_rate).toBeLessThanOrEqual(0.15);
      expect(c.avg_retries_per_failure).toBeGreaterThanOrEqual(1);
      expect(c.retry_success_rate).toBeGreaterThanOrEqual(0.7);
      expect(c.retry_success_rate).toBeLessThanOrEqual(0.95);
      expect(c.cost_multiplier).toBeGreaterThanOrEqual(1);
      expect(['A', 'B', 'C', 'D']).toContain(c.efficiency_grade);
    }
  });

  test('highest_retry_channel is the one with max retry_rate', () => {
    const out = buildNotificationRetryPatterns('BIL', NOW);
    const maxRetry = Math.max(...out.channels.map((c) => c.retry_rate));
    const highest = out.channels.find((c) => c.retry_rate === maxRetry);
    expect(out.highest_retry_channel).toBe(highest.channel);
  });

  test('sorted by retry_rate desc', () => {
    const out = buildNotificationRetryPatterns('BIL', NOW);
    for (let i = 0; i < out.channels.length - 1; i++) {
      expect(out.channels[i].retry_rate).toBeGreaterThanOrEqual(out.channels[i + 1].retry_rate);
    }
  });

  test('deterministic per (tenant, day)', () => {
    const out1 = buildNotificationRetryPatterns('BIL', NOW);
    const out2 = buildNotificationRetryPatterns('BIL', NOW);
    expect(out1.channels[0].retry_rate).toBe(out2.channels[0].retry_rate);
  });

  test('different tenants get different values', () => {
    const out1 = buildNotificationRetryPatterns('BIL', NOW);
    const out2 = buildNotificationRetryPatterns('BANK_DEMO', NOW);
    const allSame = out1.channels.every((c, i) => c.retry_rate === out2.channels[i].retry_rate);
    expect(allSame).toBe(false);
  });
});

describe('M10.26 — route', () => {
  test('admin GET /v1/notifications/retry-patterns returns 200', async () => {
    const app = makeRetryApp();
    const res = await request(app).get('/v1/notifications/retry-patterns').set(TH);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.body.channels)).toBe(true);
    expect(res.body.body.channels.length).toBe(3);
  });

  test('non-admin gets 403', async () => {
    const app = makeRetryApp('field_officer');
    const res = await request(app).get('/v1/notifications/retry-patterns').set(TH);
    expect(res.status).toBe(403);
  });
});
