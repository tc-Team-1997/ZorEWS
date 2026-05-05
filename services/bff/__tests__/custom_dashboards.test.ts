// services/bff/__tests__/custom_dashboards.test.ts
//
// T6 M11.7 — Custom dashboard builder.

import request from 'supertest';
import {
  DASHBOARD_CAP_PER_TENANT,
  DASHBOARD_GRID_COLS,
  DASHBOARD_MAX_WIDGETS,
  DashboardError,
  InMemoryCustomDashboardStore,
  WIDGET_CATALOG,
  WIDGET_TYPES,
  detectOverlaps,
  isWidgetType,
  type DashboardWidget,
} from '../src/custom_dashboards';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-05T20:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

const W1: DashboardWidget = {
  widget_type: 'risk_score_histogram',
  position: { row: 0, col: 0 },
  span: { rows: 2, cols: 6 },
  config: { vertical: 'banking' },
};

const W2: DashboardWidget = {
  widget_type: 'alerts_by_class',
  position: { row: 0, col: 6 },
  span: { rows: 1, cols: 6 },
  config: { since_hours: 24 },
};

const VALID = {
  name: 'Operations daily',
  description: 'KPI tiles + alerts overview',
  widgets: [W1, W2],
};

function makeDashApp(role = 'admin') {
  const store = new InMemoryCustomDashboardStore();
  const built = makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    customDashboardStore: store,
    now: () => NOW,
    getRole: () => role,
  });
  return { ...built, store };
}

// ─── Catalog + guards ────────────────────────────────────────────────

describe('M11.7 — widget catalog + guards', () => {
  test('every WIDGET_TYPES entry exists in the catalog', () => {
    for (const t of WIDGET_TYPES) {
      expect(WIDGET_CATALOG[t]).toBeDefined();
      expect(WIDGET_CATALOG[t].widget_type).toBe(t);
    }
  });

  test('isWidgetType accepts each catalog entry, rejects garbage', () => {
    for (const t of WIDGET_TYPES) expect(isWidgetType(t)).toBe(true);
    expect(isWidgetType('iframe_embed')).toBe(false);
    expect(isWidgetType(null)).toBe(false);
    expect(isWidgetType('')).toBe(false);
  });

  test('every catalog entry declares a config_keys whitelist', () => {
    for (const t of WIDGET_TYPES) {
      expect(Array.isArray(WIDGET_CATALOG[t].config_keys)).toBe(true);
    }
  });
});

// ─── detectOverlaps ──────────────────────────────────────────────────

describe('M11.7 — detectOverlaps', () => {
  test('non-overlapping side-by-side → null', () => {
    expect(detectOverlaps([W1, W2])).toBeNull();
  });

  test('two widgets at same row=0,col=0 → overlap', () => {
    const w = { ...W1, position: { row: 0, col: 0 } };
    expect(detectOverlaps([W1, w])).toEqual({ a: 0, b: 1 });
  });

  test('partial overlap on rows is detected', () => {
    const a: DashboardWidget = { ...W1, position: { row: 0, col: 0 }, span: { rows: 3, cols: 6 } };
    const b: DashboardWidget = { ...W1, position: { row: 2, col: 0 }, span: { rows: 1, cols: 6 } };
    expect(detectOverlaps([a, b])).toEqual({ a: 0, b: 1 });
  });

  test('touching edges (no overlap) returns null', () => {
    const a: DashboardWidget = { ...W1, position: { row: 0, col: 0 }, span: { rows: 2, cols: 6 } };
    const b: DashboardWidget = { ...W1, position: { row: 2, col: 0 }, span: { rows: 2, cols: 6 } };
    expect(detectOverlaps([a, b])).toBeNull();
  });

  test('first overlap pair returned (i, j) with i < j', () => {
    const a = { ...W1, position: { row: 0, col: 0 } };
    const b = { ...W1, position: { row: 0, col: 6 } };
    const c = { ...W1, position: { row: 0, col: 0 } }; // overlaps with a
    const r = detectOverlaps([a, b, c]);
    expect(r?.a).toBe(0);
    expect(r?.b).toBe(2);
  });
});

