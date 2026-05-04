// services/bff/__tests__/alert_ack.test.ts
//
// T6 M8.3 — Alert acknowledgment workflow.

import request from 'supertest';
import {
  AlertAckError,
  InMemoryAlertAckStore,
  type AlertAckState,
} from '../src/alert_ack';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-05T10:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function makeAckApp(role: string = 'admin') {
  const ackStore = new InMemoryAlertAckStore();
  const built = makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    alertAckStore: ackStore,
    now: () => NOW,
    getRole: () => role,
  });
  return { ...built, ackStore };
}

// ─── Store: get ───────────────────────────────────────────────────────

describe('InMemoryAlertAckStore.get', () => {
  test('returns default open state for never-touched alert', () => {
    const s = new InMemoryAlertAckStore();
    const out = s.get('BIL', 'ALR-1');
    expect(out.alert_id).toBe('ALR-1');
    expect(out.tenant_id).toBe('BIL');
    expect(out.status).toBe('open');
    expect(out.acked_by).toBeNull();
    expect(out.acked_at).toBeNull();
    expect(out.ack_notes).toBeNull();
    expect(out.history).toEqual([]);
  });

  test('returns defensive copy — caller mutation does not bleed', () => {
    const s = new InMemoryAlertAckStore();
    s.acknowledge('BIL', 'ALR-1', 'alice', 'looks like fraud', NOW);
    const a = s.get('BIL', 'ALR-1');
    a.history.push({ ts: 'fake', action: 'acknowledged', actor_username: 'mallory', notes: null });
    a.status = 'open';
    const b = s.get('BIL', 'ALR-1');
    expect(b.status).toBe('acknowledged');
    expect(b.history.length).toBe(1);
  });

  test('rejects empty/missing alert_id', () => {
    const s = new InMemoryAlertAckStore();
    expect(() => s.get('BIL', '')).toThrow(AlertAckError);
    expect(() => s.get('BIL', '   ')).toThrow(AlertAckError);
  });

  test('rejects > 64 char alert_id', () => {
    const s = new InMemoryAlertAckStore();
    expect(() => s.get('BIL', 'A'.repeat(65))).toThrow(/≤ 64/);
  });
});

// ─── Store: acknowledge ───────────────────────────────────────────────

describe('InMemoryAlertAckStore.acknowledge', () => {
  test('happy: open → acknowledged with notes', () => {
    const s = new InMemoryAlertAckStore();
    const out = s.acknowledge('BIL', 'ALR-1', 'alice', 'investigating', NOW);
    expect(out.status).toBe('acknowledged');
    expect(out.acked_by).toBe('alice');
    expect(out.acked_at).toBe(NOW.toISOString());
    expect(out.ack_notes).toBe('investigating');
    expect(out.history).toHaveLength(1);
    expect(out.history[0]!.action).toBe('acknowledged');
    expect(out.history[0]!.actor_username).toBe('alice');
    expect(out.history[0]!.notes).toBe('investigating');
  });

  test('notes are optional (null)', () => {
    const s = new InMemoryAlertAckStore();
    const out = s.acknowledge('BIL', 'ALR-1', 'alice', null, NOW);
    expect(out.status).toBe('acknowledged');
    expect(out.ack_notes).toBeNull();
    expect(out.history[0]!.notes).toBeNull();
  });

  test('notes are optional (undefined)', () => {
    const s = new InMemoryAlertAckStore();
    const out = s.acknowledge('BIL', 'ALR-1', 'alice', undefined, NOW);
    expect(out.ack_notes).toBeNull();
  });

  test('whitespace-only notes treated as null', () => {
    const s = new InMemoryAlertAckStore();
    const out = s.acknowledge('BIL', 'ALR-1', 'alice', '   ', NOW);
    expect(out.ack_notes).toBeNull();
  });

  test('notes trimmed', () => {
    const s = new InMemoryAlertAckStore();
    const out = s.acknowledge('BIL', 'ALR-1', 'alice', '  reviewed  ', NOW);
    expect(out.ack_notes).toBe('reviewed');
  });

  test('notes > 2000 chars rejected', () => {
    const s = new InMemoryAlertAckStore();
    expect(() =>
      s.acknowledge('BIL', 'ALR-1', 'alice', 'x'.repeat(2001), NOW),
    ).toThrow(/≤ 2000/);
  });

  test('non-string notes rejected', () => {
    const s = new InMemoryAlertAckStore();
    expect(() =>
      s.acknowledge('BIL', 'ALR-1', 'alice', 42 as unknown as string, NOW),
    ).toThrow(/notes must be a string/);
  });

  test('missing actor_username rejected', () => {
    const s = new InMemoryAlertAckStore();
    expect(() => s.acknowledge('BIL', 'ALR-1', '', null, NOW)).toThrow(/actor_username/);
  });

  test('already_acknowledged rejected on 2nd ack', () => {
    const s = new InMemoryAlertAckStore();
    s.acknowledge('BIL', 'ALR-1', 'alice', null, NOW);
    try {
      s.acknowledge('BIL', 'ALR-1', 'bob', null, NOW);
      fail('expected throw');
    } catch (e) {
      expect((e as AlertAckError).code).toBe('already_acknowledged');
    }
  });

  test('cross-tenant: same alert_id ack-able under different tenants', () => {
    const s = new InMemoryAlertAckStore();
    s.acknowledge('BIL', 'ALR-1', 'alice', null, NOW);
    s.acknowledge('BANK_DEMO', 'ALR-1', 'bob', null, NOW);
    expect(s.get('BIL', 'ALR-1').acked_by).toBe('alice');
    expect(s.get('BANK_DEMO', 'ALR-1').acked_by).toBe('bob');
  });
});

