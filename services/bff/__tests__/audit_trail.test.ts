// services/bff/__tests__/audit_trail.test.ts
//
// T6 M15.1 — BIL Audit & Compliance trail.
//
// Three layers:
//   1. Pure validation helpers + InMemoryAuditTrailStore behaviour
//      (record/list/get/listActions/summarise, tenant isolation,
//      retention cap eviction, all filter axes)
//   2. Routes — RBAC, envelope, every error path

import request from 'supertest';
import {
  AuditValidationError,
  InMemoryAuditTrailStore,
  isAuditOutcome,
  isAuditResourceType,
  isAuditSeverity,
  type AuditEvent,
  type AuditEventInput,
} from '../src/audit_trail';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-04T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };
const TH_BANK = { 'X-Tenant-ID': 'BANK_DEMO', 'X-Channel': 'API' };

function makeAuditApp(role: string = 'admin', auditTrailStore?: InMemoryAuditTrailStore) {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
    auditTrailStore: auditTrailStore ?? new InMemoryAuditTrailStore(),
  });
}

function evt(overrides: Partial<AuditEventInput> = {}): AuditEventInput {
  return {
    actor_username: 'alice',
    actor_role: 'admin',
    action: 'auth.login',
    resource_type: 'session',
    resource_id: 's-1',
    outcome: 'success',
    ...overrides,
  };
}

// ─── Type guards ───────────────────────────────────────────────────────

describe('Type guards', () => {
  test('isAuditOutcome', () => {
    expect(isAuditOutcome('success')).toBe(true);
    expect(isAuditOutcome('failure')).toBe(true);
    expect(isAuditOutcome('denied')).toBe(true);
    expect(isAuditOutcome('SUCCESS')).toBe(false);
    expect(isAuditOutcome(null)).toBe(false);
  });
  test('isAuditSeverity', () => {
    expect(isAuditSeverity('info')).toBe(true);
    expect(isAuditSeverity('warning')).toBe(true);
    expect(isAuditSeverity('critical')).toBe(true);
    expect(isAuditSeverity('fatal')).toBe(false);
  });
  test('isAuditResourceType', () => {
    expect(isAuditResourceType('user')).toBe(true);
    expect(isAuditResourceType('case')).toBe(true);
    expect(isAuditResourceType('system')).toBe(true);
    expect(isAuditResourceType('foo')).toBe(false);
  });
});

// ─── InMemoryAuditTrailStore ───────────────────────────────────────────

