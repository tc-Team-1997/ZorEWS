// services/bff/__tests__/case_events.test.ts
//
// T6 M9.4 — Case event journal.

import request from 'supertest';
import {
  CASE_EVENT_ACTIONS,
  CASE_EVENT_CAP_PER_TENANT,
  CASE_EVENT_MAX_LIMIT,
  CaseEventError,
  InMemoryCaseEventStore,
  isCaseEventAction,
} from '../src/case_events';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-05T20:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

const VALID = {
  case_id: 'case-001',
  action: 'opened' as const,
  actor: 'analyst.jane',
  payload: { initial_severity: 'high', source: 'cbs' },
};

function makeCaseEventApp(role = 'admin') {
  const store = new InMemoryCaseEventStore();
  const built = makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    caseEventStore: store,
    now: () => NOW,
    getRole: () => role,
  });
  return { ...built, store };
}

// ─── Type guard ───────────────────────────────────────────────────────

describe('M9.4 — isCaseEventAction', () => {
  test('every CASE_EVENT_ACTIONS value is recognised', () => {
    for (const a of CASE_EVENT_ACTIONS) expect(isCaseEventAction(a)).toBe(true);
  });

  test('unknown actions rejected', () => {
    expect(isCaseEventAction('rolled_back')).toBe(false);
    expect(isCaseEventAction('')).toBe(false);
    expect(isCaseEventAction(undefined)).toBe(false);
    expect(isCaseEventAction(42)).toBe(false);
  });
});

// ─── Store ────────────────────────────────────────────────────────────

describe('InMemoryCaseEventStore', () => {
  test('happy: record returns event with sequence_no=1', () => {
    const s = new InMemoryCaseEventStore();
    const e = s.record('BIL', VALID, NOW);
    expect(e.event_id).toMatch(/^evt-/);
    expect(e.sequence_no).toBe(1);
    expect(e.tenant_id).toBe('BIL');
    expect(e.case_id).toBe('case-001');
    expect(e.action).toBe('opened');
    expect(e.payload.source).toBe('cbs');
    expect(e.recorded_at).toBe(NOW.toISOString());
  });

  test('sequence_no monotonically increments per tenant', () => {
    const s = new InMemoryCaseEventStore();
    const e1 = s.record('BIL', VALID, NOW);
    const e2 = s.record('BIL', { ...VALID, action: 'state_change' }, NOW);
    const e3 = s.record('BIL', { ...VALID, action: 'closed' }, NOW);
    expect([e1.sequence_no, e2.sequence_no, e3.sequence_no]).toEqual([1, 2, 3]);
  });

  test('sequence_no namespace is per tenant', () => {
    const s = new InMemoryCaseEventStore();
    const a = s.record('BIL', VALID, NOW);
    const b = s.record('BANK_DEMO', VALID, NOW);
    expect(a.sequence_no).toBe(1);
    expect(b.sequence_no).toBe(1); // restarts in BANK_DEMO
  });

  test('payload omitted defaults to empty object', () => {
    const s = new InMemoryCaseEventStore();
    const noPayload = { ...VALID } as Record<string, unknown>;
    delete noPayload.payload;
    const e = s.record('BIL', noPayload, NOW);
    expect(e.payload).toEqual({});
  });

  test('rejects empty case_id', () => {
    const s = new InMemoryCaseEventStore();
    expect(() => s.record('BIL', { ...VALID, case_id: '' }, NOW)).toThrow(/case_id/);
  });

  test('rejects unknown action', () => {
    const s = new InMemoryCaseEventStore();
    expect(() =>
      s.record('BIL', { ...VALID, action: 'rolled_back' as never }, NOW),
    ).toThrow(/action/);
  });

  test('rejects empty actor', () => {
    const s = new InMemoryCaseEventStore();
    expect(() => s.record('BIL', { ...VALID, actor: '' }, NOW)).toThrow(/actor/);
  });

  test('rejects array payload', () => {
    const s = new InMemoryCaseEventStore();
    expect(() =>
      s.record('BIL', { ...VALID, payload: ['not', 'object'] as never }, NOW),
    ).toThrow(/payload/);
  });

  test('payload is deep-copied so caller mutation does not bleed in', () => {
    const s = new InMemoryCaseEventStore();
    const payload = { count: 1 } as Record<string, unknown>;
    const e = s.record('BIL', { ...VALID, payload }, NOW);
    payload.count = 99;
    expect(e.payload.count).toBe(1);
  });

  test('FIFO retention at 1000 cap with monotonic seq across eviction', () => {
    const s = new InMemoryCaseEventStore();
    for (let i = 0; i < CASE_EVENT_CAP_PER_TENANT + 5; i++) {
      s.record('BIL', { ...VALID, payload: { i } }, NOW);
    }
    const page = s.fetchSince('BIL', 0, 200);
    // 5 oldest evicted but the highest sequence_no still = total inserts.
    expect(page.high_water_mark).toBe(CASE_EVENT_CAP_PER_TENANT + 5);
    // First surviving event should be sequence_no=6 (1..5 evicted).
    expect(page.items[0]!.sequence_no).toBe(6);
  });

  test('cross-tenant isolation', () => {
    const s = new InMemoryCaseEventStore();
    s.record('BIL', VALID, NOW);
    expect(s.fetchSince('BANK_DEMO', 0, 50).items).toEqual([]);
    expect(s.forCase('BANK_DEMO', 'case-001')).toEqual([]);
  });

  test('forCase returns only events for that case', () => {
    const s = new InMemoryCaseEventStore();
    s.record('BIL', { ...VALID, case_id: 'A' }, NOW);
    s.record('BIL', { ...VALID, case_id: 'B' }, NOW);
    s.record('BIL', { ...VALID, case_id: 'A', action: 'closed' }, NOW);
    expect(s.forCase('BIL', 'A')).toHaveLength(2);
    expect(s.forCase('BIL', 'B')).toHaveLength(1);
  });

  test('get returns null on miss', () => {
    const s = new InMemoryCaseEventStore();
    expect(s.get('BIL', 'evt-nope')).toBeNull();
  });
});

