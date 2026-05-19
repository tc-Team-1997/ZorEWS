// services/bff/__tests__/recovery_svc_archive.test.ts
//
// Recovery Center Phase 2a — cross-service archive endpoint.
// Tests POST /v1/svc/recovery/archive end-to-end through the BFF
// /v1/svc/* api-key auth surface. Same setup pattern as
// api_key_auth.test.ts so the two suites stay parallel.
//
// What's covered:
//   - happy path: valid key + scope → 201 with recovery_id + DeletedRecord
//   - tenant binding: the key's tenant wins (X-Tenant-ID is ignored)
//   - auth failures: missing / mangled / revoked key → 401
//   - scope enforcement: key without recovery:archive_internal → 403
//   - input validation: missing body, missing required fields, bad module
//   - 'bff' module rejected (in-process callers must bypass HTTP)
//   - enveloped request body accepted (`{header, body: {...}}`)
//   - audit fan-out fires with the cross-service actor_role marker
//   - cross-tenant: writes land in the key's tenant; admin GET from
//     the other tenant doesn't see them

import request from 'supertest';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';
import { InMemoryApiKeyStore, type ApiKeyScope } from '../src/api_keys';
import { InMemoryRecoveryStore } from '../src/recovery/store';
import { InMemoryAuditTrailStore } from '../src/audit_trail';
import { _resetRecoveryAdapters } from '../src/recovery/adapters';

const NOW = new Date('2026-05-19T12:00:00.000Z');

function makeSvcRecoveryApp(
  keys: Array<{ tenant: string; scopes: ApiKeyScope[]; name?: string }>,
) {
  _resetRecoveryAdapters();
  const apiKeyStore = new InMemoryApiKeyStore();
  const recoveryStore = new InMemoryRecoveryStore();
  const auditTrailStore = new InMemoryAuditTrailStore();
  const created = keys.map((k) =>
    apiKeyStore.create(k.tenant, { name: k.name ?? 'svc', scopes: k.scopes }, 'admin', NOW),
  );
  const app = makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    apiKeyStore,
    recoveryStore,
    auditTrailStore,
    now: () => NOW,
    getRole: () => 'admin',
  }).app;
  return { app, apiKeyStore, recoveryStore, auditTrailStore, keys: created };
}

function validBody(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    module: 'auth-svc',
    entity_type: 'user_team',
    original_id: 'team-123',
    original_table: 'app_iam.user_teams',
    payload: { team_id: 'team-123', name: 'Legal Mumbai', branch: 'mumbai' },
    deleted_by: 'svc:auth-svc',
    ...overrides,
  };
}

