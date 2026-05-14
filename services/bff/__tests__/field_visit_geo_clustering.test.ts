// services/bff/__tests__/field_visit_geo_clustering.test.ts
//
// T6 M14.21 — Field visit geo-clustering.

import request from 'supertest';
import {
  DEFAULT_RADIUS_KM,
  MAX_RADIUS_KM,
  clusterFieldVisits,
  haversineKm,
} from '../src/field_visit_geo_clustering';
import {
  InMemoryFieldVisitStore,
  type FieldVisit,
  type VisitOutcome,
} from '../src/field_officer';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-14T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

let visitSeq = 0;
function mkVisit(o: Partial<FieldVisit> & { officer_id: string; customer_id: string; outcome: VisitOutcome }): FieldVisit {
  visitSeq += 1;
  return {
    visit_id: `vst-${visitSeq}`,
    tenant_id: o.tenant_id ?? 'BIL',
    officer_id: o.officer_id,
    customer_id: o.customer_id,
    visit_at: o.visit_at ?? NOW.toISOString(),
    outcome: o.outcome,
    note: o.note ?? 'visited',
    location: o.location ?? null,
    created_at: o.created_at ?? NOW.toISOString(),
    created_by: o.created_by ?? 'alice',
  };
}

beforeEach(() => {
  visitSeq = 0;
});

// ─── haversineKm ─────────────────────────────────────────────────────

describe('M14.21 — haversineKm', () => {
  test('same point → 0', () => {
    expect(haversineKm({ lat: 19.07, lon: 72.87 }, { lat: 19.07, lon: 72.87 })).toBe(0);
  });

  test('Mumbai → Delhi ≈ 1148 km', () => {
    // Mumbai (19.07, 72.87) → Delhi (28.61, 77.21) — actual ~1148 km
    // by Haversine with R=6371. Reference value varies ±10 km by R choice.
    const d = haversineKm({ lat: 19.07, lon: 72.87 }, { lat: 28.61, lon: 77.21 });
    expect(d).toBeGreaterThan(1140);
    expect(d).toBeLessThan(1180);
  });

  test('1° latitude at the equator ≈ 111 km', () => {
    const d = haversineKm({ lat: 0, lon: 0 }, { lat: 1, lon: 0 });
    expect(d).toBeGreaterThan(110);
    expect(d).toBeLessThan(112);
  });

  test('antipodal points ≈ half Earth circumference (≈ 20015 km)', () => {
    const d = haversineKm({ lat: 0, lon: 0 }, { lat: 0, lon: 180 });
    expect(d).toBeGreaterThan(19_900);
    expect(d).toBeLessThan(20_100);
  });
});

// ─── clusterFieldVisits — empty + no-GPS ─────────────────────────────

describe('M14.21 — clusterFieldVisits — empty + GPS-skip', () => {
  test('empty visits → zero envelope', () => {
    const out = clusterFieldVisits([]);
    expect(out.cluster_count).toBe(0);
    expect(out.total_with_gps).toBe(0);
    expect(out.total_without_gps).toBe(0);
    expect(out.clusters).toEqual([]);
    expect(out.radius_km).toBe(DEFAULT_RADIUS_KM);
  });

  test('visit without location is counted in total_without_gps and never clustered', () => {
    const visits: FieldVisit[] = [
      mkVisit({ officer_id: 'o1', customer_id: 'c1', outcome: 'met_customer' }), // no location
      mkVisit({
        officer_id: 'o2',
        customer_id: 'c2',
        outcome: 'met_customer',
        location: { lat: 19.07, lon: 72.87 },
      }),
    ];
    const out = clusterFieldVisits(visits);
    expect(out.total_with_gps).toBe(1);
    expect(out.total_without_gps).toBe(1);
    expect(out.cluster_count).toBe(1);
  });
});

// ─── clustering behaviour ────────────────────────────────────────────

