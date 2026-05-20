// Integration tests for /v1/recovery routes + the archive-before-delete
// path on /v1/webhooks/:id and /v1/scenarios/:id.

import request from 'supertest';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';
import { InMemoryRecoveryStore } from '../src/recovery/store';
import { _resetRecoveryAdapters } from '../src/recovery/adapters';
import { InMemoryAuditTrailStore } from '../src/audit_trail';

const NOW = new Date('2026-05-18T12:00:00.000Z');

function makeRecoveryApp(role: 'admin' | 'risk_analyst' = 'admin') {
  _resetRecoveryAdapters();
  const recoveryStore = new InMemoryRecoveryStore();
  const auditTrailStore = new InMemoryAuditTrailStore();
  const app = makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    recoveryStore,
    auditTrailStore,
    now: () => NOW,
    getRole: () => role,
  }).app;
  return { app, recoveryStore, auditTrailStore };
}

const HEADERS = {
  'x-tenant-id': 'BANK_DEMO',
  'x-channel': 'API',
  'x-source-system': 'test',
  'x-apex-user': 'alice.admin',
};

describe('/v1/recovery — empty store', () => {
  it('GET /v1/recovery returns empty list', async () => {
    const { app } = makeRecoveryApp();
    const res = await request(app).get('/v1/recovery').set(HEADERS);
    expect(res.status).toBe(200);
    expect(res.body.body.items).toEqual([]);
    expect(res.body.body.total).toBe(0);
  });

  it('GET /v1/recovery/stats returns zero counts + adapter list', async () => {
    const { app } = makeRecoveryApp();
    const res = await request(app).get('/v1/recovery/stats').set(HEADERS);
    expect(res.status).toBe(200);
    expect(res.body.body.total).toBe(0);
    expect(res.body.body.by_status).toEqual({ archived: 0, restored: 0, purged: 0 });
    // Adapters auto-registered by makeApp (grew over phases):
    //   Phase 1: webhook_subscription, saved_scenario
    //   Phase 1+: saved_report_filter (only when savedFilterStore is
    //             configured; not configured in this test)
    //   Phase 2h: cms_case_attachment (BFF-local, always registered)
    const types = res.body.body.adapters.map((a: { entity_type: string }) => a.entity_type).sort();
    expect(types).toEqual(['cms_case_attachment', 'saved_scenario', 'webhook_subscription']);
  });

  it('GET /v1/recovery returns 403 for non-admin', async () => {
    const { app } = makeRecoveryApp('risk_analyst');
    const res = await request(app).get('/v1/recovery').set(HEADERS);
    expect(res.status).toBe(403);
  });

  it('GET /v1/recovery rejects bad status filter', async () => {
    const { app } = makeRecoveryApp();
    const res = await request(app).get('/v1/recovery?status=bogus').set(HEADERS);
    expect(res.status).toBe(400);
  });

  it('GET /v1/recovery/:id returns 404 for unknown', async () => {
    const { app } = makeRecoveryApp();
    const res = await request(app).get('/v1/recovery/does-not-exist').set(HEADERS);
    expect(res.status).toBe(404);
  });
});

