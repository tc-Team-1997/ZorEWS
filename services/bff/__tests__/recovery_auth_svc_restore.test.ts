// services/bff/__tests__/recovery_auth_svc_restore.test.ts
//
// Recovery Center Phase 2d — BFF-side cross-service restore.
//
// Two layers tested here:
//   1. AuthSvcRestoreClient unit tests with a stub fetch — wire shape,
//      retry posture (no retries — restore is operator-initiated),
//      response→typed-error mapping.
//   2. End-to-end via /v1/recovery/:id/restore: archive an auth-svc
//      row through the Phase 2a /v1/svc/recovery/archive endpoint,
//      then click Restore and verify the BFF adapter HTTP-calls the
//      stub auth-svc, the recovery row is marked restored, and the
//      audit trail records `recovery.restore`.

import request from 'supertest';
import {
  AuthSvcRestoreClient,
  type AuthSvcRestoreRequest,
} from '../src/recovery/auth_svc_restore_client';
import { RecoveryError, RestoreConflictError } from '../src/recovery/types';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';
import { InMemoryApiKeyStore } from '../src/api_keys';
import { InMemoryRecoveryStore } from '../src/recovery/store';
import { InMemoryAuditTrailStore } from '../src/audit_trail';
import { _resetRecoveryAdapters } from '../src/recovery/adapters';

const NOW = new Date('2026-05-20T12:00:00.000Z');

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function validReq(): AuthSvcRestoreRequest {
  return {
    entity_type: 'user_team',
    original_id: 'team_abc12345',
    payload: {
      team_id: 'team_abc12345',
      name: 'Recovered Team',
      branch: 'mumbai',
      role: 'legal',
      team_leader: 'u-001',
      members: ['u-001', 'u-002'],
      created_at: '2026-05-19T10:00:00.000Z',
    },
  };
}

// ─── Constructor ──────────────────────────────────────────────────────

describe('AuthSvcRestoreClient constructor', () => {
  test('throws when baseUrl missing', () => {
    expect(() => new AuthSvcRestoreClient({ baseUrl: '', restoreKey: 'k' })).toThrow(
      /baseUrl/,
    );
  });
  test('throws when restoreKey missing', () => {
    expect(() => new AuthSvcRestoreClient({ baseUrl: 'https://x', restoreKey: '' })).toThrow(
      /restoreKey/,
    );
  });
  test('strips trailing slash from baseUrl', async () => {
    const captured: string[] = [];
    const client = new AuthSvcRestoreClient({
      baseUrl: 'https://auth.example.com/',
      restoreKey: 'k',
      fetchImpl: async (url) => {
        captured.push(String(url));
        return jsonResponse(201, { entity_type: 'user_team', original_id: 'x', restored: true });
      },
    });
    await client.restore(validReq());
    expect(captured[0]).toBe('https://auth.example.com/auth/recovery/restore');
  });
});

// ─── Wire shape ───────────────────────────────────────────────────────

describe('AuthSvcRestoreClient wire shape', () => {
  test('POST with X-Recovery-Restore-Key + Content-Type + body', async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    const client = new AuthSvcRestoreClient({
      baseUrl: 'https://auth.test',
      restoreKey: 'shared-secret-value',
      fetchImpl: async (url, init) => {
        captured = { url: String(url), init: init as RequestInit };
        return jsonResponse(201, { entity_type: 'user_team', original_id: 'x', restored: true });
      },
    });
    await client.restore(validReq());
    expect(captured!.init.method).toBe('POST');
    const headers = captured!.init.headers as Record<string, string>;
    expect(headers['X-Recovery-Restore-Key']).toBe('shared-secret-value');
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['X-Source-System']).toBe('bff-recovery-restore');
    const body = JSON.parse((captured!.init.body as string) ?? '{}');
    expect(body.entity_type).toBe('user_team');
    expect(body.original_id).toBe('team_abc12345');
    expect(body.payload.team_id).toBe('team_abc12345');
  });

  test('201 + 200 both treated as success (returns void)', async () => {
    for (const status of [200, 201]) {
      const client = new AuthSvcRestoreClient({
        baseUrl: 'https://auth.test',
        restoreKey: 'k',
        fetchImpl: async () => jsonResponse(status, { restored: true }),
      });
      await expect(client.restore(validReq())).resolves.toBeUndefined();
    }
  });
});