describe('POST /v1/svc/recovery/archive — happy path', () => {
  test('valid key with recovery:archive_internal → 201 with recovery_id + archived row', async () => {
    const { app, keys, recoveryStore } = makeSvcRecoveryApp([
      { tenant: 'BANK_DEMO', scopes: ['recovery:archive_internal'] },
    ]);
    const key = keys[0]!;
    const r = await request(app)
      .post('/v1/svc/recovery/archive')
      .set('Authorization', `Bearer ${key.key}`)
      .send(validBody());
    expect(r.status).toBe(201);
    expect(r.body.body.recovery_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(r.body.body.archived.tenant_id).toBe('BANK_DEMO');
    expect(r.body.body.archived.module).toBe('auth-svc');
    expect(r.body.body.archived.entity_type).toBe('user_team');
    expect(r.body.body.archived.original_id).toBe('team-123');
    expect(r.body.body.archived.payload).toEqual({
      team_id: 'team-123',
      name: 'Legal Mumbai',
      branch: 'mumbai',
    });
    expect(r.body.body.archived.status).toBe('archived');
    // Store-side cross-check
    const stats = await recoveryStore.stats('BANK_DEMO');
    expect(stats.total).toBe(1);
    expect(stats.by_status.archived).toBe(1);
  });

  test('optional fields (reason / source / prior_status) are persisted when supplied', async () => {
    const { app, keys } = makeSvcRecoveryApp([
      { tenant: 'BANK_DEMO', scopes: ['recovery:archive_internal'] },
    ]);
    const key = keys[0]!;
    const r = await request(app)
      .post('/v1/svc/recovery/archive')
      .set('Authorization', `Bearer ${key.key}`)
      .send(
        validBody({
          deletion_reason: 'team leader left',
          source_action: 'user_initiated',
          prior_status: 'active',
        }),
      );
    expect(r.status).toBe(201);
    expect(r.body.body.archived.deletion_reason).toBe('team leader left');
    expect(r.body.body.archived.source_action).toBe('user_initiated');
    expect(r.body.body.archived.prior_status).toBe('active');
  });

  test('enveloped request body { header, body: {...} } is unwrapped', async () => {
    const { app, keys } = makeSvcRecoveryApp([
      { tenant: 'BANK_DEMO', scopes: ['recovery:archive_internal'] },
    ]);
    const key = keys[0]!;
    const r = await request(app)
      .post('/v1/svc/recovery/archive')
      .set('Authorization', `Bearer ${key.key}`)
      .send({ header: { requestId: 'req-1' }, body: validBody() });
    expect(r.status).toBe(201);
    expect(r.body.body.archived.entity_type).toBe('user_team');
  });

  test('archive is visible via /v1/recovery list under the right tenant', async () => {
    const { app, keys } = makeSvcRecoveryApp([
      { tenant: 'BANK_DEMO', scopes: ['recovery:archive_internal'] },
    ]);
    const key = keys[0]!;
    const archiveRes = await request(app)
      .post('/v1/svc/recovery/archive')
      .set('Authorization', `Bearer ${key.key}`)
      .send(validBody());
    expect(archiveRes.status).toBe(201);
    const listRes = await request(app)
      .get('/v1/recovery')
      .set('X-Tenant-ID', 'BANK_DEMO')
      .set('X-Channel', 'API');
    expect(listRes.status).toBe(200);
    expect(listRes.body.body.total).toBe(1);
    expect(listRes.body.body.items[0].entity_type).toBe('user_team');
    expect(listRes.body.body.items[0].deleted_by).toBe('svc:auth-svc');
  });
});

describe('POST /v1/svc/recovery/archive — tenant safety', () => {
  test('tenant binds from the verified key; X-Tenant-ID override is ignored', async () => {
    const { app, keys, recoveryStore } = makeSvcRecoveryApp([
      { tenant: 'BIL', scopes: ['recovery:archive_internal'] },
    ]);
    const key = keys[0]!;
    // Attempt to write into BANK_DEMO via header override.
    const r = await request(app)
      .post('/v1/svc/recovery/archive')
      .set('Authorization', `Bearer ${key.key}`)
      .set('X-Tenant-ID', 'BANK_DEMO')
      .send(validBody());
    expect(r.status).toBe(201);
    expect(r.body.body.archived.tenant_id).toBe('BIL'); // key wins
    // BANK_DEMO sees nothing
    const bankStats = await recoveryStore.stats('BANK_DEMO');
    expect(bankStats.total).toBe(0);
    const bilStats = await recoveryStore.stats('BIL');
    expect(bilStats.total).toBe(1);
  });

  test('two keys in different tenants stay isolated end-to-end', async () => {
    const { app, keys } = makeSvcRecoveryApp([
      { tenant: 'BIL', scopes: ['recovery:archive_internal'], name: 'bil-svc' },
      { tenant: 'BANK_DEMO', scopes: ['recovery:archive_internal'], name: 'bank-svc' },
    ]);
    const bilKey = keys[0]!;
    const bankKey = keys[1]!;
    await request(app)
      .post('/v1/svc/recovery/archive')
      .set('Authorization', `Bearer ${bilKey.key}`)
      .send(validBody({ original_id: 'team-bil-1' }));
    await request(app)
      .post('/v1/svc/recovery/archive')
      .set('Authorization', `Bearer ${bankKey.key}`)
      .send(validBody({ original_id: 'team-bank-1' }));
    const bilList = await request(app)
      .get('/v1/recovery')
      .set('X-Tenant-ID', 'BIL')
      .set('X-Channel', 'API');
    const bankList = await request(app)
      .get('/v1/recovery')
      .set('X-Tenant-ID', 'BANK_DEMO')
      .set('X-Channel', 'API');
    expect(bilList.body.body.items.map((i: { original_id: string }) => i.original_id)).toEqual([
      'team-bil-1',
    ]);
    expect(bankList.body.body.items.map((i: { original_id: string }) => i.original_id)).toEqual([
      'team-bank-1',
    ]);
  });
});

describe('POST /v1/svc/recovery/archive — auth', () => {
  test('no Authorization header → 401 EWS_401_invalid_api_key', async () => {
    const { app } = makeSvcRecoveryApp([]);
    const r = await request(app).post('/v1/svc/recovery/archive').send(validBody());
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe('EWS_401_invalid_api_key');
  });

  test('mangled key → 401', async () => {
    const { app } = makeSvcRecoveryApp([]);
    const r = await request(app)
      .post('/v1/svc/recovery/archive')
      .set('Authorization', 'Bearer notakey')
      .send(validBody());
    expect(r.status).toBe(401);
  });

  test('revoked key → 401', async () => {
    const { app, apiKeyStore, keys } = makeSvcRecoveryApp([
      { tenant: 'BANK_DEMO', scopes: ['recovery:archive_internal'] },
    ]);
    const key = keys[0]!;
    apiKeyStore.revoke('BANK_DEMO', key.key_id, 'admin', NOW);
    const r = await request(app)
      .post('/v1/svc/recovery/archive')
      .set('Authorization', `Bearer ${key.key}`)
      .send(validBody());
    expect(r.status).toBe(401);
  });

  test('key without recovery:archive_internal scope → 403 EWS_403_missing_scope', async () => {
    const { app, keys } = makeSvcRecoveryApp([
      { tenant: 'BANK_DEMO', scopes: ['audit:read', 'reports:read'] },
    ]);
    const key = keys[0]!;
    const r = await request(app)
      .post('/v1/svc/recovery/archive')
      .set('Authorization', `Bearer ${key.key}`)
      .send(validBody());
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('EWS_403_missing_scope');
  });
});

describe('POST /v1/svc/recovery/archive — input validation', () => {
  function withKey() {
    return makeSvcRecoveryApp([
      { tenant: 'BANK_DEMO', scopes: ['recovery:archive_internal'] },
    ]);
  }

  // Note on absent / literal-null bodies: express.json() in strict mode
  // returns 400 with an HTML error page before our handler runs.
  // Empty-object bodies ({}) fall through our null-guard and surface
  // as invalid_module via the cascade — see the "empty object" test
  // below. The meaningful malformed-payload paths are array body +
  // payload-array (both reach our handler).

  test('empty object body → 400 invalid_module (cascade catches the first missing required)', async () => {
    const { app, keys } = withKey();
    const r = await request(app)
      .post('/v1/svc/recovery/archive')
      .set('Authorization', `Bearer ${keys[0]!.key}`)
      .send({});
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_module');
  });

  test('array body → 400 invalid_input', async () => {
    const { app, keys } = withKey();
    const r = await request(app)
      .post('/v1/svc/recovery/archive')
      .set('Authorization', `Bearer ${keys[0]!.key}`)
      .send([1, 2, 3] as unknown as object);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_input');
  });

  test("module='bff' is rejected — BFF-local code must call recoveryStore directly", async () => {
    const { app, keys } = withKey();
    const r = await request(app)
      .post('/v1/svc/recovery/archive')
      .set('Authorization', `Bearer ${keys[0]!.key}`)
      .send(validBody({ module: 'bff' }));
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_module');
  });

  test('unknown module → 400 invalid_module', async () => {
    const { app, keys } = withKey();
    const r = await request(app)
      .post('/v1/svc/recovery/archive')
      .set('Authorization', `Bearer ${keys[0]!.key}`)
      .send(validBody({ module: 'mystery-svc' }));
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_module');
  });

  test('missing entity_type → 400 invalid_input with field list', async () => {
    const { app, keys } = withKey();
    const r = await request(app)
      .post('/v1/svc/recovery/archive')
      .set('Authorization', `Bearer ${keys[0]!.key}`)
      .send(validBody({ entity_type: '' }));
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_input');
    expect(r.body.error.message).toContain('entity_type');
  });

  test('multiple missing fields are reported together', async () => {
    const { app, keys } = withKey();
    const r = await request(app)
      .post('/v1/svc/recovery/archive')
      .set('Authorization', `Bearer ${keys[0]!.key}`)
      .send(validBody({ original_id: '', original_table: '   ', deleted_by: '' }));
    expect(r.status).toBe(400);
    expect(r.body.error.message).toContain('original_id');
    expect(r.body.error.message).toContain('original_table');
    expect(r.body.error.message).toContain('deleted_by');
  });

  test('payload missing → 400 invalid_input', async () => {
    const { app, keys } = withKey();
    const r = await request(app)
      .post('/v1/svc/recovery/archive')
      .set('Authorization', `Bearer ${keys[0]!.key}`)
      .send(validBody({ payload: undefined }));
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_input');
    expect(r.body.error.message).toContain('payload');
  });

  test('payload is array → 400 (must be a row-shaped object)', async () => {
    const { app, keys } = withKey();
    const r = await request(app)
      .post('/v1/svc/recovery/archive')
      .set('Authorization', `Bearer ${keys[0]!.key}`)
      .send(validBody({ payload: ['not', 'an', 'object'] }));
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_input');
  });
});

describe('POST /v1/svc/recovery/archive — audit fan-out', () => {
  test('every successful archive writes one audit event with service:<module> actor_role', async () => {
    const { app, keys, auditTrailStore } = makeSvcRecoveryApp([
      { tenant: 'BANK_DEMO', scopes: ['recovery:archive_internal'] },
    ]);
    const key = keys[0]!;
    const r = await request(app)
      .post('/v1/svc/recovery/archive')
      .set('Authorization', `Bearer ${key.key}`)
      .send(validBody());
    expect(r.status).toBe(201);
    const { items } = auditTrailStore.list('BANK_DEMO', {});
    const events = items.filter((e) => e.action === 'recovery.archive');
    expect(events.length).toBe(1);
    expect(events[0]!.actor_username).toBe('svc:auth-svc');
    expect(events[0]!.actor_role).toBe('service:auth-svc');
    expect(events[0]!.resource_type).toBe('system');
    expect(events[0]!.resource_id).toBe(r.body.body.recovery_id);
    expect(events[0]!.outcome).toBe('success');
    expect((events[0]!.metadata as { entity_type: string }).entity_type).toBe('user_team');
  });
});