// ─── fetchSince cursor semantics ──────────────────────────────────────

describe('M9.4 — fetchSince cursor', () => {
  test('since_seq=0 returns all events ascending', () => {
    const s = new InMemoryCaseEventStore();
    for (let i = 0; i < 5; i++) s.record('BIL', VALID, NOW);
    const page = s.fetchSince('BIL', 0, 50);
    expect(page.total).toBe(5);
    expect(page.items.map((e) => e.sequence_no)).toEqual([1, 2, 3, 4, 5]);
    expect(page.next_cursor).toBeNull();
    expect(page.high_water_mark).toBe(5);
  });

  test('since_seq is exclusive — events with seq > since_seq', () => {
    const s = new InMemoryCaseEventStore();
    for (let i = 0; i < 5; i++) s.record('BIL', VALID, NOW);
    const page = s.fetchSince('BIL', 2, 50);
    expect(page.items.map((e) => e.sequence_no)).toEqual([3, 4, 5]);
    expect(page.next_cursor).toBeNull();
  });

  test('limit caps page; next_cursor set when more remain', () => {
    const s = new InMemoryCaseEventStore();
    for (let i = 0; i < 7; i++) s.record('BIL', VALID, NOW);
    const page = s.fetchSince('BIL', 0, 3);
    expect(page.items.map((e) => e.sequence_no)).toEqual([1, 2, 3]);
    expect(page.next_cursor).toBe(3);
    expect(page.total).toBe(7);
  });

  test('chained fetch using next_cursor reaches end', () => {
    const s = new InMemoryCaseEventStore();
    for (let i = 0; i < 7; i++) s.record('BIL', VALID, NOW);
    let cursor = 0;
    const seen: number[] = [];
    for (let i = 0; i < 10; i++) {
      const page = s.fetchSince('BIL', cursor, 3);
      for (const e of page.items) seen.push(e.sequence_no);
      if (page.next_cursor === null) break;
      cursor = page.next_cursor;
    }
    expect(seen).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  test('high_water_mark reports tenant\'s highest seq even when page is empty', () => {
    const s = new InMemoryCaseEventStore();
    for (let i = 0; i < 3; i++) s.record('BIL', VALID, NOW);
    const page = s.fetchSince('BIL', 99, 50);
    expect(page.items).toEqual([]);
    expect(page.total).toBe(0);
    expect(page.high_water_mark).toBe(3);
  });

  test('high_water_mark is null on empty tenant', () => {
    const s = new InMemoryCaseEventStore();
    s.record('BIL', VALID, NOW);
    const page = s.fetchSince('BANK_DEMO', 0, 50);
    expect(page.high_water_mark).toBeNull();
  });

  test('rejects negative since_seq', () => {
    const s = new InMemoryCaseEventStore();
    expect(() => s.fetchSince('BIL', -1, 50)).toThrow(/since_seq/);
  });

  test('rejects non-integer limit', () => {
    const s = new InMemoryCaseEventStore();
    expect(() => s.fetchSince('BIL', 0, 0)).toThrow(/limit/);
    expect(() => s.fetchSince('BIL', 0, 1.5)).toThrow(/limit/);
  });

  test('limit > MAX_LIMIT is silently capped', () => {
    const s = new InMemoryCaseEventStore();
    for (let i = 0; i < 250; i++) s.record('BIL', VALID, NOW);
    const page = s.fetchSince('BIL', 0, CASE_EVENT_MAX_LIMIT + 100);
    expect(page.items.length).toBe(CASE_EVENT_MAX_LIMIT);
  });
});

// ─── Routes ───────────────────────────────────────────────────────────

describe('M9.4 — routes', () => {
  test('POST 201 + GET reflects', async () => {
    const { app } = makeCaseEventApp('admin');
    const c = await request(app).post('/v1/cases/events').set(TH_BIL).send(VALID);
    expect(c.status).toBe(201);
    expect(c.body.body.sequence_no).toBe(1);
    const list = await request(app).get('/v1/cases/events').set(TH_BIL);
    expect(list.body.body.total).toBe(1);
    expect(list.body.body.high_water_mark).toBe(1);
  });

  test('POST validation: bogus action → 400', async () => {
    const { app } = makeCaseEventApp('admin');
    const r = await request(app)
      .post('/v1/cases/events')
      .set(TH_BIL)
      .send({ ...VALID, action: 'rolled_back' });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_input');
  });

  test('GET ?since_seq=N skips earlier events', async () => {
    const { app } = makeCaseEventApp('admin');
    for (let i = 0; i < 5; i++) {
      await request(app).post('/v1/cases/events').set(TH_BIL).send(VALID);
    }
    const r = await request(app).get('/v1/cases/events?since_seq=3').set(TH_BIL);
    expect(r.body.body.items).toHaveLength(2);
    expect(r.body.body.items[0].sequence_no).toBe(4);
  });

  test('GET ?limit=2 paginates with next_cursor', async () => {
    const { app } = makeCaseEventApp('admin');
    for (let i = 0; i < 5; i++) {
      await request(app).post('/v1/cases/events').set(TH_BIL).send(VALID);
    }
    const r = await request(app).get('/v1/cases/events?limit=2').set(TH_BIL);
    expect(r.body.body.items).toHaveLength(2);
    expect(r.body.body.next_cursor).toBe(2);
    const r2 = await request(app)
      .get(`/v1/cases/events?since_seq=${r.body.body.next_cursor}&limit=2`)
      .set(TH_BIL);
    expect(r2.body.body.items.map((e: { sequence_no: number }) => e.sequence_no)).toEqual([3, 4]);
  });

  test('GET ?limit=0 → 400', async () => {
    const { app } = makeCaseEventApp('admin');
    const r = await request(app).get('/v1/cases/events?limit=0').set(TH_BIL);
    expect(r.status).toBe(400);
  });

  test(`GET ?limit > ${CASE_EVENT_MAX_LIMIT} → 400`, async () => {
    const { app } = makeCaseEventApp('admin');
    const r = await request(app)
      .get(`/v1/cases/events?limit=${CASE_EVENT_MAX_LIMIT + 1}`)
      .set(TH_BIL);
    expect(r.status).toBe(400);
  });

  test('GET ?since_seq=-1 → 400', async () => {
    const { app } = makeCaseEventApp('admin');
    const r = await request(app).get('/v1/cases/events?since_seq=-1').set(TH_BIL);
    expect(r.status).toBe(400);
  });

  test('GET /events/:event_id returns the single event', async () => {
    const { app } = makeCaseEventApp('admin');
    const c = await request(app).post('/v1/cases/events').set(TH_BIL).send(VALID);
    const id = c.body.body.event_id;
    const r = await request(app).get(`/v1/cases/events/${id}`).set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.event_id).toBe(id);
  });

  test('GET /events/:event_id unknown → 404', async () => {
    const { app } = makeCaseEventApp('admin');
    const r = await request(app).get('/v1/cases/events/evt-nope').set(TH_BIL);
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('EWS_404_unknown_event');
  });

  test('GET /:case_id/events returns case-specific timeline', async () => {
    const { app } = makeCaseEventApp('admin');
    await request(app).post('/v1/cases/events').set(TH_BIL).send({ ...VALID, case_id: 'A' });
    await request(app).post('/v1/cases/events').set(TH_BIL).send({ ...VALID, case_id: 'B' });
    await request(app)
      .post('/v1/cases/events')
      .set(TH_BIL)
      .send({ ...VALID, case_id: 'A', action: 'closed' });
    const r = await request(app).get('/v1/cases/A/events').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.case_id).toBe('A');
    expect(r.body.body.total).toBe(2);
  });

  test('cross-tenant isolation', async () => {
    const { app } = makeCaseEventApp('admin');
    await request(app).post('/v1/cases/events').set(TH_BIL).send(VALID);
    const otherList = await request(app)
      .get('/v1/cases/events')
      .set('X-Tenant-ID', 'BANK_DEMO')
      .set('X-Channel', 'API');
    expect(otherList.body.body.total).toBe(0);
    expect(otherList.body.body.high_water_mark).toBeNull();
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeCaseEventApp('case_owner_unknown_role');
    const r = await request(app).get('/v1/cases/events').set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('M9.x literal /sla-summary still works (not shadowed by /:case_id)', async () => {
    const { app } = makeCaseEventApp('admin');
    const r = await request(app).get('/v1/cases/sla-summary').set(TH_BIL);
    expect(r.status).toBe(200);
  });

  test('M9.3 maker-checker still works (literal /maker-checker not shadowed)', async () => {
    const { app } = makeCaseEventApp('admin');
    const r = await request(app).get('/v1/cases/maker-checker').set(TH_BIL);
    expect(r.status).toBe(200);
  });
});
