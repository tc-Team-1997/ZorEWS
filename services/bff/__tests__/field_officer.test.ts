// services/bff/__tests__/field_officer.test.ts
//
// T6 M14.10 — Field-officer mobile.

import request from 'supertest';
import {
  FieldVisitError,
  InMemoryFieldVisitStore,
  VISIT_CAP_PER_TENANT,
  VISIT_OUTCOMES,
  aggregateByOutcome,
  isVisitOutcome,
  todayWindow,
} from '../src/field_officer';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-05T19:00:00.000Z'); // 2026-05-06 00:30 IST
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

const VALID = {
  officer_id: 'fo-101',
  customer_id: 'cust-001',
  visit_at: '2026-05-05T18:30:00.000Z',
  outcome: 'partial_payment' as const,
  note: 'Customer paid 25% of overdue. Promised remainder by 2026-05-12.',
  location: { lat: 19.076, lon: 72.8777 }, // Mumbai
};

function makeFieldApp(role = 'admin') {
  const store = new InMemoryFieldVisitStore();
  const built = makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    fieldVisitStore: store,
    now: () => NOW,
    getRole: () => role,
  });
  return { ...built, store };
}

// ─── Type guards / aggregates ─────────────────────────────────────────

describe('M14.10 — VISIT_OUTCOMES guard + aggregate', () => {
  test('isVisitOutcome accepts every enum value', () => {
    for (const o of VISIT_OUTCOMES) expect(isVisitOutcome(o)).toBe(true);
  });

  test('isVisitOutcome rejects garbage', () => {
    expect(isVisitOutcome('paid_in_full')).toBe(false);
    expect(isVisitOutcome('')).toBe(false);
    expect(isVisitOutcome(null)).toBe(false);
  });

  test('aggregateByOutcome counts every outcome bucket', () => {
    const visits = [
      { outcome: 'met_customer' },
      { outcome: 'met_customer' },
      { outcome: 'no_response' },
      { outcome: 'partial_payment' },
    ] as never;
    const a = aggregateByOutcome(visits);
    expect(a.total).toBe(4);
    expect(a.by_outcome.met_customer).toBe(2);
    expect(a.by_outcome.no_response).toBe(1);
    expect(a.by_outcome.dispute).toBe(0);
  });
});

// ─── todayWindow ──────────────────────────────────────────────────────

describe('M14.10 — todayWindow', () => {
  test('UTC: midnight-to-midnight on the request day', () => {
    const w = todayWindow(NOW, 'UTC');
    expect(w.start.toISOString()).toBe('2026-05-05T00:00:00.000Z');
    expect(w.end.toISOString()).toBe('2026-05-06T00:00:00.000Z');
  });

  test('Asia/Kolkata: window slides −05:30 from local midnight', () => {
    // 2026-05-05 19:00 UTC = 2026-05-06 00:30 IST → today is 2026-05-06 IST.
    // Local midnight 2026-05-06 00:00 IST = 2026-05-05 18:30 UTC.
    const w = todayWindow(NOW, 'Asia/Kolkata');
    expect(w.start.toISOString()).toBe('2026-05-05T18:30:00.000Z');
    expect(w.end.toISOString()).toBe('2026-05-06T18:30:00.000Z');
  });
});

// ─── Store ────────────────────────────────────────────────────────────

