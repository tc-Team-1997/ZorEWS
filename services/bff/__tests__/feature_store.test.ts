// services/bff/__tests__/feature_store.test.ts
//
// T2.1.1 — Feature store catalog + point-in-time + history queries.

import request from 'supertest';
import {
  ALL_FEATURE_NAMES,
  DEFAULT_HISTORY_WINDOW_DAYS,
  FEATURE_CATALOG,
  FeatureStoreError,
  MAX_HISTORY_WINDOW_DAYS,
  buildFeatureCoverageStats,
  getFeatureDef,
  getFeatureHistory,
  getFeatureSnapshot,
  isFeatureName,
  parseHistoryWindow,
  parseSnapshotAt,
  synthFeatureValue,
} from '../src/feature_store';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-21T12:00:00.000Z');
const TENANT = 'BIL';
const HEADERS = { 'X-Tenant-ID': TENANT, 'X-Channel': 'API', 'X-APEX-USER': 'alice.admin' };

function makeFsApp(role: string = 'admin') {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
  });
}

// ─── Catalog ─────────────────────────────────────────────────────────

describe('catalog', () => {
  test('8 features in canonical order', () => {
    expect(ALL_FEATURE_NAMES).toEqual([
      'utilization',
      'dpd_max_90d',
      'bureau_score',
      'repayment_delay_streak',
      'txn_volume_zscore_90d',
      'tenure_months',
      'product_level',
      'income_level',
    ]);
    expect(FEATURE_CATALOG).toHaveLength(8);
  });

  test('every entry has required shape', () => {
    for (const d of FEATURE_CATALOG) {
      expect(typeof d.name).toBe('string');
      expect(typeof d.display_name).toBe('string');
      expect(typeof d.description).toBe('string');
      expect(['number', 'integer', 'enum']).toContain(d.value_type);
      expect(d.range).toHaveLength(2);
      expect(d.range[0]).toBeLessThanOrEqual(d.range[1]);
      expect(['higher_is_worse', 'lower_is_worse', 'neutral']).toContain(d.risk_polarity);
    }
  });

  test('enum features carry enum_labels matching range[1]+1', () => {
    for (const d of FEATURE_CATALOG) {
      if (d.value_type === 'enum') {
        expect(d.enum_labels.length).toBe(d.range[1] + 1);
      } else {
        expect(d.enum_labels).toHaveLength(0);
      }
    }
  });

  test('isFeatureName type guard', () => {
    expect(isFeatureName('utilization')).toBe(true);
    expect(isFeatureName('bogus')).toBe(false);
    expect(isFeatureName(42)).toBe(false);
  });

  test('getFeatureDef throws on unknown', () => {
    expect(() => getFeatureDef('bogus' as never)).toThrow(FeatureStoreError);
  });
});

// ─── Synthesis ───────────────────────────────────────────────────────

