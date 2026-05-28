import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import request from 'supertest';
import { makeApp } from '../src/server';
import { OutboxSource, StaticSource } from '../src/source';
import { makeSeedLookups } from '../src/lookups';
import { InMemoryAlertAckStore } from '../src/alert_ack';
import type { CanonicalAlert } from '../src/types';

const FIXED_NOW = new Date('2026-04-27T12:00:00.000Z');

function fixture(overrides: Partial<CanonicalAlert> = {}): CanonicalAlert {
  return {
    alert_id: 'a-1001',
    raised_at: '2026-04-27T11:30:00.000Z',
    customer_id: 'c-101',
    severity: 'CRITICAL',
    rule_id: 'r-22',
    indicators_fired: ['IND_BEH_03'],
    ...overrides,
  };
}

describe('bff HTTP', () => {
  test('GET /healthz', async () => {
    const { app } = makeApp({ source: new StaticSource([]), now: () => FIXED_NOW, getRole: () => 'admin' });
    const r = await request(app).get('/healthz');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true });
  });

  test('GET /api/alerts returns mapped list-row shape', async () => {
    const events = [
      fixture({ alert_id: 'a-1', severity: 'CRITICAL' }),
      fixture({
        alert_id: 'a-2',
        severity: 'HIGH',
        customer_id: 'c-102',
        rule_id: 'r-09',
        raised_at: '2026-04-27T10:00:00.000Z',
        indicators_fired: ['IND_FIN_02', 'IND_CRD_01'],
      }),
    ];
    const { app } = makeApp({
      source: new StaticSource(events),
      lookups: makeSeedLookups(),
      now: () => FIXED_NOW,
      getRole: () => 'admin',
    });

    const r = await request(app).get('/api/alerts');
    expect(r.status).toBe(200);
    expect(r.body.total).toBe(2);
    expect(r.body.items).toHaveLength(2);

    // Newest first.
    expect(r.body.items[0]).toMatchObject({
      id: 'a-1',
      severity: 'critical',
      customer: { id: 'c-101', name: 'Achieng Otieno' },
      rule: { id: 'r-22', name: 'Salary inflow stopped 60d' },
      indicators: ['IND_BEH_03'],
      age_min: 30,
      created_at: '2026-04-27T11:30:00.000Z',
      assignee: null,
    });
    expect(r.body.items[1]).toMatchObject({
      id: 'a-2',
      severity: 'high',
      customer: { name: 'Brian Kamau' },
      rule: { name: 'DPD ≥ 30 + utilisation > 95%' },
      age_min: 120,
    });
  });

  test('GET /api/alerts?severity=high filters correctly', async () => {
    const events = [
      fixture({ alert_id: 'a-1', severity: 'CRITICAL' }),
      fixture({ alert_id: 'a-2', severity: 'HIGH' }),
      fixture({ alert_id: 'a-3', severity: 'LOW' }),
    ];
    const { app } = makeApp({ source: new StaticSource(events), now: () => FIXED_NOW, getRole: () => 'admin' });
    const r = await request(app).get('/api/alerts?severity=high');
    expect(r.status).toBe(200);
    expect(r.body.items.map((a: { id: string }) => a.id)).toEqual(['a-2']);
  });

  test('GET /api/alerts rejects unknown severity (400)', async () => {
    const { app } = makeApp({ source: new StaticSource([]), now: () => FIXED_NOW, getRole: () => 'admin' });
    const r = await request(app).get('/api/alerts?severity=urgent');
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/severity/);
  });

  test('GET /api/alerts dedupes duplicate alert_ids (last-write-wins)', async () => {
    const events = [
      fixture({ alert_id: 'a-1', severity: 'LOW' }),
      fixture({ alert_id: 'a-1', severity: 'CRITICAL' }),
    ];
    const { app } = makeApp({ source: new StaticSource(events), now: () => FIXED_NOW, getRole: () => 'admin' });
    const r = await request(app).get('/api/alerts');
    expect(r.body.total).toBe(1);
    expect(r.body.items[0].severity).toBe('critical');
  });

  test('GET /api/alerts?assignee= filters by assignee lookup', async () => {
    const lookups = makeSeedLookups();
    lookups.assignees = { 'a-1': 'fiona.field', 'a-2': 'ravi.risk' };
    const events = [fixture({ alert_id: 'a-1' }), fixture({ alert_id: 'a-2' })];
    const { app } = makeApp({
      source: new StaticSource(events),
      lookups,
      now: () => FIXED_NOW,
      getRole: () => 'admin',
    });
    const r = await request(app).get('/api/alerts?assignee=fiona.field');
    expect(r.body.items.map((a: { id: string }) => a.id)).toEqual(['a-1']);
  });
});