describe('archive-before-delete: webhook subscription', () => {
  it('DELETE /v1/webhooks/:id archives the row into recovery first', async () => {
    const { app, recoveryStore } = makeRecoveryApp();
    // Create a webhook
    const create = await request(app)
      .post('/v1/webhooks')
      .set(HEADERS)
      .send({ name: 'test', url: 'https://example.com/hook', events: ['alert.created'] });
    expect(create.status).toBe(201);
    const id = create.body.body.id;

    // Delete it — should archive first
    const del = await request(app).delete(`/v1/webhooks/${id}`).set(HEADERS);
    expect(del.status).toBe(204);

    // Recovery store should now have a record
    const list = await recoveryStore.list({ tenant_id: 'BANK_DEMO' });
    expect(list.total).toBe(1);
    expect(list.items[0].entity_type).toBe('webhook_subscription');
    expect(list.items[0].original_id).toBe(id);
    expect(list.items[0].deleted_by).toBe('alice.admin');
    expect((list.items[0].payload as { name: string }).name).toBe('test');
    // Secret IS preserved in payload (needed to restore HMAC signing)
    expect((list.items[0].payload as { secret: string }).secret).toBeTruthy();
  });

  it('restore re-creates the webhook with its original ID', async () => {
    const { app } = makeRecoveryApp();
    const create = await request(app)
      .post('/v1/webhooks')
      .set(HEADERS)
      .send({ name: 'r-test', url: 'https://example.com/h', events: ['alert.created'] });
    const id = create.body.body.id;
    const originalSecret = (
      await request(app).get('/v1/webhooks').set(HEADERS)
    ).body.body.items.find((s: { id: string }) => s.id === id);
    expect(originalSecret).toBeDefined();

    // Delete
    await request(app).delete(`/v1/webhooks/${id}`).set(HEADERS);
    expect(
      (await request(app).get('/v1/webhooks').set(HEADERS)).body.body.items.find(
        (s: { id: string }) => s.id === id,
      ),
    ).toBeUndefined();

    // Find the recovery_id from the list
    const recovery = (await request(app).get('/v1/recovery').set(HEADERS)).body.body
      .items[0];
    expect(recovery.entity_type).toBe('webhook_subscription');

    // Restore
    const restore = await request(app)
      .post(`/v1/recovery/${recovery.recovery_id}/restore`)
      .set(HEADERS);
    expect(restore.status).toBe(200);
    expect(restore.body.body.status).toBe('restored');
    expect(restore.body.body.restored_by).toBe('alice.admin');

    // Webhook is back with the same ID
    const after = (
      await request(app).get('/v1/webhooks').set(HEADERS)
    ).body.body.items.find((s: { id: string }) => s.id === id);
    expect(after).toBeDefined();
    expect(after.name).toBe('r-test');
  });

  it('restore returns 409 when the original_id already exists', async () => {
    const { app, recoveryStore } = makeRecoveryApp();
    // Create + delete a webhook
    const create = await request(app)
      .post('/v1/webhooks')
      .set(HEADERS)
      .send({ name: 'x', url: 'https://example.com/h', events: ['alert.created'] });
    const id = create.body.body.id;
    await request(app).delete(`/v1/webhooks/${id}`).set(HEADERS);

    // Manually re-create a webhook with the SAME id by inserting straight
    // into recovery. The simulated conflict: someone else made an entity
    // with the same id between delete + restore. Real life this would
    // happen if id is deterministic from input + retry. We force it by
    // archiving twice + restoring once, then trying to restore again.
    const list = await recoveryStore.list({ tenant_id: 'BANK_DEMO' });
    const recovery_id = list.items[0].recovery_id;
    // First restore succeeds
    const r1 = await request(app)
      .post(`/v1/recovery/${recovery_id}/restore`)
      .set(HEADERS);
    expect(r1.status).toBe(200);
    // Archive a SECOND copy with same original_id; restoring should now 409
    // because the webhook is back in the live store.
    await recoveryStore.archive({
      tenant_id: 'BANK_DEMO',
      module: 'bff',
      entity_type: 'webhook_subscription',
      original_id: id,
      original_table: 'app_bff.webhook_subscriptions',
      payload: { id, name: 'x', url: 'h', events: [], active: true, secret: 's' } as never,
      deleted_by: 'alice.admin',
    });
    const list2 = await recoveryStore.list({ tenant_id: 'BANK_DEMO' });
    const newRecoveryId = list2.items[0].recovery_id;

    const r2 = await request(app)
      .post(`/v1/recovery/${newRecoveryId}/restore`)
      .set(HEADERS);
    expect(r2.status).toBe(409);
  });
});

