// Recovery Center Phase 2f — auth-svc/service_clients adoption.
//
// Tests the archive-before-delete + restore-as-inactive flow for
// OAuth service clients. The CONSERVATIVE security semantic is the
// reason this adopter sits behind the simpler ones in the rollout
// order: restored clients must come back as active=false regardless
// of the archived state, so the preserved secret hash cannot
// re-authenticate. Operators who want re-activation mint a new
// credential via the existing POST /auth/service-clients endpoint.

import test from "node:test";
import assert from "node:assert/strict";
import { buildServer } from "../server.js";
import {
  __resetAuthStateForTests,
  __setRecoveryArchiverForTests,
} from "../routes/auth.js";
import {
  __resetServiceClientStoreForTests,
} from "../service_clients.js";
import type {
  ArchiveRequest,
  ArchiveResponse,
  RecoveryArchiver,
} from "../recovery_archive_client.js";
import { RecoveryArchiveError } from "../recovery_archive_client.js";

const RESTORE_KEY = "test-restore-key-phase-2f";

class RecordingArchiver implements RecoveryArchiver {
  calls: ArchiveRequest[] = [];
  failNextWith: RecoveryArchiveError | null = null;
  async archive(req: ArchiveRequest): Promise<ArchiveResponse> {
    if (this.failNextWith) {
      const err = this.failNextWith;
      this.failNextWith = null;
      throw err;
    }
    this.calls.push(req);
    return {
      recovery_id: `rec-sc-${this.calls.length}`,
      archived: {
        recovery_id: `rec-sc-${this.calls.length}`,
        tenant_id: "BANK_DEMO",
        module: req.module,
        entity_type: req.entity_type,
        original_id: req.original_id,
        original_table: req.original_table,
        payload: req.payload,
        deleted_by: req.deleted_by,
        deleted_at: new Date().toISOString(),
        deletion_reason: req.deletion_reason ?? null,
        source_action: req.source_action ?? null,
        prior_status: req.prior_status ?? null,
        restored_at: null,
        restored_by: null,
        purged_at: null,
        purged_by: null,
        status: "archived",
      },
    };
  }
}

async function loginAdmin(app: ReturnType<typeof buildServer>): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/auth/login",
    payload: { username: "alice.admin", password: "Admin!Pass1" },
  });
  assert.equal(res.statusCode, 200);
  return (res.json() as { access_token: string }).access_token;
}

async function setup() {
  __resetAuthStateForTests();
  __resetServiceClientStoreForTests();
  const archiver = new RecordingArchiver();
  __setRecoveryArchiverForTests(archiver);
  process.env.AUTH_SVC_RECOVERY_RESTORE_KEY = RESTORE_KEY;
  const app = buildServer();
  const token = await loginAdmin(app);
  return { app, archiver, token };
}

test.afterEach(() => {
  __setRecoveryArchiverForTests(null);
  __resetAuthStateForTests();
  __resetServiceClientStoreForTests();
  delete process.env.AUTH_SVC_RECOVERY_RESTORE_KEY;
});

