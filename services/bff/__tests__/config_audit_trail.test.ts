// services/bff/__tests__/config_audit_trail.test.ts
//
// T6 M13.2 — Config audit trail (cross-module integration with M15.1).
//
// Asserts:
//   1. Successful PUT /v1/admin/config/:key writes an audit event with
//      action=config.update + resource_type=config + resource_id=key
//      + metadata { previous_value, previous_was_default, new_value }.
//   2. Successful DELETE /v1/admin/config/:key writes a config.reset
//      event ONLY when there was an override to clear.
//   3. Failed PUT (validation error) does NOT write an audit event.
//   4. New GET /v1/admin/config/:key/history returns the slim
//      change-history view, newest-first.
//   5. Tenant isolation through HTTP — BIL config audit doesn't leak to
//      BANK_DEMO, BIL audit query doesn't include BANK_DEMO history.

import request from 'supertest';
import { InMemoryAuditTrailStore, type AuditEvent } from '../src/audit_trail';
import { InMemoryConfigStore } from '../src/admin_config';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-04T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };
const TH_BANK = { 'X-Tenant-ID': 'BANK_DEMO', 'X-Channel': 'API' };

function makeCfgAuditApp(role: string = 'admin') {
  const auditTrailStore = new InMemoryAuditTrailStore();
  const configStore = new InMemoryConfigStore();
  const { app } = makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
    auditTrailStore,
    configStore,
  });
  return { app, auditTrailStore, configStore };
}

// ─── PUT writes audit event ────────────────────────────────────────────

describe('PUT /v1/admin/config/:key writes a config.update audit event', () => {
  test('first override → audit event with previous_was_default=true', async () => {
    const { app, auditTrailStore } = makeCfgAuditApp('admin');
    const r = await request(app)
      .put('/v1/admin/config/alerts.red_sla_hours')
      .set(TH_BIL)
      .set('x-apex-user', 'taniya')
      .send({ value: 2 });
    expect(r.status).toBe(200);
    const events = auditTrailStore.list('BIL', { resource_type: 'config' });
    expect(events.total).toBe(1);
    const e = events.items[0]!;
    expect(e.action).toBe('config.update');
    expect(e.resource_type).toBe('config');
    expect(e.resource_id).toBe('alerts.red_sla_hours');
    expect(e.actor_username).toBe('taniya');
    expect(e.outcome).toBe('success');
    expect(e.metadata.previous_value).toBe(4); // default
    expect(e.metadata.previous_was_default).toBe(true);
    expect(e.metadata.new_value).toBe(2);
  });

  test('second update → previous_was_default=false, previous_value=prior override', async () => {
    const { app, auditTrailStore } = makeCfgAuditApp('admin');
    await request(app)
      .put('/v1/admin/config/alerts.red_sla_hours')
      .set(TH_BIL)
      .set('x-apex-user', 'taniya')
      .send({ value: 2 });
    await request(app)
      .put('/v1/admin/config/alerts.red_sla_hours')
      .set(TH_BIL)
      .set('x-apex-user', 'taniya')
      .send({ value: 1 });
    const events = auditTrailStore.list('BIL', { resource_type: 'config' });
    expect(events.total).toBe(2);
    // newest-first ordering — second update first
    const second = events.items[0]!;
    expect(second.metadata.previous_value).toBe(2);
    expect(second.metadata.previous_was_default).toBe(false);
    expect(second.metadata.new_value).toBe(1);
  });

  test('default actor is "admin" when no x-apex-user header', async () => {
    const { app, auditTrailStore } = makeCfgAuditApp('admin');
    await request(app)
      .put('/v1/admin/config/alerts.red_sla_hours')
      .set(TH_BIL)
      .send({ value: 2 });
    const events = auditTrailStore.list('BIL', { resource_type: 'config' });
    expect(events.items[0]!.actor_username).toBe('admin');
  });

  test('invalid value (type mismatch) → no audit event written', async () => {
    const { app, auditTrailStore } = makeCfgAuditApp('admin');
    const r = await request(app)
      .put('/v1/admin/config/alerts.red_sla_hours')
      .set(TH_BIL)
      .send({ value: 'two' });
    expect(r.status).toBe(400);
    expect(auditTrailStore.list('BIL', {}).total).toBe(0);
  });

  test('unknown_key → no audit event written', async () => {
    const { app, auditTrailStore } = makeCfgAuditApp('admin');
    const r = await request(app)
      .put('/v1/admin/config/no.such.key')
      .set(TH_BIL)
      .send({ value: 1 });
    expect(r.status).toBe(404);
    expect(auditTrailStore.list('BIL', {}).total).toBe(0);
  });

  test('audit chain integrity preserved across multiple config writes', async () => {
    const { app, auditTrailStore } = makeCfgAuditApp('admin');
    for (const v of [2, 3, 4, 5, 6]) {
      await request(app)
        .put('/v1/admin/config/alerts.red_sla_hours')
        .set(TH_BIL)
        .send({ value: v });
    }
    const integrity = auditTrailStore.verifyChain('BIL', NOW);
    expect(integrity.valid).toBe(true);
    expect(integrity.total_events).toBe(5);
  });
});