describe('archive-before-delete: saved scenario', () => {
  it('DELETE /v1/scenarios/:id archives the row', async () => {
    const { app, recoveryStore } = makeRecoveryApp();
    const save = await request(app)
      .post('/v1/scenarios')
      .set(HEADERS)
      .send({
        id: 'sc-test-1',
        name: 'My scenario',
        inputs: { gdp: -1, rate: 100, fx: 5 },
        result: { portfolio_pd: 0.05 },
      });
    expect([200, 201]).toContain(save.status);

    const del = await request(app).delete('/v1/scenarios/sc-test-1').set(HEADERS);
    expect(del.status).toBe(204);

    const list = await recoveryStore.list({ tenant_id: 'BANK_DEMO' });
    expect(list.total).toBe(1);
    expect(list.items[0].entity_type).toBe('saved_scenario');
    expect(list.items[0].original_id).toBe('sc-test-1');
  });
});

describe('archive-before-delete: saved report filter (3rd adopter)', () => {
  // Use InMemorySavedFilterStore directly + wire it into makeApp through
  // the casesDetailSource/savedFilterStore deps so the sub-router mounts.
  const {
    InMemorySavedFilterStore,
  } = require('../src/reports/saved_filters_store') as typeof import('../src/reports/saved_filters_store');

  function makeAppWithFilters() {
    _resetRecoveryAdapters();
    const recoveryStore = new InMemoryRecoveryStore();
    const savedFilterStore = new InMemorySavedFilterStore();
    // Minimal cases-detail source stub — only needs to exist so the
    // sub-router mounts. We're not exercising the detail/export paths
    // in this test; only the saved-filter delete + restore.
    const casesDetailSource = {
      run: async () => ({
        rows: [],
        total: 0,
        kpis: {
          total: 0,
          breached: 0,
          breached_pct: 0,
          avg_age_hours: 0,
          oldest_age_hours: 0,
        },
        sort: { column: 'age_hours', desc: true },
        page: 1,
        page_size: 50,
      }),
    };
    const app = makeApp({
      source: new StaticSource([]),
      evaluator: new StubEvaluator(),
      riskProfile: new StubRiskProfileSource(),
      caseAction: new UnavailableCaseActionSink(),
      recoveryStore,
      casesDetailSource: casesDetailSource as never,
      savedFilterStore,
      now: () => NOW,
      getRole: () => 'admin',
    }).app;
    return { app, recoveryStore, savedFilterStore };
  }

  it('DELETE /v1/reports/cases/filters/:id archives + then restore re-creates with same ID', async () => {
    const { app, recoveryStore, savedFilterStore } = makeAppWithFilters();
    // Create a filter via the store directly
    const created = await savedFilterStore.create(
      'BANK_DEMO',
      'alice.admin',
      { report_type: 'cases', name: 'Breached this week', filters: { breached: true } },
      NOW,
    );

    // Delete via HTTP — triggers archive-first
    const del = await request(app)
      .delete(`/v1/reports/cases/filters/${created.filter_id}`)
      .set(HEADERS);
    expect(del.status).toBe(200);

    // Recovery store has the archive
    const list = await recoveryStore.list({ tenant_id: 'BANK_DEMO' });
    expect(list.total).toBe(1);
    expect(list.items[0].entity_type).toBe('saved_report_filter');
    expect(list.items[0].original_id).toBe(created.filter_id);

    // Store has no row
    expect(await savedFilterStore.get('BANK_DEMO', created.filter_id)).toBeNull();

    // Restore via /v1/recovery/:id/restore
    const restore = await request(app)
      .post(`/v1/recovery/${list.items[0].recovery_id}/restore`)
      .set(HEADERS);
    expect(restore.status).toBe(200);

    // Row is back in the store with the same ID + same name
    const restored = await savedFilterStore.get('BANK_DEMO', created.filter_id);
    expect(restored?.name).toBe('Breached this week');
  });
});