// ─── Response mapping ─────────────────────────────────────────────────

describe('AuthSvcRestoreClient response mapping', () => {
  function mkClient(fetchImpl: typeof fetch) {
    return new AuthSvcRestoreClient({
      baseUrl: 'https://auth.test',
      restoreKey: 'k',
      fetchImpl,
    });
  }

  test('401 → RecoveryError(invalid_input) with auth_svc_unauthorized detail', async () => {
    const c = mkClient(async () => jsonResponse(401, { error: 'invalid_restore_key' }));
    const err = await c.restore(validReq()).catch((e) => e);
    expect(err).toBeInstanceOf(RecoveryError);
    expect(err.code).toBe('invalid_input');
    expect(err.detail?.adapter_code).toBe('auth_svc_unauthorized');
  });

  test('503 → RecoveryError(invalid_input) with auth_svc_disabled detail', async () => {
    const c = mkClient(async () => jsonResponse(503, { error: 'restore_disabled' }));
    const err = await c.restore(validReq()).catch((e) => e);
    expect(err.detail?.adapter_code).toBe('auth_svc_disabled');
  });

  test('409 → RestoreConflictError', async () => {
    const c = mkClient(async () => jsonResponse(409, { error: 'team_exists' }));
    const err = await c.restore(validReq()).catch((e) => e);
    expect(err).toBeInstanceOf(RestoreConflictError);
    expect(err.code).toBe('restore_conflict');
    expect(err.detail?.entity_type).toBe('user_team');
  });

  test('404 (member restore + missing parent team) → RecoveryError(restore_conflict) with parent_team_id', async () => {
    const c = mkClient(async () =>
      jsonResponse(404, { error: 'team_not_found', team_id: 'team_gone' }),
    );
    const err = await c
      .restore({
        entity_type: 'user_team_member',
        original_id: 'team_gone:u-002',
        payload: { team_id: 'team_gone', user_id: 'u-002' },
      })
      .catch((e) => e);
    expect(err).toBeInstanceOf(RecoveryError);
    expect(err.code).toBe('restore_conflict');
    expect(err.detail?.parent_team_id).toBe('team_gone');
    expect(err.detail?.adapter_code).toBe('auth_svc_parent_missing');
  });

  test('400 unknown_entity_type → RecoveryError(no_adapter)', async () => {
    const c = mkClient(async () =>
      jsonResponse(400, { error: 'unknown_entity_type', message: 'auth-svc cannot restore mystery' }),
    );
    const err = await c
      .restore({ entity_type: 'user_team', original_id: 'x', payload: {} })
      .catch((e) => e);
    expect(err.code).toBe('no_adapter');
  });

  test('400 invalid_payload → RecoveryError(invalid_input) with auth_svc_bad_payload detail', async () => {
    const c = mkClient(async () =>
      jsonResponse(400, { error: 'invalid_payload', message: 'team payload missing required fields' }),
    );
    const err = await c.restore(validReq()).catch((e) => e);
    expect(err.code).toBe('invalid_input');
    expect(err.detail?.adapter_code).toBe('auth_svc_bad_payload');
  });

  test('5xx → RecoveryError with auth_svc_server_error', async () => {
    const c = mkClient(async () => jsonResponse(500, { error: 'internal_error' }));
    const err = await c.restore(validReq()).catch((e) => e);
    expect(err.detail?.adapter_code).toBe('auth_svc_server_error');
    expect(err.detail?.status).toBe(500);
  });

  test('network error → RecoveryError with auth_svc_unreachable', async () => {
    const c = mkClient(async () => {
      throw new Error('connect ECONNREFUSED');
    });
    const err = await c.restore(validReq()).catch((e) => e);
    expect(err.detail?.adapter_code).toBe('auth_svc_unreachable');
  });

  test('non-JSON 5xx body still produces server_error', async () => {
    const c = mkClient(
      async () =>
        new Response('<html>oops</html>', {
          status: 502,
          headers: { 'content-type': 'text/html' },
        }),
    );
    const err = await c.restore(validReq()).catch((e) => e);
    expect(err.detail?.adapter_code).toBe('auth_svc_server_error');
  });
});