// ─── Store ────────────────────────────────────────────────────────────

describe('InMemoryCustomDashboardStore', () => {
  test('create returns dashboard with id, version=1', () => {
    const s = new InMemoryCustomDashboardStore();
    const d = s.create('BIL', VALID, 'admin', NOW);
    expect(d.dashboard_id).toMatch(/^dsh-/);
    expect(d.version).toBe(1);
    expect(d.widgets).toHaveLength(2);
  });

  test('rejects empty name', () => {
    const s = new InMemoryCustomDashboardStore();
    expect(() => s.create('BIL', { ...VALID, name: '' }, 'admin', NOW)).toThrow(/name/);
  });

  test('rejects empty widgets[]', () => {
    const s = new InMemoryCustomDashboardStore();
    expect(() => s.create('BIL', { ...VALID, widgets: [] }, 'admin', NOW)).toThrow(
      /at least 1 widget/,
    );
  });

  test(`rejects > ${DASHBOARD_MAX_WIDGETS} widgets`, () => {
    const s = new InMemoryCustomDashboardStore();
    const tooMany = Array.from({ length: DASHBOARD_MAX_WIDGETS + 1 }, (_, i) => ({
      ...W2,
      position: { row: i, col: 0 },
    }));
    expect(() =>
      s.create('BIL', { ...VALID, widgets: tooMany }, 'admin', NOW),
    ).toThrow(/at most/);
  });

  test('rejects unknown widget_type', () => {
    const s = new InMemoryCustomDashboardStore();
    const bad = { ...W1, widget_type: 'iframe_embed' as never };
    expect(() => s.create('BIL', { ...VALID, widgets: [bad] }, 'admin', NOW)).toThrow(
      /widget_type/,
    );
  });

  test('rejects col + cols > 12 (grid overflow)', () => {
    const s = new InMemoryCustomDashboardStore();
    const overflow = { ...W1, position: { row: 0, col: 8 }, span: { rows: 1, cols: 6 } };
    expect(() => s.create('BIL', { ...VALID, widgets: [overflow] }, 'admin', NOW)).toThrow(
      /grid/,
    );
  });

  test('rejects overlapping widgets', () => {
    const s = new InMemoryCustomDashboardStore();
    const overlap = { ...W2, position: { row: 0, col: 0 } }; // same as W1
    expect(() =>
      s.create('BIL', { ...VALID, widgets: [W1, overlap] }, 'admin', NOW),
    ).toThrow(/overlap/);
  });

  test('rejects unknown config keys per widget_type', () => {
    const s = new InMemoryCustomDashboardStore();
    const bad = { ...W1, config: { iframe_url: 'http://evil' } };
    expect(() => s.create('BIL', { ...VALID, widgets: [bad] }, 'admin', NOW)).toThrow(
      /unknown key/,
    );
  });

  test('cap_reached after 10 dashboards', () => {
    const s = new InMemoryCustomDashboardStore();
    for (let i = 0; i < DASHBOARD_CAP_PER_TENANT; i++) {
      s.create('BIL', { ...VALID, name: `dash-${i}` }, 'admin', NOW);
    }
    try {
      s.create('BIL', { ...VALID, name: 'overflow' }, 'admin', NOW);
      fail('expected throw');
    } catch (e) {
      expect((e as DashboardError).code).toBe('cap_reached');
    }
  });

  test('cross-tenant isolation', () => {
    const s = new InMemoryCustomDashboardStore();
    const d = s.create('BIL', VALID, 'admin', NOW);
    expect(s.get('BANK_DEMO', d.dashboard_id)).toBeNull();
    expect(s.list('BANK_DEMO')).toEqual([]);
  });

  test('replace bumps version + updated_at, preserves id + created_at', () => {
    const s = new InMemoryCustomDashboardStore();
    const d = s.create('BIL', VALID, 'admin', NOW);
    const later = new Date(NOW.getTime() + 60_000);
    const d2 = s.replace('BIL', d.dashboard_id, { ...VALID, name: 'Renamed' }, 'admin', later);
    expect(d2.dashboard_id).toBe(d.dashboard_id);
    expect(d2.created_at).toBe(d.created_at);
    expect(d2.version).toBe(2);
    expect(d2.name).toBe('Renamed');
    expect(d2.updated_at).toBe(later.toISOString());
  });

  test('replace unknown_dashboard', () => {
    const s = new InMemoryCustomDashboardStore();
    expect(() => s.replace('BIL', 'dsh-nope', VALID, 'admin', NOW)).toThrow(/not found/);
  });

  test('delete returns true on hit, false on miss', () => {
    const s = new InMemoryCustomDashboardStore();
    const d = s.create('BIL', VALID, 'admin', NOW);
    expect(s.delete('BIL', d.dashboard_id)).toBe(true);
    expect(s.delete('BIL', d.dashboard_id)).toBe(false);
  });

  test('list/get return defensive copies', () => {
    const s = new InMemoryCustomDashboardStore();
    const d = s.create('BIL', VALID, 'admin', NOW);
    const fetched = s.get('BIL', d.dashboard_id)!;
    fetched.widgets[0]!.config.vertical = 'TAMPERED';
    const refetched = s.get('BIL', d.dashboard_id)!;
    expect(refetched.widgets[0]!.config.vertical).toBe('banking');
  });
});