describe('M14.21 — clustering rules', () => {
  test('two visits within 1 km cluster together', () => {
    const visits: FieldVisit[] = [
      mkVisit({
        officer_id: 'alice',
        customer_id: 'c1',
        outcome: 'met_customer',
        location: { lat: 19.07, lon: 72.87 }, // Mumbai
      }),
      mkVisit({
        officer_id: 'bob',
        customer_id: 'c2',
        outcome: 'partial_payment',
        location: { lat: 19.0705, lon: 72.8705 }, // ~80m away
      }),
    ];
    const out = clusterFieldVisits(visits, 1);
    expect(out.cluster_count).toBe(1);
    expect(out.clusters[0]!.visit_count).toBe(2);
    expect(out.clusters[0]!.officer_ids).toEqual(['alice', 'bob']);
    expect(out.clusters[0]!.customer_ids).toEqual(['c1', 'c2']);
    expect(out.clusters[0]!.by_outcome.met_customer).toBe(1);
    expect(out.clusters[0]!.by_outcome.partial_payment).toBe(1);
  });

  test('points outside radius produce separate clusters', () => {
    const visits: FieldVisit[] = [
      mkVisit({
        officer_id: 'a',
        customer_id: 'c1',
        outcome: 'met_customer',
        location: { lat: 19.07, lon: 72.87 }, // Mumbai
      }),
      mkVisit({
        officer_id: 'b',
        customer_id: 'c2',
        outcome: 'met_customer',
        location: { lat: 28.61, lon: 77.21 }, // Delhi, ~1163km away
      }),
    ];
    const out = clusterFieldVisits(visits, 5);
    expect(out.cluster_count).toBe(2);
  });

  test('centroid is the running mean of contributing points', () => {
    const visits: FieldVisit[] = [
      mkVisit({
        officer_id: 'a',
        customer_id: 'c1',
        outcome: 'met_customer',
        location: { lat: 0, lon: 0 },
      }),
      mkVisit({
        officer_id: 'a',
        customer_id: 'c2',
        outcome: 'met_customer',
        location: { lat: 0, lon: 0.001 }, // ~111m east
      }),
    ];
    const out = clusterFieldVisits(visits, 1);
    expect(out.clusters[0]!.centroid.lat).toBe(0);
    expect(out.clusters[0]!.centroid.lon).toBeCloseTo(0.0005, 6);
  });

  test('latest_visit_at tracks the newest contributor', () => {
    const visits: FieldVisit[] = [
      mkVisit({
        officer_id: 'a',
        customer_id: 'c1',
        outcome: 'met_customer',
        visit_at: '2026-05-14T08:00:00.000Z',
        location: { lat: 19.07, lon: 72.87 },
      }),
      mkVisit({
        officer_id: 'a',
        customer_id: 'c2',
        outcome: 'met_customer',
        visit_at: '2026-05-14T11:00:00.000Z',
        location: { lat: 19.07, lon: 72.87 },
      }),
    ];
    const out = clusterFieldVisits(visits);
    expect(out.clusters[0]!.latest_visit_at).toBe('2026-05-14T11:00:00.000Z');
  });

  test('clusters sorted by visit_count desc, ties broken by latest_visit_at desc', () => {
    // 3 clusters: A (2 visits, oldest), B (1 visit, newest), C (1 visit, older).
    const visits: FieldVisit[] = [
      mkVisit({
        officer_id: 'a',
        customer_id: 'c1',
        outcome: 'met_customer',
        visit_at: '2026-05-14T08:00:00.000Z',
        location: { lat: 0, lon: 0 },
      }),
      mkVisit({
        officer_id: 'a',
        customer_id: 'c2',
        outcome: 'met_customer',
        visit_at: '2026-05-14T08:30:00.000Z',
        location: { lat: 0, lon: 0.001 },
      }),
      mkVisit({
        officer_id: 'b',
        customer_id: 'c3',
        outcome: 'met_customer',
        visit_at: '2026-05-14T11:00:00.000Z',
        location: { lat: 10, lon: 10 }, // far from A + C
      }),
      mkVisit({
        officer_id: 'c',
        customer_id: 'c4',
        outcome: 'met_customer',
        visit_at: '2026-05-14T09:00:00.000Z',
        location: { lat: -10, lon: -10 }, // far from A + B
      }),
    ];
    const out = clusterFieldVisits(visits, 1);
    expect(out.cluster_count).toBe(3);
    // A has 2 visits → first; B newer than C → B second.
    expect(out.clusters[0]!.visit_count).toBe(2);
    expect(out.clusters[1]!.latest_visit_at).toBe('2026-05-14T11:00:00.000Z');
    expect(out.clusters[2]!.latest_visit_at).toBe('2026-05-14T09:00:00.000Z');
  });
});

