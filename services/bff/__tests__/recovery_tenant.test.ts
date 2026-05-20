// Recovery Center Phase 2i — tenant config row adoption (BFF-local).
//
// DELETE /v1/tenants/:tenant_id archives the tenant config row BEFORE
// removing it from the registry. Restored tenants come back with
// active=false regardless of the archived flag (conservative
// semantic) — operators must PATCH active=true to bring the tenant
// back online. System-protected tenants (BANK_DEMO) can never be
// archived: the DELETE route refuses them before the archive call
// would fire.

import request from 'supertest';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';
import { InMemoryRecoveryStore } from '../src/recovery/store';
import { InMemoryAuditTrailStore } from '../src/audit_trail';
import { _resetRecoveryAdapters } from '../src/recovery/adapters';
import { defaultTenantLookup } from '../src/tenant';

const NOW = new Date('2026-05-20T17:00:00.000Z');

function setup() {
  _resetRecoveryAdapters();
  const recoveryStore = new InMemoryRecoveryStore();
  const auditTrailStore = new InMemoryAuditTrailStore();
  const tenantLookup = defaultTenantLookup();
  const { app } = makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    recoveryStore,
    auditTrailStore,
    tenantLookup,
    now: () => NOW,
    getRole: () => 'admin',
  });
  return { app, recoveryStore, auditTrailStore, tenantLookup };
}

const HEADERS = {
  'x-tenant-id': 'BANK_DEMO',
  'x-channel': 'API',
  'x-source-system': 'test',
  'x-apex-user': 'alice.admin',
};

// ─── Archive-before-delete ──────────────────────────────────────────