describe('synthFeatureValue', () => {
  test('deterministic per (tenant, entity, feature, day)', () => {
    const a = synthFeatureValue(TENANT, 'CUST-1', 'utilization', NOW);
    const b = synthFeatureValue(TENANT, 'CUST-1', 'utilization', NOW);
    expect(a).toBe(b);
  });

  test('different entity yields different value', () => {
    const a = synthFeatureValue(TENANT, 'CUST-1', 'utilization', NOW);
    const b = synthFeatureValue(TENANT, 'CUST-2', 'utilization', NOW);
    expect(a).not.toBe(b);
  });

  test('different tenant yields different value (cross-tenant isolation)', () => {
    const a = synthFeatureValue('BIL', 'CUST-1', 'utilization', NOW);
    const b = synthFeatureValue('BANK_DEMO', 'CUST-1', 'utilization', NOW);
    expect(a).not.toBe(b);
  });

  test('every numeric feature value lands inside its catalog range', () => {
    for (const f of ALL_FEATURE_NAMES) {
      const def = getFeatureDef(f);
      for (let i = 0; i < 50; i++) {
        const v = synthFeatureValue(TENANT, `CUST-${i}`, f, NOW);
        expect(v).toBeGreaterThanOrEqual(def.range[0]);
        expect(v).toBeLessThanOrEqual(def.range[1]);
      }
    }
  });

  test('integer features return integers', () => {
    for (const f of ALL_FEATURE_NAMES) {
      const def = getFeatureDef(f);
      if (def.value_type !== 'integer' && def.value_type !== 'enum') continue;
      for (let i = 0; i < 10; i++) {
        const v = synthFeatureValue(TENANT, `CUST-${i}`, f, NOW);
        expect(Number.isInteger(v)).toBe(true);
      }
    }
  });

  test('enum features stable across day (entity-pinned, not date-pinned)', () => {
    const yesterday = new Date(NOW.getTime() - 86_400_000);
    const tomorrow = new Date(NOW.getTime() + 86_400_000);
    for (const id of ['CUST-A', 'CUST-B', 'CUST-C']) {
      const y = synthFeatureValue(TENANT, id, 'product_level', yesterday);
      const t = synthFeatureValue(TENANT, id, 'product_level', NOW);
      const tm = synthFeatureValue(TENANT, id, 'product_level', tomorrow);
      expect(y).toBe(t);
      expect(t).toBe(tm);
    }
  });

  test('tenure_months monotonically increases with time', () => {
    const oldDate = new Date('2024-06-01T00:00:00Z');
    const newDate = new Date('2026-05-21T00:00:00Z');
    const oldT = synthFeatureValue(TENANT, 'CUST-1', 'tenure_months', oldDate);
    const newT = synthFeatureValue(TENANT, 'CUST-1', 'tenure_months', newDate);
    expect(newT).toBeGreaterThanOrEqual(oldT);
  });
});

// ─── Snapshot ────────────────────────────────────────────────────────

describe('getFeatureSnapshot', () => {
  test('every catalog feature present in returned row', () => {
    const row = getFeatureSnapshot(TENANT, 'CUST-1', NOW);
    expect(row.entity_id).toBe('CUST-1');
    expect(row.observed_at).toBe(NOW.toISOString());
    for (const f of ALL_FEATURE_NAMES) {
      expect(row.features[f]).toBeDefined();
      expect(typeof row.features[f]).toBe('number');
    }
    expect(Object.keys(row.features).length).toBe(ALL_FEATURE_NAMES.length);
  });

  test('deterministic same input → same row', () => {
    const a = getFeatureSnapshot(TENANT, 'CUST-1', NOW);
    const b = getFeatureSnapshot(TENANT, 'CUST-1', NOW);
    expect(a).toEqual(b);
  });

  test('different at yields different feature values (excl. stable enums)', () => {
    const a = getFeatureSnapshot(TENANT, 'CUST-1', NOW);
    const b = getFeatureSnapshot(TENANT, 'CUST-1', new Date(NOW.getTime() - 30 * 86_400_000));
    // utilization is daily — must differ; product_level is stable — must match.
    expect(a.features.utilization).not.toBe(b.features.utilization);
    expect(a.features.product_level).toBe(b.features.product_level);
  });

  test('empty tenant_id rejected', () => {
    expect(() => getFeatureSnapshot('', 'CUST-1', NOW)).toThrow(/tenant_id/);
  });

  test('empty entity_id rejected', () => {
    expect(() => getFeatureSnapshot(TENANT, '', NOW)).toThrow(/entity_id/);
  });
});

// ─── History ─────────────────────────────────────────────────────────

