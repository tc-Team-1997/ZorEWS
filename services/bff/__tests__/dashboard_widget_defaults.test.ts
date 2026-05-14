// services/bff/__tests__/dashboard_widget_defaults.test.ts
//
// T6 M11.12 — Dashboard widget config defaults seed.

import request from 'supertest';
import {
  getWidgetDefaultConfig,
  listWidgetDefaults,
} from '../src/dashboard_widget_defaults';
import { WIDGET_CATALOG, WIDGET_TYPES } from '../src/custom_dashboards';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-14T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

// ─── getWidgetDefaultConfig — pure ───────────────────────────────────

describe('M11.12 — getWidgetDefaultConfig', () => {
  test('every widget type has a default config', () => {
    for (const wt of WIDGET_TYPES) {
      expect(getWidgetDefaultConfig(wt)).not.toBeNull();
    }
  });

  test('risk_score_histogram default has all 3 config keys filled', () => {
    const cfg = getWidgetDefaultConfig('risk_score_histogram')!;
    expect(cfg.vertical).toBe('banking');
    expect(cfg.bucket_count).toBe(10);
    expect(cfg.segment_filter).toBe('all');
  });

  test('alerts_by_class default has since_hours', () => {
    const cfg = getWidgetDefaultConfig('alerts_by_class')!;
    expect(cfg.since_hours).toBe(24);
  });
});

// ─── listWidgetDefaults — pure ───────────────────────────────────────

describe('M11.12 — listWidgetDefaults', () => {
  test('emits one entry per widget type', () => {
    const r = listWidgetDefaults();
    expect(r.total_widget_types).toBe(WIDGET_TYPES.length);
    expect(r.defaults).toHaveLength(WIDGET_TYPES.length);
  });

  test('every default config keys ⊆ WIDGET_CATALOG.config_keys', () => {
    const r = listWidgetDefaults();
    for (const entry of r.defaults) {
      const allowed = new Set(WIDGET_CATALOG[entry.widget_type].config_keys);
      for (const key of Object.keys(entry.default_config)) {
        expect(allowed.has(key)).toBe(true);
      }
    }
  });

  test('defaults sorted by widget_type asc', () => {
    const r = listWidgetDefaults();
    const ids = r.defaults.map((d) => d.widget_type);
    expect(ids).toEqual([...ids].sort());
  });

  test('default_config is defensively copied (mutations do not pollute source)', () => {
    const r1 = listWidgetDefaults();
    const first = r1.defaults[0]!;
    first.default_config.injected = 'mutation';
    const r2 = listWidgetDefaults();
    expect(r2.defaults[0]!.default_config.injected).toBeUndefined();
  });
});

// ─── GET /v1/dashboards/widgets/defaults ─────────────────────────────

function makeDefaultsApp(role = 'admin') {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
  });
}

describe('M11.12 — GET /v1/dashboards/widgets/defaults', () => {
  test('admin → 200 with full catalog of defaults', async () => {
    const { app } = makeDefaultsApp('admin');
    const r = await request(app).get('/v1/dashboards/widgets/defaults').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_widget_types).toBe(WIDGET_TYPES.length);
    expect(r.body.body.defaults).toHaveLength(WIDGET_TYPES.length);
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeDefaultsApp('case_owner');
    const r = await request(app).get('/v1/dashboards/widgets/defaults').set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('platform-static — same response across tenants', async () => {
    const { app } = makeDefaultsApp('admin');
    const bil = await request(app).get('/v1/dashboards/widgets/defaults').set(TH_BIL);
    const bank = await request(app)
      .get('/v1/dashboards/widgets/defaults')
      .set('X-Tenant-ID', 'BANK_DEMO')
      .set('X-Channel', 'API');
    expect(bil.body.body).toEqual(bank.body.body);
  });

  test('existing /v1/dashboards/widgets/catalog still works (route ordering)', async () => {
    const { app } = makeDefaultsApp('admin');
    const r = await request(app).get('/v1/dashboards/widgets/catalog').set(TH_BIL);
    expect(r.status).toBe(200);
  });
});