describe('DELETE /v1/tenants/:tenant_id archives before delete', () => {
  test('happy path: existing tenant archived, then deleted, then visible in /v1/recovery list', async () => {
    const { app, recoveryStore, tenantLookup } = setup();
    // Create a fresh tenant to delete (BIL is in the seed; we delete that).
    const before = await tenantLookup('BIL');
    expect(before).toBeDefined();
    expect(before!.active).toBe(true);

    const del = await request(app).delete('/v1/tenants/BIL').set(HEADERS);
    expect(del.status).toBe(204);

    // Tenant is gone from the lookup.
    const after = await tenantLookup('BIL');
    expect(after).toBeUndefined();

    // Recovery row exists under the CALLER's tenant (BANK_DEMO), not BIL.
    const stats = await recoveryStore.stats('BANK_DEMO');
    expect(stats.by_entity_type['tenant']).toBe(1);

    const list = await request(app).get('/v1/recovery?status=archived').set(HEADERS);
    expect(list.status).toBe(200);
    const items = list.body.body.items as Array<{
      entity_type: string;
      original_id: string;
      original_table: string;
      payload: { tenant_id: string; vertical: string; active: boolean };
      deleted_by: string;
      prior_status: string;
    }>;
    const ours = items.find((i) => i.original_id === 'BIL');
    expect(ours).toBeDefined();
    expect(ours!.entity_type).toBe('tenant');
    expect(ours!.original_table).toBe('app_iam.tenants');
    expect(ours!.deleted_by).toBe('alice.admin');
    expect(ours!.payload.tenant_id).toBe('BIL');
    expect(ours!.payload.vertical).toBe('insurance');
    expect(ours!.payload.active).toBe(true);
    expect(ours!.prior_status).toBe('active');
  });

  test('system-protected (BANK_DEMO): 409 + NO archive (Recycle Bin stays clean)', async () => {
    const { app, recoveryStore } = setup();
    const del = await request(app).delete('/v1/tenants/BANK_DEMO').set(HEADERS);
    expect(del.status).toBe(409);
    expect(del.body.error.code).toBe('EWS_409');
    // The archive call IS skipped before the refusal — verified via the
    // recovery store staying empty for the tenant key.
    const stats = await recoveryStore.stats('BANK_DEMO');
    expect(stats.total).toBe(0);
  });

  test('unknown tenant_id: 404 + NO archive', async () => {
    const { app, recoveryStore } = setup();
    const del = await request(app).delete('/v1/tenants/MYSTERY_TENANT').set(HEADERS);
    expect(del.status).toBe(404);
    const stats = await recoveryStore.stats('BANK_DEMO');
    expect(stats.total).toBe(0);
  });

  test('archive failure does NOT block the delete (best-effort posture)', async () => {
    // Override the recovery store with one that throws on archive.
    _resetRecoveryAdapters();
    const auditTrailStore = new InMemoryAuditTrailStore();
    const tenantLookup = defaultTenantLookup();
    const throwingStore = new InMemoryRecoveryStore();
    // Monkey-patch archive() to simulate a transient BFF outage.
    const originalArchive = throwingStore.archive.bind(throwingStore);
    let archiveAttempts = 0;
    throwingStore.archive = async (...args) => {
      archiveAttempts++;
      throw new Error('simulated archive failure');
    };
    const { app } = makeApp({
      source: new StaticSource([]),
      evaluator: new StubEvaluator(),
      riskProfile: new StubRiskProfileSource(),
      caseAction: new UnavailableCaseActionSink(),
      recoveryStore: throwingStore,
      auditTrailStore,
      tenantLookup,
      now: () => NOW,
      getRole: () => 'admin',
    });
    // We can't have BIL deleted twice — the test setup creates a fresh
    // registry per test, so BIL is present.
    const del = await request(app).delete('/v1/tenants/BIL').set(HEADERS);
    // Best-effort: 204 even when the archive throws.
    expect(del.status).toBe(204);
    expect(archiveAttempts).toBe(1);
    // BIL is still gone from the lookup.
    const after = await tenantLookup('BIL');
    expect(after).toBeUndefined();
    void originalArchive; // suppress unused-var
  });

  test('audit trail records `recovery.archive` event for the delete', async () => {
    const { app, auditTrailStore } = setup();
    await request(app).delete('/v1/tenants/BIL').set(HEADERS);
    const events = auditTrailStore.list('BANK_DEMO', {}).items;
    const archive = events.find((e) => e.action === 'recovery.archive');
    expect(archive).toBeDefined();
    expect(archive!.actor_username).toBe('alice.admin');
    const meta = archive!.metadata as { entity_type: string; original_id: string };
    expect(meta.entity_type).toBe('tenant');
    expect(meta.original_id).toBe('BIL');
  });

  test('non-admin role: 403 + NO archive', async () => {
    _resetRecoveryAdapters();
    const recoveryStore = new InMemoryRecoveryStore();
    const tenantLookup = defaultTenantLookup();
    const { app } = makeApp({
      source: new StaticSource([]),
      evaluator: new StubEvaluator(),
      riskProfile: new StubRiskProfileSource(),
      caseAction: new UnavailableCaseActionSink(),
      recoveryStore,
      tenantLookup,
      now: () => NOW,
      getRole: () => 'risk_analyst', // non-admin
    });
    const del = await request(app).delete('/v1/tenants/BIL').set(HEADERS);
    expect(del.status).toBe(403);
    // BIL still exists in the lookup.
    expect(await tenantLookup('BIL')).toBeDefined();
    const stats = await recoveryStore.stats('BANK_DEMO');
    expect(stats.total).toBe(0);
  });
});

// ─── Restore via /v1/recovery/:id/restore ───────────────────────────