describe('getFeatureHistory', () => {
  test('daily-sampled time series with min/max/mean + first/last + trend', () => {
    const since = new Date(NOW.getTime() - 30 * 86_400_000);
    const series = getFeatureHistory(TENANT, 'CUST-1', 'utilization', since, NOW);
    expect(series.feature_name).toBe('utilization');
    expect(series.count).toBe(31); // inclusive both ends
    expect(series.points).toHaveLength(31);
    expect(series.min).not.toBeNull();
    expect(series.max).not.toBeNull();
    expect(series.mean).not.toBeNull();
    expect(series.first_value).toBe(series.points[0].value);
    expect(series.last_value).toBe(series.points[30].value);
    expect(['rising', 'falling', 'flat']).toContain(series.trend);
  });

  test('since > until → invalid_window', () => {
    try {
      getFeatureHistory(TENANT, 'CUST-1', 'utilization', NOW, new Date(NOW.getTime() - 1000));
      throw new Error('expected throw');
    } catch (err) {
      expect((err as FeatureStoreError).code).toBe('invalid_window');
    }
  });

  test('window > 24mo → window_too_long', () => {
    const since = new Date(NOW.getTime() - (MAX_HISTORY_WINDOW_DAYS + 10) * 86_400_000);
    try {
      getFeatureHistory(TENANT, 'CUST-1', 'utilization', since, NOW);
      throw new Error('expected throw');
    } catch (err) {
      expect((err as FeatureStoreError).code).toBe('window_too_long');
    }
  });

  test('unknown feature_name → unknown_feature', () => {
    const since = new Date(NOW.getTime() - 10 * 86_400_000);
    try {
      getFeatureHistory(TENANT, 'CUST-1', 'bogus' as never, since, NOW);
      throw new Error('expected throw');
    } catch (err) {
      expect((err as FeatureStoreError).code).toBe('unknown_feature');
    }
  });

  test('enum feature history is flat (entity-pinned stable value)', () => {
    const since = new Date(NOW.getTime() - 90 * 86_400_000);
    const series = getFeatureHistory(TENANT, 'CUST-1', 'product_level', since, NOW);
    expect(series.trend).toBe('flat');
    // All points should be the same value.
    const first = series.points[0].value;
    expect(series.points.every((p) => p.value === first)).toBe(true);
  });

  test('tenure_months history is monotone non-decreasing', () => {
    const since = new Date('2025-01-01T00:00:00Z');
    const until = new Date('2026-01-01T00:00:00Z');
    const series = getFeatureHistory(TENANT, 'CUST-1', 'tenure_months', since, until);
    for (let i = 1; i < series.points.length; i++) {
      expect(series.points[i].value).toBeGreaterThanOrEqual(series.points[i - 1].value);
    }
  });

  test('min ≤ mean ≤ max invariant when count > 0', () => {
    const since = new Date(NOW.getTime() - 60 * 86_400_000);
    const series = getFeatureHistory(TENANT, 'CUST-1', 'bureau_score', since, NOW);
    expect(series.min).toBeLessThanOrEqual(series.mean!);
    expect(series.mean).toBeLessThanOrEqual(series.max!);
  });

  test('cross-tenant isolation — same entity_id different value series', () => {
    const since = new Date(NOW.getTime() - 30 * 86_400_000);
    const bil = getFeatureHistory('BIL', 'CUST-1', 'utilization', since, NOW);
    const bank = getFeatureHistory('BANK_DEMO', 'CUST-1', 'utilization', since, NOW);
    // At least one daily value should differ.
    const anyDiff = bil.points.some((p, i) => p.value !== bank.points[i].value);
    expect(anyDiff).toBe(true);
  });
});

// ─── Coverage stats ──────────────────────────────────────────────────

describe('buildFeatureCoverageStats', () => {
  test('window spans 24 months', () => {
    const stats = buildFeatureCoverageStats(TENANT, NOW);
    expect(stats.window_days).toBe(MAX_HISTORY_WINDOW_DAYS);
    expect(stats.catalog_size).toBe(8);
    expect(stats.features).toEqual(FEATURE_CATALOG);
    expect(stats.total_entities_seeded).toBe('unbounded_synthetic');
    const earliestMs = Date.parse(stats.earliest_observed_at);
    const latestMs = Date.parse(stats.latest_observed_at);
    const daysSpan = Math.round((latestMs - earliestMs) / 86_400_000);
    expect(daysSpan).toBe(MAX_HISTORY_WINDOW_DAYS);
  });
});

// ─── Parsers ─────────────────────────────────────────────────────────