describe('purge', () => {
  it('DELETE /v1/recovery/:id marks the record as purged', async () => {
    const { app, recoveryStore } = makeRecoveryApp();
    const recovery_id = await recoveryStore.archive({
      tenant_id: 'BANK_DEMO',
      module: 'bff',
      entity_type: 'webhook_subscription',
      original_id: 'wh-purgeme',
      original_table: 't',
      payload: {},
      deleted_by: 'alice',
    });
    const del = await request(app).delete(`/v1/recovery/${recovery_id}`).set(HEADERS);
    expect(del.status).toBe(204);
    const r = await recoveryStore.get('BANK_DEMO', recovery_id);
    expect(r?.status).toBe('purged');
  });

  it('purge is 403 for non-admin', async () => {
    const { app, recoveryStore } = makeRecoveryApp('risk_analyst');
    const recovery_id = await recoveryStore.archive({
      tenant_id: 'BANK_DEMO',
      module: 'bff',
      entity_type: 'webhook_subscription',
      original_id: 'x',
      original_table: 't',
      payload: {},
      deleted_by: 'alice',
    });
    const del = await request(app).delete(`/v1/recovery/${recovery_id}`).set(HEADERS);
    expect(del.status).toBe(403);
  });

  it('cannot purge an already-restored record', async () => {
    const { app, recoveryStore } = makeRecoveryApp();
    const recovery_id = await recoveryStore.archive({
      tenant_id: 'BANK_DEMO',
      module: 'bff',
      entity_type: 'webhook_subscription',
      original_id: 'wh-restored',
      original_table: 'app_bff.webhook_subscriptions',
      payload: { id: 'wh-restored', name: 'x', url: 'h', events: [], active: true, secret: 's' } as never,
      deleted_by: 'alice',
    });
    // Restore first
    const r = await request(app)
      .post(`/v1/recovery/${recovery_id}/restore`)
      .set(HEADERS);
    expect(r.status).toBe(200);
    // Try to purge
    const p = await request(app).delete(`/v1/recovery/${recovery_id}`).set(HEADERS);
    expect(p.status).toBe(409);
  });
});

