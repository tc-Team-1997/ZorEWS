// @ts-nocheck
// services/bff/__tests__/adapter_error_classifier.test.ts
// T6 M14.34 — Adapter error classification.

import request from 'supertest';
import { buildAdapterErrorClassification } from '../src/adapter_error_classifier';
import { listFleetAdapters } from '../src/adapter_health';
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

describe('M14.34 — buildAdapterErrorClassification — shape', () => {
  test('returns all 8 adapters', () => {
    const out = buildAdapterErrorClassification('BIL', NOW);
    expect(out.adapters).toHaveLength(listFleetAdapters().length);
    expect(out.adapters).toHaveLength(8);
  });

  test('each adapter has 4 error_classes', () => {
    const out = buildAdapterErrorClassification('BIL', NOW);
    for (const a of out.adapters) {
      expect(a.error_classes).toHaveLength(4);
    }
  });

  test('error types are the 4 expected', () => {
    const out = buildAdapterErrorClassification('BIL', NOW);
    const types = out.adapters[0].error_classes.map((e) => e.type);
    expect(types).toContain('timeout');
    expect(types).toContain('auth_failure');
    expect(types).toContain('data_format');
    expect(types).toContain('unavailable');
  });

  test('overall_risk_score in [0, 100]', () => {
    const out = buildAdapterErrorClassification('BIL', NOW);
    for (const a of out.adapters) {
      expect(a.overall_risk_score).toBeGreaterThanOrEqual(0);
      expect(a.overall_risk_score).toBeLessThanOrEqual(100);
    }
  });

  test('sorted by overall_risk_score desc', () => {
    const out = buildAdapterErrorClassification('BIL', NOW);
    for (let i = 0; i < out.adapters.length - 1; i++) {
      expect(out.adapters[i].overall_risk_score).toBeGreaterThanOrEqual(out.adapters[i + 1].overall_risk_score);
    }
  });

  test('highest_risk_adapter is first adapter', () => {
    const out = buildAdapterErrorClassification('BIL', NOW);
    expect(out.highest_risk_adapter).toBe(out.adapters[0].adapter_id);
  });

  test('deterministic per (tenant)', () => {
    const a = buildAdapterErrorClassification('BIL', NOW);
    const b = buildAdapterErrorClassification('BIL', NOW);
    expect(a.adapters[0].overall_risk_score).toBe(b.adapters[0].overall_risk_score);
  });

  test('different tenants yield different risk scores', () => {
    const a = buildAdapterErrorClassification('BIL', NOW);
    const b = buildAdapterErrorClassification('BANK_DEMO', NOW);
    const differs = a.adapters.some((ap, i) => ap.overall_risk_score !== b.adapters[i].overall_risk_score);
    expect(differs).toBe(true);
  });

  test('each adapter has label and adapter_id', () => {
    const out = buildAdapterErrorClassification('BIL', NOW);
    for (const a of out.adapters) {
      expect(typeof a.adapter_id).toBe('string');
      expect(typeof a.label).toBe('string');
    }
  });

  test('avg_risk_score is mean of adapter scores', () => {
    const out = buildAdapterErrorClassification('BIL', NOW);
    const expected = Math.round(
      (out.adapters.reduce((s, a) => s + a.overall_risk_score, 0) / out.adapters.length) * 100,
    ) / 100;
    expect(out.avg_risk_score).toBe(expected);
  });
});

// ─── Route tests ────────────────────────────────────────────────────────

describe('M14.34 — route GET /v1/integrations/adapters/error-classification', () => {
  test('admin → 200 with 8 adapters', async () => {
    const app = fakeApp('admin');
    const res = await request(app).get('/v1/integrations/adapters/error-classification').set(TH);
    expect(res.status).toBe(200);
    expect(res.body.body.adapters).toHaveLength(8);
  });

  test('case_owner → 403', async () => {
    const app = fakeApp('case_owner');
    const res = await request(app).get('/v1/integrations/adapters/error-classification').set(TH);
    expect(res.status).toBe(403);
  });

  test('no tenant → 400', async () => {
    const app = fakeApp('admin');
    const res = await request(app).get('/v1/integrations/adapters/error-classification');
    expect(res.status).toBe(400);
  });
});