describe('InMemoryAuditTrailStore — record', () => {
  test('assigns event_id, ts, tenant_id, defaults severity to info', () => {
    const s = new InMemoryAuditTrailStore();
    const e = s.record('BIL', evt(), NOW);
    expect(e.event_id).toMatch(/^aud-/);
    expect(e.ts).toBe(NOW.toISOString());
    expect(e.tenant_id).toBe('BIL');
    expect(e.severity).toBe('info');
    expect(e.correlation_id).toBeNull();
    expect(e.ip_address).toBeNull();
    expect(e.metadata).toEqual({});
  });

  test('preserves caller-supplied severity, correlation_id, ip_address, metadata', () => {
    const s = new InMemoryAuditTrailStore();
    const e = s.record(
      'BIL',
      evt({
        severity: 'critical',
        correlation_id: 'req-42',
        ip_address: '10.0.0.1',
        metadata: { reason: 'bad creds' },
      }),
      NOW,
    );
    expect(e.severity).toBe('critical');
    expect(e.correlation_id).toBe('req-42');
    expect(e.ip_address).toBe('10.0.0.1');
    expect(e.metadata).toEqual({ reason: 'bad creds' });
  });

  test('rejects missing required fields with code invalid_input', () => {
    const s = new InMemoryAuditTrailStore();
    try {
      s.record('BIL', evt({ actor_username: '' }), NOW);
      fail('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(AuditValidationError);
      expect((e as AuditValidationError).code).toBe('invalid_input');
    }
  });

  test('rejects invalid resource_type / outcome / severity', () => {
    const s = new InMemoryAuditTrailStore();
    expect(() => s.record('BIL', evt({ resource_type: 'foo' as never }), NOW)).toThrow(
      /resource_type/,
    );
    expect(() => s.record('BIL', evt({ outcome: 'maybe' as never }), NOW)).toThrow(/outcome/);
    expect(() =>
      s.record('BIL', evt({ severity: 'fatal' as never }), NOW),
    ).toThrow(/severity/);
  });
});

describe('InMemoryAuditTrailStore — list + get + listActions', () => {
  function seed(s: InMemoryAuditTrailStore): void {
    // Mix of tenants, actions, outcomes.
    s.record('BIL', evt({ actor_username: 'alice', action: 'auth.login' }), new Date('2026-05-01T10:00:00Z'));
    s.record('BIL', evt({ actor_username: 'bob', action: 'auth.login', outcome: 'failure' }), new Date('2026-05-02T10:00:00Z'));
    s.record('BIL', evt({ actor_username: 'alice', action: 'config.update', resource_type: 'config' }), new Date('2026-05-03T10:00:00Z'));
    s.record('BIL', evt({ actor_username: 'alice', action: 'case.close', resource_type: 'case', outcome: 'denied' }), new Date('2026-05-04T09:00:00Z'));
    s.record('BANK_DEMO', evt({ actor_username: 'carol', action: 'auth.login' }), new Date('2026-05-04T11:00:00Z'));
  }

  test('newest-first ordering', () => {
    const s = new InMemoryAuditTrailStore();
    seed(s);
    const out = s.list('BIL', {});
    expect(out.items.length).toBe(4);
    for (let i = 1; i < out.items.length; i++) {
      expect(out.items[i - 1]!.ts >= out.items[i]!.ts).toBe(true);
    }
  });

  test('actor_username filter', () => {
    const s = new InMemoryAuditTrailStore();
    seed(s);
    const out = s.list('BIL', { actor_username: 'alice' });
    expect(out.items.every((e) => e.actor_username === 'alice')).toBe(true);
    expect(out.total).toBe(3);
  });

  test('action filter (single)', () => {
    const s = new InMemoryAuditTrailStore();
    seed(s);
    const out = s.list('BIL', { action: 'auth.login' });
    expect(out.total).toBe(2);
  });

  test('action filter (comma-list string)', () => {
    const s = new InMemoryAuditTrailStore();
    seed(s);
    const out = s.list('BIL', { action: 'auth.login,case.close' });
    expect(out.total).toBe(3);
  });

  test('action filter (string array)', () => {
    const s = new InMemoryAuditTrailStore();
    seed(s);
    const out = s.list('BIL', { action: ['config.update', 'case.close'] });
    expect(out.total).toBe(2);
  });

  test('resource_type + outcome combine (AND semantics)', () => {
    const s = new InMemoryAuditTrailStore();
    seed(s);
    const out = s.list('BIL', { resource_type: 'case', outcome: 'denied' });
    expect(out.total).toBe(1);
    expect(out.items[0]!.action).toBe('case.close');
  });

  test('since/until time-window filter', () => {
    const s = new InMemoryAuditTrailStore();
    seed(s);
    const out = s.list('BIL', {
      since: '2026-05-02T00:00:00Z',
      until: '2026-05-03T23:59:59Z',
    });
    expect(out.total).toBe(2);
  });

  test('pagination — page 2 with page_size 1 yields the next item, no overlap', () => {
    const s = new InMemoryAuditTrailStore();
    seed(s);
    const p1 = s.list('BIL', { page: 1, page_size: 2 });
    const p2 = s.list('BIL', { page: 2, page_size: 2 });
    expect(p1.items.length).toBe(2);
    expect(p2.items.length).toBe(2);
    const p1Ids = new Set(p1.items.map((e) => e.event_id));
    for (const e of p2.items) expect(p1Ids.has(e.event_id)).toBe(false);
  });

  test('page_size clamped to [1, 500]', () => {
    const s = new InMemoryAuditTrailStore();
    seed(s);
    const tooBig = s.list('BIL', { page_size: 99999 });
    expect(tooBig.page_size).toBe(500);
    const tooSmall = s.list('BIL', { page_size: 0 });
    expect(tooSmall.page_size).toBe(1);
  });

  test('tenant isolation — BIL list does not include BANK_DEMO entries', () => {
    const s = new InMemoryAuditTrailStore();
    seed(s);
    const bil = s.list('BIL', {});
    expect(bil.items.some((e) => e.actor_username === 'carol')).toBe(false);
    const bank = s.list('BANK_DEMO', {});
    expect(bank.items.length).toBe(1);
    expect(bank.items[0]!.actor_username).toBe('carol');
  });

  test('get() returns event by id; null for missing or wrong tenant', () => {
    const s = new InMemoryAuditTrailStore();
    const e = s.record('BIL', evt(), NOW);
    expect(s.get('BIL', e.event_id)).toEqual(e);
    expect(s.get('BIL', 'nope')).toBeNull();
    // Tenant scoping
    expect(s.get('BANK_DEMO', e.event_id)).toBeNull();
  });

  test('listActions returns sorted distinct action verbs per tenant', () => {
    const s = new InMemoryAuditTrailStore();
    seed(s);
    expect(s.listActions('BIL')).toEqual(['auth.login', 'case.close', 'config.update']);
    expect(s.listActions('BANK_DEMO')).toEqual(['auth.login']);
  });
});

describe('InMemoryAuditTrailStore — retention cap', () => {
  test('cap evicts oldest entries', () => {
    const s = new InMemoryAuditTrailStore({ cap: 3 });
    for (let i = 0; i < 5; i++) {
      s.record('BIL', evt({ resource_id: `r-${i}` }), new Date(NOW.getTime() + i * 1000));
    }
    const out = s.list('BIL', {});
    expect(out.total).toBe(3);
    // Newest 3 retained
    expect(out.items.map((e) => e.resource_id)).toEqual(['r-4', 'r-3', 'r-2']);
  });
});

describe('InMemoryAuditTrailStore — summarise', () => {
  test('aggregates counts by outcome, severity, action, resource_type within window', () => {
    const s = new InMemoryAuditTrailStore();
    s.record('BIL', evt({ action: 'auth.login', outcome: 'success' }), new Date('2026-05-04T11:00:00Z'));
    s.record('BIL', evt({ action: 'auth.login', outcome: 'failure', severity: 'warning' }), new Date('2026-05-04T11:30:00Z'));
    s.record('BIL', evt({ action: 'config.update', resource_type: 'config', severity: 'critical' }), new Date('2026-05-04T11:45:00Z'));
    // Outside the window
    s.record('BIL', evt({ action: 'auth.login' }), new Date('2026-04-01T10:00:00Z'));

    const sum = s.summarise('BIL', 1, NOW);
    expect(sum.total).toBe(3);
    expect(sum.by_outcome.success).toBe(2);
    expect(sum.by_outcome.failure).toBe(1);
    expect(sum.by_outcome.denied).toBe(0);
    expect(sum.by_severity.info).toBe(1);
    expect(sum.by_severity.warning).toBe(1);
    expect(sum.by_severity.critical).toBe(1);
    // by_action sorted by count desc
    expect(sum.by_action[0]).toEqual({ action: 'auth.login', count: 2 });
    expect(sum.by_action.find((a) => a.action === 'config.update')).toEqual({
      action: 'config.update',
      count: 1,
    });
  });

  test('window respects days parameter', () => {
    const s = new InMemoryAuditTrailStore();
    s.record('BIL', evt(), new Date('2026-05-01T10:00:00Z')); // 3 days back
    s.record('BIL', evt(), new Date('2026-05-04T10:00:00Z')); // today
    const oneDay = s.summarise('BIL', 1, NOW);
    expect(oneDay.total).toBe(1);
    const sevenDays = s.summarise('BIL', 7, NOW);
    expect(sevenDays.total).toBe(2);
  });

  test('zero-event window returns zero counts not undefined', () => {
    const s = new InMemoryAuditTrailStore();
    const sum = s.summarise('BIL', 30, NOW);
    expect(sum.total).toBe(0);
    expect(sum.by_outcome.success).toBe(0);
    expect(sum.by_outcome.failure).toBe(0);
    expect(sum.by_outcome.denied).toBe(0);
    expect(sum.by_action).toEqual([]);
  });
});

// ─── Routes ────────────────────────────────────────────────────────────

describe('POST /v1/audit/events', () => {
  test('admin: 201 with assigned event_id + ts', async () => {
    const store = new InMemoryAuditTrailStore();
    const { app } = makeAuditApp('admin', store);
    const r = await request(app).post('/v1/audit/events').set(TH_BIL).send(evt());
    expect(r.status).toBe(201);
    expect(r.body.body.event_id).toMatch(/^aud-/);
    expect(r.body.body.tenant_id).toBe('BIL');
    expect(store.list('BIL', {}).total).toBe(1);
  });

  test('accepts an enveloped request body', async () => {
    const store = new InMemoryAuditTrailStore();
    const { app } = makeAuditApp('admin', store);
    const r = await request(app)
      .post('/v1/audit/events')
      .set(TH_BIL)
      .send({ header: { requestId: 'r-1' }, body: evt() });
    expect(r.status).toBe(201);
    expect(store.list('BIL', {}).total).toBe(1);
  });

  test('invalid_input → 400 EWS_400_invalid_input', async () => {
    const { app } = makeAuditApp('admin');
    const r = await request(app).post('/v1/audit/events').set(TH_BIL).send(evt({ actor_username: '' }));
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_input');
  });

  test('invalid resource_type → 400 EWS_400_invalid_resource_type', async () => {
    const { app } = makeAuditApp('admin');
    const r = await request(app)
      .post('/v1/audit/events')
      .set(TH_BIL)
      .send(evt({ resource_type: 'foo' as never }));
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_resource_type');
  });

  test('non-admin → 403', async () => {
    const { app } = makeAuditApp('risk_analyst');
    const r = await request(app).post('/v1/audit/events').set(TH_BIL).send(evt());
    expect(r.status).toBe(403);
  });
});

describe('GET /v1/audit/events', () => {
  function seedRoute(app: import('express').Express): Promise<unknown> {
    return Promise.all([
      request(app).post('/v1/audit/events').set(TH_BIL).send(evt({ action: 'auth.login' })),
      request(app)
        .post('/v1/audit/events')
        .set(TH_BIL)
        .send(evt({ action: 'config.update', resource_type: 'config', outcome: 'failure' })),
      request(app)
        .post('/v1/audit/events')
        .set(TH_BIL)
        .send(evt({ action: 'case.close', resource_type: 'case', outcome: 'denied', severity: 'warning' })),
    ]);
  }

  test('admin: 200 with paginated list newest-first', async () => {
    const { app } = makeAuditApp('admin');
    await seedRoute(app);
    const r = await request(app).get('/v1/audit/events').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total).toBe(3);
    expect(r.body.body.page).toBe(1);
    expect(r.body.body.items.length).toBe(3);
  });

  test('?action=auth.login filters', async () => {
    const { app } = makeAuditApp('admin');
    await seedRoute(app);
    const r = await request(app).get('/v1/audit/events?action=auth.login').set(TH_BIL);
    expect(r.body.body.total).toBe(1);
  });

  test('?action=auth.login,case.close (comma list) filters to 2', async () => {
    const { app } = makeAuditApp('admin');
    await seedRoute(app);
    const r = await request(app)
      .get('/v1/audit/events?action=auth.login,case.close')
      .set(TH_BIL);
    expect(r.body.body.total).toBe(2);
  });

  test('?outcome=failure filter', async () => {
    const { app } = makeAuditApp('admin');
    await seedRoute(app);
    const r = await request(app).get('/v1/audit/events?outcome=failure').set(TH_BIL);
    expect(r.body.body.total).toBe(1);
  });

  test('?outcome=invalid → 400 EWS_400_invalid_outcome', async () => {
    const { app } = makeAuditApp('admin');
    const r = await request(app).get('/v1/audit/events?outcome=maybe').set(TH_BIL);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_outcome');
  });

  test('?resource_type=invalid → 400 EWS_400_invalid_resource_type', async () => {
    const { app } = makeAuditApp('admin');
    const r = await request(app).get('/v1/audit/events?resource_type=widget').set(TH_BIL);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_resource_type');
  });

  test('?severity=invalid → 400 EWS_400_invalid_severity', async () => {
    const { app } = makeAuditApp('admin');
    const r = await request(app).get('/v1/audit/events?severity=fatal').set(TH_BIL);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_severity');
  });

  test('?page=2&page_size=2 disjoint from page 1', async () => {
    const { app } = makeAuditApp('admin');
    await seedRoute(app);
    const p1 = await request(app).get('/v1/audit/events?page=1&page_size=2').set(TH_BIL);
    const p2 = await request(app).get('/v1/audit/events?page=2&page_size=2').set(TH_BIL);
    const ids1 = new Set((p1.body.body.items as AuditEvent[]).map((e) => e.event_id));
    for (const e of p2.body.body.items as AuditEvent[]) {
      expect(ids1.has(e.event_id)).toBe(false);
    }
  });

  test('non-admin → 403', async () => {
    const { app } = makeAuditApp('risk_analyst');
    const r = await request(app).get('/v1/audit/events').set(TH_BIL);
    expect(r.status).toBe(403);
  });
});

