// services/bff/__tests__/config_rollback.test.ts
//
// T6 M13.3 — Config rollback to a prior audit event.

import request from 'supertest';
import {
  ConfigRollbackError,
  rollbackConfig,
  rollbackTargetFromMetadata,
} from '../src/config_rollback';
import {
  InMemoryConfigStore,
  type ConfigStore,
} from '../src/admin_config';
import {
  InMemoryAuditTrailStore,
  type AuditTrailStore,
} from '../src/audit_trail';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-05T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

// ─── rollbackTargetFromMetadata ───────────────────────────────────────

describe('rollbackTargetFromMetadata', () => {
  test('config.update returns metadata.new_value', () => {
    expect(rollbackTargetFromMetadata('config.update', { new_value: 10000 })).toBe(10000);
    expect(rollbackTargetFromMetadata('config.update', { new_value: 'abc', other: 1 })).toBe('abc');
    expect(rollbackTargetFromMetadata('config.update', { new_value: true })).toBe(true);
  });

  test('config.update missing new_value → null', () => {
    expect(rollbackTargetFromMetadata('config.update', {})).toBeNull();
    expect(rollbackTargetFromMetadata('config.update', { previous_value: 1 })).toBeNull();
  });

  test('config.reset returns metadata.default_value', () => {
    expect(rollbackTargetFromMetadata('config.reset', { default_value: 4 })).toBe(4);
  });

  test('config.reset missing default_value → null', () => {
    expect(rollbackTargetFromMetadata('config.reset', {})).toBeNull();
  });

  test('null/undefined values not accepted as ConfigValue', () => {
    expect(rollbackTargetFromMetadata('config.update', { new_value: null })).toBeNull();
    expect(rollbackTargetFromMetadata('config.update', { new_value: undefined })).toBeNull();
  });

  test('array values rejected (object guard requires non-array)', () => {
    expect(rollbackTargetFromMetadata('config.update', { new_value: [1, 2] })).toBeNull();
  });

  test('object values accepted (json type)', () => {
    const v = rollbackTargetFromMetadata('config.update', { new_value: { a: 1 } });
    expect(v).toEqual({ a: 1 });
  });

  test('unknown action returns null', () => {
    expect(rollbackTargetFromMetadata('case.close', { new_value: 1 })).toBeNull();
  });
});

// ─── Pure rollbackConfig() ────────────────────────────────────────────

