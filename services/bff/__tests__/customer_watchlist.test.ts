// services/bff/__tests__/customer_watchlist.test.ts
//
// T6 M4.7 — Customer watchlist + scan.

import request from 'supertest';
import {
  InMemoryWatchlistStore,
  WatchlistError,
} from '../src/customer_watchlist';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-05T19:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

const VALID = {
  customer_id: 'cust-001',
  reason: 'Recent stage migration to S3',
  vertical: 'banking' as const,
};

function makeWatchlistApp(role = 'admin') {
  const store = new InMemoryWatchlistStore();
  const built = makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    watchlistStore: store,
    now: () => NOW,
    getRole: () => role,
  });
  return { ...built, store };
}

// ─── Store ────────────────────────────────────────────────────────────

describe('InMemoryWatchlistStore', () => {
  test('happy: add returns entry with metadata', () => {
    const s = new InMemoryWatchlistStore();
    const e = s.add('BIL', VALID, 'analyst.jane', NOW);
    expect(e.customer_id).toBe('cust-001');
    expect(e.tenant_id).toBe('BIL');
    expect(e.reason).toBe(VALID.reason);
    expect(e.vertical).toBe('banking');
    expect(e.added_by).toBe('analyst.jane');
    expect(e.added_at).toBe(NOW.toISOString());
  });

  test('vertical omitted → null', () => {
    const s = new InMemoryWatchlistStore();
    const noVert = { customer_id: 'c', reason: 'r' };
    const e = s.add('BIL', noVert, 'admin', NOW);
    expect(e.vertical).toBeNull();
  });

  test('rejects empty customer_id', () => {
    const s = new InMemoryWatchlistStore();
    expect(() => s.add('BIL', { ...VALID, customer_id: '' }, 'admin', NOW)).toThrow(
      /customer_id/,
    );
  });

  test('rejects empty reason', () => {
    const s = new InMemoryWatchlistStore();
    expect(() => s.add('BIL', { ...VALID, reason: '' }, 'admin', NOW)).toThrow(/reason/);
  });

  test('rejects reason > 200 chars', () => {
    const s = new InMemoryWatchlistStore();
    expect(() =>
      s.add('BIL', { ...VALID, reason: 'x'.repeat(201) }, 'admin', NOW),
    ).toThrow(/reason/);
  });

  test('rejects customer_id > 64 chars', () => {
    const s = new InMemoryWatchlistStore();
    expect(() =>
      s.add('BIL', { ...VALID, customer_id: 'x'.repeat(65) }, 'admin', NOW),
    ).toThrow(/customer_id/);
  });

  test('rejects bad vertical', () => {
    const s = new InMemoryWatchlistStore();
    expect(() =>
      s.add('BIL', { ...VALID, vertical: 'crypto' as never }, 'admin', NOW),
    ).toThrow(/vertical/);
  });

  test('duplicate add → already_watched', () => {
    const s = new InMemoryWatchlistStore();
    s.add('BIL', VALID, 'admin', NOW);
    try {
      s.add('BIL', VALID, 'admin', NOW);
      fail('expected throw');
    } catch (e) {
      expect((e as WatchlistError).code).toBe('already_watched');
    }
  });

  test('cap_reached after 50', () => {
    const s = new InMemoryWatchlistStore();
    for (let i = 0; i < 50; i++) {
      s.add('BIL', { customer_id: `c-${i}`, reason: 'r' }, 'admin', NOW);
    }
    try {
      s.add('BIL', { customer_id: 'c-51', reason: 'r' }, 'admin', NOW);
      fail('expected throw');
    } catch (e) {
      expect((e as WatchlistError).code).toBe('cap_reached');
    }
  });

  test('cross-tenant isolation', () => {
    const s = new InMemoryWatchlistStore();
    s.add('BIL', VALID, 'admin', NOW);
    expect(s.has('BIL', 'cust-001')).toBe(true);
    expect(s.has('BANK_DEMO', 'cust-001')).toBe(false);
    expect(s.list('BANK_DEMO')).toEqual([]);
  });

  test('remove returns true on hit, false on miss', () => {
    const s = new InMemoryWatchlistStore();
    s.add('BIL', VALID, 'admin', NOW);
    expect(s.remove('BIL', 'cust-001')).toBe(true);
    expect(s.remove('BIL', 'cust-001')).toBe(false);
  });

  test('list returns defensive copy', () => {
    const s = new InMemoryWatchlistStore();
    s.add('BIL', VALID, 'admin', NOW);
    const copy = s.list('BIL');
    copy.pop();
    expect(s.list('BIL')).toHaveLength(1);
  });

  test('after remove, same id can be re-added (no zombie state)', () => {
    const s = new InMemoryWatchlistStore();
    s.add('BIL', VALID, 'admin', NOW);
    s.remove('BIL', 'cust-001');
    expect(() => s.add('BIL', VALID, 'admin', NOW)).not.toThrow();
  });
});

