// __tests__/alert_volume_forecast.test.ts
// T6 M8.19 — Alert volume 7-day forecast

import request from 'supertest';
import {
  buildAlertVolumeForecast,
} from '../src/alert_volume_forecast';
import type { RoutedAlertRecord } from '../src/alert_routing_analytics';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-06-08T12:00:00Z');
const NOW_MS = NOW.getTime();
const DAY_MS = 24 * 60 * 60 * 1000;
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function makeForecastApp(role = 'admin') {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
  });
}

function makeRecord(daysAgo: number, cls: 'red' | 'orange' | 'yellow' | 'green' = 'orange'): RoutedAlertRecord {
  const created_at = new Date(NOW_MS - daysAgo * DAY_MS).toISOString();
  return {
    alert_id: `a-${Math.random().toString(36).slice(2)}`,
    tenant_id: 'BIL',
    class: cls,
    severity_in: 'HIGH',
    created_at,
    channels: ['email'],
    sla_hours: 24,
    escalate_after_hours: 12,
    acked_at: null,
    monitor_only: false,
  } as RoutedAlertRecord;
}

describe('buildAlertVolumeForecast — M8.19', () => {
  it('empty records → stable trend + low confidence', () => {
    const result = buildAlertVolumeForecast('BIL', [], NOW);
    expect(result.tenant_id).toBe('BIL');
    expect(result.historical_7d_avg).toBe(0);
    expect(result.historical_14d_avg).toBe(0);
    expect(result.forecast_next_7d).toBe(0);
    expect(result.trend).toBe('stable');
    expect(result.trend_pct_change).toBeNull();
    expect(result.confidence).toBe('low');
    expect(result.data_points).toBe(0);
    expect(result.warning).toBeNull();
  });

  it('7 days of data → medium confidence', () => {
    const records = Array.from({ length: 7 }, (_, i) => makeRecord(i + 1));
    const result = buildAlertVolumeForecast('BIL', records, NOW);
    expect(result.confidence).toBe('medium');
    expect(result.data_points).toBeGreaterThanOrEqual(7);
  });

  it('14 days of data → high confidence', () => {
    const records = Array.from({ length: 14 }, (_, i) => makeRecord(i + 1));
    const result = buildAlertVolumeForecast('BIL', records, NOW);
    expect(result.confidence).toBe('high');
    expect(result.data_points).toBeGreaterThanOrEqual(14);
  });

  it('rising trend when recent days have more alerts', () => {
    const recentRecords: RoutedAlertRecord[] = [];
    for (let d = 1; d <= 7; d++) {
      for (let j = 0; j < 7; j++) recentRecords.push(makeRecord(d));
    }
    for (let d = 8; d <= 14; d++) {
      for (let j = 0; j < 2; j++) recentRecords.push(makeRecord(d));
    }
    const result = buildAlertVolumeForecast('BIL', recentRecords, NOW);
    expect(result.trend).toBe('rising');
    expect(result.historical_7d_avg).toBeGreaterThan(result.historical_14d_avg);
  });

  it('falling trend when recent days have fewer alerts', () => {
    const records: RoutedAlertRecord[] = [];
    for (let d = 1; d <= 7; d++) {
      for (let j = 0; j < 2; j++) records.push(makeRecord(d));
    }
    for (let d = 8; d <= 14; d++) {
      for (let j = 0; j < 8; j++) records.push(makeRecord(d));
    }
    const result = buildAlertVolumeForecast('BIL', records, NOW);
    expect(result.trend).toBe('falling');
  });

  it('forecast_next_7d equals historical_7d_avg', () => {
    const records = Array.from({ length: 7 }, (_, i) => makeRecord(i + 1));
    const result = buildAlertVolumeForecast('BIL', records, NOW);
    expect(result.forecast_next_7d).toBe(result.historical_7d_avg);
  });

  it('by_class_forecast sums to approximately forecast_next_7d', () => {
    const records = [
      makeRecord(1, 'red'),
      makeRecord(2, 'orange'),
      makeRecord(3, 'yellow'),
    ];
    const result = buildAlertVolumeForecast('BIL', records, NOW);
    const classTotal = Object.values(result.by_class_forecast).reduce((a, b) => a + b, 0);
    expect(classTotal).toBeCloseTo(result.forecast_next_7d, 0);
  });

  it('warning when forecast spikes (rising trend + 1.5x 14d_avg)', () => {
    // recent 7 days have 10 alerts/day; prior 7 days had 1/day
    // 7d_avg = 10; 14d_avg = (70+7)/14 = 5.5; trend=rising; 10 >= 1.5*5.5=8.25 → warning
    const records: RoutedAlertRecord[] = [];
    for (let d = 1; d <= 7; d++) {
      for (let j = 0; j < 10; j++) records.push(makeRecord(d));
    }
    for (let d = 8; d <= 14; d++) {
      records.push(makeRecord(d));
    }
    const result = buildAlertVolumeForecast('BIL', records, NOW);
    expect(result.trend).toBe('rising');
    expect(result.warning).not.toBeNull();
  });

  it('admin route GET /v1/alerts/volume-forecast → 200', async () => {
    const { app } = makeForecastApp('admin');
    const res = await request(app)
      .get('/v1/alerts/volume-forecast')
      .set(TH_BIL)
      .set('x-apex-role', 'admin');
    expect(res.status).toBe(200);
    expect(typeof res.body.body.historical_7d_avg).toBe('number');
    expect(res.body.body.tenant_id).toBe('BIL');
  });

  it('non-admin role → 403', async () => {
    const { app } = makeForecastApp('field_officer');
    const res = await request(app)
      .get('/v1/alerts/volume-forecast')
      .set(TH_BIL)
      .set('x-apex-role', 'field_officer');
    expect(res.status).toBe(403);
  });

  it('M8.15 sibling regression: /v1/alerts/daily-volume still 200', async () => {
    const { app } = makeForecastApp('admin');
    const res = await request(app)
      .get('/v1/alerts/daily-volume')
      .set(TH_BIL)
      .set('x-apex-role', 'admin');
    expect(res.status).toBe(200);
  });
});
