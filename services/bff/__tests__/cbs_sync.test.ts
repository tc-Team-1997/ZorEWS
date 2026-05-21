// services/bff/__tests__/cbs_sync.test.ts
//
// Phase T3.1 — CBS Integration Deepening tests.

import request from 'supertest';
import {
  ALL_CBS_SYNC_DIRECTIONS,
  ALL_CBS_ENTITIES,
  ALL_CBS_SYNC_STATUSES,
  isCbsSyncDirection,
  isCbsEntity,
  isCbsSyncStatus,
  computeBackoff,
  InMemoryCbsSyncStore,
  CbsSyncError,
  CBS_SYNC_CAP_PER_TENANT,
  type CbsSyncEnqueueInput,
  type CbsReconciliationReceipt,
} from '../src/integrations/cbs_sync';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-21T16:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API', 'X-APEX-USER': 'alice.admin' };
const TH_BANK = { 'X-Tenant-ID': 'BANK_DEMO', 'X-Channel': 'API', 'X-APEX-USER': 'admin' };

function makeCbsApp(
  role: string = 'admin',
  overrides: { cbsSyncStore?: InMemoryCbsSyncStore } = {},
) {
  const { app } = makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
    cbsSyncStore: overrides.cbsSyncStore ?? new InMemoryCbsSyncStore(),
  });
  return app;
}

const validEnqueue = (over: Partial<CbsSyncEnqueueInput> = {}): CbsSyncEnqueueInput => ({
  direction: 'inbound',
  entity: 'loan',
  idempotency_key: 'cbs-loan-pull-2026-05-21T16',
  trace_id: 'trace-abc-123',
  notes: 'Daily CBS loan pull',
  ...over,
});

const validReconciliation = (over: Partial<CbsReconciliationReceipt> = {}): CbsReconciliationReceipt => ({
  rows_offered: 100,
  rows_accepted: 98,
  rows_rejected: 2,
  rejection_reasons: [{ reason: 'validation_failed', count: 2 }],
  duration_ms: 1234,
  cursor: 'cursor-next-batch',
  ...over,
});

// ── 1. Constants + type guards ────────────────────────────────────────

describe('cbs_sync constants', () => {
  test('ALL_CBS_SYNC_DIRECTIONS = inbound + outbound', () => {
    expect(ALL_CBS_SYNC_DIRECTIONS).toEqual(['inbound', 'outbound']);
  });

  test('ALL_CBS_ENTITIES covers 5 canonical CBS surfaces', () => {
    expect(ALL_CBS_ENTITIES).toEqual([
      'loan', 'repayment', 'transaction', 'account_profile', 'case_action',
    ]);
  });

  test('ALL_CBS_SYNC_STATUSES has 6 lifecycle states', () => {
    expect(ALL_CBS_SYNC_STATUSES.length).toBe(6);
  });

  test('type guards accept + reject', () => {
    expect(isCbsSyncDirection('inbound')).toBe(true);
    expect(isCbsSyncDirection('lateral')).toBe(false);
    expect(isCbsEntity('loan')).toBe(true);
    expect(isCbsEntity('mortgage')).toBe(false);
    expect(isCbsSyncStatus('queued')).toBe(true);
    expect(isCbsSyncStatus('done')).toBe(false);
  });
});

// ── 2. computeBackoff ────────────────────────────────────────────────

describe('computeBackoff', () => {
  test('attempt 0 → 1 minute', () => {
    const next = computeBackoff(0, NOW);
    expect(next.getTime() - NOW.getTime()).toBe(60_000);
  });

  test('attempt 1 → 2 minutes', () => {
    expect(computeBackoff(1, NOW).getTime() - NOW.getTime()).toBe(120_000);
  });

  test('attempt 5 → 32 minutes', () => {
    expect(computeBackoff(5, NOW).getTime() - NOW.getTime()).toBe(32 * 60_000);
  });

  test('caps at 1 hour for large attempts', () => {
    expect(computeBackoff(20, NOW).getTime() - NOW.getTime()).toBe(60 * 60_000);
  });

  test('negative attempt throws', () => {
    expect(() => computeBackoff(-1, NOW)).toThrow(/invalid_input/);
  });
});

// ── 3. Store enqueue ─────────────────────────────────────────────────