describe('rollbackConfig (unit)', () => {
  function setup(): { config: ConfigStore; audit: AuditTrailStore } {
    return {
      config: new InMemoryConfigStore(),
      audit: new InMemoryAuditTrailStore(),
    };
  }

  test('happy: rollback to a prior config.update event', () => {
    const { config, audit } = setup();
    // Day 1: set red_sla to 10
    config.set('BIL', 'alerts.red_sla_hours', 10, 'admin', NOW);
    const ev1 = audit.record(
      'BIL',
      {
        actor_username: 'admin',
        actor_role: 'admin',
        action: 'config.update',
        resource_type: 'config',
        resource_id: 'alerts.red_sla_hours',
        outcome: 'success',
        severity: 'info',
        metadata: { previous_value: 4, new_value: 10 },
      },
      NOW,
    );
    // Day 2: set red_sla to 20
    const day2 = new Date('2026-05-06T12:00:00Z');
    config.set('BIL', 'alerts.red_sla_hours', 20, 'admin', day2);
    audit.record(
      'BIL',
      {
        actor_username: 'admin',
        actor_role: 'admin',
        action: 'config.update',
        resource_type: 'config',
        resource_id: 'alerts.red_sla_hours',
        outcome: 'success',
        severity: 'info',
        metadata: { previous_value: 10, new_value: 20 },
      },
      day2,
    );
    // Rollback to ev1's state (red_sla=10)
    const day3 = new Date('2026-05-07T12:00:00Z');
    const out = rollbackConfig(
      'BIL',
      'alerts.red_sla_hours',
      ev1.event_id,
      'compliance.lead',
      day3,
      config,
      audit,
    );
    expect(out.entry.value).toBe(10);
    expect(out.previous_value).toBe(20);
    expect(out.new_value).toBe(10);
    expect(out.rolled_back_from_event_id).toBe(ev1.event_id);
    // Live store reflects rollback
    expect(config.get('BIL', 'alerts.red_sla_hours')?.value).toBe(10);
    // A new audit event was recorded with rolled_back_from_event_id
    const allEvents = audit.list('BIL', { resource_type: 'config' });
    const rollbackEvent = allEvents.items.find(
      (e) => (e.metadata as { rolled_back_from_event_id?: string }).rolled_back_from_event_id === ev1.event_id,
    );
    expect(rollbackEvent).toBeDefined();
    expect(rollbackEvent!.actor_username).toBe('compliance.lead');
    expect(rollbackEvent!.metadata.new_value).toBe(10);
    expect(rollbackEvent!.metadata.previous_value).toBe(20);
  });

  test('rollback to a config.reset event uses metadata.default_value', () => {
    const { config, audit } = setup();
    // Set then reset
    config.set('BIL', 'alerts.red_sla_hours', 10, 'admin', NOW);
    audit.record(
      'BIL',
      {
        actor_username: 'admin',
        actor_role: 'admin',
        action: 'config.update',
        resource_type: 'config',
        resource_id: 'alerts.red_sla_hours',
        outcome: 'success',
        severity: 'info',
        metadata: { previous_value: 4, new_value: 10 },
      },
      NOW,
    );
    config.reset('BIL', 'alerts.red_sla_hours');
    const resetEv = audit.record(
      'BIL',
      {
        actor_username: 'admin',
        actor_role: 'admin',
        action: 'config.reset',
        resource_type: 'config',
        resource_id: 'alerts.red_sla_hours',
        outcome: 'success',
        severity: 'info',
        metadata: { previous_value: 10, default_value: 4 },
      },
      NOW,
    );
    // Set to 20 → then rollback to the reset event (which should restore 4)
    config.set('BIL', 'alerts.red_sla_hours', 20, 'admin', NOW);
    const out = rollbackConfig(
      'BIL',
      'alerts.red_sla_hours',
      resetEv.event_id,
      'admin',
      NOW,
      config,
      audit,
    );
    expect(out.new_value).toBe(4);
  });

  test('unknown event_id → unknown_event 404', () => {
    const { config, audit } = setup();
    try {
      rollbackConfig(
        'BIL',
        'alerts.red_sla_hours',
        'aud-no-such',
        'admin',
        NOW,
        config,
        audit,
      );
      fail('expected throw');
    } catch (e) {
      expect((e as ConfigRollbackError).code).toBe('unknown_event');
    }
  });

  test('event for different key → event_not_for_this_key 400', () => {
    const { config, audit } = setup();
    const ev = audit.record(
      'BIL',
      {
        actor_username: 'admin',
        actor_role: 'admin',
        action: 'config.update',
        resource_type: 'config',
        resource_id: 'alerts.orange_sla_hours',
        outcome: 'success',
        severity: 'info',
        metadata: { previous_value: 24, new_value: 48 },
      },
      NOW,
    );
    try {
      rollbackConfig('BIL', 'alerts.red_sla_hours', ev.event_id, 'admin', NOW, config, audit);
      fail('expected throw');
    } catch (e) {
      expect((e as ConfigRollbackError).code).toBe('event_not_for_this_key');
    }
  });

  test('event with non-config resource_type → event_not_for_this_key', () => {
    const { config, audit } = setup();
    const ev = audit.record(
      'BIL',
      {
        actor_username: 'admin',
        actor_role: 'admin',
        action: 'case.close',
        resource_type: 'case',
        resource_id: 'alerts.red_sla_hours',
        outcome: 'success',
        severity: 'info',
        metadata: { new_value: 10 },
      },
      NOW,
    );
    expect(() =>
      rollbackConfig('BIL', 'alerts.red_sla_hours', ev.event_id, 'admin', NOW, config, audit),
    ).toThrow(ConfigRollbackError);
  });

  test('event with no recoverable metadata → event_not_recoverable', () => {
    const { config, audit } = setup();
    const ev = audit.record(
      'BIL',
      {
        actor_username: 'admin',
        actor_role: 'admin',
        action: 'config.update',
        resource_type: 'config',
        resource_id: 'alerts.red_sla_hours',
        outcome: 'success',
        severity: 'info',
        metadata: {}, // missing new_value
      },
      NOW,
    );
    try {
      rollbackConfig('BIL', 'alerts.red_sla_hours', ev.event_id, 'admin', NOW, config, audit);
      fail('expected throw');
    } catch (e) {
      expect((e as ConfigRollbackError).code).toBe('event_not_recoverable');
    }
  });

  test('rollback with type-mismatched value → event_not_recoverable', () => {
    const { config, audit } = setup();
    const ev = audit.record(
      'BIL',
      {
        actor_username: 'admin',
        actor_role: 'admin',
        action: 'config.update',
        resource_type: 'config',
        resource_id: 'alerts.red_sla_hours', // declared as number
        outcome: 'success',
        severity: 'info',
        metadata: { new_value: 'four hours' }, // string, but key expects number
      },
      NOW,
    );
    expect(() =>
      rollbackConfig('BIL', 'alerts.red_sla_hours', ev.event_id, 'admin', NOW, config, audit),
    ).toThrow(/event_not_recoverable|rejected by schema/);
  });

  test('current value already equals target → already_at_value 409', () => {
    const { config, audit } = setup();
    config.set('BIL', 'alerts.red_sla_hours', 10, 'admin', NOW);
    const ev = audit.record(
      'BIL',
      {
        actor_username: 'admin',
        actor_role: 'admin',
        action: 'config.update',
        resource_type: 'config',
        resource_id: 'alerts.red_sla_hours',
        outcome: 'success',
        severity: 'info',
        metadata: { previous_value: 4, new_value: 10 },
      },
      NOW,
    );
    try {
      rollbackConfig('BIL', 'alerts.red_sla_hours', ev.event_id, 'admin', NOW, config, audit);
      fail('expected throw');
    } catch (e) {
      expect((e as ConfigRollbackError).code).toBe('already_at_value');
    }
  });

  test('cross-tenant event lookup denied (BANK_DEMO event invisible to BIL caller)', () => {
    const { config, audit } = setup();
    const ev = audit.record(
      'BANK_DEMO',
      {
        actor_username: 'admin',
        actor_role: 'admin',
        action: 'config.update',
        resource_type: 'config',
        resource_id: 'alerts.red_sla_hours',
        outcome: 'success',
        severity: 'info',
        metadata: { new_value: 10 },
      },
      NOW,
    );
    try {
      rollbackConfig('BIL', 'alerts.red_sla_hours', ev.event_id, 'admin', NOW, config, audit);
      fail('expected throw');
    } catch (e) {
      expect((e as ConfigRollbackError).code).toBe('unknown_event');
    }
  });

  test('missing actor_username rejected', () => {
    const { config, audit } = setup();
    expect(() =>
      rollbackConfig('BIL', 'alerts.red_sla_hours', 'aud-x', '', NOW, config, audit),
    ).toThrow(/actor_username/);
  });

  test('missing to_event_id rejected', () => {
    const { config, audit } = setup();
    expect(() =>
      rollbackConfig('BIL', 'alerts.red_sla_hours', '', 'admin', NOW, config, audit),
    ).toThrow(/to_event_id/);
  });
});