// Phase 4 — backend parity: /api/alerts joins the M8.3 ack store +
// honours ?status, and POST /api/alerts/ack acknowledges (bulk).
describe('bff /api/alerts acknowledge (Phase 4 backend parity)', () => {
  const makeAlertApp = () => {
    const events = [
      fixture({ alert_id: 'a-1', customer_id: 'c-101' }),
      fixture({ alert_id: 'a-2', customer_id: 'c-102', severity: 'HIGH' }),
    ];
    return makeApp({
      source: new StaticSource(events),
      lookups: makeSeedLookups(),
      now: () => FIXED_NOW,
      getRole: () => 'admin',
      // Fresh store per app so tests don't share the module singleton.
      alertAckStore: new InMemoryAlertAckStore(),
    });
  };

  test('rows carry acknowledged=false by default', async () => {
    const { app } = makeAlertApp();
    const r = await request(app).get('/api/alerts?dedup=false');
    expect(r.status).toBe(200);
    expect(r.body.items.every((a: { acknowledged: boolean }) => a.acknowledged === false)).toBe(true);
  });

  test('POST /api/alerts/ack acknowledges + the next GET reflects it', async () => {
    const { app } = makeAlertApp();
    const ack = await request(app).post('/api/alerts/ack').send({ ids: ['a-1'] });
    expect(ack.status).toBe(200);
    expect(ack.body.acknowledged).toEqual(['a-1']);

    const r = await request(app).get('/api/alerts?dedup=false');
    const a1 = r.body.items.find((a: { id: string }) => a.id === 'a-1');
    const a2 = r.body.items.find((a: { id: string }) => a.id === 'a-2');
    expect(a1.acknowledged).toBe(true);
    expect(a2.acknowledged).toBe(false);
  });

  test('?status=acknowledged / ?status=open partition the list', async () => {
    const { app } = makeAlertApp();
    await request(app).post('/api/alerts/ack').send({ ids: ['a-1'] });

    const acked = await request(app).get('/api/alerts?dedup=false&status=acknowledged');
    expect(acked.body.items.map((a: { id: string }) => a.id)).toEqual(['a-1']);

    const open = await request(app).get('/api/alerts?dedup=false&status=open');
    expect(open.body.items.map((a: { id: string }) => a.id)).toEqual(['a-2']);
  });

  test('?status=bogus → 400', async () => {
    const { app } = makeAlertApp();
    const r = await request(app).get('/api/alerts?status=bogus');
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/status/);
  });

  test('bulk ack is idempotent (acking twice still reports acknowledged)', async () => {
    const { app } = makeAlertApp();
    await request(app).post('/api/alerts/ack').send({ ids: ['a-1', 'a-2'] });
    const again = await request(app).post('/api/alerts/ack').send({ ids: ['a-1', 'a-2'] });
    expect(again.status).toBe(200);
    expect(again.body.acknowledged.sort()).toEqual(['a-1', 'a-2']);
  });

  test('POST /api/alerts/ack is gated (unknown role → 4xx)', async () => {
    const events = [fixture({ alert_id: 'a-1' })];
    const { app } = makeApp({
      source: new StaticSource(events),
      lookups: makeSeedLookups(),
      now: () => FIXED_NOW,
      getRole: () => 'nobody',
      alertAckStore: new InMemoryAlertAckStore(),
    });
    const r = await request(app).post('/api/alerts/ack').send({ ids: ['a-1'] });
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(r.status).toBeLessThan(500);
  });
});

describe('OutboxSource — reads NDJSON from regulatory-svc/alerts outbox', () => {
  test('parses one event per line and skips corrupt lines', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-bff-outbox-'));
    const file = path.join(dir, 'apex.regulatory.events-2026-04-27.ndjson');
    const valid = JSON.stringify(fixture({ alert_id: 'a-1' }));
    fs.writeFileSync(file, valid + '\n{"not":"valid json"\n' + valid + '\n');

    const src = new OutboxSource(dir);
    const events = src.read();
    expect(events).toHaveLength(2);
    expect(events.every((e) => e.alert_id === 'a-1')).toBe(true);
  });

  test('returns [] when outbox dir does not exist', () => {
    const src = new OutboxSource(path.join(os.tmpdir(), 'apex-bff-nope-' + Date.now()));
    expect(src.read()).toEqual([]);
  });
});
