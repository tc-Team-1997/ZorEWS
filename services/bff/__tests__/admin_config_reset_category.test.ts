// services/bff/__tests__/admin_config_reset_category.test.ts
//
// T6 M13.8 — Admin config bulk-reset by category.

import request from 'supertest';
import { InMemoryConfigStore } from '../src/admin_config';
import { InMemoryAuditTrailStore } from '../src/audit_trail';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-14T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function makeResetApp(role = 'admin') {
  const configStore = new InMemoryConfigStore();
  const auditTrailStore = new InMemoryAuditTrailStore();
  const built = makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    configStore,
    auditTrailStore,
    now: () => NOW,
    getRole: () => role,
  });
  return { ...built, configStore, auditTrailStore };
}

describe('M13.8 — POST /v1/admin/config/_reset-category — validation', () => {
  test('missing category → 400', async () => {
    const { app } = makeResetApp('admin');
    const r = await request(app)
      .post('/v1/admin/config/_reset-category')
      .set(TH_BIL)
      .set('x-apex-user', 'alice')
      .send({});
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_input');
  });

  test('invalid category → 400 with allowed list', async () => {
    const { app } = makeResetApp('admin');
    const r = await request(app)
      .post('/v1/admin/config/_reset-category')
      .set(TH_BIL)
      .set('x-apex-user', 'alice')
      .send({ category: 'banana' });
    expect(r.status).toBe(400);
    expect(r.body.error.message).toMatch(/alerts|notifications|reporting|scoring|features/);
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeResetApp('case_owner');
    const r = await request(app)
      .post('/v1/admin/config/_reset-category')
      .set(TH_BIL)
      .set('x-apex-user', 'alice')
      .send({ category: 'alerts' });
    expect(r.status).toBe(403);
  });
});

describe('M13.8 — happy paths', () => {
  test('empty (no overrides yet) → all keys in category skipped no_override', async () => {
    const { app, configStore } = makeResetApp('admin');
    const r = await request(app)
      .post('/v1/admin/config/_reset-category')
      .set(TH_BIL)
      .set('x-apex-user', 'alice')
      .send({ category: 'alerts' });
    expect(r.status).toBe(200);
    expect(r.body.body.category).toBe('alerts');
    expect(r.body.body.reset_count).toBe(0);
    // Every alerts-category key shows up in skipped[] with no_override.
    expect(r.body.body.skipped.every(
      (s: { reason: string }) => s.reason === 'no_override',
    )).toBe(true);
    expect(r.body.body.total_keys_in_category).toBeGreaterThan(0);
    // Listing alerts entries shows is_default=true unchanged.
    expect(configStore.list('BIL').filter((e) => e.category === 'alerts').every((e) => e.is_default)).toBe(true);
  });

  test('keys with overrides get reset, others stay skipped', async () => {
    const { app, configStore } = makeResetApp('admin');
    // Set one override.
    configStore.set('BIL', 'alerts.red_sla_hours', 2, 'alice', NOW);
    const r = await request(app)
      .post('/v1/admin/config/_reset-category')
      .set(TH_BIL)
      .set('x-apex-user', 'alice')
      .send({ category: 'alerts' });
    expect(r.status).toBe(200);
    expect(r.body.body.reset_count).toBe(1);
    expect(r.body.body.reset[0]).toMatchObject({
      key: 'alerts.red_sla_hours',
      previous_value: 2,
    });
    expect(configStore.get('BIL', 'alerts.red_sla_hours')!.is_default).toBe(true);
  });

  test('dry_run: no actual reset, no audit event, but reset[] previews the change', async () => {
    const { app, configStore, auditTrailStore } = makeResetApp('admin');
    configStore.set('BIL', 'alerts.red_sla_hours', 2, 'alice', NOW);
    configStore.set('BIL', 'alerts.orange_sla_hours', 12, 'alice', NOW);
    const r = await request(app)
      .post('/v1/admin/config/_reset-category')
      .set(TH_BIL)
      .set('x-apex-user', 'alice')
      .send({ category: 'alerts', dry_run: true });
    expect(r.status).toBe(200);
    expect(r.body.body.dry_run).toBe(true);
    expect(r.body.body.reset_count).toBe(2);
    // Live store unchanged.
    expect(configStore.get('BIL', 'alerts.red_sla_hours')!.value).toBe(2);
    expect(configStore.get('BIL', 'alerts.orange_sla_hours')!.value).toBe(12);
    // No audit events.
    const events = auditTrailStore.list('BIL', { action: 'config.reset', page_size: 50 }).items;
    expect(events.length).toBe(0);
  });

  test('writes config.reset audit event per reset with bulk:true marker', async () => {
    const { app, configStore, auditTrailStore } = makeResetApp('admin');
    configStore.set('BIL', 'alerts.red_sla_hours', 2, 'alice', NOW);
    configStore.set('BIL', 'alerts.orange_sla_hours', 12, 'alice', NOW);
    await request(app)
      .post('/v1/admin/config/_reset-category')
      .set(TH_BIL)
      .set('x-apex-user', 'alice')
      .send({ category: 'alerts' });
    const events = auditTrailStore.list('BIL', { action: 'config.reset', page_size: 50 }).items;
    expect(events.length).toBe(2);
    expect(events.every((e) => (e.metadata as Record<string, unknown>).bulk === true)).toBe(true);
    expect(events.every((e) => (e.metadata as Record<string, unknown>).category === 'alerts')).toBe(true);
    expect(events.every((e) => e.resource_type === 'config')).toBe(true);
  });
});

describe('M13.8 — tenant isolation', () => {
  test('resetting BIL alerts leaves BANK_DEMO overrides intact', async () => {
    const { app, configStore } = makeResetApp('admin');
    configStore.set('BIL', 'alerts.red_sla_hours', 2, 'alice', NOW);
    configStore.set('BANK_DEMO', 'alerts.red_sla_hours', 1, 'alice', NOW);
    await request(app)
      .post('/v1/admin/config/_reset-category')
      .set(TH_BIL)
      .set('x-apex-user', 'alice')
      .send({ category: 'alerts' });
    // BIL reset to default; BANK_DEMO still has its override.
    expect(configStore.get('BIL', 'alerts.red_sla_hours')!.is_default).toBe(true);
    expect(configStore.get('BANK_DEMO', 'alerts.red_sla_hours')!.value).toBe(1);
    expect(configStore.get('BANK_DEMO', 'alerts.red_sla_hours')!.is_default).toBe(false);
  });
});

describe('M13.8 — route ordering', () => {
  test('"_reset-category" segment is NOT captured as a config key by DELETE /:key', async () => {
    const { app } = makeResetApp('admin');
    const r = await request(app)
      .post('/v1/admin/config/_reset-category')
      .set(TH_BIL)
      .set('x-apex-user', 'alice')
      .send({ category: 'alerts' });
    expect(r.status).toBe(200);
    expect(r.body.body).toHaveProperty('reset_count');
    expect(r.body.body).toHaveProperty('total_keys_in_category');
  });

  test('existing DELETE /:key still works (M13.2 regression check)', async () => {
    const { app, configStore } = makeResetApp('admin');
    configStore.set('BIL', 'alerts.red_sla_hours', 2, 'alice', NOW);
    const r = await request(app)
      .delete('/v1/admin/config/alerts.red_sla_hours')
      .set(TH_BIL)
      .set('x-apex-user', 'alice');
    expect(r.status).toBe(200);
    expect(r.body.body.is_default).toBe(true);
  });
});