// ─── Routes ───────────────────────────────────────────────────────────

function makeRollbackApp(role: string = 'admin') {
  const config = new InMemoryConfigStore();
  const audit = new InMemoryAuditTrailStore();
  const built = makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    configStore: config,
    auditTrailStore: audit,
    now: () => NOW,
    getRole: () => role,
  });
  return { ...built, config, audit };
}

async function seedTwoUpdates(
  app: ReturnType<typeof makeRollbackApp>,
): Promise<{ ev1Id: string; ev2Id: string }> {
  // PUT to set 10 → audit ev1 written
  await request(app.app)
    .put('/v1/admin/config/alerts.red_sla_hours')
    .set(TH_BIL)
    .send({ value: 10 });
  // PUT to set 20 → audit ev2 written
  await request(app.app)
    .put('/v1/admin/config/alerts.red_sla_hours')
    .set(TH_BIL)
    .send({ value: 20 });
  // Use the history endpoint (which now exposes event_id) to grab ids
  const hist = await request(app.app)
    .get('/v1/admin/config/alerts.red_sla_hours/history')
    .set(TH_BIL);
  // History is newest-first. ev2 first, ev1 second.
  expect(hist.body.body.items.length).toBe(2);
  return {
    ev1Id: hist.body.body.items[1].event_id,
    ev2Id: hist.body.body.items[0].event_id,
  };
}