// ─── Store: unacknowledge ─────────────────────────────────────────────

describe('InMemoryAlertAckStore.unacknowledge', () => {
  test('happy: acknowledged → open with reason in history', () => {
    const s = new InMemoryAlertAckStore();
    s.acknowledge('BIL', 'ALR-1', 'alice', 'investigating', NOW);
    const out = s.unacknowledge('BIL', 'ALR-1', 'bob', 'reassign to senior', NOW);
    expect(out.status).toBe('open');
    expect(out.acked_by).toBeNull();
    expect(out.acked_at).toBeNull();
    expect(out.ack_notes).toBeNull();
    expect(out.history).toHaveLength(2);
    expect(out.history[1]!.action).toBe('unacknowledged');
    expect(out.history[1]!.actor_username).toBe('bob');
    expect(out.history[1]!.notes).toBe('reassign to senior');
  });

  test('reason is required (empty rejected)', () => {
    const s = new InMemoryAlertAckStore();
    s.acknowledge('BIL', 'ALR-1', 'alice', null, NOW);
    expect(() => s.unacknowledge('BIL', 'ALR-1', 'bob', '', NOW)).toThrow(/reason is required/);
  });

  test('reason whitespace-only rejected', () => {
    const s = new InMemoryAlertAckStore();
    s.acknowledge('BIL', 'ALR-1', 'alice', null, NOW);
    expect(() => s.unacknowledge('BIL', 'ALR-1', 'bob', '   ', NOW)).toThrow(/reason is required/);
  });

  test('reason > 2000 chars rejected', () => {
    const s = new InMemoryAlertAckStore();
    s.acknowledge('BIL', 'ALR-1', 'alice', null, NOW);
    expect(() =>
      s.unacknowledge('BIL', 'ALR-1', 'bob', 'x'.repeat(2001), NOW),
    ).toThrow(/≤ 2000/);
  });

  test('not_acknowledged rejected when alert is already open', () => {
    const s = new InMemoryAlertAckStore();
    try {
      s.unacknowledge('BIL', 'ALR-1', 'bob', 'oops', NOW);
      fail('expected throw');
    } catch (e) {
      expect((e as AlertAckError).code).toBe('not_acknowledged');
    }
  });

  test('not_acknowledged rejected after a prior unack', () => {
    const s = new InMemoryAlertAckStore();
    s.acknowledge('BIL', 'ALR-1', 'alice', null, NOW);
    s.unacknowledge('BIL', 'ALR-1', 'bob', 'reassign', NOW);
    try {
      s.unacknowledge('BIL', 'ALR-1', 'bob', 'again', NOW);
      fail('expected throw');
    } catch (e) {
      expect((e as AlertAckError).code).toBe('not_acknowledged');
    }
  });

  test('re-ack after unack rebuilds the live state', () => {
    const s = new InMemoryAlertAckStore();
    s.acknowledge('BIL', 'ALR-1', 'alice', 'first ack', NOW);
    s.unacknowledge('BIL', 'ALR-1', 'bob', 'reassign', NOW);
    const out = s.acknowledge('BIL', 'ALR-1', 'carol', 'second ack', NOW);
    expect(out.status).toBe('acknowledged');
    expect(out.acked_by).toBe('carol');
    expect(out.ack_notes).toBe('second ack');
    expect(out.history).toHaveLength(3);
    expect(out.history.map((h) => h.action)).toEqual([
      'acknowledged',
      'unacknowledged',
      'acknowledged',
    ]);
  });
});