describe('GET /v1/audit/events/:event_id', () => {
  test('returns the event when found', async () => {
    const store = new InMemoryAuditTrailStore();
    const e = store.record('BIL', evt(), NOW);
    const { app } = makeAuditApp('admin', store);
    const r = await request(app).get(`/v1/audit/events/${e.event_id}`).set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.event_id).toBe(e.event_id);
  });

  test('404 when not found', async () => {
    const { app } = makeAuditApp('admin');
    const r = await request(app).get('/v1/audit/events/aud-nope').set(TH_BIL);
    expect(r.status).toBe(404);
  });

  test('cross-tenant lookup → 404 (tenant scoping)', async () => {
    const store = new InMemoryAuditTrailStore();
    const e = store.record('BIL', evt(), NOW);
    const { app } = makeAuditApp('admin', store);
    const r = await request(app).get(`/v1/audit/events/${e.event_id}`).set(TH_BANK);
    expect(r.status).toBe(404);
  });
});

describe('GET /v1/audit/actions', () => {
  test('returns distinct actions sorted', async () => {
    const store = new InMemoryAuditTrailStore();
    store.record('BIL', evt({ action: 'config.update' }), NOW);
    store.record('BIL', evt({ action: 'auth.login' }), NOW);
    store.record('BIL', evt({ action: 'auth.login' }), NOW);
    const { app } = makeAuditApp('admin', store);
    const r = await request(app).get('/v1/audit/actions').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.items).toEqual(['auth.login', 'config.update']);
    expect(r.body.body.total).toBe(2);
  });

  test('non-admin → 403', async () => {
    const { app } = makeAuditApp('risk_analyst');
    const r = await request(app).get('/v1/audit/actions').set(TH_BIL);
    expect(r.status).toBe(403);
  });
});