// ─── End-to-end via /v1/recovery/:id/restore ──────────────────────────
//
// Archive a user_team row through the Phase 2a endpoint, then exercise
// the restore round-trip — BFF route → registered adapter → stub
// auth-svc → success. The stub auth-svc just records what was POSTed
// and returns 201.

describe('Phase 2d end-to-end: archive → restore for user_team', () => {
  function setup() {
    _resetRecoveryAdapters();
    const apiKeyStore = new InMemoryApiKeyStore();
    const recoveryStore = new InMemoryRecoveryStore();
    const auditTrailStore = new InMemoryAuditTrailStore();
    const created = apiKeyStore.create(
      'BANK_DEMO',
      { name: 'auth-svc', scopes: ['recovery:archive_internal'] },
      'admin',
      NOW,
    );
    const stubFetches: Array<{ url: string; body: Record<string, unknown> }> = [];
    const stubFetch: typeof fetch = async (url, init) => {
      const body = JSON.parse(((init as RequestInit).body as string) ?? '{}');
      stubFetches.push({ url: String(url), body });
      return new Response(
        JSON.stringify({ entity_type: body.entity_type, original_id: body.original_id, restored: true }),
        { status: 201, headers: { 'content-type': 'application/json' } },
      );
    };
    const authSvcRestoreClient = new AuthSvcRestoreClient({
      baseUrl: 'http://auth-svc.test',
      restoreKey: 'shared-secret',
      fetchImpl: stubFetch,
    });
    const { app } = makeApp({
      source: new StaticSource([]),
      evaluator: new StubEvaluator(),
      riskProfile: new StubRiskProfileSource(),
      caseAction: new UnavailableCaseActionSink(),
      apiKeyStore,
      recoveryStore,
      auditTrailStore,
      authSvcRestoreClient,
      now: () => NOW,
      getRole: () => 'admin',
    });
    return { app, recoveryStore, auditTrailStore, apiKey: created.key, stubFetches };
  }

  test('admin clicks Restore → BFF adapter calls auth-svc → recovery row marked restored', async () => {
    const { app, recoveryStore, auditTrailStore, apiKey, stubFetches } = setup();
    // 1. auth-svc archives a deleted team via Phase 2a.
    const archive = await request(app)
      .post('/v1/svc/recovery/archive')
      .set('Authorization', `Bearer ${apiKey}`)
      .send({
        module: 'auth-svc',
        entity_type: 'user_team',
        original_id: 'team_e2e1',
        original_table: 'app_iam.user_teams',
        payload: {
          team_id: 'team_e2e1',
          name: 'E2E Team',
          branch: 'mumbai',
          role: 'legal',
          team_leader: 'u-001',
          email: null,
          description: null,
          created_at: '2026-05-19T10:00:00.000Z',
          members: ['u-001', 'u-002'],
        },
        deleted_by: 'alice.admin',
      });
    expect(archive.status).toBe(201);
    const recovery_id = archive.body.body.recovery_id;

    // 2. Admin (via SPA) clicks Restore — human auth path.
    const restore = await request(app)
      .post(`/v1/recovery/${recovery_id}/restore`)
      .set('X-Tenant-ID', 'BANK_DEMO')
      .set('X-Channel', 'API')
      .set('x-apex-user', 'alice.admin');
    expect(restore.status).toBe(200);
    expect(restore.body.body.status).toBe('restored');

    // 3. The BFF adapter forwarded the call to the stub auth-svc.
    expect(stubFetches.length).toBe(1);
    expect(stubFetches[0]!.url).toBe('http://auth-svc.test/auth/recovery/restore');
    expect(stubFetches[0]!.body.entity_type).toBe('user_team');
    expect(stubFetches[0]!.body.original_id).toBe('team_e2e1');
    const fwdPayload = stubFetches[0]!.body.payload as { team_id: string; members: string[] };
    expect(fwdPayload.team_id).toBe('team_e2e1');
    expect(fwdPayload.members.sort()).toEqual(['u-001', 'u-002']);

    // 4. Recovery row is now in 'restored' status.
    const rec = await recoveryStore.get('BANK_DEMO', recovery_id);
    expect(rec!.status).toBe('restored');
    expect(rec!.restored_by).toBe('alice.admin');

    // 5. Audit trail recorded the restore (M15.1 fan-out).
    const events = auditTrailStore.list('BANK_DEMO', {}).items;
    const restoreEvent = events.find((e) => e.action === 'recovery.restore');
    expect(restoreEvent).toBeDefined();
    expect(restoreEvent!.resource_id).toBe(recovery_id);
  });

  test('auth-svc returns 409 → BFF surfaces 409 restore_conflict + recovery row stays archived', async () => {
    _resetRecoveryAdapters();
    const apiKeyStore = new InMemoryApiKeyStore();
    const recoveryStore = new InMemoryRecoveryStore();
    const created = apiKeyStore.create(
      'BANK_DEMO',
      { name: 'auth-svc', scopes: ['recovery:archive_internal'] },
      'admin',
      NOW,
    );
    const authSvcRestoreClient = new AuthSvcRestoreClient({
      baseUrl: 'http://auth-svc.test',
      restoreKey: 'k',
      fetchImpl: async () => jsonResponse(409, { error: 'team_exists' }),
    });
    const { app } = makeApp({
      source: new StaticSource([]),
      evaluator: new StubEvaluator(),
      riskProfile: new StubRiskProfileSource(),
      caseAction: new UnavailableCaseActionSink(),
      apiKeyStore,
      recoveryStore,
      authSvcRestoreClient,
      now: () => NOW,
      getRole: () => 'admin',
    });
    // Archive
    const archive = await request(app)
      .post('/v1/svc/recovery/archive')
      .set('Authorization', `Bearer ${created.key}`)
      .send({
        module: 'auth-svc',
        entity_type: 'user_team',
        original_id: 'team_dup',
        original_table: 'app_iam.user_teams',
        payload: {
          team_id: 'team_dup',
          name: 'Dup',
          branch: 'x',
          role: 'y',
          team_leader: 'u-001',
          created_at: '2026-05-19T10:00:00.000Z',
          members: ['u-001'],
        },
        deleted_by: 'alice.admin',
      });
    const recovery_id = archive.body.body.recovery_id;

    const restore = await request(app)
      .post(`/v1/recovery/${recovery_id}/restore`)
      .set('X-Tenant-ID', 'BANK_DEMO')
      .set('X-Channel', 'API')
      .set('x-apex-user', 'alice.admin');
    expect(restore.status).toBe(409);
    expect(restore.body.error.code).toMatch(/restore_conflict|409/);

    // Recovery row stays archived — operator can retry after resolving the conflict.
    const rec = await recoveryStore.get('BANK_DEMO', recovery_id);
    expect(rec!.status).toBe('archived');
  });
});