describe('InMemoryCbsSyncStore — enqueue', () => {
  test('happy path with idempotency key', () => {
    const s = new InMemoryCbsSyncStore();
    const j = s.enqueue('BIL', validEnqueue(), 'admin', NOW);
    expect(j.status).toBe('queued');
    expect(j.attempt).toBe(0);
    expect(j.direction).toBe('inbound');
    expect(j.entity).toBe('loan');
    expect(j.idempotency_key).toBe('cbs-loan-pull-2026-05-21T16');
    expect(j.tenant_id).toBe('BIL');
  });

  test('idempotency: same key → same job', () => {
    const s = new InMemoryCbsSyncStore();
    const a = s.enqueue('BIL', validEnqueue(), 'admin', NOW);
    const b = s.enqueue('BIL', validEnqueue(), 'admin', new Date(NOW.getTime() + 10000));
    expect(a.job_id).toBe(b.job_id);
    expect(a.enqueued_at).toBe(b.enqueued_at);
  });

  test('different idempotency key → new job', () => {
    const s = new InMemoryCbsSyncStore();
    const a = s.enqueue('BIL', validEnqueue({ idempotency_key: 'key-1' }), 'admin', NOW);
    const b = s.enqueue('BIL', validEnqueue({ idempotency_key: 'key-2' }), 'admin', NOW);
    expect(a.job_id).not.toBe(b.job_id);
  });

  test('cross-tenant: same key works independently per tenant', () => {
    const s = new InMemoryCbsSyncStore();
    s.enqueue('BIL', validEnqueue(), 'admin', NOW);
    const other = s.enqueue('BANK_DEMO', validEnqueue(), 'admin', NOW);
    expect(other.tenant_id).toBe('BANK_DEMO');
    expect(s.list('BANK_DEMO')).toHaveLength(1);
  });

  test('auto-generated job_id when not supplied', () => {
    const s = new InMemoryCbsSyncStore();
    const j = s.enqueue('BIL', validEnqueue({ idempotency_key: null }), 'admin', NOW);
    expect(j.job_id).toMatch(/^csj_auto_/);
  });

  test('explicit job_id collision → duplicate_idempotency_key', () => {
    const s = new InMemoryCbsSyncStore();
    s.enqueue('BIL', validEnqueue({ job_id: 'csj_x', idempotency_key: null }), 'admin', NOW);
    expect(() =>
      s.enqueue('BIL', validEnqueue({ job_id: 'csj_x', idempotency_key: null }), 'admin', NOW),
    ).toThrow(/duplicate_idempotency_key/);
  });

  test('invalid_direction', () => {
    const s = new InMemoryCbsSyncStore();
    expect(() =>
      s.enqueue('BIL', validEnqueue({ direction: 'lateral' as never }), 'admin', NOW),
    ).toThrow(/invalid_direction/);
  });

  test('invalid_entity', () => {
    const s = new InMemoryCbsSyncStore();
    expect(() =>
      s.enqueue('BIL', validEnqueue({ entity: 'mortgage' as never }), 'admin', NOW),
    ).toThrow(/invalid_entity/);
  });

  test('invalid_max_attempts', () => {
    const s = new InMemoryCbsSyncStore();
    expect(() => s.enqueue('BIL', validEnqueue({ max_attempts: 0 }), 'admin', NOW)).toThrow(/invalid_max_attempts/);
    expect(() => s.enqueue('BIL', validEnqueue({ max_attempts: 100 }), 'admin', NOW)).toThrow(/invalid_max_attempts/);
  });

  test('long idempotency_key → invalid_input', () => {
    const s = new InMemoryCbsSyncStore();
    expect(() =>
      s.enqueue('BIL', validEnqueue({ idempotency_key: 'x'.repeat(201) }), 'admin', NOW),
    ).toThrow(/invalid_input/);
  });

  test('cap_reached', () => {
    const s = new InMemoryCbsSyncStore();
    for (let i = 0; i < CBS_SYNC_CAP_PER_TENANT; i++) {
      s.enqueue('BIL', validEnqueue({ idempotency_key: `k-${i}` }), 'admin', NOW);
    }
    expect(() =>
      s.enqueue('BIL', validEnqueue({ idempotency_key: 'overflow' }), 'admin', NOW),
    ).toThrow(/cap_reached/);
  });
});

// ── 4. Store transition ──────────────────────────────────────────────

