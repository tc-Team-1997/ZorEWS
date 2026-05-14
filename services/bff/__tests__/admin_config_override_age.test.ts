// services/bff/__tests__/admin_config_override_age.test.ts
//
// T6 M13.11 — Admin config override age tracker.

import request from 'supertest';
import {
  analyseConfigOverrideAges,
  OverrideAgeError,
} from '../src/admin_config_override_age';
import { InMemoryConfigStore } from '../src/admin_config';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-14T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

// ─── analyseConfigOverrideAges — pure ────────────────────────────────

describe('M13.11 — empty', () => {
  test('no overrides → zero envelope + null oldest/newest', () => {
    const store = new InMemoryConfigStore();
    const entries = store.list('BIL');
    const r = analyseConfigOverrideAges('BIL', entries, NOW);
    expect(r.total_overrides).toBe(0);
    expect(r.recent_count).toBe(0);
    expect(r.stable_count).toBe(0);
    expect(r.stale_count).toBe(0);
    expect(r.oldest_override).toBeNull();
    expect(r.newest_override).toBeNull();
    expect(r.overrides).toEqual([]);
  });
});

describe('M13.11 — freshness buckets', () => {
  test('recent (5d), stable (60d), stale (120d) classified correctly', () => {
    const store = new InMemoryConfigStore();
    // 5-day-old override
    store.set('BIL', 'alerts.red_sla_hours', 3, 'alice', new Date(NOW.getTime() - 5 * 86_400_000));
    // 60-day-old override
    store.set('BIL', 'alerts.orange_sla_hours', 12, 'bob', new Date(NOW.getTime() - 60 * 86_400_000));
    // 120-day-old override
    store.set('BIL', 'alerts.yellow_sla_hours', 36, 'carol', new Date(NOW.getTime() - 120 * 86_400_000));
    const entries = store.list('BIL');
    const r = analyseConfigOverrideAges('BIL', entries, NOW);
    expect(r.total_overrides).toBe(3);
    expect(r.recent_count).toBe(1);
    expect(r.stable_count).toBe(1);
    expect(r.stale_count).toBe(1);
    // oldest = stale; newest = recent
    expect(r.oldest_override!.key).toBe('alerts.yellow_sla_hours');
    expect(r.oldest_override!.age_days).toBe(120);
    expect(r.newest_override!.key).toBe('alerts.red_sla_hours');
    expect(r.newest_override!.age_days).toBe(5);
  });
});

describe('M13.11 — sort order', () => {
  test('overrides sorted by age_days desc with key asc tie-break', () => {
    const store = new InMemoryConfigStore();
    // 3 overrides at exactly 30 days old → tie-break by key
    const set_at = new Date(NOW.getTime() - 30 * 86_400_000);
    store.set('BIL', 'scoring.default_thresholds.low_max', 25, 'alice', set_at);
    store.set('BIL', 'alerts.red_sla_hours', 2, 'alice', set_at);
    store.set('BIL', 'features.scenario_simulation_enabled', false, 'alice', set_at);
    const r = analyseConfigOverrideAges('BIL', store.list('BIL'), NOW);
    expect(r.overrides[0]!.key).toBe('alerts.red_sla_hours');
    expect(r.overrides[1]!.key).toBe('features.scenario_simulation_enabled');
    expect(r.overrides[2]!.key).toBe('scoring.default_thresholds.low_max');
  });
});

describe('M13.11 — configurable thresholds', () => {
  test('fresh_days=7, stale_days=30 → 5d=recent, 20d=stable, 60d=stale', () => {
    const store = new InMemoryConfigStore();
    store.set('BIL', 'alerts.red_sla_hours', 2, 'alice', new Date(NOW.getTime() - 5 * 86_400_000));
    store.set('BIL', 'alerts.orange_sla_hours', 18, 'alice', new Date(NOW.getTime() - 20 * 86_400_000));
    store.set('BIL', 'alerts.yellow_sla_hours', 60, 'alice', new Date(NOW.getTime() - 60 * 86_400_000));
    const r = analyseConfigOverrideAges('BIL', store.list('BIL'), NOW, 7, 30);
    expect(r.recent_count).toBe(1);
    expect(r.stable_count).toBe(1);
    expect(r.stale_count).toBe(1);
  });
});