describe('parseHistoryWindow + parseSnapshotAt', () => {
  test('parseSnapshotAt defaults to now', () => {
    expect(parseSnapshotAt(undefined, NOW).getTime()).toBe(NOW.getTime());
  });

  test('parseSnapshotAt parses ISO', () => {
    const at = '2026-01-15T10:00:00.000Z';
    expect(parseSnapshotAt(at, NOW).toISOString()).toBe(at);
  });

  test('parseSnapshotAt rejects malformed → invalid_date', () => {
    expect(() => parseSnapshotAt('not-a-date', NOW)).toThrow(/invalid_date|ISO/);
  });

  test('parseHistoryWindow defaults: until=now, since=now - 90d', () => {
    const { since, until } = parseHistoryWindow(undefined, undefined, NOW);
    expect(until.getTime()).toBe(NOW.getTime());
    const expected = new Date(NOW.getTime() - DEFAULT_HISTORY_WINDOW_DAYS * 86_400_000);
    expect(since.getTime()).toBe(expected.getTime());
  });

  test('parseHistoryWindow with only until set defaults since=until - 90d', () => {
    const u = '2026-01-15T10:00:00.000Z';
    const { since, until } = parseHistoryWindow(undefined, u, NOW);
    expect(until.toISOString()).toBe(u);
    expect(since.getTime()).toBe(until.getTime() - DEFAULT_HISTORY_WINDOW_DAYS * 86_400_000);
  });
});

// ─── Routes ──────────────────────────────────────────────────────────