describe('audit fan-out — recovery lifecycle → app_iam.audit_events', () => {
  it('archive emits recovery.archive audit event', async () => {
    const { app, auditTrailStore } = makeRecoveryApp();
    const create = await request(app)
      .post('/v1/webhooks')
      .set(HEADERS)
      .send({ name: 'audited', url: 'https://example.com/h', events: ['alert.created'] });
    const id = create.body.body.id;
    await request(app).delete(`/v1/webhooks/${id}`).set(HEADERS);

    const audit = auditTrailStore.list('BANK_DEMO', {});
    const archive = audit.items.find((e) => e.action === 'recovery.archive');
    expect(archive).toBeDefined();
    expect(archive!.actor_username).toBe('alice.admin');
    expect(archive!.actor_role).toBe('admin');
    expect(archive!.resource_type).toBe('system');
    expect(archive!.outcome).toBe('success');
    expect(archive!.severity).toBe('info');
    expect(archive!.metadata).toMatchObject({
      entity_type: 'webhook_subscription',
      original_id: id,
      original_table: 'app_bff.webhook_subscriptions',
    });
  });

  it('restore emits recovery.restore audit event', async () => {
    const { app, recoveryStore, auditTrailStore } = makeRecoveryApp();
    const create = await request(app)
      .post('/v1/webhooks')
      .set(HEADERS)
      .send({ name: 'audited-2', url: 'https://example.com/h', events: ['alert.created'] });
    const id = create.body.body.id;
    await request(app).delete(`/v1/webhooks/${id}`).set(HEADERS);
    const list = await recoveryStore.list({ tenant_id: 'BANK_DEMO' });
    const recovery_id = list.items[0].recovery_id;

    await request(app).post(`/v1/recovery/${recovery_id}/restore`).set(HEADERS);

    const audit = auditTrailStore.list('BANK_DEMO', {});
    const restore = audit.items.find((e) => e.action === 'recovery.restore');
    expect(restore).toBeDefined();
    expect(restore!.resource_id).toBe(recovery_id);
    expect(restore!.metadata).toMatchObject({
      entity_type: 'webhook_subscription',
      original_id: id,
    });
    expect(restore!.metadata.restored_by).toBe('alice.admin');
    expect(restore!.metadata.restored_at).toBeTruthy();
  });

  it('purge emits recovery.purge audit event with warning severity', async () => {
    const { app, recoveryStore, auditTrailStore } = makeRecoveryApp();
    const recovery_id = await recoveryStore.archive(
      {
        tenant_id: 'BANK_DEMO',
        module: 'bff',
        entity_type: 'webhook_subscription',
        original_id: 'wh-x',
        original_table: 't',
        payload: {},
        deleted_by: 'alice',
      },
      NOW,
    );
    await request(app).delete(`/v1/recovery/${recovery_id}`).set(HEADERS);

    const audit = auditTrailStore.list('BANK_DEMO', {});
    const purge = audit.items.find((e) => e.action === 'recovery.purge');
    expect(purge).toBeDefined();
    expect(purge!.severity).toBe('warning');
    expect(purge!.metadata.purged_by).toBe('alice.admin');
    expect(purge!.metadata.purged_at).toBeTruthy();
  });

  it('audit failures do NOT block the recovery operation', async () => {
    // Build an audit store that throws on record() — proves try/catch isolation
    const recoveryStore = new InMemoryRecoveryStore();
    const exploding: typeof import('../src/audit_trail').InMemoryAuditTrailStore.prototype = {
      record: () => {
        throw new Error('audit pipeline down');
      },
    } as never;
    _resetRecoveryAdapters();
    const app = makeApp({
      source: new StaticSource([]),
      evaluator: new StubEvaluator(),
      riskProfile: new StubRiskProfileSource(),
      caseAction: new UnavailableCaseActionSink(),
      recoveryStore,
      auditTrailStore: exploding as never,
      now: () => NOW,
      getRole: () => 'admin',
    }).app;

    const create = await request(app)
      .post('/v1/webhooks')
      .set(HEADERS)
      .send({ name: 'iso', url: 'https://example.com/h', events: ['alert.created'] });
    const id = create.body.body.id;
    // The DELETE should still succeed (204) even though audit throws.
    const del = await request(app).delete(`/v1/webhooks/${id}`).set(HEADERS);
    expect(del.status).toBe(204);
    // And the recovery archive STILL happened
    const list = await recoveryStore.list({ tenant_id: 'BANK_DEMO' });
    expect(list.total).toBe(1);
  });
});