describe('InMemoryFieldVisitStore', () => {
  test('happy: log returns visit with metadata', () => {
    const s = new InMemoryFieldVisitStore();
    const v = s.log('BIL', VALID, 'fo-101', NOW);
    expect(v.visit_id).toMatch(/^vst-/);
    expect(v.tenant_id).toBe('BIL');
    expect(v.outcome).toBe('partial_payment');
    expect(v.location).toEqual({ lat: 19.076, lon: 72.8777 });
    expect(v.created_at).toBe(NOW.toISOString());
  });

  test('location omitted → null', () => {
    const s = new InMemoryFieldVisitStore();
    const noLoc = { ...VALID } as Record<string, unknown>;
    delete noLoc.location;
    const v = s.log('BIL', noLoc, 'fo-101', NOW);
    expect(v.location).toBeNull();
  });

  test('rejects empty officer_id', () => {
    const s = new InMemoryFieldVisitStore();
    expect(() => s.log('BIL', { ...VALID, officer_id: '' }, 'fo', NOW)).toThrow(/officer_id/);
  });

  test('rejects empty customer_id', () => {
    const s = new InMemoryFieldVisitStore();
    expect(() => s.log('BIL', { ...VALID, customer_id: '' }, 'fo', NOW)).toThrow(/customer_id/);
  });

  test('rejects bad visit_at', () => {
    const s = new InMemoryFieldVisitStore();
    expect(() => s.log('BIL', { ...VALID, visit_at: 'not-a-date' }, 'fo', NOW)).toThrow(/visit_at/);
  });

  test('rejects bogus outcome', () => {
    const s = new InMemoryFieldVisitStore();
    expect(() => s.log('BIL', { ...VALID, outcome: 'paid_in_full' as never }, 'fo', NOW)).toThrow(
      /outcome/,
    );
  });

  test('rejects empty note', () => {
    const s = new InMemoryFieldVisitStore();
    expect(() => s.log('BIL', { ...VALID, note: '' }, 'fo', NOW)).toThrow(/note/);
  });

  test('rejects note > 1000 chars', () => {
    const s = new InMemoryFieldVisitStore();
    expect(() =>
      s.log('BIL', { ...VALID, note: 'x'.repeat(1001) }, 'fo', NOW),
    ).toThrow(/note/);
  });

  test('rejects out-of-range lat', () => {
    const s = new InMemoryFieldVisitStore();
    expect(() =>
      s.log('BIL', { ...VALID, location: { lat: 91, lon: 0 } }, 'fo', NOW),
    ).toThrow(/lat/);
  });

  test('rejects out-of-range lon', () => {
    const s = new InMemoryFieldVisitStore();
    expect(() =>
      s.log('BIL', { ...VALID, location: { lat: 0, lon: 200 } }, 'fo', NOW),
    ).toThrow(/lon/);
  });

  test('FIFO retention at 200 cap', () => {
    const s = new InMemoryFieldVisitStore();
    const base = new Date('2026-05-01T00:00:00.000Z').getTime();
    for (let i = 0; i < VISIT_CAP_PER_TENANT + 5; i++) {
      // Distinct visit_at per iteration so the newest-first sort
      // is deterministic.
      s.log(
        'BIL',
        { ...VALID, note: `v-${i}`, visit_at: new Date(base + i * 60_000).toISOString() },
        'fo',
        NOW,
      );
    }
    const items = s.list('BIL', {});
    expect(items).toHaveLength(VISIT_CAP_PER_TENANT);
    // The 5 oldest (v-0..v-4) got evicted; newest first means v-204 is at index 0.
    expect(items[0]!.note).toBe('v-204');
    expect(items[items.length - 1]!.note).toBe('v-5');
  });

  test('cross-tenant isolation', () => {
    const s = new InMemoryFieldVisitStore();
    s.log('BIL', VALID, 'fo', NOW);
    expect(s.list('BIL', {})).toHaveLength(1);
    expect(s.list('BANK_DEMO', {})).toEqual([]);
  });

  test('list filters: customer_id, officer_id, outcome, since/until', () => {
    const s = new InMemoryFieldVisitStore();
    s.log(
      'BIL',
      { ...VALID, officer_id: 'fo-1', customer_id: 'A', outcome: 'met_customer' },
      'system',
      NOW,
    );
    s.log(
      'BIL',
      {
        ...VALID,
        officer_id: 'fo-2',
        customer_id: 'B',
        outcome: 'partial_payment',
        visit_at: '2026-05-04T10:00:00.000Z',
      },
      'system',
      NOW,
    );
    s.log(
      'BIL',
      {
        ...VALID,
        officer_id: 'fo-1',
        customer_id: 'A',
        outcome: 'no_response',
        visit_at: '2026-05-03T10:00:00.000Z',
      },
      'system',
      NOW,
    );
    expect(s.list('BIL', { customer_id: 'A' })).toHaveLength(2);
    expect(s.list('BIL', { officer_id: 'fo-2' })).toHaveLength(1);
    expect(s.list('BIL', { outcome: 'partial_payment' })).toHaveLength(1);
    expect(s.list('BIL', { since: '2026-05-04T00:00:00.000Z' })).toHaveLength(2);
    expect(s.list('BIL', { until: '2026-05-04T00:00:00.000Z' })).toHaveLength(1);
  });

  test('list returns newest first', () => {
    const s = new InMemoryFieldVisitStore();
    s.log('BIL', { ...VALID, visit_at: '2026-05-01T10:00:00.000Z' }, 'fo', NOW);
    s.log('BIL', { ...VALID, visit_at: '2026-05-05T10:00:00.000Z' }, 'fo', NOW);
    s.log('BIL', { ...VALID, visit_at: '2026-05-03T10:00:00.000Z' }, 'fo', NOW);
    const items = s.list('BIL', {});
    expect(items.map((v) => v.visit_at)).toEqual([
      '2026-05-05T10:00:00.000Z',
      '2026-05-03T10:00:00.000Z',
      '2026-05-01T10:00:00.000Z',
    ]);
  });

  test('todayForOfficer (UTC) returns only today\'s visits for the officer', () => {
    const s = new InMemoryFieldVisitStore();
    s.log(
      'BIL',
      { ...VALID, officer_id: 'fo-1', visit_at: '2026-05-05T08:00:00.000Z' },
      'system',
      NOW,
    ); // today UTC
    s.log(
      'BIL',
      { ...VALID, officer_id: 'fo-1', visit_at: '2026-05-04T23:59:00.000Z' },
      'system',
      NOW,
    ); // yesterday UTC
    s.log(
      'BIL',
      { ...VALID, officer_id: 'fo-2', visit_at: '2026-05-05T10:00:00.000Z' },
      'system',
      NOW,
    ); // wrong officer
    const today = s.todayForOfficer('BIL', 'fo-1', NOW, 'UTC');
    expect(today).toHaveLength(1);
    expect(today[0]!.visit_at).toBe('2026-05-05T08:00:00.000Z');
  });

  test('todayForOfficer (Asia/Kolkata) shifts the window', () => {
    const s = new InMemoryFieldVisitStore();
    // Today IST is 2026-05-06 (NOW=19:00 UTC = 00:30 IST on 6 May).
    // IST window: [2026-05-05 18:30 UTC, 2026-05-06 18:30 UTC).
    s.log(
      'BIL',
      { ...VALID, officer_id: 'fo-1', visit_at: '2026-05-05T19:00:00.000Z' },
      'system',
      NOW,
    );
    s.log(
      'BIL',
      { ...VALID, officer_id: 'fo-1', visit_at: '2026-05-05T18:00:00.000Z' },
      'system',
      NOW,
    );
    const today = s.todayForOfficer('BIL', 'fo-1', NOW, 'Asia/Kolkata');
    expect(today).toHaveLength(1);
    expect(today[0]!.visit_at).toBe('2026-05-05T19:00:00.000Z');
  });
});