// ─── DELETE writes audit event ─────────────────────────────────────────

describe('DELETE /v1/admin/config/:key writes a config.reset audit event', () => {
  test('after override, DELETE writes config.reset', async () => {
    const { app, auditTrailStore } = makeCfgAuditApp('admin');
    await request(app)
      .put('/v1/admin/config/alerts.red_sla_hours')
      .set(TH_BIL)
      .set('x-apex-user', 'taniya')
      .send({ value: 2 });
    auditTrailStore.list('BIL', {}); // sanity check
    await request(app)
      .delete('/v1/admin/config/alerts.red_sla_hours')
      .set(TH_BIL)
      .set('x-apex-user', 'reviewer');
    const events = auditTrailStore.list('BIL', { resource_type: 'config' });
    expect(events.total).toBe(2); // PUT + DELETE
    const reset = events.items[0]!; // newest-first
    expect(reset.action).toBe('config.reset');
    expect(reset.actor_username).toBe('reviewer');
    expect(reset.metadata.previous_value).toBe(2);
    expect(reset.metadata.default_value).toBe(4);
  });

  test('DELETE on a never-set key (already default) → no audit event written', async () => {
    const { app, auditTrailStore } = makeCfgAuditApp('admin');
    const r = await request(app)
      .delete('/v1/admin/config/alerts.red_sla_hours')
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(auditTrailStore.list('BIL', { resource_type: 'config' }).total).toBe(0);
  });

  test('DELETE unknown_key → no audit event written', async () => {
    const { app, auditTrailStore } = makeCfgAuditApp('admin');
    const r = await request(app).delete('/v1/admin/config/no.such.key').set(TH_BIL);
    expect(r.status).toBe(404);
    expect(auditTrailStore.list('BIL', {}).total).toBe(0);
  });
});

// ─── GET /v1/admin/config/:key/history ─────────────────────────────────

describe('GET /v1/admin/config/:key/history', () => {
  test('returns ordered change history with previous_value + new_value', async () => {
    const { app } = makeCfgAuditApp('admin');
    await request(app)
      .put('/v1/admin/config/alerts.red_sla_hours')
      .set(TH_BIL)
      .set('x-apex-user', 'alice')
      .send({ value: 3 });
    await request(app)
      .put('/v1/admin/config/alerts.red_sla_hours')
      .set(TH_BIL)
      .set('x-apex-user', 'bob')
      .send({ value: 2 });
    const r = await request(app)
      .get('/v1/admin/config/alerts.red_sla_hours/history')
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total).toBe(2);
    // newest-first
    expect(r.body.body.items[0].new_value).toBe(2);
    expect(r.body.body.items[0].previous_value).toBe(3);
    expect(r.body.body.items[0].actor_username).toBe('bob');
    expect(r.body.body.items[0].action).toBe('config.update');
    expect(r.body.body.items[1].new_value).toBe(3);
    expect(r.body.body.items[1].previous_value).toBe(4); // default
    expect(r.body.body.items[1].actor_username).toBe('alice');
  });

  test('reset events appear in history with new_value = default_value', async () => {
    const { app } = makeCfgAuditApp('admin');
    await request(app)
      .put('/v1/admin/config/alerts.red_sla_hours')
      .set(TH_BIL)
      .send({ value: 2 });
    await request(app).delete('/v1/admin/config/alerts.red_sla_hours').set(TH_BIL);
    const r = await request(app)
      .get('/v1/admin/config/alerts.red_sla_hours/history')
      .set(TH_BIL);
    expect(r.body.body.total).toBe(2);
    const reset = r.body.body.items[0];
    expect(reset.action).toBe('config.reset');
    expect(reset.previous_value).toBe(2);
    expect(reset.new_value).toBe(4); // default
  });

  test('history scoped to the specific key (other keys excluded)', async () => {
    const { app } = makeCfgAuditApp('admin');
    await request(app)
      .put('/v1/admin/config/alerts.red_sla_hours')
      .set(TH_BIL)
      .send({ value: 2 });
    await request(app)
      .put('/v1/admin/config/alerts.orange_sla_hours')
      .set(TH_BIL)
      .send({ value: 12 });
    const r = await request(app)
      .get('/v1/admin/config/alerts.red_sla_hours/history')
      .set(TH_BIL);
    expect(r.body.body.total).toBe(1);
    expect(r.body.body.items[0].new_value).toBe(2);
  });

  test('empty history when the key has never been overridden', async () => {
    const { app } = makeCfgAuditApp('admin');
    const r = await request(app)
      .get('/v1/admin/config/alerts.red_sla_hours/history')
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total).toBe(0);
    expect(r.body.body.items).toEqual([]);
  });

  test('unknown_key → 404 EWS_404_unknown_key', async () => {
    const { app } = makeCfgAuditApp('admin');
    const r = await request(app).get('/v1/admin/config/no.such.key/history').set(TH_BIL);
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('EWS_404_unknown_key');
  });

  test('?limit caps the response', async () => {
    const { app } = makeCfgAuditApp('admin');
    for (const v of [2, 3, 4, 5, 6]) {
      await request(app)
        .put('/v1/admin/config/alerts.red_sla_hours')
        .set(TH_BIL)
        .send({ value: v });
    }
    const r = await request(app)
      .get('/v1/admin/config/alerts.red_sla_hours/history?limit=2')
      .set(TH_BIL);
    expect(r.body.body.items.length).toBe(2);
    expect(r.body.body.limit).toBe(2);
  });

  test('non-admin → 403', async () => {
    const { app } = makeCfgAuditApp('risk_analyst');
    const r = await request(app)
      .get('/v1/admin/config/alerts.red_sla_hours/history')
      .set(TH_BIL);
    expect(r.status).toBe(403);
  });
});