// ─── Routes ───────────────────────────────────────────────────────────

describe('M4.7 — watchlist routes', () => {
  test('GET empty → 200 with total 0', async () => {
    const { app } = makeWatchlistApp('admin');
    const r = await request(app).get('/v1/watchlist').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total).toBe(0);
    expect(r.body.body.items).toEqual([]);
  });

  test('POST 201 + GET reflects', async () => {
    const { app } = makeWatchlistApp('admin');
    const c = await request(app).post('/v1/watchlist').set(TH_BIL).send(VALID);
    expect(c.status).toBe(201);
    expect(c.body.body.customer_id).toBe('cust-001');
    const list = await request(app).get('/v1/watchlist').set(TH_BIL);
    expect(list.body.body.total).toBe(1);
    expect(list.body.body.items[0].reason).toBe(VALID.reason);
  });

  test('POST duplicate → 409 EWS_409_already_watched', async () => {
    const { app } = makeWatchlistApp('admin');
    await request(app).post('/v1/watchlist').set(TH_BIL).send(VALID);
    const r = await request(app).post('/v1/watchlist').set(TH_BIL).send(VALID);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('EWS_409_already_watched');
  });

  test('POST cap_reached → 409 after 50', async () => {
    const { app } = makeWatchlistApp('admin');
    for (let i = 0; i < 50; i++) {
      await request(app)
        .post('/v1/watchlist')
        .set(TH_BIL)
        .send({ customer_id: `c-${i}`, reason: 'r' });
    }
    const r = await request(app)
      .post('/v1/watchlist')
      .set(TH_BIL)
      .send({ customer_id: 'c-51', reason: 'r' });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('EWS_409_cap_reached');
  });

  test('POST validation: empty reason → 400', async () => {
    const { app } = makeWatchlistApp('admin');
    const r = await request(app)
      .post('/v1/watchlist')
      .set(TH_BIL)
      .send({ customer_id: 'c-x', reason: '' });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_input');
  });

  test('DELETE 204 then 404', async () => {
    const { app } = makeWatchlistApp('admin');
    await request(app).post('/v1/watchlist').set(TH_BIL).send(VALID);
    const d1 = await request(app).delete('/v1/watchlist/cust-001').set(TH_BIL);
    expect(d1.status).toBe(204);
    const d2 = await request(app).delete('/v1/watchlist/cust-001').set(TH_BIL);
    expect(d2.status).toBe(404);
    expect(d2.body.error.code).toBe('EWS_404_unknown_customer');
  });

  test('cross-tenant isolation via routes', async () => {
    const { app } = makeWatchlistApp('admin');
    await request(app).post('/v1/watchlist').set(TH_BIL).send(VALID);
    const otherList = await request(app)
      .get('/v1/watchlist')
      .set('X-Tenant-ID', 'BANK_DEMO')
      .set('X-Channel', 'API');
    expect(otherList.body.body.total).toBe(0);
    const otherDel = await request(app)
      .delete('/v1/watchlist/cust-001')
      .set('X-Tenant-ID', 'BANK_DEMO')
      .set('X-Channel', 'API');
    expect(otherDel.status).toBe(404);
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeWatchlistApp('case_owner');
    const r = await request(app).get('/v1/watchlist').set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('X-APEX-USER header captured as added_by', async () => {
    const { app } = makeWatchlistApp('admin');
    const c = await request(app)
      .post('/v1/watchlist')
      .set(TH_BIL)
      .set('X-APEX-USER', 'compliance.lead')
      .send(VALID);
    expect(c.body.body.added_by).toBe('compliance.lead');
  });

  test('missing X-APEX-USER falls back to admin', async () => {
    const { app } = makeWatchlistApp('admin');
    const c = await request(app).post('/v1/watchlist').set(TH_BIL).send(VALID);
    expect(c.body.body.added_by).toBe('admin');
  });
});

// ─── Scan composition ─────────────────────────────────────────────────

describe('M4.7 — POST /v1/watchlist/scan', () => {
  test('empty watchlist → 200 with watchlist_size=0 + zeroed aggregate', async () => {
    const { app } = makeWatchlistApp('admin');
    const r = await request(app).post('/v1/watchlist/scan').set(TH_BIL).send({});
    expect(r.status).toBe(200);
    expect(r.body.body.watchlist_size).toBe(0);
    expect(r.body.body.results).toEqual([]);
    expect(r.body.body.aggregate.customer_count).toBe(0);
    expect(r.body.body.aggregate.red_total).toBe(0);
  });

  test('non-empty watchlist → result includes every watched customer', async () => {
    const { app } = makeWatchlistApp('admin');
    await request(app)
      .post('/v1/watchlist')
      .set(TH_BIL)
      .send({ customer_id: 'c-A', reason: 'recent default' });
    await request(app)
      .post('/v1/watchlist')
      .set(TH_BIL)
      .send({ customer_id: 'c-B', reason: 'agent escalation' });
    const r = await request(app).post('/v1/watchlist/scan').set(TH_BIL).send({});
    expect(r.status).toBe(200);
    expect(r.body.body.watchlist_size).toBe(2);
    expect(r.body.body.results).toHaveLength(2);
    const ids = r.body.body.results.map((x: { customer_id: string }) => x.customer_id);
    expect(ids).toContain('c-A');
    expect(ids).toContain('c-B');
  });

  test('scan annotates rows with watchlist reason', async () => {
    const { app } = makeWatchlistApp('admin');
    await request(app)
      .post('/v1/watchlist')
      .set(TH_BIL)
      .send({ customer_id: 'c-A', reason: 'recent default' });
    const r = await request(app).post('/v1/watchlist/scan').set(TH_BIL).send({});
    const row = r.body.body.results.find(
      (x: { customer_id: string }) => x.customer_id === 'c-A',
    );
    expect(row.reason).toBe('recent default');
  });

  test('vertical filter passed through to bulk scan', async () => {
    const { app } = makeWatchlistApp('admin');
    await request(app)
      .post('/v1/watchlist')
      .set(TH_BIL)
      .send({ customer_id: 'c-A', reason: 'r', vertical: 'banking' });
    const r = await request(app)
      .post('/v1/watchlist/scan')
      .set(TH_BIL)
      .send({ vertical: 'banking' });
    expect(r.status).toBe(200);
    expect(r.body.body.vertical).toBe('banking');
  });

  test('scan respects tenant isolation: BANK_DEMO scan does not see BIL watchlist', async () => {
    const { app } = makeWatchlistApp('admin');
    await request(app)
      .post('/v1/watchlist')
      .set(TH_BIL)
      .send({ customer_id: 'c-A', reason: 'r' });
    const r = await request(app)
      .post('/v1/watchlist/scan')
      .set('X-Tenant-ID', 'BANK_DEMO')
      .set('X-Channel', 'API')
      .send({});
    expect(r.status).toBe(200);
    expect(r.body.body.watchlist_size).toBe(0);
    expect(r.body.body.results).toEqual([]);
  });

  test('aggregate sums match per-row counts', async () => {
    const { app } = makeWatchlistApp('admin');
    for (const id of ['c-A', 'c-B', 'c-C']) {
      await request(app)
        .post('/v1/watchlist')
        .set(TH_BIL)
        .send({ customer_id: id, reason: 'r' });
    }
    const r = await request(app).post('/v1/watchlist/scan').set(TH_BIL).send({});
    const summed = r.body.body.results.reduce(
      (acc: { red: number; orange: number }, x: { summary: { red_count: number; orange_count: number } }) => ({
        red: acc.red + x.summary.red_count,
        orange: acc.orange + x.summary.orange_count,
      }),
      { red: 0, orange: 0 },
    );
    expect(r.body.body.aggregate.red_total).toBe(summed.red);
    expect(r.body.body.aggregate.orange_total).toBe(summed.orange);
  });

  test('results sorted worst-class first (matches M4.6 contract)', async () => {
    const { app } = makeWatchlistApp('admin');
    for (const id of ['c-A', 'c-B', 'c-C', 'c-D']) {
      await request(app)
        .post('/v1/watchlist')
        .set(TH_BIL)
        .send({ customer_id: id, reason: 'r' });
    }
    const r = await request(app).post('/v1/watchlist/scan').set(TH_BIL).send({});
    const order = r.body.body.results.map(
      (x: { summary: { worst_class: string } }) => x.summary.worst_class,
    );
    const rank: Record<string, number> = { red: 0, orange: 1, yellow: 2, green: 3 };
    for (let i = 1; i < order.length; i++) {
      expect(rank[order[i]] >= rank[order[i - 1]]).toBe(true);
    }
  });

  test('non-allowed role → 403 on scan', async () => {
    const { app } = makeWatchlistApp('case_owner');
    const r = await request(app).post('/v1/watchlist/scan').set(TH_BIL).send({});
    expect(r.status).toBe(403);
  });

  test('M4.6 single bulk-scan still works (literal /scan did not shadow)', async () => {
    const { app } = makeWatchlistApp('admin');
    const r = await request(app)
      .post('/v1/indicators/scan-customers')
      .set(TH_BIL)
      .send({ customer_ids: ['c-X'] });
    expect(r.status).toBe(200);
    expect(r.body.body.results).toHaveLength(1);
  });
});