// ─── Routes ───────────────────────────────────────────────────────────

describe('M14.10 — routes', () => {
  test('POST 201 + GET reflects', async () => {
    const { app } = makeFieldApp('admin');
    const c = await request(app).post('/v1/field/visits').set(TH_BIL).send(VALID);
    expect(c.status).toBe(201);
    expect(c.body.body.visit_id).toMatch(/^vst-/);
    const list = await request(app).get('/v1/field/visits').set(TH_BIL);
    expect(list.body.body.total).toBe(1);
    expect(list.body.body.items[0].outcome).toBe('partial_payment');
  });

  test('POST validation: bogus outcome → 400', async () => {
    const { app } = makeFieldApp('admin');
    const r = await request(app)
      .post('/v1/field/visits')
      .set(TH_BIL)
      .send({ ...VALID, outcome: 'paid_in_full' });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_input');
  });

  test('POST without location is accepted', async () => {
    const { app } = makeFieldApp('admin');
    const noLoc = { ...VALID } as Record<string, unknown>;
    delete noLoc.location;
    const r = await request(app).post('/v1/field/visits').set(TH_BIL).send(noLoc);
    expect(r.status).toBe(201);
    expect(r.body.body.location).toBeNull();
  });

  test('POST captures X-APEX-USER as created_by', async () => {
    const { app } = makeFieldApp('admin');
    const r = await request(app)
      .post('/v1/field/visits')
      .set(TH_BIL)
      .set('X-APEX-USER', 'fo-101')
      .send(VALID);
    expect(r.body.body.created_by).toBe('fo-101');
  });

  test('GET with customer_id filter scopes results', async () => {
    const { app } = makeFieldApp('admin');
    await request(app).post('/v1/field/visits').set(TH_BIL).send({ ...VALID, customer_id: 'A' });
    await request(app).post('/v1/field/visits').set(TH_BIL).send({ ...VALID, customer_id: 'B' });
    const r = await request(app)
      .get('/v1/field/visits?customer_id=A')
      .set(TH_BIL);
    expect(r.body.body.total).toBe(1);
    expect(r.body.body.items[0].customer_id).toBe('A');
  });

  test('GET aggregate counts by outcome', async () => {
    const { app } = makeFieldApp('admin');
    await request(app).post('/v1/field/visits').set(TH_BIL).send(VALID);
    await request(app)
      .post('/v1/field/visits')
      .set(TH_BIL)
      .send({ ...VALID, outcome: 'no_response' });
    const r = await request(app).get('/v1/field/visits').set(TH_BIL);
    expect(r.body.body.aggregate.total).toBe(2);
    expect(r.body.body.aggregate.by_outcome.partial_payment).toBe(1);
    expect(r.body.body.aggregate.by_outcome.no_response).toBe(1);
  });

  test('GET officer/today returns visits in window', async () => {
    const { app } = makeFieldApp('admin');
    await request(app)
      .post('/v1/field/visits')
      .set(TH_BIL)
      .send({ ...VALID, officer_id: 'fo-1', visit_at: '2026-05-05T08:00:00.000Z' });
    await request(app)
      .post('/v1/field/visits')
      .set(TH_BIL)
      .send({ ...VALID, officer_id: 'fo-1', visit_at: '2026-05-04T08:00:00.000Z' });
    const r = await request(app).get('/v1/field/officers/fo-1/today').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total).toBe(1);
    expect(r.body.body.tz).toBe('UTC');
    expect(r.body.body.items[0].visit_at).toBe('2026-05-05T08:00:00.000Z');
  });

  test('GET officer/today?tz=Asia/Kolkata applies zone window', async () => {
    const { app } = makeFieldApp('admin');
    // Visit at 2026-05-05 19:00 UTC = 2026-05-06 00:30 IST → "today" in IST
    await request(app)
      .post('/v1/field/visits')
      .set(TH_BIL)
      .send({ ...VALID, officer_id: 'fo-1', visit_at: '2026-05-05T19:00:00.000Z' });
    // Visit at 2026-05-05 17:00 UTC = 2026-05-05 22:30 IST → "yesterday" in IST
    await request(app)
      .post('/v1/field/visits')
      .set(TH_BIL)
      .send({ ...VALID, officer_id: 'fo-1', visit_at: '2026-05-05T17:00:00.000Z' });
    const r = await request(app)
      .get('/v1/field/officers/fo-1/today?tz=Asia/Kolkata')
      .set(TH_BIL);
    expect(r.body.body.total).toBe(1);
    expect(r.body.body.tz).toBe('Asia/Kolkata');
    expect(r.body.body.items[0].visit_at).toBe('2026-05-05T19:00:00.000Z');
  });

  test('GET officer/today?tz=Pacific/Auckland → 400 (not whitelisted)', async () => {
    const { app } = makeFieldApp('admin');
    const r = await request(app)
      .get('/v1/field/officers/fo-1/today?tz=Pacific/Auckland')
      .set(TH_BIL);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_tz');
  });

  test('cross-tenant isolation', async () => {
    const { app } = makeFieldApp('admin');
    await request(app).post('/v1/field/visits').set(TH_BIL).send(VALID);
    const otherList = await request(app)
      .get('/v1/field/visits')
      .set('X-Tenant-ID', 'BANK_DEMO')
      .set('X-Channel', 'API');
    expect(otherList.body.body.total).toBe(0);
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeFieldApp('case_owner');
    const r = await request(app).get('/v1/field/visits').set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('M4.7 watchlist no-regression: literal /field path did not shadow other routes', async () => {
    const { app } = makeFieldApp('admin');
    const r = await request(app).get('/v1/watchlist').set(TH_BIL);
    expect(r.status).toBe(200);
  });
});