// ─── Tenant isolation ──────────────────────────────────────────────────

describe('Tenant isolation through HTTP', () => {
  test('BIL config update writes only to BIL audit chain, not BANK_DEMO', async () => {
    const { app, auditTrailStore } = makeCfgAuditApp('admin');
    await request(app)
      .put('/v1/admin/config/alerts.red_sla_hours')
      .set(TH_BIL)
      .send({ value: 2 });
    expect(auditTrailStore.list('BIL', { resource_type: 'config' }).total).toBe(1);
    expect(auditTrailStore.list('BANK_DEMO', { resource_type: 'config' }).total).toBe(0);
  });

  test('BIL config history does not surface BANK_DEMO changes', async () => {
    const { app } = makeCfgAuditApp('admin');
    await request(app)
      .put('/v1/admin/config/alerts.red_sla_hours')
      .set(TH_BIL)
      .send({ value: 2 });
    await request(app)
      .put('/v1/admin/config/alerts.red_sla_hours')
      .set(TH_BANK)
      .send({ value: 3 });
    const bil = await request(app)
      .get('/v1/admin/config/alerts.red_sla_hours/history')
      .set(TH_BIL);
    const bank = await request(app)
      .get('/v1/admin/config/alerts.red_sla_hours/history')
      .set(TH_BANK);
    expect(bil.body.body.total).toBe(1);
    expect(bank.body.body.total).toBe(1);
    expect(bil.body.body.items[0].new_value).toBe(2);
    expect(bank.body.body.items[0].new_value).toBe(3);
  });
});

// ─── Audit-trail integration sanity ───────────────────────────────────

describe('M15.1 / M15.2 surface still exposes config.update events', () => {
  test('GET /v1/audit/events?resource_type=config returns the same events', async () => {
    const { app } = makeCfgAuditApp('admin');
    await request(app)
      .put('/v1/admin/config/alerts.red_sla_hours')
      .set(TH_BIL)
      .set('x-apex-user', 'taniya')
      .send({ value: 2 });
    const r = await request(app)
      .get('/v1/audit/events?resource_type=config')
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total).toBe(1);
    const e = r.body.body.items[0] as AuditEvent;
    expect(e.action).toBe('config.update');
    expect(e.resource_id).toBe('alerts.red_sla_hours');
    expect(e.actor_username).toBe('taniya');
  });

  test('GET /v1/audit/integrity verifies the chain after config writes', async () => {
    const { app } = makeCfgAuditApp('admin');
    await request(app)
      .put('/v1/admin/config/alerts.red_sla_hours')
      .set(TH_BIL)
      .send({ value: 2 });
    await request(app)
      .put('/v1/admin/config/alerts.orange_sla_hours')
      .set(TH_BIL)
      .send({ value: 18 });
    const r = await request(app).get('/v1/audit/integrity').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.valid).toBe(true);
    expect(r.body.body.total_events).toBe(2);
  });
});