describe('Phase 2d end-to-end: user_team_member with missing parent team', () => {
  test('restoring a member whose team is gone → 409 restore_conflict, recovery stays archived', async () => {
    _resetRecoveryAdapters();
    const apiKeyStore = new InMemoryApiKeyStore();
    const recoveryStore = new InMemoryRecoveryStore();
    const apiKey = apiKeyStore.create(
      'BANK_DEMO',
      { name: 'auth-svc', scopes: ['recovery:archive_internal'] },
      'admin',
      NOW,
    ).key;
    const authSvcRestoreClient = new AuthSvcRestoreClient({
      baseUrl: 'http://auth-svc.test',
      restoreKey: 'k',
      fetchImpl: async () =>
        jsonResponse(404, { error: 'team_not_found', team_id: 'team_gone' }),
    });
    const { app } = makeApp({
      source: new StaticSource([]),
      evaluator: new StubEvaluator(),
      riskProfile: new StubRiskProfileSource(),
      caseAction: new UnavailableCaseActionSink(),
      apiKeyStore,
      recoveryStore,
      authSvcRestoreClient,
      now: () => NOW,
      getRole: () => 'admin',
    });
    const archive = await request(app)
      .post('/v1/svc/recovery/archive')
      .set('Authorization', `Bearer ${apiKey}`)
      .send({
        module: 'auth-svc',
        entity_type: 'user_team_member',
        original_id: 'team_gone:u-002',
        original_table: 'app_iam.user_team_members',
        payload: { team_id: 'team_gone', user_id: 'u-002' },
        deleted_by: 'alice.admin',
      });
    const recovery_id = archive.body.body.recovery_id;

    const restore = await request(app)
      .post(`/v1/recovery/${recovery_id}/restore`)
      .set('X-Tenant-ID', 'BANK_DEMO')
      .set('X-Channel', 'API')
      .set('x-apex-user', 'alice.admin');
    // The client maps auth-svc's 404 to RecoveryError(restore_conflict)
    // → BFF route returns 409. SPA shows "team is gone — restore the
    // team first".
    expect(restore.status).toBe(409);
    const rec = await recoveryStore.get('BANK_DEMO', recovery_id);
    expect(rec!.status).toBe('archived'); // stays archived, retry-able
  });
});