// ─── Routes ───────────────────────────────────────────────────────────

describe('M11.7 — widget catalog route', () => {
  test('GET /widgets/catalog returns all entries', async () => {
    const { app } = makeDashApp('admin');
    const r = await request(app).get('/v1/dashboards/widgets/catalog').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total).toBe(WIDGET_TYPES.length);
    const ids = r.body.body.items.map((x: { widget_type: string }) => x.widget_type);
    expect(ids).toEqual(expect.arrayContaining([...WIDGET_TYPES]));
  });
});

describe('M11.7 — custom dashboard CRUD routes', () => {
  test('POST 201 + GET reflects', async () => {
    const { app } = makeDashApp('admin');
    const c = await request(app).post('/v1/dashboards/custom').set(TH_BIL).send(VALID);
    expect(c.status).toBe(201);
    expect(c.body.body.version).toBe(1);
    const id = c.body.body.dashboard_id;
    const list = await request(app).get('/v1/dashboards/custom').set(TH_BIL);
    expect(list.body.body.total).toBe(1);
    const single = await request(app).get(`/v1/dashboards/custom/${id}`).set(TH_BIL);
    expect(single.body.body.dashboard_id).toBe(id);
  });

  test('POST validation: empty widgets → 400', async () => {
    const { app } = makeDashApp('admin');
    const r = await request(app)
      .post('/v1/dashboards/custom')
      .set(TH_BIL)
      .send({ ...VALID, widgets: [] });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_input');
  });

  test('POST validation: overlap → 400', async () => {
    const { app } = makeDashApp('admin');
    const r = await request(app)
      .post('/v1/dashboards/custom')
      .set(TH_BIL)
      .send({ ...VALID, widgets: [W1, { ...W2, position: { row: 0, col: 0 } }] });
    expect(r.status).toBe(400);
  });

  test(`POST validation: col + cols > ${DASHBOARD_GRID_COLS} → 400`, async () => {
    const { app } = makeDashApp('admin');
    const overflow = { ...W1, position: { row: 0, col: 10 }, span: { rows: 1, cols: 4 } };
    const r = await request(app)
      .post('/v1/dashboards/custom')
      .set(TH_BIL)
      .send({ ...VALID, widgets: [overflow] });
    expect(r.status).toBe(400);
  });

  test('POST cap_reached → 409', async () => {
    const { app } = makeDashApp('admin');
    for (let i = 0; i < DASHBOARD_CAP_PER_TENANT; i++) {
      await request(app)
        .post('/v1/dashboards/custom')
        .set(TH_BIL)
        .send({ ...VALID, name: `dash-${i}` });
    }
    const r = await request(app)
      .post('/v1/dashboards/custom')
      .set(TH_BIL)
      .send({ ...VALID, name: 'overflow' });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('EWS_409_cap_reached');
  });

  test('GET unknown → 404', async () => {
    const { app } = makeDashApp('admin');
    const r = await request(app).get('/v1/dashboards/custom/dsh-nope').set(TH_BIL);
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('EWS_404_unknown_dashboard');
  });

  test('PUT replaces + bumps version', async () => {
    const { app } = makeDashApp('admin');
    const c = await request(app).post('/v1/dashboards/custom').set(TH_BIL).send(VALID);
    const id = c.body.body.dashboard_id;
    const r = await request(app)
      .put(`/v1/dashboards/custom/${id}`)
      .set(TH_BIL)
      .send({ ...VALID, name: 'Renamed' });
    expect(r.status).toBe(200);
    expect(r.body.body.name).toBe('Renamed');
    expect(r.body.body.version).toBe(2);
  });

  test('PUT unknown → 404', async () => {
    const { app } = makeDashApp('admin');
    const r = await request(app)
      .put('/v1/dashboards/custom/dsh-nope')
      .set(TH_BIL)
      .send(VALID);
    expect(r.status).toBe(404);
  });

  test('PUT bad widget → 400', async () => {
    const { app } = makeDashApp('admin');
    const c = await request(app).post('/v1/dashboards/custom').set(TH_BIL).send(VALID);
    const id = c.body.body.dashboard_id;
    const r = await request(app)
      .put(`/v1/dashboards/custom/${id}`)
      .set(TH_BIL)
      .send({ ...VALID, widgets: [{ ...W1, widget_type: 'iframe_embed' }] });
    expect(r.status).toBe(400);
  });

  test('DELETE 204 then 404', async () => {
    const { app } = makeDashApp('admin');
    const c = await request(app).post('/v1/dashboards/custom').set(TH_BIL).send(VALID);
    const id = c.body.body.dashboard_id;
    const d1 = await request(app).delete(`/v1/dashboards/custom/${id}`).set(TH_BIL);
    expect(d1.status).toBe(204);
    const d2 = await request(app).delete(`/v1/dashboards/custom/${id}`).set(TH_BIL);
    expect(d2.status).toBe(404);
  });

  test('cross-tenant isolation', async () => {
    const { app } = makeDashApp('admin');
    const c = await request(app).post('/v1/dashboards/custom').set(TH_BIL).send(VALID);
    const id = c.body.body.dashboard_id;
    const otherList = await request(app)
      .get('/v1/dashboards/custom')
      .set('X-Tenant-ID', 'BANK_DEMO')
      .set('X-Channel', 'API');
    expect(otherList.body.body.total).toBe(0);
    const otherGet = await request(app)
      .get(`/v1/dashboards/custom/${id}`)
      .set('X-Tenant-ID', 'BANK_DEMO')
      .set('X-Channel', 'API');
    expect(otherGet.status).toBe(404);
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeDashApp('case_owner');
    const r = await request(app).get('/v1/dashboards/custom').set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('captures X-APEX-USER as created_by / updated_by', async () => {
    const { app } = makeDashApp('admin');
    const c = await request(app)
      .post('/v1/dashboards/custom')
      .set(TH_BIL)
      .set('X-APEX-USER', 'compliance.lead')
      .send(VALID);
    expect(c.body.body.created_by).toBe('compliance.lead');
  });

  test('M11.1 BIL dashboards still work (literal /custom did not shadow)', async () => {
    const { app } = makeDashApp('admin');
    const r = await request(app).get('/v1/dashboards/bil/operational').set(TH_BIL);
    expect(r.status).toBe(200);
  });
});
