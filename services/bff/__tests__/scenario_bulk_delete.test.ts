// services/bff/__tests__/scenario_bulk_delete.test.ts
//
// T6 M16.12 — Scenario bulk delete.

import request from 'supertest';
import { InMemoryCustomPresetStore } from '../src/scenario_custom';
import { InMemoryAuditTrailStore } from '../src/audit_trail';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-14T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function makeBulkDeleteApp(role = 'admin') {
  const customPresetStore = new InMemoryCustomPresetStore();
  const auditTrailStore = new InMemoryAuditTrailStore();
  const built = makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    customPresetStore,
    auditTrailStore,
    now: () => NOW,
    getRole: () => role,
  });
  return { ...built, customPresetStore, auditTrailStore };
}

function seedPreset(
  store: InMemoryCustomPresetStore,
  tenant: string,
  name: string,
) {
  return store.create(
    tenant,
    {
      name,
      description: `desc for ${name}`,
      category: 'business',
      regulator: 'INTERNAL',
      severity: 'moderate',
      shocks: { gdp: -0.02, rate: 0.01, fx: 0.05 },
    },
    'alice',
    NOW,
  );
}

describe('M16.12 — POST /v1/scenarios/library/custom/bulk-delete — validation', () => {
  test('empty preset_ids → 400', async () => {
    const { app } = makeBulkDeleteApp('admin');
    const r = await request(app)
      .post('/v1/scenarios/library/custom/bulk-delete')
      .set(TH_BIL)
      .set('x-apex-user', 'alice')
      .send({ preset_ids: [] });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_input');
  });

  test('preset_ids exceeds cap of 10 → 400', async () => {
    const { app } = makeBulkDeleteApp('admin');
    const r = await request(app)
      .post('/v1/scenarios/library/custom/bulk-delete')
      .set(TH_BIL)
      .set('x-apex-user', 'alice')
      .send({ preset_ids: Array.from({ length: 11 }, (_, i) => `p${i}`) });
    expect(r.status).toBe(400);
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeBulkDeleteApp('case_owner');
    const r = await request(app)
      .post('/v1/scenarios/library/custom/bulk-delete')
      .set(TH_BIL)
      .set('x-apex-user', 'alice')
      .send({ preset_ids: ['anything'] });
    expect(r.status).toBe(403);
  });
});

describe('M16.12 — bulk delete — happy paths', () => {
  test('all-valid ids → all deleted, skipped=[]', async () => {
    const { app, customPresetStore } = makeBulkDeleteApp('admin');
    const a = seedPreset(customPresetStore, 'BIL', 'Alpha');
    const b = seedPreset(customPresetStore, 'BIL', 'Beta');
    const r = await request(app)
      .post('/v1/scenarios/library/custom/bulk-delete')
      .set(TH_BIL)
      .set('x-apex-user', 'alice')
      .send({ preset_ids: [a.id, b.id] });
    expect(r.status).toBe(200);
    expect(r.body.body.total).toBe(2);
    expect(r.body.body.deleted_count).toBe(2);
    expect(r.body.body.skipped_count).toBe(0);
    expect(r.body.body.deleted.map((d: { preset_id: string }) => d.preset_id).sort()).toEqual(
      [a.id, b.id].sort(),
    );
    expect(customPresetStore.list('BIL').length).toBe(0);
  });

  test('mixed: unknown + valid → per-row outcomes capture each', async () => {
    const { app, customPresetStore } = makeBulkDeleteApp('admin');
    const a = seedPreset(customPresetStore, 'BIL', 'Alpha');
    const r = await request(app)
      .post('/v1/scenarios/library/custom/bulk-delete')
      .set(TH_BIL)
      .set('x-apex-user', 'alice')
      .send({ preset_ids: [a.id, 'preset_does_not_exist'] });
    expect(r.status).toBe(200);
    expect(r.body.body.deleted_count).toBe(1);
    expect(r.body.body.skipped_count).toBe(1);
    expect(r.body.body.deleted[0].preset_id).toBe(a.id);
    expect(r.body.body.skipped[0]).toEqual({
      preset_id: 'preset_does_not_exist',
      reason: 'unknown_preset',
    });
  });

  test('non-string ids → skipped with invalid_id', async () => {
    const { app } = makeBulkDeleteApp('admin');
    const r = await request(app)
      .post('/v1/scenarios/library/custom/bulk-delete')
      .set(TH_BIL)
      .set('x-apex-user', 'alice')
      .send({ preset_ids: [123, '', '   '] });
    expect(r.status).toBe(200);
    expect(r.body.body.deleted_count).toBe(0);
    expect(r.body.body.skipped_count).toBe(3);
    expect(r.body.body.skipped.every((s: { reason: string }) => s.reason === 'invalid_id')).toBe(true);
  });
});

