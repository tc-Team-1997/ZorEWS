// Recovery Center Phase 2c — auth-svc/teams cross-service adoption.
//
// Tests that DELETE /auth/teams/:id and DELETE /auth/teams/:id/members/:user_id
// archive into the central Recovery Center BEFORE doing the local
// store delete. The archiver is stubbed (no real HTTP) — we only
// assert the wire shape passed to .archive(), not the BFF round-trip.
// The BFF endpoint itself is covered by recovery_svc_archive.test.ts
// over in services/bff/.

import test from "node:test";
import assert from "node:assert/strict";
import { buildServer } from "../server.js";
import {
  __resetAuthStateForTests,
  __setRecoveryArchiverForTests,
} from "../routes/auth.js";
import type {
  ArchiveRequest,
  ArchiveResponse,
  RecoveryArchiver,
} from "../recovery_archive_client.js";
import { RecoveryArchiveError } from "../recovery_archive_client.js";

// Login as alice.admin — the demo seed admin. Same pattern as auth.test.ts.
async function loginAdmin(app: ReturnType<typeof buildServer>): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/auth/login",
    payload: { username: "alice.admin", password: "Admin!Pass1" },
  });
  assert.equal(res.statusCode, 200, `login failed: ${res.body}`);
  return (res.json() as { access_token: string }).access_token;
}