describe('Phase 2d wiring: no auth-svc client → no adapters', () => {
  test('when no authSvcRestoreClient is configured, restoring user_team returns 501 no_adapter', async () => {
    _resetRecoveryAdapters();
    // Make sure no env vars leak in from a parent process.
    delete process.env.AUTH_SVC_BASE_URL;
    delete process.env.AUTH_SVC_RECOVERY_RESTORE_KEY;
    const apiKeyStore = new InMemoryApiKeyStore();
    const recoveryStore = new InMemoryRecoveryStore();
    const apiKey = apiKeyStore.create(
      'BANK_DEMO',
      { name: 'auth-svc', scopes: ['recovery:archive_internal'] },
      'admin',
      NOW,
    ).key;
    const { app } = makeApp({
      source: new StaticSource([]),
      evaluator: new StubEvaluator(),
      riskProfile: new StubRiskProfileSource(),
      caseAction: new UnavailableCaseActionSink(),
      apiKeyStore,
      recoveryStore,
      // authSvcRestoreClient deliberately omitted
      now: () => NOW,
      getRole: () => 'admin',
    });
    const archive = await request(app)
      .post('/v1/svc/recovery/archive')
      .set('Authorization', `Bearer ${apiKey}`)
      .send({
        module: 'auth-svc',
        entity_type: 'user_team',
        original_id: 'team_no_adapter',
        original_table: 'app_iam.user_teams',
        payload: {
          team_id: 'team_no_adapter',
          name: 'X',
          branch: 'x',
          role: 'y',
          team_leader: 'u-001',
          created_at: '2026-05-19T10:00:00.000Z',
          members: ['u-001'],
        },
        deleted_by: 'alice.admin',
      });
    const recovery_id = archive.body.body.recovery_id;
    const restore = await request(app)
      .post(`/v1/recovery/${recovery_id}/restore`)
      .set('X-Tenant-ID', 'BANK_DEMO')
      .set('X-Channel', 'API')
      .set('x-apex-user', 'alice.admin');
    expect(restore.status).toBe(501);
  });
});
