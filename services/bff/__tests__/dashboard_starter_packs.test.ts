// services/bff/__tests__/dashboard_starter_packs.test.ts
//
// T6 M11.13 — Custom dashboard starter pack suggestions.

import request from 'supertest';
import {
  listStarterPacks,
  getStarterPack,
} from '../src/dashboard_starter_packs';
import { WIDGET_CATALOG, type WidgetType } from '../src/custom_dashboards';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-14T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

// ─── listStarterPacks — pure ─────────────────────────────────────────

describe('M11.13 — catalog', () => {
  test('emits 3 starter packs', () => {
    const r = listStarterPacks();
    expect(r.total_packs).toBe(3);
    expect(r.packs).toHaveLength(3);
  });

  test('pack_ids unique', () => {
    const r = listStarterPacks();
    const ids = r.packs.map((p) => p.pack_id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('each pack has name + description + audience + widgets', () => {
    const r = listStarterPacks();
    for (const p of r.packs) {
      expect(typeof p.name).toBe('string');
      expect(p.name.length).toBeGreaterThan(0);
      expect(typeof p.description).toBe('string');
      expect(p.description.length).toBeGreaterThan(0);
      expect(['ops', 'executive', 'audit']).toContain(p.audience);
      expect(p.widgets.length).toBeGreaterThan(0);
    }
  });

  test('each widget references a real WidgetType', () => {
    const r = listStarterPacks();
    const validTypes = new Set(Object.keys(WIDGET_CATALOG) as WidgetType[]);
    for (const pack of r.packs) {
      for (const w of pack.widgets) {
        expect(validTypes.has(w.widget_type)).toBe(true);
      }
    }
  });

  test('every widget config key is within catalog config_keys', () => {
    const r = listStarterPacks();
    for (const pack of r.packs) {
      for (const w of pack.widgets) {
        const allowed = new Set(WIDGET_CATALOG[w.widget_type].config_keys);
        for (const k of Object.keys(w.config)) {
          expect(allowed.has(k)).toBe(true);
        }
      }
    }
  });

  test('every widget position + span has valid bounds', () => {
    const r = listStarterPacks();
    for (const pack of r.packs) {
      for (const w of pack.widgets) {
        expect(w.position.row).toBeGreaterThanOrEqual(0);
        expect(w.position.col).toBeGreaterThanOrEqual(0);
        expect(w.span.rows).toBeGreaterThan(0);
        expect(w.span.cols).toBeGreaterThan(0);
      }
    }
  });

  test('packs include all 3 audience buckets (ops, executive, audit)', () => {
    const r = listStarterPacks();
    const audiences = new Set(r.packs.map((p) => p.audience));
    expect(audiences.has('ops')).toBe(true);
    expect(audiences.has('executive')).toBe(true);
    expect(audiences.has('audit')).toBe(true);
  });

  test('deep-copy: mutating a returned pack does not pollute next call', () => {
    const r1 = listStarterPacks();
    r1.packs[0]!.widgets[0]!.config.injected = 'mutation';
    const r2 = listStarterPacks();
    expect(r2.packs[0]!.widgets[0]!.config.injected).toBeUndefined();
  });
});

describe('M11.13 — getStarterPack', () => {
  test('known pack_id → returns pack', () => {
    expect(getStarterPack('daily_ops')).not.toBeNull();
    expect(getStarterPack('executive_overview')).not.toBeNull();
    expect(getStarterPack('audit_compliance')).not.toBeNull();
  });

  test('unknown pack_id → null', () => {
    expect(getStarterPack('not-a-real-pack')).toBeNull();
  });
});

// ─── GET /v1/dashboards/custom/starter-packs ─────────────────────────

function makeStarterApp(role = 'admin') {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
  });
}

describe('M11.13 — GET /v1/dashboards/custom/starter-packs', () => {
  test('admin → 200 with 3 packs', async () => {
    const { app } = makeStarterApp('admin');
    const r = await request(app).get('/v1/dashboards/custom/starter-packs').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_packs).toBe(3);
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeStarterApp('case_owner');
    const r = await request(app).get('/v1/dashboards/custom/starter-packs').set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('platform-static — same across tenants', async () => {
    const { app } = makeStarterApp('admin');
    const bil = await request(app).get('/v1/dashboards/custom/starter-packs').set(TH_BIL);
    const bank = await request(app)
      .get('/v1/dashboards/custom/starter-packs')
      .set('X-Tenant-ID', 'BANK_DEMO')
      .set('X-Channel', 'API');
    expect(bil.body.body).toEqual(bank.body.body);
  });
});