describe('M14.21 — radius tuning', () => {
  test('wider radius collapses separate points into one cluster', () => {
    const visits: FieldVisit[] = [
      mkVisit({
        officer_id: 'a',
        customer_id: 'c1',
        outcome: 'met_customer',
        location: { lat: 19.07, lon: 72.87 }, // Mumbai
      }),
      mkVisit({
        officer_id: 'b',
        customer_id: 'c2',
        outcome: 'met_customer',
        location: { lat: 18.52, lon: 73.86 }, // Pune, ~120 km from Mumbai
      }),
    ];
    // radius=300 km covers Mumbai↔Pune (~120 km); within the 500 km clamp.
    const out = clusterFieldVisits(visits, 300);
    expect(out.cluster_count).toBe(1);
  });

  test('non-positive radius falls back to DEFAULT_RADIUS_KM', () => {
    const visits: FieldVisit[] = [
      mkVisit({
        officer_id: 'a',
        customer_id: 'c1',
        outcome: 'met_customer',
        location: { lat: 19.07, lon: 72.87 },
      }),
    ];
    expect(clusterFieldVisits(visits, 0).radius_km).toBe(DEFAULT_RADIUS_KM);
    expect(clusterFieldVisits(visits, -5).radius_km).toBe(DEFAULT_RADIUS_KM);
  });

  test('radius > MAX_RADIUS_KM clamps to MAX', () => {
    const visits: FieldVisit[] = [
      mkVisit({
        officer_id: 'a',
        customer_id: 'c1',
        outcome: 'met_customer',
        location: { lat: 19.07, lon: 72.87 },
      }),
    ];
    expect(clusterFieldVisits(visits, MAX_RADIUS_KM + 100).radius_km).toBe(MAX_RADIUS_KM);
  });
});

// ─── GET /v1/field/visits/geo-clusters ───────────────────────────────

function makeGeoApp(role = 'admin', store?: InMemoryFieldVisitStore) {
  const fieldVisitStore = store ?? new InMemoryFieldVisitStore();
  const built = makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    fieldVisitStore,
    now: () => NOW,
    getRole: () => role,
  });
  return { ...built, fieldVisitStore };
}

describe('M14.21 — GET /v1/field/visits/geo-clusters', () => {
  test('empty store → 200 zero envelope', async () => {
    const { app } = makeGeoApp('admin');
    const r = await request(app).get('/v1/field/visits/geo-clusters').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.clusters.cluster_count).toBe(0);
    expect(r.body.body.clusters.radius_km).toBe(DEFAULT_RADIUS_KM);
  });

  test('visits cluster correctly through the route', async () => {
    const store = new InMemoryFieldVisitStore();
    store.log(
      'BIL',
      {
        officer_id: 'alice',
        customer_id: 'c1',
        visit_at: NOW.toISOString(),
        outcome: 'met_customer',
        note: 'visited',
        location: { lat: 19.07, lon: 72.87 },
      },
      'alice',
      NOW,
    );
    store.log(
      'BIL',
      {
        officer_id: 'bob',
        customer_id: 'c2',
        visit_at: NOW.toISOString(),
        outcome: 'partial_payment',
        note: 'visited',
        location: { lat: 19.0705, lon: 72.8705 },
      },
      'bob',
      NOW,
    );
    const { app } = makeGeoApp('admin', store);
    const r = await request(app).get('/v1/field/visits/geo-clusters?radius_km=1').set(TH_BIL);
    expect(r.body.body.clusters.cluster_count).toBe(1);
    expect(r.body.body.clusters.clusters[0].visit_count).toBe(2);
  });

  test('?radius_km=invalid → 400', async () => {
    const { app } = makeGeoApp('admin');
    const r = await request(app)
      .get('/v1/field/visits/geo-clusters?radius_km=abc')
      .set(TH_BIL);
    expect(r.status).toBe(400);
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeGeoApp('case_owner');
    const r = await request(app).get('/v1/field/visits/geo-clusters').set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('cross-tenant: BANK_DEMO does not see BIL visits', async () => {
    const store = new InMemoryFieldVisitStore();
    store.log(
      'BIL',
      {
        officer_id: 'alice',
        customer_id: 'c1',
        visit_at: NOW.toISOString(),
        outcome: 'met_customer',
        note: 'v',
        location: { lat: 19, lon: 72 },
      },
      'alice',
      NOW,
    );
    const { app } = makeGeoApp('admin', store);
    const r = await request(app)
      .get('/v1/field/visits/geo-clusters')
      .set('X-Tenant-ID', 'BANK_DEMO')
      .set('X-Channel', 'API');
    expect(r.status).toBe(200);
    expect(r.body.body.clusters.cluster_count).toBe(0);
  });
});