describe('POST /v1/recovery/purge-expired', () => {
  const OLD = new Date('2026-04-01T00:00:00Z'); // 47 days before NOW
  const RECENT = new Date('2026-05-15T00:00:00Z'); // 3 days before NOW

  async function seedPurgedRow(store: InMemoryRecoveryStore, deleted_at: Date, original_id: string) {
    const id = await store.archive(
      {
        tenant_id: 'BANK_DEMO',
        module: 'bff',
        entity_type: 'webhook_subscription',
        original_id,
        original_table: 't',
        payload: {},
        deleted_by: 'alice',
      },
      deleted_at,
    );
    await store.markPurged('BANK_DEMO', id, 'admin', deleted_at);
  }

  it('removes purged rows older than days + reports the count', async () => {
    const { app, recoveryStore } = makeRecoveryApp();
    await seedPurgedRow(recoveryStore as InMemoryRecoveryStore, OLD, 'a-old');
    await seedPurgedRow(recoveryStore as InMemoryRecoveryStore, RECENT, 'a-recent');
    const res = await request(app).post('/v1/recovery/purge-expired?days=30').set(HEADERS);
    expect(res.status).toBe(200);
    expect(res.body.body.removed).toBe(1);
    expect(res.body.body.days).toBe(30);
    expect(typeof res.body.body.cutoff).toBe('string');

    // The recent purge still exists
    const purged = await recoveryStore.list({ tenant_id: 'BANK_DEMO', status: 'purged' });
    expect(purged.items.map((r) => r.original_id)).toEqual(['a-recent']);
  });

  it('defaults to days=30 when query param absent', async () => {
    const { app, recoveryStore } = makeRecoveryApp();
    await seedPurgedRow(recoveryStore as InMemoryRecoveryStore, OLD, 'old-1');
    const res = await request(app).post('/v1/recovery/purge-expired').set(HEADERS);
    expect(res.status).toBe(200);
    expect(res.body.body.days).toBe(30);
    expect(res.body.body.removed).toBe(1);
  });

  it('rejects invalid days param', async () => {
    const { app } = makeRecoveryApp();
    const r1 = await request(app).post('/v1/recovery/purge-expired?days=-1').set(HEADERS);
    expect(r1.status).toBe(400);
    const r2 = await request(app).post('/v1/recovery/purge-expired?days=abc').set(HEADERS);
    expect(r2.status).toBe(400);
    const r3 = await request(app).post('/v1/recovery/purge-expired?days=9999').set(HEADERS);
    expect(r3.status).toBe(400);
  });

  it('is admin-only (403 for non-admin)', async () => {
    const { app } = makeRecoveryApp('risk_analyst');
    const res = await request(app).post('/v1/recovery/purge-expired').set(HEADERS);
    expect(res.status).toBe(403);
  });

  it('tenant-scoped — does not reclaim other tenants', async () => {
    const { app, recoveryStore } = makeRecoveryApp();
    // Purge an OLD row for BIL
    const bilId = await recoveryStore.archive(
      {
        tenant_id: 'BIL',
        module: 'bff',
        entity_type: 'webhook_subscription',
        original_id: 'bil-old',
        original_table: 't',
        payload: {},
        deleted_by: 'bob',
      },
      OLD,
    );
    await recoveryStore.markPurged('BIL', bilId, 'admin', OLD);
    // BANK_DEMO admin calls purge-expired — should NOT touch BIL's row
    const res = await request(app).post('/v1/recovery/purge-expired').set(HEADERS);
    expect(res.status).toBe(200);
    expect(res.body.body.removed).toBe(0);
    const bilPurged = await recoveryStore.list({ tenant_id: 'BIL', status: 'purged' });
    expect(bilPurged.items).toHaveLength(1);
  });

  it('returns 0 when nothing qualifies', async () => {
    const { app } = makeRecoveryApp();
    const res = await request(app).post('/v1/recovery/purge-expired').set(HEADERS);
    expect(res.status).toBe(200);
    expect(res.body.body.removed).toBe(0);
  });
});

describe('tenant isolation', () => {
  it('a tenant cannot see another tenant\'s recovery records', async () => {
    const { app, recoveryStore } = makeRecoveryApp();
    await recoveryStore.archive({
      tenant_id: 'BANK_DEMO',
      module: 'bff',
      entity_type: 'webhook_subscription',
      original_id: 'wh-1',
      original_table: 't',
      payload: {},
      deleted_by: 'alice',
    });
    await recoveryStore.archive({
      tenant_id: 'BIL',
      module: 'bff',
      entity_type: 'webhook_subscription',
      original_id: 'wh-2',
      original_table: 't',
      payload: {},
      deleted_by: 'bob',
    });
    const bank = await request(app).get('/v1/recovery').set(HEADERS);
    expect(bank.body.body.total).toBe(1);
    expect(bank.body.body.items[0].original_id).toBe('wh-1');

    const bil = await request(app).get('/v1/recovery').set({ ...HEADERS, 'x-tenant-id': 'BIL' });
    expect(bil.body.body.total).toBe(1);
    expect(bil.body.body.items[0].original_id).toBe('wh-2');
  });
});