describe('M13.11 — boundary semantics', () => {
  test('age_days exactly = fresh_days is stable (not recent); exactly = stale_days is stable (not stale)', () => {
    const store = new InMemoryConfigStore();
    store.set('BIL', 'alerts.red_sla_hours', 2, 'alice', new Date(NOW.getTime() - 30 * 86_400_000));
    store.set('BIL', 'alerts.orange_sla_hours', 12, 'alice', new Date(NOW.getTime() - 90 * 86_400_000));
    const r = analyseConfigOverrideAges('BIL', store.list('BIL'), NOW, 30, 90);
    expect(r.recent_count).toBe(0);
    expect(r.stable_count).toBe(2);
    expect(r.stale_count).toBe(0);
  });
});

describe('M13.11 — defaults excluded', () => {
  test('only overrides are counted; defaults skipped', () => {
    const store = new InMemoryConfigStore();
    store.set('BIL', 'alerts.red_sla_hours', 2, 'alice', NOW);
    const r = analyseConfigOverrideAges('BIL', store.list('BIL'), NOW);
    // Only the one override; the rest of the 13 defaults are excluded.
    expect(r.total_overrides).toBe(1);
    expect(r.overrides).toHaveLength(1);
  });
});

describe('M13.11 — validation', () => {
  test('fresh_days < 0 throws', () => {
    expect(() => analyseConfigOverrideAges('BIL', [], NOW, -1, 90)).toThrow(OverrideAgeError);
  });

  test('stale_days < fresh_days throws', () => {
    expect(() => analyseConfigOverrideAges('BIL', [], NOW, 90, 30)).toThrow(/stale_days/);
  });
});

// ─── GET /v1/admin/config/override-ages ──────────────────────────────

function makeAgeApp(role = 'admin') {
  const configStore = new InMemoryConfigStore();
  const built = makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    configStore,
    now: () => NOW,
    getRole: () => role,
  });
  return { ...built, configStore };
}

describe('M13.11 — GET /v1/admin/config/override-ages', () => {
  test('empty tenant → 200 zero envelope', async () => {
    const { app } = makeAgeApp('admin');
    const r = await request(app).get('/v1/admin/config/override-ages').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_overrides).toBe(0);
  });

  test('override surfaces with age + freshness', async () => {
    const { app, configStore } = makeAgeApp('admin');
    configStore.set('BIL', 'alerts.red_sla_hours', 2, 'alice', new Date(NOW.getTime() - 100 * 86_400_000));
    const r = await request(app).get('/v1/admin/config/override-ages').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_overrides).toBe(1);
    expect(r.body.body.stale_count).toBe(1);
    expect(r.body.body.overrides[0].key).toBe('alerts.red_sla_hours');
    expect(r.body.body.overrides[0].age_days).toBe(100);
    expect(r.body.body.overrides[0].freshness).toBe('stale');
  });

  test('?fresh_days + ?stale_days honoured', async () => {
    const { app, configStore } = makeAgeApp('admin');
    configStore.set('BIL', 'alerts.red_sla_hours', 2, 'alice', new Date(NOW.getTime() - 14 * 86_400_000));
    const r = await request(app)
      .get('/v1/admin/config/override-ages?fresh_days=7&stale_days=30')
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.fresh_days).toBe(7);
    expect(r.body.body.stale_days).toBe(30);
    expect(r.body.body.stable_count).toBe(1);
  });

  test('invalid fresh_days → 400', async () => {
    const { app } = makeAgeApp('admin');
    const r = await request(app)
      .get('/v1/admin/config/override-ages?fresh_days=-5')
      .set(TH_BIL);
    expect(r.status).toBe(400);
  });

  test('stale_days < fresh_days → 400', async () => {
    const { app } = makeAgeApp('admin');
    const r = await request(app)
      .get('/v1/admin/config/override-ages?fresh_days=90&stale_days=30')
      .set(TH_BIL);
    expect(r.status).toBe(400);
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeAgeApp('readonly');
    const r = await request(app).get('/v1/admin/config/override-ages').set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('cross-tenant: BIL overrides invisible to BANK_DEMO', async () => {
    const { app, configStore } = makeAgeApp('admin');
    configStore.set('BIL', 'alerts.red_sla_hours', 2, 'alice', NOW);
    const r = await request(app)
      .get('/v1/admin/config/override-ages')
      .set('X-Tenant-ID', 'BANK_DEMO')
      .set('X-Channel', 'API');
    expect(r.status).toBe(200);
    expect(r.body.body.total_overrides).toBe(0);
  });
});