describe('POST /v1/recovery/:id/restore for tenant', () => {
  test('happy path: restored tenant comes back with active=false (conservative semantic)', async () => {
    const { app, tenantLookup } = setup();
    // 1. Delete BIL — archive captures it as active.
    await request(app).delete('/v1/tenants/BIL').set(HEADERS);
    expect(await tenantLookup('BIL')).toBeUndefined();

    // 2. Find the recovery_id.
    const list = await request(app).get('/v1/recovery?status=archived').set(HEADERS);
    const ours = (list.body.body.items as Array<{
      recovery_id: string;
      original_id: string;
    }>).find((i) => i.original_id === 'BIL')!;
    expect(ours).toBeDefined();

    // 3. Restore.
    const restore = await request(app)
      .post(`/v1/recovery/${ours.recovery_id}/restore`)
      .set(HEADERS);
    expect(restore.status).toBe(200);
    expect(restore.body.body.status).toBe('restored');

    // 4. BIL is back in the lookup, but INACTIVE.
    const restored = await tenantLookup('BIL');
    expect(restored).toBeDefined();
    expect(restored!.tenant_id).toBe('BIL');
    expect(restored!.vertical).toBe('insurance');
    expect(restored!.name).toBe('Bhutan Insurance Limited');
    expect(restored!.active).toBe(false); // CONSERVATIVE SEMANTIC
  });

  test('restored tenant can be re-activated via PATCH active=true', async () => {
    const { app, tenantLookup } = setup();
    await request(app).delete('/v1/tenants/BIL').set(HEADERS);
    const list = await request(app).get('/v1/recovery?status=archived').set(HEADERS);
    const ours = (list.body.body.items as Array<{ recovery_id: string; original_id: string }>).find(
      (i) => i.original_id === 'BIL',
    )!;
    await request(app).post(`/v1/recovery/${ours.recovery_id}/restore`).set(HEADERS);

    // Operator re-activates via the existing PATCH route.
    const patch = await request(app)
      .patch('/v1/tenants/BIL')
      .set(HEADERS)
      .send({ active: true });
    expect(patch.status).toBe(200);

    const reactivated = await tenantLookup('BIL');
    expect(reactivated!.active).toBe(true);
  });

  test('409 restore_conflict when a tenant with the same id already exists', async () => {
    const { app } = setup();
    // Delete BIL, then re-CREATE it via POST (different from restore).
    // Now the recovery row's restore must refuse — the slot is taken.
    await request(app).delete('/v1/tenants/BIL').set(HEADERS);
    const list = await request(app).get('/v1/recovery?status=archived').set(HEADERS);
    const ours = (list.body.body.items as Array<{ recovery_id: string; original_id: string }>).find(
      (i) => i.original_id === 'BIL',
    )!;
    // Re-create a tenant with the same id via the create route.
    const recreate = await request(app)
      .post('/v1/tenants')
      .set(HEADERS)
      .send({
        tenant_id: 'BIL',
        name: 'BIL (re-created manually)',
        vertical: 'insurance',
        channels_allowed: ['API'],
      });
    expect(recreate.status).toBe(201);
    // Now restore must conflict.
    const restore = await request(app)
      .post(`/v1/recovery/${ours.recovery_id}/restore`)
      .set(HEADERS);
    expect(restore.status).toBe(409);
  });

  test('full round-trip: BIL deleted (active=true archived) → restored (active=false) → manually re-activated', async () => {
    const { app, tenantLookup, recoveryStore } = setup();
    // Active BIL exists in the seed.
    const before = await tenantLookup('BIL');
    expect(before!.active).toBe(true);

    // Delete.
    await request(app).delete('/v1/tenants/BIL').set(HEADERS);
    expect(await tenantLookup('BIL')).toBeUndefined();

    // Restore.
    const list = await request(app).get('/v1/recovery?status=archived').set(HEADERS);
    const ours = (list.body.body.items as Array<{ recovery_id: string; original_id: string }>).find(
      (i) => i.original_id === 'BIL',
    )!;
    const r1 = await request(app).post(`/v1/recovery/${ours.recovery_id}/restore`).set(HEADERS);
    expect(r1.status).toBe(200);

    // Restored as inactive.
    const restored = await tenantLookup('BIL');
    expect(restored!.active).toBe(false);

    // Recovery row marked restored — second click → 409.
    const r2 = await request(app).post(`/v1/recovery/${ours.recovery_id}/restore`).set(HEADERS);
    expect(r2.status).toBe(409);

    // Recovery store agrees.
    const rec = await recoveryStore.get('BANK_DEMO', ours.recovery_id);
    expect(rec!.status).toBe('restored');

    // PATCH active=true brings BIL back fully online.
    const patch = await request(app)
      .patch('/v1/tenants/BIL')
      .set(HEADERS)
      .send({ active: true });
    expect(patch.status).toBe(200);
    const final = await tenantLookup('BIL');
    expect(final!.active).toBe(true);
  });
});
