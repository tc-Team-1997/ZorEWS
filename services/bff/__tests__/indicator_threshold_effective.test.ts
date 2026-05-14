// services/bff/__tests__/indicator_threshold_effective.test.ts
//
// T6 M4.9 — Indicator threshold effective view.

import request from 'supertest';
import { resolveEffectiveThresholds } from '../src/indicator_threshold_effective';
import { InMemoryThresholdOverrideStore } from '../src/indicator_thresholds';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-14T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

// ─── resolveEffectiveThresholds — pure ───────────────────────────────

describe('M4.9 — resolveEffectiveThresholds — no overrides', () => {
  test('untouched tenant → every indicator resolves to library_default', () => {
    const store = new InMemoryThresholdOverrideStore();
    const out = resolveEffectiveThresholds(store, 'BIL');
    expect(out.tenant_id).toBe('BIL');
    expect(out.vertical).toBeNull();
    expect(out.override_count).toBe(0);
    expect(out.library_count).toBeGreaterThan(0);
    expect(out.total).toBe(out.library_count);
    for (const e of out.entries) {
      expect(e.source).toBe('library_default');
      expect(e.override).toBeNull();
      expect(e.effective).toBe(e.library_default);
    }
  });

  test('entries sorted by indicator_id asc', () => {
    const store = new InMemoryThresholdOverrideStore();
    const out = resolveEffectiveThresholds(store, 'BIL');
    const ids = out.entries.map((e) => e.indicator_id);
    const sorted = [...ids].sort();
    expect(ids).toEqual(sorted);
  });
});

describe('M4.9 — tenant override resolution', () => {
  test('setting an override flips source to tenant_override + keeps library_default visible', () => {
    const store = new InMemoryThresholdOverrideStore();
    store.setOverride('BIL', 'FIN-001', {
      yellow_at: 0.20,
      orange_at: 0.40,
      red_at: 0.60,
    });
    const out = resolveEffectiveThresholds(store, 'BIL');
    const fin001 = out.entries.find((e) => e.indicator_id === 'FIN-001')!;
    expect(fin001.source).toBe('tenant_override');
    expect(fin001.effective.yellow_at).toBe(0.20);
    // library_default still shows the original platform value.
    expect(fin001.library_default.yellow_at).toBe(0.30);
    // Other indicators stay on library_default.
    const other = out.entries.find((e) => e.indicator_id === 'FIN-002')!;
    expect(other.source).toBe('library_default');
  });

  test('override_count + library_count split correctly', () => {
    const store = new InMemoryThresholdOverrideStore();
    store.setOverride('BIL', 'FIN-001', {
      yellow_at: 0.20,
      orange_at: 0.40,
      red_at: 0.60,
    });
    store.setOverride('BIL', 'CLM-001', {
      yellow_at: 0.10,
      orange_at: 0.30,
      red_at: 0.50,
    });
    const out = resolveEffectiveThresholds(store, 'BIL');
    expect(out.override_count).toBe(2);
    expect(out.library_count).toBe(out.total - 2);
  });

  test('deleting an override flips source back to library_default', () => {
    const store = new InMemoryThresholdOverrideStore();
    store.setOverride('BIL', 'FIN-001', {
      yellow_at: 0.20,
      orange_at: 0.40,
      red_at: 0.60,
    });
    store.deleteOverride('BIL', 'FIN-001');
    const out = resolveEffectiveThresholds(store, 'BIL');
    expect(out.override_count).toBe(0);
    const fin001 = out.entries.find((e) => e.indicator_id === 'FIN-001')!;
    expect(fin001.source).toBe('library_default');
    expect(fin001.override).toBeNull();
  });
});

describe('M4.9 — vertical filter', () => {
  test('vertical=banking narrows to banking-tagged indicators only', () => {
    const store = new InMemoryThresholdOverrideStore();
    const out = resolveEffectiveThresholds(store, 'BIL', 'banking');
    expect(out.vertical).toBe('banking');
    expect(out.total).toBeGreaterThan(0);
    expect(out.entries.every((e) => e.vertical === 'banking')).toBe(true);
  });

  test('vertical=insurance narrows to insurance-tagged indicators only', () => {
    const store = new InMemoryThresholdOverrideStore();
    const out = resolveEffectiveThresholds(store, 'BIL', 'insurance');
    expect(out.entries.every((e) => e.vertical === 'insurance')).toBe(true);
  });

  test('invalid vertical throws', () => {
    const store = new InMemoryThresholdOverrideStore();
    expect(() =>
      // @ts-expect-error — testing runtime guard
      resolveEffectiveThresholds(store, 'BIL', 'fake'),
    ).toThrow(/banking|insurance/);
  });
});