/** In-memory archiver that records every .archive() call. */
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
      recovery_id: `rec-stub-${this.calls.length}`,
      archived: {
        recovery_id: `rec-stub-${this.calls.length}`,
        tenant_id: "BANK_DEMO",
        module: req.module,
        entity_type: req.entity_type,
        original_id: req.original_id,
        original_table: req.original_table,
        payload: req.payload,
        deleted_by: req.deleted_by,
        deleted_at: "2026-05-19T12:00:00.000Z",
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

/** Set up: fresh state + a stubbed archiver bound to the next request. */
async function setup() {
  __resetAuthStateForTests();
  const archiver = new RecordingArchiver();
  __setRecoveryArchiverForTests(archiver);
  const app = buildServer();
  const token = await loginAdmin(app);
  return { app, archiver, token };
}

/** Tear-down hook for the suite — drops the stub so other test files
 *  don't observe it. node:test runs files in isolation but the
 *  module-level `state` lives for the process lifetime. */
test.after(() => {
  __setRecoveryArchiverForTests(null);
  __resetAuthStateForTests();
});

// ─── DELETE /auth/teams/:team_id ─────────────────────────────────────

test("DELETE /auth/teams/:team_id archives the team row BEFORE deleting", async () => {
  const { app, archiver, token } = await setup();
  // Create a team to delete.
  const created = await app.inject({
    method: "POST",
    url: "/auth/teams",
    headers: { authorization: `Bearer ${token}` },
    payload: {
      name: "Phase-2c Test Team",
      branch: "mumbai",
      role: "legal",
      team_leader: "u-001",
      members: ["u-002", "u-003"],
    },
  });
  assert.equal(created.statusCode, 201, `team creation failed: ${created.body}`);
  const team_id = (created.json() as { team_id: string }).team_id;

  // Sanity: team exists.
  const beforeGet = await app.inject({
    method: "GET",
    url: `/auth/teams/${team_id}`,
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(beforeGet.statusCode, 200);

  // Delete it.
  const del = await app.inject({
    method: "DELETE",
    url: `/auth/teams/${team_id}`,
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(del.statusCode, 204);

  // Archive call shape.
  assert.equal(archiver.calls.length, 1, "expected exactly one archive call");
  const arch = archiver.calls[0]!;
  assert.equal(arch.module, "auth-svc");
  assert.equal(arch.entity_type, "user_team");
  assert.equal(arch.original_id, team_id);
  assert.equal(arch.original_table, "app_iam.user_teams");
  assert.equal(arch.deleted_by, "alice.admin");
  assert.equal(arch.source_action, "user_initiated");
  assert.equal(arch.prior_status, "active");
  // Payload carries the full row including members[] so a future
  // restore can re-link the membership join in one go.
  const payload = arch.payload as Record<string, unknown>;
  assert.equal(payload.team_id, team_id);
  assert.equal(payload.name, "Phase-2c Test Team");
  assert.equal(payload.branch, "mumbai");
  assert.equal(payload.role, "legal");
  assert.equal(payload.team_leader, "u-001");
  // Store appends the leader to members[] after explicit members.
  assert.deepEqual((payload.members as string[]).sort(), ["u-001", "u-002", "u-003"]);

  // Team is gone from the store.
  const afterGet = await app.inject({
    method: "GET",
    url: `/auth/teams/${team_id}`,
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(afterGet.statusCode, 404);
});

test("DELETE /auth/teams/:team_id — archive failure does NOT block the delete", async () => {
  const { app, archiver, token } = await setup();
  const created = await app.inject({
    method: "POST",
    url: "/auth/teams",
    headers: { authorization: `Bearer ${token}` },
    payload: {
      name: "Best-effort Test",
      branch: "delhi",
      role: "ops",
      team_leader: "u-001",
    },
  });
  const team_id = (created.json() as { team_id: string }).team_id;

  // Arm the archiver to throw (simulates BFF being down).
  archiver.failNextWith = new RecoveryArchiveError(
    "network_error",
    "connect ECONNREFUSED",
  );

  const del = await app.inject({
    method: "DELETE",
    url: `/auth/teams/${team_id}`,
    headers: { authorization: `Bearer ${token}` },
  });
  // Best-effort posture: 204 even when archive failed.
  assert.equal(del.statusCode, 204);

  // Team is still gone locally.
  const afterGet = await app.inject({
    method: "GET",
    url: `/auth/teams/${team_id}`,
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(afterGet.statusCode, 404);
});

test("DELETE /auth/teams/:team_id — unknown team is 404 + does NOT archive", async () => {
  const { app, archiver, token } = await setup();
  const del = await app.inject({
    method: "DELETE",
    url: "/auth/teams/team-does-not-exist",
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(del.statusCode, 404);
  assert.equal(archiver.calls.length, 0, "no archive for nonexistent rows");
});

test("DELETE /auth/teams/:team_id — when no archiver is configured the delete still works", async () => {
  __resetAuthStateForTests();
  __setRecoveryArchiverForTests(null); // explicitly: no recovery
  const app = buildServer();
  const token = await loginAdmin(app);
  const created = await app.inject({
    method: "POST",
    url: "/auth/teams",
    headers: { authorization: `Bearer ${token}` },
    payload: {
      name: "No-archiver Test",
      branch: "delhi",
      role: "ops",
      team_leader: "u-001",
    },
  });
  const team_id = (created.json() as { team_id: string }).team_id;
  const del = await app.inject({
    method: "DELETE",
    url: `/auth/teams/${team_id}`,
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(del.statusCode, 204);
});

// ─── DELETE /auth/teams/:team_id/members/:user_id ────────────────────

test("DELETE /auth/teams/:team_id/members/:user_id archives the membership row BEFORE removing", async () => {
  const { app, archiver, token } = await setup();
  const created = await app.inject({
    method: "POST",
    url: "/auth/teams",
    headers: { authorization: `Bearer ${token}` },
    payload: {
      name: "Member-delete Test",
      branch: "mumbai",
      role: "legal",
      team_leader: "u-001",
      members: ["u-002", "u-003"],
    },
  });
  const team_id = (created.json() as { team_id: string }).team_id;

  const del = await app.inject({
    method: "DELETE",
    url: `/auth/teams/${team_id}/members/u-002`,
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(del.statusCode, 204);

  // One archive call, with the right shape.
  assert.equal(archiver.calls.length, 1);
  const arch = archiver.calls[0]!;
  assert.equal(arch.module, "auth-svc");
  assert.equal(arch.entity_type, "user_team_member");
  assert.equal(arch.original_id, `${team_id}:u-002`);
  assert.equal(arch.original_table, "app_iam.user_team_members");
  assert.equal(arch.deleted_by, "alice.admin");
  assert.deepEqual(arch.payload, { team_id, user_id: "u-002" });

  // Team still exists; member is gone.
  const get = await app.inject({
    method: "GET",
    url: `/auth/teams/${team_id}`,
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(get.statusCode, 200);
  const team = get.json() as { members: string[] };
  assert.ok(!team.members.includes("u-002"), "u-002 still in members");
});

test("DELETE /auth/teams/:team_id/members/:user_id — unknown member is 404 + NO archive", async () => {
  const { app, archiver, token } = await setup();
  const created = await app.inject({
    method: "POST",
    url: "/auth/teams",
    headers: { authorization: `Bearer ${token}` },
    payload: {
      name: "Unknown-member Test",
      branch: "delhi",
      role: "ops",
      team_leader: "u-001",
      members: ["u-002"],
    },
  });
  const team_id = (created.json() as { team_id: string }).team_id;

  const del = await app.inject({
    method: "DELETE",
    url: `/auth/teams/${team_id}/members/u-999`,
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(del.statusCode, 404);
  assert.equal(archiver.calls.length, 0, "no archive for unknown member");
});

test("DELETE /auth/teams/:team_id/members/:user_id — leader removal is 409 + NO archive", async () => {
  const { app, archiver, token } = await setup();
  const created = await app.inject({
    method: "POST",
    url: "/auth/teams",
    headers: { authorization: `Bearer ${token}` },
    payload: {
      name: "Leader-remove Test",
      branch: "delhi",
      role: "ops",
      team_leader: "u-001",
    },
  });
  const team_id = (created.json() as { team_id: string }).team_id;

  const del = await app.inject({
    method: "DELETE",
    url: `/auth/teams/${team_id}/members/u-001`,
    headers: { authorization: `Bearer ${token}` },
  });
  // The leader-removal block fires BEFORE the archive call.
  assert.equal(del.statusCode, 409);
  assert.equal(
    archiver.calls.length,
    0,
    "no archive when delete itself is refused",
  );
});

test("DELETE /auth/teams/:team_id/members/:user_id — archive failure does NOT block removal", async () => {
  const { app, archiver, token } = await setup();
  const created = await app.inject({
    method: "POST",
    url: "/auth/teams",
    headers: { authorization: `Bearer ${token}` },
    payload: {
      name: "Member-archive-fail Test",
      branch: "delhi",
      role: "ops",
      team_leader: "u-001",
      members: ["u-002"],
    },
  });
  const team_id = (created.json() as { team_id: string }).team_id;
  archiver.failNextWith = new RecoveryArchiveError(
    "server_error",
    "BFF returned 503",
    503,
  );

  const del = await app.inject({
    method: "DELETE",
    url: `/auth/teams/${team_id}/members/u-002`,
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(del.statusCode, 204);
});

// ─── Authentication is unchanged ─────────────────────────────────────

test("DELETE /auth/teams/:team_id — 401 without token, no archive attempted", async () => {
  __resetAuthStateForTests();
  const archiver = new RecordingArchiver();
  __setRecoveryArchiverForTests(archiver);
  const app = buildServer();
  // No auth header on the delete call.
  const del = await app.inject({
    method: "DELETE",
    url: "/auth/teams/anything",
  });
  assert.equal(del.statusCode, 401);
  assert.equal(archiver.calls.length, 0);
});

test("DELETE /auth/teams/:team_id — 403 when token is not admin role, no archive", async () => {
  __resetAuthStateForTests();
  const archiver = new RecordingArchiver();
  __setRecoveryArchiverForTests(archiver);
  const app = buildServer();
  // ravi.risk is risk_analyst in the demo seed (services/auth-svc/src/users.ts).
  const loginRes = await app.inject({
    method: "POST",
    url: "/auth/login",
    payload: { username: "ravi.risk", password: "RiskAnalyst!1" },
  });
  assert.equal(loginRes.statusCode, 200);
  const token = (loginRes.json() as { access_token: string }).access_token;
  const del = await app.inject({
    method: "DELETE",
    url: "/auth/teams/anything",
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(del.statusCode, 403);
  assert.equal(archiver.calls.length, 0);
});