describe('Routes — /v1/feature-store/*', () => {
  test('GET /catalog returns 8 features', async () => {
    const { app } = makeFsApp('admin');
    const r = await request(app).get('/v1/feature-store/catalog').set(HEADERS);
    expect(r.status).toBe(200);
    expect(r.body.body.total_features).toBe(8);
    expect(r.body.body.features.map((f: { name: string }) => f.name)).toEqual([
      ...ALL_FEATURE_NAMES,
    ]);
  });

  test('GET /coverage returns 24-month window', async () => {
    const { app } = makeFsApp('admin');
    const r = await request(app).get('/v1/feature-store/coverage').set(HEADERS);
    expect(r.status).toBe(200);
    expect(r.body.body.window_days).toBe(MAX_HISTORY_WINDOW_DAYS);
    expect(r.body.body.catalog_size).toBe(8);
  });

  test('GET /customers/:id/snapshot — every feature in body', async () => {
    const { app } = makeFsApp('admin');
    const r = await request(app)
      .get('/v1/feature-store/customers/CUST-1/snapshot')
      .set(HEADERS);
    expect(r.status).toBe(200);
    expect(r.body.body.entity_id).toBe('CUST-1');
    for (const f of ALL_FEATURE_NAMES) {
      expect(r.body.body.features[f]).toBeDefined();
    }
  });

  test('GET /customers/:id/snapshot?at=ISO honours at param', async () => {
    const { app } = makeFsApp('admin');
    const at = '2025-01-15T10:00:00.000Z';
    const r = await request(app)
      .get(`/v1/feature-store/customers/CUST-1/snapshot?at=${at}`)
      .set(HEADERS);
    expect(r.status).toBe(200);
    expect(r.body.body.observed_at).toBe(at);
  });

  test('GET /snapshot?at=BOGUS → 400 EWS_400_invalid_date', async () => {
    const { app } = makeFsApp('admin');
    const r = await request(app)
      .get('/v1/feature-store/customers/CUST-1/snapshot?at=NOT-A-DATE')
      .set(HEADERS);
    expect(r.status).toBe(400);
    expect(r.body.error?.code).toBe('EWS_400_invalid_date');
  });

  test('GET /history?feature_name=utilization — happy path', async () => {
    const { app } = makeFsApp('admin');
    const r = await request(app)
      .get('/v1/feature-store/customers/CUST-1/history?feature_name=utilization')
      .set(HEADERS);
    expect(r.status).toBe(200);
    expect(r.body.body.feature_name).toBe('utilization');
    expect(r.body.body.count).toBeGreaterThan(0);
    expect(['rising', 'falling', 'flat']).toContain(r.body.body.trend);
  });

  test('GET /history with explicit since + until', async () => {
    const { app } = makeFsApp('admin');
    const since = '2026-01-01T00:00:00.000Z';
    const until = '2026-03-01T00:00:00.000Z';
    const r = await request(app)
      .get(
        `/v1/feature-store/customers/CUST-1/history?feature_name=utilization&since=${since}&until=${until}`,
      )
      .set(HEADERS);
    expect(r.status).toBe(200);
    expect(r.body.body.since).toBe(since);
    expect(r.body.body.until).toBe(until);
    expect(r.body.body.count).toBe(60); // 2026-01-01 → 2026-03-01 inclusive = 60 days
  });

  test('GET /history without feature_name → 400 EWS_400_unknown_feature', async () => {
    const { app } = makeFsApp('admin');
    const r = await request(app)
      .get('/v1/feature-store/customers/CUST-1/history')
      .set(HEADERS);
    expect(r.status).toBe(400);
    expect(r.body.error?.code).toBe('EWS_400_unknown_feature');
  });

  test('GET /history with bogus feature_name → 400', async () => {
    const { app } = makeFsApp('admin');
    const r = await request(app)
      .get('/v1/feature-store/customers/CUST-1/history?feature_name=bogus')
      .set(HEADERS);
    expect(r.status).toBe(400);
    expect(r.body.error?.code).toBe('EWS_400_unknown_feature');
  });

  test('GET /history window > 24mo → 400 window_too_long', async () => {
    const { app } = makeFsApp('admin');
    const since = '2023-01-01T00:00:00.000Z';
    const until = '2026-05-01T00:00:00.000Z';
    const r = await request(app)
      .get(
        `/v1/feature-store/customers/CUST-1/history?feature_name=utilization&since=${since}&until=${until}`,
      )
      .set(HEADERS);
    expect(r.status).toBe(400);
    expect(r.body.error?.code).toBe('EWS_400_window_too_long');
  });

  test('analyst+ accepted on all read routes', async () => {
    const { app } = makeFsApp('risk_analyst');
    const r = await request(app).get('/v1/feature-store/catalog').set(HEADERS);
    expect(r.status).toBe(200);
  });

  test('unknown role 403', async () => {
    const { app } = makeFsApp('viewer');
    const r = await request(app).get('/v1/feature-store/catalog').set(HEADERS);
    expect(r.status).toBe(403);
  });

  test('cross-tenant isolation — same customer_id, different snapshot per tenant', async () => {
    const { app } = makeFsApp('admin');
    const r1 = await request(app)
      .get('/v1/feature-store/customers/CUST-1/snapshot')
      .set(HEADERS);
    const r2 = await request(app)
      .get('/v1/feature-store/customers/CUST-1/snapshot')
      .set({ ...HEADERS, 'X-Tenant-ID': 'BANK_DEMO' });
    expect(r1.body.body.features.utilization).not.toBe(r2.body.body.features.utilization);
  });
});

// ─── T2.1.3 — PgFeatureStore (mocked pool) ──────────────────────────

import { PgFeatureStore, SynthFeatureStore, makeFeatureStore } from '../src/feature_store';

interface MockPgRow {
  feature_name?: string;
  value?: number;
  observed_at?: Date | string;
  distinct_entities?: number;
  earliest?: Date | null;
  latest?: Date | null;
}

class MockPool {
  constructor(private rows: MockPgRow[] = []) {}
  async query(_sql: string, _params: unknown[]) {
    return { rows: this.rows };
  }
}

describe('SynthFeatureStore (default path)', () => {
  test('getSnapshot returns the same shape as the pure function', async () => {
    const s = new SynthFeatureStore();
    const row = await s.getSnapshot(TENANT, 'CUST-1', NOW);
    expect(row.entity_id).toBe('CUST-1');
    for (const f of ALL_FEATURE_NAMES) expect(row.features[f]).toBeDefined();
  });
});