describe('InMemoryCbsSyncStore — transition', () => {
  test('queued → in_progress sets started_at', () => {
    const s = new InMemoryCbsSyncStore();
    const j = s.enqueue('BIL', validEnqueue(), 'admin', NOW);
    const t = s.transition('BIL', j.job_id, { status: 'in_progress' }, 'admin', NOW);
    expect(t.status).toBe('in_progress');
    expect(t.started_at).toBe(NOW.toISOString());
  });

  test('in_progress → succeeded requires reconciliation', () => {
    const s = new InMemoryCbsSyncStore();
    const j = s.enqueue('BIL', validEnqueue(), 'admin', NOW);
    s.transition('BIL', j.job_id, { status: 'in_progress' }, 'admin', NOW);
    expect(() =>
      s.transition('BIL', j.job_id, { status: 'succeeded' }, 'admin', NOW),
    ).toThrow(/invalid_reconciliation/);
    const ok = s.transition(
      'BIL',
      j.job_id,
      { status: 'succeeded', reconciliation: validReconciliation() },
      'admin',
      NOW,
    );
    expect(ok.status).toBe('succeeded');
    expect(ok.reconciliation?.rows_accepted).toBe(98);
    expect(ok.completed_at).toBe(NOW.toISOString());
  });

  test('in_progress → retry_scheduled bumps attempt + sets next_retry_at', () => {
    const s = new InMemoryCbsSyncStore();
    const j = s.enqueue('BIL', validEnqueue(), 'admin', NOW);
    s.transition('BIL', j.job_id, { status: 'in_progress' }, 'admin', NOW);
    const t = s.transition(
      'BIL',
      j.job_id,
      { status: 'retry_scheduled', error_message: 'CBS timeout' },
      'admin',
      NOW,
    );
    expect(t.status).toBe('retry_scheduled');
    expect(t.attempt).toBe(1);
    expect(t.next_retry_at).not.toBeNull();
    expect(t.error_message).toBe('CBS timeout');
  });

  test('retry_scheduled → in_progress clears next_retry_at + error', () => {
    const s = new InMemoryCbsSyncStore();
    const j = s.enqueue('BIL', validEnqueue(), 'admin', NOW);
    s.transition('BIL', j.job_id, { status: 'in_progress' }, 'admin', NOW);
    s.transition('BIL', j.job_id, { status: 'retry_scheduled' }, 'admin', NOW);
    const t = s.transition('BIL', j.job_id, { status: 'in_progress' }, 'admin', NOW);
    expect(t.next_retry_at).toBeNull();
    expect(t.error_message).toBeNull();
  });

  test('retry exhaustion blocks more retries', () => {
    const s = new InMemoryCbsSyncStore();
    const j = s.enqueue('BIL', validEnqueue({ max_attempts: 2 }), 'admin', NOW);
    s.transition('BIL', j.job_id, { status: 'in_progress' }, 'admin', NOW);
    s.transition('BIL', j.job_id, { status: 'retry_scheduled' }, 'admin', NOW);
    s.transition('BIL', j.job_id, { status: 'in_progress' }, 'admin', NOW);
    // attempt would become 2 = max_attempts → invalid_transition
    expect(() =>
      s.transition('BIL', j.job_id, { status: 'retry_scheduled' }, 'admin', NOW),
    ).toThrow(/exceeds max_attempts/);
  });

  test('illegal transition: succeeded → in_progress', () => {
    const s = new InMemoryCbsSyncStore();
    const j = s.enqueue('BIL', validEnqueue(), 'admin', NOW);
    s.transition('BIL', j.job_id, { status: 'in_progress' }, 'admin', NOW);
    s.transition(
      'BIL',
      j.job_id,
      { status: 'succeeded', reconciliation: validReconciliation() },
      'admin',
      NOW,
    );
    expect(() =>
      s.transition('BIL', j.job_id, { status: 'in_progress' }, 'admin', NOW),
    ).toThrow(/invalid_transition/);
  });

  test('cancelled at any pre-terminal state', () => {
    const s = new InMemoryCbsSyncStore();
    const j = s.enqueue('BIL', validEnqueue(), 'admin', NOW);
    const t = s.transition('BIL', j.job_id, { status: 'cancelled' }, 'admin', NOW);
    expect(t.status).toBe('cancelled');
    expect(t.completed_at).toBe(NOW.toISOString());
  });

  test('reconciliation: accepted + rejected > offered → invalid', () => {
    const s = new InMemoryCbsSyncStore();
    const j = s.enqueue('BIL', validEnqueue(), 'admin', NOW);
    s.transition('BIL', j.job_id, { status: 'in_progress' }, 'admin', NOW);
    expect(() =>
      s.transition(
        'BIL',
        j.job_id,
        {
          status: 'succeeded',
          reconciliation: { ...validReconciliation(), rows_offered: 10, rows_accepted: 8, rows_rejected: 5 },
        },
        'admin',
        NOW,
      ),
    ).toThrow(/invalid_reconciliation/);
  });

  test('unknown_job throws', () => {
    const s = new InMemoryCbsSyncStore();
    expect(() =>
      s.transition('BIL', 'csj_nope', { status: 'in_progress' }, 'admin', NOW),
    ).toThrow(/unknown_job/);
  });
});