// ─── Routes ───────────────────────────────────────────────────────────

describe('POST /v1/alerts/:alert_id/ack', () => {
  test('analyst+: 200 with new state', async () => {
    const { app } = makeAckApp('risk_analyst');
    const r = await request(app)
      .post('/v1/alerts/ALR-1/ack')
      .set(TH_BIL)
      .set('X-APEX-USER', 'alice')
      .send({ notes: 'investigating' });
    expect(r.status).toBe(200);
    const body = r.body.body as AlertAckState;
    expect(body.status).toBe('acknowledged');
    expect(body.acked_by).toBe('alice');
    expect(body.ack_notes).toBe('investigating');
    expect(body.history).toHaveLength(1);
  });

  test('accepts enveloped body', async () => {
    const { app } = makeAckApp('admin');
    const r = await request(app)
      .post('/v1/alerts/ALR-2/ack')
      .set(TH_BIL)
      .send({ header: { requestId: 'r-1' }, body: { notes: 'reviewed' } });
    expect(r.status).toBe(200);
    expect(r.body.body.ack_notes).toBe('reviewed');
  });

  test('default actor = admin when no X-APEX-USER', async () => {
    const { app } = makeAckApp('admin');
    const r = await request(app).post('/v1/alerts/ALR-1/ack').set(TH_BIL).send({});
    expect(r.body.body.acked_by).toBe('admin');
  });

  test('notes optional → ack_notes null', async () => {
    const { app } = makeAckApp('admin');
    const r = await request(app).post('/v1/alerts/ALR-1/ack').set(TH_BIL).send({});
    expect(r.body.body.ack_notes).toBeNull();
  });

  test('notes > 2000 chars → 400 EWS_400_invalid_input', async () => {
    const { app } = makeAckApp('admin');
    const r = await request(app)
      .post('/v1/alerts/ALR-1/ack')
      .set(TH_BIL)
      .send({ notes: 'x'.repeat(2001) });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_input');
  });

  test('alert_id > 64 chars → 400 EWS_400_invalid_alert_id', async () => {
    const { app } = makeAckApp('admin');
    const r = await request(app)
      .post(`/v1/alerts/${'A'.repeat(65)}/ack`)
      .set(TH_BIL)
      .send({});
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_alert_id');
  });

  test('2nd ack on same alert → 409 EWS_409_already_acknowledged', async () => {
    const { app } = makeAckApp('admin');
    await request(app).post('/v1/alerts/ALR-1/ack').set(TH_BIL).send({});
    const r = await request(app).post('/v1/alerts/ALR-1/ack').set(TH_BIL).send({});
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('EWS_409_already_acknowledged');
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeAckApp('case_owner');
    const r = await request(app).post('/v1/alerts/ALR-1/ack').set(TH_BIL).send({});
    expect(r.status).toBe(403);
  });
});

describe('POST /v1/alerts/:alert_id/unack', () => {
  test('analyst+: 200 with new state', async () => {
    const { app } = makeAckApp('risk_analyst');
    await request(app)
      .post('/v1/alerts/ALR-1/ack')
      .set(TH_BIL)
      .set('X-APEX-USER', 'alice')
      .send({});
    const r = await request(app)
      .post('/v1/alerts/ALR-1/unack')
      .set(TH_BIL)
      .set('X-APEX-USER', 'bob')
      .send({ reason: 'reassign to senior' });
    expect(r.status).toBe(200);
    expect(r.body.body.status).toBe('open');
    expect(r.body.body.history).toHaveLength(2);
    expect(r.body.body.history[1].action).toBe('unacknowledged');
    expect(r.body.body.history[1].notes).toBe('reassign to senior');
  });

  test('reason missing → 400 EWS_400_invalid_input', async () => {
    const { app } = makeAckApp('admin');
    await request(app).post('/v1/alerts/ALR-1/ack').set(TH_BIL).send({});
    const r = await request(app).post('/v1/alerts/ALR-1/unack').set(TH_BIL).send({});
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_input');
  });

  test('reason empty string → 400', async () => {
    const { app } = makeAckApp('admin');
    await request(app).post('/v1/alerts/ALR-1/ack').set(TH_BIL).send({});
    const r = await request(app)
      .post('/v1/alerts/ALR-1/unack')
      .set(TH_BIL)
      .send({ reason: '' });
    expect(r.status).toBe(400);
  });

  test('unack on never-acked alert → 409 EWS_409_not_acknowledged', async () => {
    const { app } = makeAckApp('admin');
    const r = await request(app)
      .post('/v1/alerts/ALR-NEW/unack')
      .set(TH_BIL)
      .send({ reason: 'oops' });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('EWS_409_not_acknowledged');
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeAckApp('case_owner');
    const r = await request(app)
      .post('/v1/alerts/ALR-1/unack')
      .set(TH_BIL)
      .send({ reason: 'no' });
    expect(r.status).toBe(403);
  });
});