// Helper: create a fresh client so each test has something to delete.
async function createClient(
  app: ReturnType<typeof buildServer>,
  token: string,
  client_id = `client-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
) {
  const res = await app.inject({
    method: "POST",
    url: "/auth/service-clients",
    headers: { authorization: `Bearer ${token}` },
    payload: {
      tenant_id: "BANK_DEMO",
      client_id,
      display_name: `Phase 2f test ${client_id}`,
    },
  });
  assert.equal(res.statusCode, 201, `create failed: ${res.body}`);
  return res.json() as {
    tenant_id: string;
    client_id: string;
    display_name: string;
    scopes: string[];
    active: boolean;
    client_secret: string;
  };
}

// ─── Archive-before-delete ──────────────────────────────────────────

test("DELETE /auth/service-clients/:tenant/:client archives the row BEFORE deleting", async () => {
  const { app, archiver, token } = await setup();
  const created = await createClient(app, token, "phase2f-archive-happy");
  const del = await app.inject({
    method: "DELETE",
    url: `/auth/service-clients/BANK_DEMO/${created.client_id}`,
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(del.statusCode, 204);
  assert.equal(archiver.calls.length, 1);
  const arch = archiver.calls[0]!;
  assert.equal(arch.module, "auth-svc");
  assert.equal(arch.entity_type, "service_client");
  assert.equal(arch.original_id, `BANK_DEMO:${created.client_id}`);
  assert.equal(arch.original_table, "app_iam.service_clients");
  assert.equal(arch.deleted_by, "alice.admin");
  assert.equal(arch.source_action, "user_initiated");
  // Active client → prior_status records "active".
  assert.equal(arch.prior_status, "active");
  // Payload includes the secret hash (audit-historic; the Recovery
  // table sits in the same admin-only trust boundary as
  // app_iam.service_clients).
  const payload = arch.payload as {
    tenant_id: string;
    client_id: string;
    client_secret_hash: string;
    active: boolean;
  };
  assert.equal(payload.tenant_id, "BANK_DEMO");
  assert.equal(payload.client_id, created.client_id);
  assert.equal(typeof payload.client_secret_hash, "string");
  assert.ok(payload.client_secret_hash.length > 0);
  assert.equal(payload.active, true);
});

test("DELETE /auth/service-clients/:tenant/:client — unknown client is 404 + does NOT archive", async () => {
  const { app, archiver, token } = await setup();
  const del = await app.inject({
    method: "DELETE",
    url: "/auth/service-clients/BANK_DEMO/does-not-exist",
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(del.statusCode, 404);
  assert.equal(archiver.calls.length, 0);
});

test("DELETE /auth/service-clients — cross-tenant attempt is 404 + does NOT archive", async () => {
  const { app, archiver, token } = await setup();
  const created = await createClient(app, token, "phase2f-xtenant");
  // Try to delete from a different tenant.
  const del = await app.inject({
    method: "DELETE",
    url: `/auth/service-clients/BIL/${created.client_id}`,
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(del.statusCode, 404);
  assert.equal(archiver.calls.length, 0);
});

test("DELETE /auth/service-clients — archive failure does NOT block the delete", async () => {
  const { app, archiver, token } = await setup();
  const created = await createClient(app, token, "phase2f-archive-fail");
  archiver.failNextWith = new RecoveryArchiveError(
    "network_error",
    "connect ECONNREFUSED",
  );
  const del = await app.inject({
    method: "DELETE",
    url: `/auth/service-clients/BANK_DEMO/${created.client_id}`,
    headers: { authorization: `Bearer ${token}` },
  });
  // Best-effort posture: 204 even when archive failed.
  assert.equal(del.statusCode, 204);
  // Client is gone locally.
  const list = await app.inject({
    method: "GET",
    url: "/auth/service-clients?tenant_id=BANK_DEMO",
    headers: { authorization: `Bearer ${token}` },
  });
  const ids = (list.json() as { items: Array<{ client_id: string }> }).items.map(
    (c) => c.client_id,
  );
  assert.ok(!ids.includes(created.client_id), "client should be deleted");
});

test("DELETE /auth/service-clients — 401 without token + does NOT archive", async () => {
  __resetAuthStateForTests();
  __resetServiceClientStoreForTests();
  const archiver = new RecordingArchiver();
  __setRecoveryArchiverForTests(archiver);
  const app = buildServer();
  const del = await app.inject({
    method: "DELETE",
    url: "/auth/service-clients/BANK_DEMO/anything",
  });
  assert.equal(del.statusCode, 401);
  assert.equal(archiver.calls.length, 0);
});

// ─── Restore via POST /auth/recovery/restore ────────────────────────

test("POST /auth/recovery/restore service_client — happy path: 201 + active_after_restore=false", async () => {
  const { app, archiver, token } = await setup();
  // 1. Create + delete → archive captures the snapshot.
  const created = await createClient(app, token, "phase2f-restore-happy");
  await app.inject({
    method: "DELETE",
    url: `/auth/service-clients/BANK_DEMO/${created.client_id}`,
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(archiver.calls.length, 1);
  const archived = archiver.calls[0]!.payload as Record<string, unknown>;

  // 2. Restore.
  const restore = await app.inject({
    method: "POST",
    url: "/auth/recovery/restore",
    headers: { "x-recovery-restore-key": RESTORE_KEY },
    payload: {
      entity_type: "service_client",
      original_id: `BANK_DEMO:${created.client_id}`,
      payload: archived,
    },
  });
  assert.equal(restore.statusCode, 201);
  const body = restore.json() as { active_after_restore: boolean; restored: boolean };
  assert.equal(body.restored, true);
  // CONSERVATIVE SEMANTIC — restored row comes back as inactive even
  // though the archive shows active=true.
  assert.equal(body.active_after_restore, false);

  // 3. Verify via /oauth/token — restored client should NOT authenticate
  //    because active=false short-circuits find() to undefined.
  const tokenAttempt = await app.inject({
    method: "POST",
    url: "/oauth/token",
    payload: {
      grant_type: "client_credentials",
      client_id: created.client_id,
      client_secret: created.client_secret,
      tenant_id: "BANK_DEMO",
    },
  });
  assert.equal(
    tokenAttempt.statusCode,
    401,
    "restored client must NOT authenticate with the preserved secret",
  );
});

test("POST /auth/recovery/restore service_client — 400 when payload missing required fields", async () => {
  const { app } = await setup();
  const res = await app.inject({
    method: "POST",
    url: "/auth/recovery/restore",
    headers: { "x-recovery-restore-key": RESTORE_KEY },
    payload: {
      entity_type: "service_client",
      original_id: "BANK_DEMO:foo",
      // Missing client_secret_hash + display_name.
      payload: { tenant_id: "BANK_DEMO", client_id: "foo", scopes: [] },
    },
  });
  assert.equal(res.statusCode, 400);
});

test("POST /auth/recovery/restore service_client — 400 when original_id doesn't match composite", async () => {
  const { app } = await setup();
  const res = await app.inject({
    method: "POST",
    url: "/auth/recovery/restore",
    headers: { "x-recovery-restore-key": RESTORE_KEY },
    payload: {
      entity_type: "service_client",
      original_id: "BANK_DEMO:foo",
      payload: {
        tenant_id: "BANK_DEMO",
        client_id: "different",
        display_name: "X",
        scopes: [],
        client_secret_hash: "$argon2id$foo",
      },
    },
  });
  assert.equal(res.statusCode, 400);
});

test("POST /auth/recovery/restore service_client — 409 when client_id already exists", async () => {
  const { app, archiver, token } = await setup();
  const created = await createClient(app, token, "phase2f-409-test");
  // Delete + restore once.
  await app.inject({
    method: "DELETE",
    url: `/auth/service-clients/BANK_DEMO/${created.client_id}`,
    headers: { authorization: `Bearer ${token}` },
  });
  const archived = archiver.calls[0]!.payload;
  const first = await app.inject({
    method: "POST",
    url: "/auth/recovery/restore",
    headers: { "x-recovery-restore-key": RESTORE_KEY },
    payload: {
      entity_type: "service_client",
      original_id: `BANK_DEMO:${created.client_id}`,
      payload: archived,
    },
  });
  assert.equal(first.statusCode, 201);
  // Second restore must refuse.
  const second = await app.inject({
    method: "POST",
    url: "/auth/recovery/restore",
    headers: { "x-recovery-restore-key": RESTORE_KEY },
    payload: {
      entity_type: "service_client",
      original_id: `BANK_DEMO:${created.client_id}`,
      payload: archived,
    },
  });
  assert.equal(second.statusCode, 409);
  assert.equal((second.json() as { error: string }).error, "client_exists");
});

test("POST /auth/recovery/restore service_client — restored row is visible in admin list as inactive", async () => {
  const { app, archiver, token } = await setup();
  const created = await createClient(app, token, "phase2f-list-test");
  await app.inject({
    method: "DELETE",
    url: `/auth/service-clients/BANK_DEMO/${created.client_id}`,
    headers: { authorization: `Bearer ${token}` },
  });
  await app.inject({
    method: "POST",
    url: "/auth/recovery/restore",
    headers: { "x-recovery-restore-key": RESTORE_KEY },
    payload: {
      entity_type: "service_client",
      original_id: `BANK_DEMO:${created.client_id}`,
      payload: archiver.calls[0]!.payload,
    },
  });
  // Admin list shows the restored row with active=false. This is
  // useful UX: operator sees the row exists (so they don't try to
  // re-create with the same id), but knows it's not authenticating.
  const list = await app.inject({
    method: "GET",
    url: "/auth/service-clients?tenant_id=BANK_DEMO",
    headers: { authorization: `Bearer ${token}` },
  });
  const rows = (list.json() as { items: Array<{ client_id: string; active: boolean }> }).items;
  const restored = rows.find((r) => r.client_id === created.client_id);
  assert.ok(restored, `expected restored client in list; got ${JSON.stringify(rows)}`);
  assert.equal(restored!.active, false);
});

// ─── Round-trip: full create → delete → restore → re-create ─────────

test("Round-trip: create → delete (archive) → restore (inactive) → re-create with new secret works", async () => {
  const { app, archiver, token } = await setup();
  const id = "phase2f-roundtrip";
  // 1. Create + capture original secret.
  const original = await createClient(app, token, id);
  // 2. Delete → archive.
  await app.inject({
    method: "DELETE",
    url: `/auth/service-clients/BANK_DEMO/${id}`,
    headers: { authorization: `Bearer ${token}` },
  });
  // 3. Restore — comes back inactive, original secret won't auth.
  await app.inject({
    method: "POST",
    url: "/auth/recovery/restore",
    headers: { "x-recovery-restore-key": RESTORE_KEY },
    payload: {
      entity_type: "service_client",
      original_id: `BANK_DEMO:${id}`,
      payload: archiver.calls[0]!.payload,
    },
  });
  const failedAuth = await app.inject({
    method: "POST",
    url: "/oauth/token",
    payload: {
      grant_type: "client_credentials",
      client_id: id,
      client_secret: original.client_secret,
      tenant_id: "BANK_DEMO",
    },
  });
  assert.equal(failedAuth.statusCode, 401);
  // 4. To re-activate, operator deletes the inactive row + re-creates
  //    with the same id. The new credential authenticates.
  await app.inject({
    method: "DELETE",
    url: `/auth/service-clients/BANK_DEMO/${id}`,
    headers: { authorization: `Bearer ${token}` },
  });
  const replacement = await createClient(app, token, id);
  const reAuth = await app.inject({
    method: "POST",
    url: "/oauth/token",
    payload: {
      grant_type: "client_credentials",
      client_id: id,
      client_secret: replacement.client_secret,
      tenant_id: "BANK_DEMO",
    },
  });
  assert.equal(reAuth.statusCode, 200);
  // Sanity: the OLD secret still doesn't authenticate (replacement
  // minted a fresh hash).
  const stillBad = await app.inject({
    method: "POST",
    url: "/oauth/token",
    payload: {
      grant_type: "client_credentials",
      client_id: id,
      client_secret: original.client_secret,
      tenant_id: "BANK_DEMO",
    },
  });
  assert.equal(stillBad.statusCode, 401);
});