// ── 5. Store list/get/summary ────────────────────────────────────────

describe('InMemoryCbsSyncStore — list/get/summary', () => {
  test('list newest-first by enqueued_at', () => {
    const s = new InMemoryCbsSyncStore();
    s.enqueue('BIL', validEnqueue({ idempotency_key: 'k1' }), 'admin', NOW);
    s.enqueue('BIL', validEnqueue({ idempotency_key: 'k2' }), 'admin', new Date(NOW.getTime() + 1000));
    const items = s.list('BIL');
    expect(items[0].idempotency_key).toBe('k2');
    expect(items[1].idempotency_key).toBe('k1');
  });

  test('list filter by direction + entity + status', () => {
    const s = new InMemoryCbsSyncStore();
    s.enqueue('BIL', validEnqueue({ idempotency_key: 'a', direction: 'inbound', entity: 'loan' }), 'admin', NOW);
    s.enqueue('BIL', validEnqueue({ idempotency_key: 'b', direction: 'outbound', entity: 'case_action' }), 'admin', NOW);
    expect(s.list('BIL', { direction: 'outbound' })).toHaveLength(1);
    expect(s.list('BIL', { entity: 'loan' })).toHaveLength(1);
    expect(s.list('BIL', { status: 'queued' })).toHaveLength(2);
    expect(s.list('BIL', { status: 'succeeded' })).toHaveLength(0);
  });

  test('list limit clamp', () => {
    const s = new InMemoryCbsSyncStore();
    for (let i = 0; i < 50; i++) {
      s.enqueue('BIL', validEnqueue({ idempotency_key: `k-${i}` }), 'admin', NOW);
    }
    expect(s.list('BIL', { limit: 10 })).toHaveLength(10);
    expect(s.list('BIL', { limit: 1000 })).toHaveLength(50);
  });

  test('getByIdempotencyKey hit + null', () => {
    const s = new InMemoryCbsSyncStore();
    s.enqueue('BIL', validEnqueue({ idempotency_key: 'k-x' }), 'admin', NOW);
    expect(s.getByIdempotencyKey('BIL', 'k-x')?.idempotency_key).toBe('k-x');
    expect(s.getByIdempotencyKey('BIL', 'nope')).toBeNull();
  });

  test('summary rollup', () => {
    const s = new InMemoryCbsSyncStore();
    const j1 = s.enqueue('BIL', validEnqueue({ idempotency_key: 'k1' }), 'admin', NOW);
    s.transition('BIL', j1.job_id, { status: 'in_progress' }, 'admin', NOW);
    s.transition('BIL', j1.job_id, { status: 'succeeded', reconciliation: validReconciliation() }, 'admin', NOW);
    s.enqueue('BIL', validEnqueue({ idempotency_key: 'k2', direction: 'outbound', entity: 'case_action' }), 'admin', NOW);
    const sum = s.summary('BIL');
    expect(sum.total_jobs).toBe(2);
    expect(sum.by_status.succeeded).toBe(1);
    expect(sum.by_status.queued).toBe(1);
    expect(sum.by_direction.inbound).toBe(1);
    expect(sum.by_direction.outbound).toBe(1);
    expect(sum.total_rows_offered).toBe(100);
    expect(sum.total_rows_accepted).toBe(98);
  });

  test('summary detects overdue retries', () => {
    const s = new InMemoryCbsSyncStore();
    const past = new Date(Date.now() - 10 * 60_000); // 10m ago
    const j = s.enqueue('BIL', validEnqueue(), 'admin', past);
    s.transition('BIL', j.job_id, { status: 'in_progress' }, 'admin', past);
    s.transition(
      'BIL',
      j.job_id,
      { status: 'retry_scheduled', next_retry_at: past.toISOString() },
      'admin',
      past,
    );
    const sum = s.summary('BIL');
    expect(sum.overdue_retries).toBe(1);
  });
});

// ── 6. Soft-delete + restore ─────────────────────────────────────────

