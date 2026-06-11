// @ts-nocheck
// services/bff/__tests__/adapter_data_freshness.test.ts
// T6 M14.33 — Adapter data freshness comparison.

import request from 'supertest';
import { buildAdapterDataFreshness } from '../src/adapter_data_freshness';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-20T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function fakeApp(role = 'admin') {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    getRole: () => role,
    now: () => NOW,
  });
}

// ─── Pure function tests ────────────────────────────────────────────────

describe('M14.33 — buildAdapterDataFreshness — shape', () => {
  test('returns 8 adapters', () => {
    const out = buildAdapterDataFreshness('BIL', NOW);
    expect(out.adapters).toHaveLength(8);
    expect(out.tenant_id).toBe('BIL');
    expect(out.generated_at).toBeDefined();
  });

  test('all known adapter_ids present', () => {
    const out = buildAdapterDataFreshness('BIL', NOW);
    const ids = out.adapters.map(a => a.adapter_id);
    expect(ids).toContain('insurance');
    expect(ids).toContain('ifrs9');
    expect(ids).toContain('aml');
    expect(ids).toContain('dms');
    expect(ids).toContain('bureau');
    expect(ids).toContain('agent');
    expect(ids).toContain('finance');
    expect(ids).toContain('hr');
  });
});

describe('M14.33 — freshness_status values', () => {
  test('every adapter has valid freshness_status', () => {
    const out = buildAdapterDataFreshness('BIL', NOW);
    const validStatuses = new Set(['fresh', 'aging', 'stale']);
    for (const a of out.adapters) {
      expect(validStatuses.has(a.freshness_status)).toBe(true);
    }
  });

  test('age_vs_sla_pct = age_hours / expected_interval_hours', () => {
    const out = buildAdapterDataFreshness('BIL', NOW);
    for (const a of out.adapters) {
      const expected = Math.round((a.age_hours / a.expected_interval_hours) * 10000) / 10000;
      expect(a.age_vs_sla_pct).toBeCloseTo(expected, 3);
    }
  });
});

describe('M14.33 — sort order', () => {
  test('sorted age_hours desc (most stale first)', () => {
    const out = buildAdapterDataFreshness('BIL', NOW);
    for (let i = 0; i + 1 < out.adapters.length; i++) {
      expect(out.adapters[i].age_hours).toBeGreaterThanOrEqual(out.adapters[i + 1].age_hours);
    }
  });
});

describe('M14.33 — counts', () => {
  test('stale_count + aging_count + fresh_count = 8', () => {
    const out = buildAdapterDataFreshness('BIL', NOW);
    expect(out.stale_count + out.aging_count + out.fresh_count).toBe(8);
  });
});

describe('M14.33 — determinism', () => {
  test('same (tenant, day) → same output', () => {
    const out1 = buildAdapterDataFreshness('BIL', NOW);
    const out2 = buildAdapterDataFreshness('BIL', NOW);
    expect(JSON.stringify(out1.adapters)).toBe(JSON.stringify(out2.adapters));
  });

  test('different tenants → different outputs', () => {
    const bilOut = buildAdapterDataFreshness('BIL', NOW);
    const bankOut = buildAdapterDataFreshness('BANK_DEMO', NOW);
    // At least one age_hours should differ
    const bilAges = bilOut.adapters.map(a => a.age_hours);
    const bankAges = bankOut.adapters.map(a => a.age_hours);
    expect(bilAges).not.toEqual(bankAges);
  });
});

describe('M14.33 — last_refreshed_at', () => {
  test('last_refreshed_at is in the past', () => {
    const out = buildAdapterDataFreshness('BIL', NOW);
    for (const a of out.adapters) {
      const ts = Date.parse(a.last_refreshed_at);
      expect(ts).toBeLessThanOrEqual(NOW.getTime());
    }
  });
});

// ─── Route tests ────────────────────────────────────────────────────────

describe('M14.33 — route', () => {
  test('GET /v1/integrations/adapters/data-freshness → 200', async () => {
    const { app } = fakeApp();
    const res = await request(app)
      .get('/v1/integrations/adapters/data-freshness')
      .set(TH_BIL)
      .set('x-apex-role', 'admin');
    expect(res.status).toBe(200);
    expect(res.body.body.adapters).toHaveLength(8);
    expect(typeof res.body.body.stale_count).toBe('number');
  });

  test('platform-static across BIL and BANK_DEMO', async () => {
    const { app } = fakeApp();
    const bilRes = await request(app)
      .get('/v1/integrations/adapters/data-freshness')
      .set(TH_BIL)
      .set('x-apex-role', 'admin');
    const bankRes = await request(app)
      .get('/v1/integrations/adapters/data-freshness')
      .set({ 'X-Tenant-ID': 'BANK_DEMO', 'X-Channel': 'API' })
      .set('x-apex-role', 'admin');
    // Different tenants → different age hours (deterministic per tenant)
    expect(bilRes.body.body.adapters[0].adapter_id).toBe(bankRes.body.body.adapters[0].adapter_id);
  });

  test('403 for unknown role', async () => {
    const { app } = fakeApp('viewer');
    const res = await request(app)
      .get('/v1/integrations/adapters/data-freshness')
      .set(TH_BIL)
      .set('x-apex-role', 'viewer');
    expect(res.status).toBe(403);
  });

  test('400 when no tenant header', async () => {
    const { app } = fakeApp();
    const res = await request(app)
      .get('/v1/integrations/adapters/data-freshness')
      .set('x-apex-role', 'admin');
    expect(res.status).toBe(400);
  });
});
