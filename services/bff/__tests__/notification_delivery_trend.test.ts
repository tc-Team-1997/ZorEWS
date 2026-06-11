// @ts-nocheck
// services/bff/__tests__/notification_delivery_trend.test.ts
// T6 M10.22 — Notification delivery success rate trend.

import request from 'supertest';
import { buildNotificationDeliveryTrend } from '../src/notification_delivery_trend';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-06-11T12:00:00.000Z');
const TH = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function fakeApp(role = 'admin') {
  const { app } = makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    getRole: () => role,
    now: () => NOW,
  });
  return app;
}

// ─── Pure function tests ────────────────────────────────────────────────

describe('M10.22 — buildNotificationDeliveryTrend — shape', () => {
  test('returns exactly 7 days', () => {
    const out = buildNotificationDeliveryTrend('BIL', NOW);
    expect(out.days).toBe(7);
    expect(out.trend).toHaveLength(7);
  });

  test('trend is oldest-first', () => {
    const out = buildNotificationDeliveryTrend('BIL', NOW);
    // ISO date strings sort correctly as strings: "2026-06-05" < "2026-06-11"
    expect(out.trend[0].date < out.trend[6].date).toBe(true);
    expect(out.trend[6].date).toBe(NOW.toISOString().slice(0, 10));
  });

  test('all rates in [0.85, 0.99]', () => {
    const out = buildNotificationDeliveryTrend('BIL', NOW);
    for (const day of out.trend) {
      expect(day.email_success_rate).toBeGreaterThanOrEqual(0.85);
      expect(day.email_success_rate).toBeLessThanOrEqual(0.99);
      expect(day.sms_success_rate).toBeGreaterThanOrEqual(0.85);
      expect(day.push_success_rate).toBeGreaterThanOrEqual(0.85);
    }
  });

  test('overall_success_rate = mean of 3 channels', () => {
    const out = buildNotificationDeliveryTrend('BIL', NOW);
    for (const day of out.trend) {
      const expected = Math.round(
        ((day.email_success_rate + day.sms_success_rate + day.push_success_rate) / 3) * 1000,
      ) / 1000;
      expect(day.overall_success_rate).toBeCloseTo(expected, 3);
    }
  });

  test('deterministic per (tenant, date)', () => {
    const a = buildNotificationDeliveryTrend('BIL', NOW);
    const b = buildNotificationDeliveryTrend('BIL', NOW);
    expect(a.trend[3].email_success_rate).toBe(b.trend[3].email_success_rate);
  });

  test('different tenants yield different rates', () => {
    const a = buildNotificationDeliveryTrend('BIL', NOW);
    const b = buildNotificationDeliveryTrend('BANK_DEMO', NOW);
    // Highly unlikely to be identical across all days
    const differs = a.trend.some((d, i) => d.email_success_rate !== b.trend[i].email_success_rate);
    expect(differs).toBe(true);
  });

  test('avg_overall_success_rate is mean over 7 days', () => {
    const out = buildNotificationDeliveryTrend('BIL', NOW);
    const expected = Math.round(
      (out.trend.reduce((s, d) => s + d.overall_success_rate, 0) / 7) * 1000,
    ) / 1000;
    expect(out.avg_overall_success_rate).toBe(expected);
  });

  test('generated_at = NOW', () => {
    const out = buildNotificationDeliveryTrend('BIL', NOW);
    expect(out.generated_at).toBe(NOW.toISOString());
  });
});

// ─── Route tests ────────────────────────────────────────────────────────

describe('M10.22 — route GET /v1/notifications/delivery-trend', () => {
  test('admin → 200 with 7-day trend', async () => {
    const app = fakeApp('admin');
    const res = await request(app).get('/v1/notifications/delivery-trend').set(TH);
    expect(res.status).toBe(200);
    expect(res.body.body.days).toBe(7);
    expect(res.body.body.trend).toHaveLength(7);
  });

  test('case_owner → 403', async () => {
    const app = fakeApp('case_owner');
    const res = await request(app).get('/v1/notifications/delivery-trend').set(TH);
    expect(res.status).toBe(403);
  });

  test('no tenant → 400', async () => {
    const app = fakeApp('admin');
    const res = await request(app).get('/v1/notifications/delivery-trend');
    expect(res.status).toBe(400);
  });
});