describe('M4.9 — tenant isolation', () => {
  test('override on tenant A invisible to tenant B', () => {
    const store = new InMemoryThresholdOverrideStore();
    store.setOverride('BIL', 'FIN-001', {
      yellow_at: 0.20,
      orange_at: 0.40,
      red_at: 0.60,
    });
    const bil = resolveEffectiveThresholds(store, 'BIL');
    const demo = resolveEffectiveThresholds(store, 'BANK_DEMO');
    expect(bil.entries.find((e) => e.indicator_id === 'FIN-001')!.source).toBe('tenant_override');
    expect(demo.entries.find((e) => e.indicator_id === 'FIN-001')!.source).toBe('library_default');
  });
});

// ─── Route — GET /v1/indicators/thresholds/effective ─────────────────

function makeEffectiveApp(role = 'admin', store?: InMemoryThresholdOverrideStore) {
  const thresholdOverrideStore = store ?? new InMemoryThresholdOverrideStore();
  const built = makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    thresholdOverrideStore,
    now: () => NOW,
    getRole: () => role,
  });
  return { ...built, thresholdOverrideStore };
}

describe('M4.9 — GET /v1/indicators/thresholds/effective', () => {
  test('untouched tenant → 200 with all library_default entries', async () => {
    const { app } = makeEffectiveApp('admin');
    const r = await request(app).get('/v1/indicators/thresholds/effective').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.tenant_id).toBe('BIL');
    expect(r.body.body.override_count).toBe(0);
    expect(r.body.body.entries.every(
      (e: { source: string }) => e.source === 'library_default',
    )).toBe(true);
  });

  test('after setting an override, route surfaces it', async () => {
    const store = new InMemoryThresholdOverrideStore();
    store.setOverride('BIL', 'FIN-001', {
      yellow_at: 0.20,
      orange_at: 0.40,
      red_at: 0.60,
    });
    const { app } = makeEffectiveApp('admin', store);
    const r = await request(app).get('/v1/indicators/thresholds/effective').set(TH_BIL);
    expect(r.body.body.override_count).toBe(1);
    const fin001 = r.body.body.entries.find(
      (e: { indicator_id: string }) => e.indicator_id === 'FIN-001',
    );
    expect(fin001.source).toBe('tenant_override');
    expect(fin001.effective.yellow_at).toBe(0.20);
    expect(fin001.library_default.yellow_at).toBe(0.30);
  });

  test('?vertical=banking narrows the list', async () => {
    const { app } = makeEffectiveApp('admin');
    const r = await request(app)
      .get('/v1/indicators/thresholds/effective?vertical=banking')
      .set(TH_BIL);
    expect(r.body.body.vertical).toBe('banking');
    expect(r.body.body.entries.every(
      (e: { vertical: string }) => e.vertical === 'banking',
    )).toBe(true);
  });

  test('?vertical=invalid → 400', async () => {
    const { app } = makeEffectiveApp('admin');
    const r = await request(app)
      .get('/v1/indicators/thresholds/effective?vertical=banana')
      .set(TH_BIL);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_input');
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeEffectiveApp('case_owner');
    const r = await request(app).get('/v1/indicators/thresholds/effective').set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('cross-tenant: BIL override invisible to BANK_DEMO', async () => {
    const store = new InMemoryThresholdOverrideStore();
    store.setOverride('BIL', 'FIN-001', {
      yellow_at: 0.20,
      orange_at: 0.40,
      red_at: 0.60,
    });
    const { app } = makeEffectiveApp('admin', store);
    const r = await request(app)
      .get('/v1/indicators/thresholds/effective')
      .set('X-Tenant-ID', 'BANK_DEMO')
      .set('X-Channel', 'API');
    expect(r.status).toBe(200);
    const fin001 = r.body.body.entries.find(
      (e: { indicator_id: string }) => e.indicator_id === 'FIN-001',
    );
    expect(fin001.source).toBe('library_default');
  });

  test('M4.4 PUT /thresholds/:indicator_id still works (effective route is additive)', async () => {
    const { app } = makeEffectiveApp('admin');
    // The existing M4.4 PUT route should be unchanged.
    const r = await request(app)
      .put('/v1/indicators/thresholds/FIN-001')
      .set(TH_BIL)
      .send({ yellow_at: 0.15, orange_at: 0.35, red_at: 0.55 });
    expect([200, 201]).toContain(r.status);
  });
});