describe('InMemoryCbsSyncStore — soft-delete + restore', () => {
  test('softDelete excludes from list', () => {
    const s = new InMemoryCbsSyncStore();
    const j = s.enqueue('BIL', validEnqueue(), 'admin', NOW);
    s.softDelete('BIL', j.job_id, 'admin', NOW);
    expect(s.list('BIL')).toHaveLength(0);
    expect(s.list('BIL', { include_deleted: true })).toHaveLength(1);
    expect(s.get('BIL', j.job_id)).toBeNull();
  });

  test('restore round-trip', () => {
    const s = new InMemoryCbsSyncStore();
    const j = s.enqueue('BIL', validEnqueue(), 'admin', NOW);
    s.softDelete('BIL', j.job_id, 'admin', NOW);
    expect(s.restore({ ...j, deleted_at: NOW.toISOString(), deleted_by: 'admin' })).toBe(true);
    expect(s.get('BIL', j.job_id)?.deleted_at).toBeNull();
    // Conflict on live row
    expect(s.restore({ ...j })).toBe(false);
  });
});

// ── 7. Routes ────────────────────────────────────────────────────────

describe('GET /v1/integrations/cbs/enums', () => {
  test('admin → 200 with enums', async () => {
    const app = makeCbsApp('admin');
    const r = await request(app).get('/v1/integrations/cbs/enums').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.directions).toEqual([...ALL_CBS_SYNC_DIRECTIONS]);
    expect(r.body.body.entities).toEqual([...ALL_CBS_ENTITIES]);
    expect(r.body.body.statuses).toEqual([...ALL_CBS_SYNC_STATUSES]);
  });

  test('case_owner → 403', async () => {
    const app = makeCbsApp('case_owner');
    const r = await request(app).get('/v1/integrations/cbs/enums').set(TH_BIL);
    expect(r.status).toBe(403);
  });
});

describe('POST /v1/integrations/cbs/sync-jobs', () => {
  test('happy path → 201', async () => {
    const app = makeCbsApp('admin');
    const r = await request(app)
      .post('/v1/integrations/cbs/sync-jobs')
      .set(TH_BIL)
      .send(validEnqueue());
    expect(r.status).toBe(201);
    expect(r.body.body.status).toBe('queued');
    expect(r.body.body.direction).toBe('inbound');
  });

  test('idempotent: second POST returns same job', async () => {
    const app = makeCbsApp('admin');
    const a = await request(app).post('/v1/integrations/cbs/sync-jobs').set(TH_BIL).send(validEnqueue());
    const b = await request(app).post('/v1/integrations/cbs/sync-jobs').set(TH_BIL).send(validEnqueue());
    expect(a.body.body.job_id).toBe(b.body.body.job_id);
  });

  test('invalid direction → 400', async () => {
    const app = makeCbsApp('admin');
    const r = await request(app)
      .post('/v1/integrations/cbs/sync-jobs')
      .set(TH_BIL)
      .send({ ...validEnqueue(), direction: 'sideways' });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_direction');
  });

  test('case_owner → 403', async () => {
    const app = makeCbsApp('case_owner');
    const r = await request(app)
      .post('/v1/integrations/cbs/sync-jobs')
      .set(TH_BIL)
      .send(validEnqueue());
    expect(r.status).toBe(403);
  });
});