describe('GET /v1/alerts/:alert_id/ack', () => {
  test('never-touched alert returns status=open + empty history', async () => {
    const { app } = makeAckApp('risk_analyst');
    const r = await request(app).get('/v1/alerts/ALR-NEW/ack').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.status).toBe('open');
    expect(r.body.body.history).toEqual([]);
  });

  test('reflects current state after ack', async () => {
    const { app } = makeAckApp('admin');
    await request(app)
      .post('/v1/alerts/ALR-1/ack')
      .set(TH_BIL)
      .set('X-APEX-USER', 'alice')
      .send({ notes: 'reviewing' });
    const r = await request(app).get('/v1/alerts/ALR-1/ack').set(TH_BIL);
    expect(r.body.body.status).toBe('acknowledged');
    expect(r.body.body.acked_by).toBe('alice');
    expect(r.body.body.ack_notes).toBe('reviewing');
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeAckApp('case_owner');
    const r = await request(app).get('/v1/alerts/ALR-1/ack').set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('cross-tenant isolation', async () => {
    const { app } = makeAckApp('admin');
    await request(app)
      .post('/v1/alerts/ALR-1/ack')
      .set(TH_BIL)
      .set('X-APEX-USER', 'alice')
      .send({});
    const r = await request(app)
      .get('/v1/alerts/ALR-1/ack')
      .set('X-Tenant-ID', 'BANK_DEMO')
      .set('X-Channel', 'API');
    expect(r.status).toBe(200);
    expect(r.body.body.status).toBe('open');
    expect(r.body.body.acked_by).toBeNull();
  });
});

describe('GET /v1/alerts/:alert_id/ack/history', () => {
  test('empty history for never-touched', async () => {
    const { app } = makeAckApp('admin');
    const r = await request(app).get('/v1/alerts/ALR-NEW/ack/history').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.items).toEqual([]);
    expect(r.body.body.total).toBe(0);
  });

  test('records all transitions oldest-first', async () => {
    const { app } = makeAckApp('admin');
    await request(app)
      .post('/v1/alerts/ALR-1/ack')
      .set(TH_BIL)
      .set('X-APEX-USER', 'alice')
      .send({ notes: 'first' });
    await request(app)
      .post('/v1/alerts/ALR-1/unack')
      .set(TH_BIL)
      .set('X-APEX-USER', 'bob')
      .send({ reason: 'reassign' });
    await request(app)
      .post('/v1/alerts/ALR-1/ack')
      .set(TH_BIL)
      .set('X-APEX-USER', 'carol')
      .send({ notes: 'second' });
    const r = await request(app).get('/v1/alerts/ALR-1/ack/history').set(TH_BIL);
    expect(r.body.body.total).toBe(3);
    expect(r.body.body.items.map((h: { action: string }) => h.action)).toEqual([
      'acknowledged',
      'unacknowledged',
      'acknowledged',
    ]);
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeAckApp('case_owner');
    const r = await request(app).get('/v1/alerts/ALR-1/ack/history').set(TH_BIL);
    expect(r.status).toBe(403);
  });
});

// ─── No-regression ────────────────────────────────────────────────────

describe('No-regression: M8.1 + M8.2 alert routes still work', () => {
  test('GET /v1/alerts still 200 (sub-paths didn\'t shadow)', async () => {
    const { app } = makeAckApp('admin');
    const r = await request(app).get('/v1/alerts').set(TH_BIL);
    expect(r.status).toBe(200);
  });

  test('GET /v1/alerts/classification/spec still 200', async () => {
    const { app } = makeAckApp('admin');
    const r = await request(app).get('/v1/alerts/classification/spec').set(TH_BIL);
    expect(r.status).toBe(200);
  });

  test('GET /v1/alerts/by-class/red still 200 (alert_id param didn\'t capture by-class)', async () => {
    const { app } = makeAckApp('admin');
    const r = await request(app).get('/v1/alerts/by-class/red').set(TH_BIL);
    expect(r.status).toBe(200);
  });

  test('GET /v1/alerts/routing/rules still 200', async () => {
    const { app } = makeAckApp('admin');
    const r = await request(app).get('/v1/alerts/routing/rules').set(TH_BIL);
    expect(r.status).toBe(200);
  });
});