describe('M16.12 — audit', () => {
  test('writes scenario.delete audit event per successful delete with bulk:true marker', async () => {
    const { app, customPresetStore, auditTrailStore } = makeBulkDeleteApp('admin');
    const a = seedPreset(customPresetStore, 'BIL', 'Alpha');
    const b = seedPreset(customPresetStore, 'BIL', 'Beta');
    await request(app)
      .post('/v1/scenarios/library/custom/bulk-delete')
      .set(TH_BIL)
      .set('x-apex-user', 'alice')
      .send({ preset_ids: [a.id, b.id] });
    const events = auditTrailStore.list('BIL', { action: 'scenario.delete', page_size: 50 }).items;
    expect(events.length).toBe(2);
    expect(events.every((e) => e.actor_username === 'alice')).toBe(true);
    expect(events.every((e) => e.resource_type === 'scenario')).toBe(true);
    expect(events.every((e) => (e.metadata as Record<string, unknown>).bulk === true)).toBe(true);
    const ids = events.map((e) => e.resource_id).sort();
    expect(ids).toEqual([a.id, b.id].sort());
  });

  test('no audit event written for skipped rows', async () => {
    const { app, customPresetStore, auditTrailStore } = makeBulkDeleteApp('admin');
    const a = seedPreset(customPresetStore, 'BIL', 'Alpha');
    await request(app)
      .post('/v1/scenarios/library/custom/bulk-delete')
      .set(TH_BIL)
      .set('x-apex-user', 'alice')
      .send({ preset_ids: [a.id, 'preset_does_not_exist'] });
    const events = auditTrailStore.list('BIL', { action: 'scenario.delete', page_size: 50 }).items;
    expect(events.length).toBe(1);
    expect(events[0]!.resource_id).toBe(a.id);
  });
});

describe('M16.12 — tenant isolation', () => {
  test('preset_id from another tenant is skipped, not deleted', async () => {
    const { app, customPresetStore } = makeBulkDeleteApp('admin');
    const bilPreset = seedPreset(customPresetStore, 'BIL', 'BIL one');
    const demoPreset = seedPreset(customPresetStore, 'BANK_DEMO', 'DEMO one');
    // Caller is BIL — DEMO id should be skipped (not visible).
    const r = await request(app)
      .post('/v1/scenarios/library/custom/bulk-delete')
      .set(TH_BIL)
      .set('x-apex-user', 'alice')
      .send({ preset_ids: [demoPreset.id, bilPreset.id] });
    expect(r.body.body.deleted_count).toBe(1);
    expect(r.body.body.skipped_count).toBe(1);
    expect(r.body.body.deleted[0].preset_id).toBe(bilPreset.id);
    expect(r.body.body.skipped[0]).toEqual({
      preset_id: demoPreset.id,
      reason: 'unknown_preset',
    });
    // DEMO preset still intact.
    expect(customPresetStore.get('BANK_DEMO', demoPreset.id)).toBeTruthy();
  });
});

describe('M16.12 — route ordering: bulk-delete vs :preset_id', () => {
  test('"bulk-delete" segment is NOT captured as a preset_id by the single-DELETE route', async () => {
    // The POST /bulk-delete route MUST be registered before
    // DELETE /:preset_id so the literal segment is taken as a route
    // match, not a wildcard parameter.
    const { app } = makeBulkDeleteApp('admin');
    const r = await request(app)
      .post('/v1/scenarios/library/custom/bulk-delete')
      .set(TH_BIL)
      .set('x-apex-user', 'alice')
      .send({ preset_ids: ['anything'] });
    // Route resolved → 200 with the bulk-delete envelope shape.
    expect(r.status).toBe(200);
    expect(r.body.body).toHaveProperty('deleted_count');
    expect(r.body.body).toHaveProperty('skipped_count');
  });
});