describe('M13.2 history slim shape now exposes event_id (M13.3 prerequisite)', () => {
  test('history items carry event_id', async () => {
    const app = makeRollbackApp('admin');
    await request(app.app)
      .put('/v1/admin/config/alerts.red_sla_hours')
      .set(TH_BIL)
      .send({ value: 7 });
    const r = await request(app.app)
      .get('/v1/admin/config/alerts.red_sla_hours/history')
      .set(TH_BIL);
    expect(r.body.body.items[0].event_id).toMatch(/^aud-/);
  });
});

describe('POST /v1/admin/config/:key/rollback', () => {
  test('admin: 200 rolls back to prior event\'s new_value', async () => {
    const app = makeRollbackApp('admin');
    const { ev1Id } = await seedTwoUpdates(app);
    // Current value is 20; rollback to ev1 → expect 10.
    const r = await request(app.app)
      .post('/v1/admin/config/alerts.red_sla_hours/rollback')
      .set(TH_BIL)
      .set('X-APEX-USER', 'compliance.lead')
      .send({ to_event_id: ev1Id });
    expect(r.status).toBe(200);
    expect(r.body.body.entry.value).toBe(10);
    expect(r.body.body.previous_value).toBe(20);
    expect(r.body.body.new_value).toBe(10);
    expect(r.body.body.rolled_back_from_event_id).toBe(ev1Id);
  });

  test('rollback writes a NEW audit event with rolled_back_from_event_id', async () => {
    const app = makeRollbackApp('admin');
    const { ev1Id } = await seedTwoUpdates(app);
    await request(app.app)
      .post('/v1/admin/config/alerts.red_sla_hours/rollback')
      .set(TH_BIL)
      .send({ to_event_id: ev1Id });
    const hist = await request(app.app)
      .get('/v1/admin/config/alerts.red_sla_hours/history')
      .set(TH_BIL);
    // There should be 3 events now: ev1 (set 10), ev2 (set 20), ev3 (rollback to 10)
    expect(hist.body.body.items.length).toBe(3);
    const newest = hist.body.body.items[0];
    expect(newest.rolled_back_from_event_id).toBe(ev1Id);
    expect(newest.new_value).toBe(10);
    expect(newest.previous_value).toBe(20);
  });

  test('accepts enveloped body', async () => {
    const app = makeRollbackApp('admin');
    const { ev1Id } = await seedTwoUpdates(app);
    const r = await request(app.app)
      .post('/v1/admin/config/alerts.red_sla_hours/rollback')
      .set(TH_BIL)
      .send({ header: { requestId: 'r-1' }, body: { to_event_id: ev1Id } });
    expect(r.status).toBe(200);
  });

  test('default actor=admin when no X-APEX-USER', async () => {
    const app = makeRollbackApp('admin');
    const { ev1Id } = await seedTwoUpdates(app);
    await request(app.app)
      .post('/v1/admin/config/alerts.red_sla_hours/rollback')
      .set(TH_BIL)
      .send({ to_event_id: ev1Id });
    const hist = await request(app.app)
      .get('/v1/admin/config/alerts.red_sla_hours/history')
      .set(TH_BIL);
    expect(hist.body.body.items[0].actor_username).toBe('admin');
  });

  test('unknown event → 404 EWS_404_unknown_event', async () => {
    const app = makeRollbackApp('admin');
    const r = await request(app.app)
      .post('/v1/admin/config/alerts.red_sla_hours/rollback')
      .set(TH_BIL)
      .send({ to_event_id: 'aud-no-such' });
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('EWS_404_unknown_event');
  });

  test('missing to_event_id → 400 EWS_400_invalid_input', async () => {
    const app = makeRollbackApp('admin');
    const r = await request(app.app)
      .post('/v1/admin/config/alerts.red_sla_hours/rollback')
      .set(TH_BIL)
      .send({});
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_input');
  });

  test('event for different key → 400 EWS_400_event_not_for_this_key', async () => {
    const app = makeRollbackApp('admin');
    // Make an audit event for orange_sla:
    await request(app.app)
      .put('/v1/admin/config/alerts.orange_sla_hours')
      .set(TH_BIL)
      .send({ value: 48 });
    const orangeHist = await request(app.app)
      .get('/v1/admin/config/alerts.orange_sla_hours/history')
      .set(TH_BIL);
    const orangeEv = orangeHist.body.body.items[0].event_id;
    // Try to rollback red_sla using orange's event id
    const r = await request(app.app)
      .post('/v1/admin/config/alerts.red_sla_hours/rollback')
      .set(TH_BIL)
      .send({ to_event_id: orangeEv });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_event_not_for_this_key');
  });

  test('already_at_value → 409', async () => {
    const app = makeRollbackApp('admin');
    // Single PUT to value 10
    await request(app.app)
      .put('/v1/admin/config/alerts.red_sla_hours')
      .set(TH_BIL)
      .send({ value: 10 });
    const hist = await request(app.app)
      .get('/v1/admin/config/alerts.red_sla_hours/history')
      .set(TH_BIL);
    const evId = hist.body.body.items[0].event_id;
    // Current value is 10; rolling back to ev (which set 10) is no-op
    const r = await request(app.app)
      .post('/v1/admin/config/alerts.red_sla_hours/rollback')
      .set(TH_BIL)
      .send({ to_event_id: evId });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('EWS_409_already_at_value');
  });

  test('cross-tenant: BIL caller cannot use BANK_DEMO event id → 404', async () => {
    const app = makeRollbackApp('admin');
    // Seed a BANK_DEMO event
    await request(app.app)
      .put('/v1/admin/config/alerts.red_sla_hours')
      .set('X-Tenant-ID', 'BANK_DEMO')
      .set('X-Channel', 'API')
      .send({ value: 99 });
    const bdHist = await request(app.app)
      .get('/v1/admin/config/alerts.red_sla_hours/history')
      .set('X-Tenant-ID', 'BANK_DEMO')
      .set('X-Channel', 'API');
    const bdEv = bdHist.body.body.items[0].event_id;
    // BIL tries to use BANK_DEMO's event id
    const r = await request(app.app)
      .post('/v1/admin/config/alerts.red_sla_hours/rollback')
      .set(TH_BIL)
      .send({ to_event_id: bdEv });
    expect(r.status).toBe(404);
  });

  test('non-allowed role → 403', async () => {
    const app = makeRollbackApp('case_owner');
    const r = await request(app.app)
      .post('/v1/admin/config/alerts.red_sla_hours/rollback')
      .set(TH_BIL)
      .send({ to_event_id: 'aud-x' });
    expect(r.status).toBe(403);
  });

  test('chain: ev1=10 → ev2=20 → rollback to ev1 → rollback to ev2', async () => {
    const app = makeRollbackApp('admin');
    const { ev1Id, ev2Id } = await seedTwoUpdates(app);
    // First rollback: 20 → 10
    const r1 = await request(app.app)
      .post('/v1/admin/config/alerts.red_sla_hours/rollback')
      .set(TH_BIL)
      .send({ to_event_id: ev1Id });
    expect(r1.body.body.entry.value).toBe(10);
    // Second rollback: 10 → 20 (using ev2)
    const r2 = await request(app.app)
      .post('/v1/admin/config/alerts.red_sla_hours/rollback')
      .set(TH_BIL)
      .send({ to_event_id: ev2Id });
    expect(r2.body.body.entry.value).toBe(20);
  });
});

// ─── No-regression ────────────────────────────────────────────────────

describe('No-regression: M13.1 + M13.2 routes still work', () => {
  test('GET /v1/admin/config still 200', async () => {
    const app = makeRollbackApp('admin');
    const r = await request(app.app).get('/v1/admin/config').set(TH_BIL);
    expect(r.status).toBe(200);
  });

  test('PUT /v1/admin/config/:key still works (value updates)', async () => {
    const app = makeRollbackApp('admin');
    const r = await request(app.app)
      .put('/v1/admin/config/alerts.red_sla_hours')
      .set(TH_BIL)
      .send({ value: 5 });
    expect(r.status).toBe(200);
    expect(r.body.body.value).toBe(5);
  });

  test('GET /v1/admin/config/:key/history still 200 (with new event_id field)', async () => {
    const app = makeRollbackApp('admin');
    await request(app.app)
      .put('/v1/admin/config/alerts.red_sla_hours')
      .set(TH_BIL)
      .send({ value: 5 });
    const r = await request(app.app)
      .get('/v1/admin/config/alerts.red_sla_hours/history')
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.items[0].event_id).toMatch(/^aud-/);
  });
});