describe('PgFeatureStore (mocked pool)', () => {
  test('getSnapshot pulls each feature from latest-row pg DISTINCT ON', async () => {
    const rows: MockPgRow[] = ALL_FEATURE_NAMES.map((name, i) => ({
      feature_name: name,
      value: 0.1 * (i + 1),
    }));
    const pool = new MockPool(rows);
    const s = new PgFeatureStore(pool);
    const snap = await s.getSnapshot(TENANT, 'CUST-1', NOW);
    expect(snap.features.utilization).toBeCloseTo(0.1);
    expect(snap.features.income_level).toBeCloseTo(0.8);
  });

  test('getSnapshot falls back to synth when pg returns empty', async () => {
    const pool = new MockPool([]);
    const s = new PgFeatureStore(pool);
    const snap = await s.getSnapshot(TENANT, 'CUST-1', NOW);
    // Every catalog feature still present.
    for (const f of ALL_FEATURE_NAMES) {
      expect(snap.features[f]).toBeDefined();
    }
  });

  test('getSnapshot rejects empty tenant_id', async () => {
    const pool = new MockPool([]);
    const s = new PgFeatureStore(pool);
    await expect(s.getSnapshot('', 'CUST-1', NOW)).rejects.toThrow(/tenant_id/);
  });

  test('getHistory builds points + aggregates from pg rows', async () => {
    const since = new Date(NOW.getTime() - 10 * 86_400_000);
    const rows: MockPgRow[] = Array.from({ length: 11 }, (_, i) => ({
      observed_at: new Date(since.getTime() + i * 86_400_000),
      value: 0.1 + i * 0.05,
    }));
    const pool = new MockPool(rows);
    const s = new PgFeatureStore(pool);
    const h = await s.getHistory(TENANT, 'CUST-1', 'utilization', since, NOW);
    expect(h.count).toBe(11);
    expect(h.first_value).toBeCloseTo(0.1);
    expect(h.last_value).toBeCloseTo(0.6);
    expect(h.min).toBeCloseTo(0.1);
    expect(h.max).toBeCloseTo(0.6);
    expect(h.trend).toBe('rising'); // > 5% rel change
  });

  test('getHistory falls back to synth when pg returns empty', async () => {
    const since = new Date(NOW.getTime() - 10 * 86_400_000);
    const pool = new MockPool([]);
    const s = new PgFeatureStore(pool);
    const h = await s.getHistory(TENANT, 'CUST-1', 'utilization', since, NOW);
    expect(h.count).toBeGreaterThan(0);
    expect(h.feature_name).toBe('utilization');
  });

  test('getHistory window > 24mo rejected as window_too_long', async () => {
    const since = new Date(NOW.getTime() - (MAX_HISTORY_WINDOW_DAYS + 5) * 86_400_000);
    const pool = new MockPool([]);
    const s = new PgFeatureStore(pool);
    try {
      await s.getHistory(TENANT, 'CUST-1', 'utilization', since, NOW);
      throw new Error('expected throw');
    } catch (err) {
      expect((err as FeatureStoreError).code).toBe('window_too_long');
    }
  });

  test('coverage reflects pg distinct_entities + earliest/latest when populated', async () => {
    const earliest = new Date('2025-01-01T00:00:00Z');
    const latest = new Date('2026-05-21T00:00:00Z');
    const pool = new MockPool([{ distinct_entities: 5_000, earliest, latest }]);
    const s = new PgFeatureStore(pool);
    const cov = await s.coverage(TENANT, NOW);
    expect(cov.total_entities_seeded).toBe(5_000);
    expect(cov.earliest_observed_at).toBe(earliest.toISOString());
    expect(cov.latest_observed_at).toBe(latest.toISOString());
  });

  test('coverage falls back to synth envelope when pg is empty', async () => {
    const pool = new MockPool([{ distinct_entities: 0, earliest: null, latest: null }]);
    const s = new PgFeatureStore(pool);
    const cov = await s.coverage(TENANT, NOW);
    expect(cov.total_entities_seeded).toBe('unbounded_synthetic');
  });
});

describe('makeFeatureStore factory', () => {
  test('returns SynthFeatureStore when FEATURE_STORE_PG_URL is unset', async () => {
    const { store, pool } = await makeFeatureStore({});
    expect(store).toBeInstanceOf(SynthFeatureStore);
    expect(pool).toBeNull();
  });
});
