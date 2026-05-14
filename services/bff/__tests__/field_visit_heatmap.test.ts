// services/bff/__tests__/field_visit_heatmap.test.ts
//
// T6 M14.22 — Field-visit day-of-week × hour-of-day heatmap.

import request from 'supertest';
import { bucketVisitsByDowHour } from '../src/field_visit_heatmap';
import { InMemoryFieldVisitStore } from '../src/field_officer';
import type { FieldVisit } from '../src/field_officer';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-14T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

let visitSeq = 0;
function mkVisit(o: Partial<FieldVisit> & { visit_at: string }): FieldVisit {
  visitSeq += 1;
  return {
    visit_id: o.visit_id ?? `visit-${visitSeq}`,
    tenant_id: o.tenant_id ?? 'BIL',
    officer_id: o.officer_id ?? 'officer-1',
    customer_id: o.customer_id ?? 'C1',
    visit_at: o.visit_at,
    outcome: o.outcome ?? 'met_customer',
    note: o.note ?? 'visited',
    location: o.location ?? null,
    created_at: o.created_at ?? o.visit_at,
    created_by: o.created_by ?? 'officer-1',
  };
}

beforeEach(() => {
  visitSeq = 0;
});

// ─── bucketVisitsByDowHour — pure ────────────────────────────────────

describe('M14.22 — empty input', () => {
  test('zero visits → all-zero matrix + no peak', () => {
    const h = bucketVisitsByDowHour([], 'UTC');
    expect(h.total_visits).toBe(0);
    expect(h.tz).toBe('UTC');
    expect(h.by_dow_hour.length).toBe(7);
    expect(h.by_dow_hour[0]!.length).toBe(24);
    expect(h.by_dow.reduce((s, x) => s + x, 0)).toBe(0);
    expect(h.by_hour.reduce((s, x) => s + x, 0)).toBe(0);
    expect(h.peak_dow).toBeNull();
    expect(h.peak_hour).toBeNull();
    expect(h.peak_count).toBe(0);
  });
});

describe('M14.22 — single visit', () => {
  test('Monday 14:00 UTC → bucket [0][14]', () => {
    // 2026-05-11 is a Monday.
    const h = bucketVisitsByDowHour(
      [mkVisit({ visit_at: '2026-05-11T14:00:00.000Z' })],
      'UTC',
    );
    expect(h.total_visits).toBe(1);
    expect(h.by_dow_hour[0]![14]).toBe(1);
    expect(h.by_dow[0]).toBe(1);
    expect(h.by_hour[14]).toBe(1);
    expect(h.peak_dow).toBe(0);
    expect(h.peak_hour).toBe(14);
    expect(h.peak_count).toBe(1);
  });

  test('Sunday 09:00 UTC → bucket [6][9]', () => {
    // 2026-05-10 is a Sunday.
    const h = bucketVisitsByDowHour(
      [mkVisit({ visit_at: '2026-05-10T09:00:00.000Z' })],
      'UTC',
    );
    expect(h.by_dow_hour[6]![9]).toBe(1);
    expect(h.peak_dow).toBe(6);
    expect(h.peak_hour).toBe(9);
  });
});

describe('M14.22 — distribution', () => {
  test('marginal totals match matrix sums', () => {
    const visits = [
      mkVisit({ visit_at: '2026-05-11T09:00:00.000Z' }), // Mon 09
      mkVisit({ visit_at: '2026-05-11T15:00:00.000Z' }), // Mon 15
      mkVisit({ visit_at: '2026-05-12T09:00:00.000Z' }), // Tue 09
      mkVisit({ visit_at: '2026-05-12T09:00:00.000Z' }), // Tue 09 dup
      mkVisit({ visit_at: '2026-05-14T18:00:00.000Z' }), // Thu 18
    ];
    const h = bucketVisitsByDowHour(visits, 'UTC');
    expect(h.total_visits).toBe(5);
    expect(h.by_dow[0]).toBe(2); // Mon
    expect(h.by_dow[1]).toBe(2); // Tue
    expect(h.by_dow[3]).toBe(1); // Thu
    expect(h.by_hour[9]).toBe(3);
    expect(h.by_hour[15]).toBe(1);
    expect(h.by_hour[18]).toBe(1);
    // Peak should be Tue 09 (2 visits)
    expect(h.peak_dow).toBe(1);
    expect(h.peak_hour).toBe(9);
    expect(h.peak_count).toBe(2);
  });
});