describe('GET + transitions', () => {
  test('full lifecycle: enqueue → in_progress → succeeded', async () => {
    const store = new InMemoryCbsSyncStore();
    const app = makeCbsApp('admin', { cbsSyncStore: store });
    const created = await request(app)
      .post('/v1/integrations/cbs/sync-jobs')
      .set(TH_BIL)
      .send(validEnqueue());
    const jobId = created.body.body.job_id;

    const t1 = await request(app)
      .post(`/v1/integrations/cbs/sync-jobs/${jobId}/transition`)
      .set(TH_BIL)
      .send({ status: 'in_progress' });
    expect(t1.status).toBe(200);
    expect(t1.body.body.status).toBe('in_progress');

    const t2 = await request(app)
      .post(`/v1/integrations/cbs/sync-jobs/${jobId}/transition`)
      .set(TH_BIL)
      .send({ status: 'succeeded', reconciliation: validReconciliation() });
    expect(t2.status).toBe(200);
    expect(t2.body.body.status).toBe('succeeded');
  });

  test('illegal transition → 409', async () => {
    const store = new InMemoryCbsSyncStore();
    const app = makeCbsApp('admin', { cbsSyncStore: store });
    const created = await request(app)
      .post('/v1/integrations/cbs/sync-jobs')
      .set(TH_BIL)
      .send(validEnqueue());
    const jobId = created.body.body.job_id;
    // queued → succeeded is illegal
    const r = await request(app)
      .post(`/v1/integrations/cbs/sync-jobs/${jobId}/transition`)
      .set(TH_BIL)
      .send({ status: 'succeeded', reconciliation: validReconciliation() });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('EWS_409_invalid_transition');
  });

  test('transition unknown_job → 404', async () => {
    const app = makeCbsApp('admin');
    const r = await request(app)
      .post('/v1/integrations/cbs/sync-jobs/csj_nope/transition')
      .set(TH_BIL)
      .send({ status: 'in_progress' });
    expect(r.status).toBe(404);
  });

  test('GET by job_id 200 + 404', async () => {
    const store = new InMemoryCbsSyncStore();
    const app = makeCbsApp('admin', { cbsSyncStore: store });
    const j = store.enqueue('BIL', validEnqueue(), 'admin', NOW);
    const ok = await request(app).get(`/v1/integrations/cbs/sync-jobs/${j.job_id}`).set(TH_BIL);
    expect(ok.status).toBe(200);
    const miss = await request(app).get('/v1/integrations/cbs/sync-jobs/csj_nope').set(TH_BIL);
    expect(miss.status).toBe(404);
  });

  test('GET by-key 200 + 404', async () => {
    const store = new InMemoryCbsSyncStore();
    const app = makeCbsApp('admin', { cbsSyncStore: store });
    store.enqueue('BIL', validEnqueue(), 'admin', NOW);
    const ok = await request(app)
      .get('/v1/integrations/cbs/sync-jobs/by-key/cbs-loan-pull-2026-05-21T16')
      .set(TH_BIL);
    expect(ok.status).toBe(200);
    const miss = await request(app)
      .get('/v1/integrations/cbs/sync-jobs/by-key/nope')
      .set(TH_BIL);
    expect(miss.status).toBe(404);
  });
});

describe('GET /v1/integrations/cbs/sync-jobs (list)', () => {
  test('filter by direction', async () => {
    const store = new InMemoryCbsSyncStore();
    const app = makeCbsApp('admin', { cbsSyncStore: store });
    store.enqueue('BIL', validEnqueue({ idempotency_key: 'a', direction: 'inbound' }), 'admin', NOW);
    store.enqueue('BIL', validEnqueue({ idempotency_key: 'b', direction: 'outbound', entity: 'case_action' }), 'admin', NOW);
    const r = await request(app).get('/v1/integrations/cbs/sync-jobs?direction=outbound').set(TH_BIL);
    expect(r.body.body.total).toBe(1);
  });

  test('invalid filter → 400', async () => {
    const app = makeCbsApp('admin');
    const r = await request(app).get('/v1/integrations/cbs/sync-jobs?status=bogus').set(TH_BIL);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_status');
  });

  test('cross-tenant invisibility', async () => {
    const store = new InMemoryCbsSyncStore();
    const app = makeCbsApp('admin', { cbsSyncStore: store });
    store.enqueue('BIL', validEnqueue(), 'admin', NOW);
    const r = await request(app).get('/v1/integrations/cbs/sync-jobs').set(TH_BANK);
    expect(r.body.body.total).toBe(0);
  });
});

describe('GET /v1/integrations/cbs/summary', () => {
  test('admin → rollup', async () => {
    const store = new InMemoryCbsSyncStore();
    const app = makeCbsApp('admin', { cbsSyncStore: store });
    store.enqueue('BIL', validEnqueue(), 'admin', NOW);
    const r = await request(app).get('/v1/integrations/cbs/summary').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_jobs).toBe(1);
    expect(r.body.body.by_status.queued).toBe(1);
  });
});

describe('DELETE /v1/integrations/cbs/sync-jobs/:job_id', () => {
  test('happy → 204', async () => {
    const store = new InMemoryCbsSyncStore();
    const app = makeCbsApp('admin', { cbsSyncStore: store });
    const j = store.enqueue('BIL', validEnqueue(), 'admin', NOW);
    const r = await request(app).delete(`/v1/integrations/cbs/sync-jobs/${j.job_id}`).set(TH_BIL);
    expect(r.status).toBe(204);
    expect(store.get('BIL', j.job_id)).toBeNull();
  });

  test('unknown → 404', async () => {
    const app = makeCbsApp('admin');
    const r = await request(app).delete('/v1/integrations/cbs/sync-jobs/csj_nope').set(TH_BIL);
    expect(r.status).toBe(404);
  });
});