describe('GET /v1/audit/summary', () => {
  test('default 30-day window, aggregates by outcome/severity/action/resource_type', async () => {
    const store = new InMemoryAuditTrailStore();
    store.record('BIL', evt({ outcome: 'success' }), new Date('2026-05-04T11:00:00Z'));
    store.record('BIL', evt({ outcome: 'failure', severity: 'warning' }), new Date('2026-05-04T11:30:00Z'));
    const { app } = makeAuditApp('admin', store);
    const r = await request(app).get('/v1/audit/summary').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.days).toBe(30);
    expect(r.body.body.total).toBe(2);
    expect(r.body.body.by_outcome.success).toBe(1);
    expect(r.body.body.by_outcome.failure).toBe(1);
  });

  test('?days=7 honours the override', async () => {
    const store = new InMemoryAuditTrailStore();
    store.record('BIL', evt(), new Date('2026-05-04T11:00:00Z'));
    store.record('BIL', evt(), new Date('2026-04-01T11:00:00Z'));
    const { app } = makeAuditApp('admin', store);
    const r = await request(app).get('/v1/audit/summary?days=7').set(TH_BIL);
    expect(r.body.body.days).toBe(7);
    expect(r.body.body.total).toBe(1);
  });

  test('?days clamped to [1, 365]', async () => {
    const { app } = makeAuditApp('admin');
    const r1 = await request(app).get('/v1/audit/summary?days=99999').set(TH_BIL);
    expect(r1.body.body.days).toBe(365);
    const r2 = await request(app).get('/v1/audit/summary?days=0').set(TH_BIL);
    expect(r2.body.body.days).toBe(1);
  });

  test('non-admin → 403', async () => {
    const { app } = makeAuditApp('risk_analyst');
    const r = await request(app).get('/v1/audit/summary').set(TH_BIL);
    expect(r.status).toBe(403);
  });
});

describe('Tenant isolation through routes', () => {
  test('BIL audit log does not leak to BANK_DEMO admin', async () => {
    const store = new InMemoryAuditTrailStore();
    const { app } = makeAuditApp('admin', store);
    await request(app).post('/v1/audit/events').set(TH_BIL).send(evt({ actor_username: 'alice' }));
    await request(app).post('/v1/audit/events').set(TH_BANK).send(evt({ actor_username: 'bob' }));
    const bil = await request(app).get('/v1/audit/events').set(TH_BIL);
    const bank = await request(app).get('/v1/audit/events').set(TH_BANK);
    expect(bil.body.body.total).toBe(1);
    expect(bil.body.body.items[0].actor_username).toBe('alice');
    expect(bank.body.body.total).toBe(1);
    expect(bank.body.body.items[0].actor_username).toBe('bob');
  });
});