describe('M14.22 — timezone shift', () => {
  test('UTC midnight shifts to previous day in America/Los_Angeles', () => {
    // 2026-05-11T05:00:00Z is Mon 05:00 UTC, but Sun 22:00 in LA (UTC-7 in May DST).
    const v = mkVisit({ visit_at: '2026-05-11T05:00:00.000Z' });
    const utc = bucketVisitsByDowHour([v], 'UTC');
    expect(utc.peak_dow).toBe(0); // Mon
    expect(utc.peak_hour).toBe(5);
    const la = bucketVisitsByDowHour([v], 'America/Los_Angeles');
    expect(la.peak_dow).toBe(6); // Sun
    expect(la.peak_hour).toBe(22);
  });

  test('Asia/Kolkata is UTC+5:30 — wall-clock hour shifts correctly', () => {
    // 09:00 UTC on Mon 2026-05-11 == 14:30 IST on Mon 2026-05-11.
    const h = bucketVisitsByDowHour(
      [mkVisit({ visit_at: '2026-05-11T09:00:00.000Z' })],
      'Asia/Kolkata',
    );
    expect(h.peak_dow).toBe(0); // Still Mon
    expect(h.peak_hour).toBe(14); // 14:30 IST → hour 14
  });
});

describe('M14.22 — peak tie-break', () => {
  test('first equal-count bucket in (dow asc, hour asc) wins', () => {
    const visits = [
      mkVisit({ visit_at: '2026-05-11T09:00:00.000Z' }), // Mon 09
      mkVisit({ visit_at: '2026-05-12T15:00:00.000Z' }), // Tue 15
    ];
    const h = bucketVisitsByDowHour(visits, 'UTC');
    expect(h.peak_count).toBe(1);
    // Tie on count=1; (Mon 09) precedes (Tue 15) in row-major.
    expect(h.peak_dow).toBe(0);
    expect(h.peak_hour).toBe(9);
  });
});

// ─── GET /v1/field/visits/dow-hour-heatmap ───────────────────────────

function makeHeatmapApp(role = 'admin') {
  const fieldVisitStore = new InMemoryFieldVisitStore();
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

describe('M14.22 — GET /v1/field/visits/dow-hour-heatmap', () => {
  test('empty tenant → 200 zero matrix', async () => {
    const { app } = makeHeatmapApp('admin');
    const r = await request(app).get('/v1/field/visits/dow-hour-heatmap').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_visits).toBe(0);
    expect(r.body.body.tz).toBe('UTC');
    expect(r.body.body.peak_dow).toBeNull();
  });

  test('records show up bucketed', async () => {
    const { app, fieldVisitStore } = makeHeatmapApp('admin');
    fieldVisitStore.log(
      'BIL',
      {
        officer_id: 'officer-1',
        customer_id: 'C1',
        visit_at: '2026-05-11T09:00:00.000Z',
        outcome: 'met_customer',
        note: 'visited',
      },
      'officer-1',
      NOW,
    );
    fieldVisitStore.log(
      'BIL',
      {
        officer_id: 'officer-1',
        customer_id: 'C1',
        visit_at: '2026-05-11T09:00:00.000Z',
        outcome: 'no_response',
        note: 'no answer',
      },
      'officer-1',
      NOW,
    );
    const r = await request(app).get('/v1/field/visits/dow-hour-heatmap').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_visits).toBe(2);
    expect(r.body.body.peak_count).toBe(2);
    expect(r.body.body.peak_dow).toBe(0); // Mon
    expect(r.body.body.peak_hour).toBe(9);
  });

  test('?tz=Asia/Kolkata shifts the wall-clock', async () => {
    const { app, fieldVisitStore } = makeHeatmapApp('admin');
    fieldVisitStore.log(
      'BIL',
      {
        officer_id: 'officer-1',
        customer_id: 'C1',
        visit_at: '2026-05-11T09:00:00.000Z',
        outcome: 'met_customer',
        note: 'visited',
      },
      'officer-1',
      NOW,
    );
    const r = await request(app)
      .get('/v1/field/visits/dow-hour-heatmap?tz=Asia/Kolkata')
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.tz).toBe('Asia/Kolkata');
    expect(r.body.body.peak_hour).toBe(14); // 09:00 UTC → 14:30 IST
  });

  test('invalid ?tz → 400 invalid_input', async () => {
    const { app } = makeHeatmapApp('admin');
    const r = await request(app)
      .get('/v1/field/visits/dow-hour-heatmap?tz=Mars/Olympus')
      .set(TH_BIL);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_input');
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeHeatmapApp('case_owner');
    const r = await request(app).get('/v1/field/visits/dow-hour-heatmap').set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('cross-tenant: BIL visits invisible to BANK_DEMO', async () => {
    const { app, fieldVisitStore } = makeHeatmapApp('admin');
    fieldVisitStore.log(
      'BIL',
      {
        officer_id: 'officer-1',
        customer_id: 'C1',
        visit_at: '2026-05-11T09:00:00.000Z',
        outcome: 'met_customer',
        note: 'visited',
      },
      'officer-1',
      NOW,
    );
    const r = await request(app)
      .get('/v1/field/visits/dow-hour-heatmap')
      .set('X-Tenant-ID', 'BANK_DEMO')
      .set('X-Channel', 'API');
    expect(r.status).toBe(200);
    expect(r.body.body.total_visits).toBe(0);
  });
});
