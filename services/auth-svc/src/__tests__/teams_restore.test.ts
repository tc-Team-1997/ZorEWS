// Recovery Center Phase 2d — auth-svc restore callback endpoint.
//
// Tests POST /auth/recovery/restore for the two auth-svc entity_types
// the BFF currently archives (user_team, user_team_member). The
// endpoint is shared-secret-auth (X-Recovery-Restore-Key) — NOT
// user-JWT — so these tests don't go through /auth/login.
//
// The BFF-side adapter that calls this is tested in services/bff/.

import test from "node:test";
import assert from "node:assert/strict";
import { buildServer } from "../server.js";
import { __resetAuthStateForTests } from "../routes/auth.js";

const RESTORE_KEY = "test-restore-key-do-not-leak";

function setEnv() {
  process.env.AUTH_SVC_RECOVERY_RESTORE_KEY = RESTORE_KEY;
}
function unsetEnv() {
  delete process.env.AUTH_SVC_RECOVERY_RESTORE_KEY;
}

test.beforeEach(() => {
  __resetAuthStateForTests();
  setEnv();
});

test.after(() => {
  unsetEnv();
  __resetAuthStateForTests();
});

// Helper: full UserTeam shape for archive payload.
function teamPayload(team_id: string, overrides: Record<string, unknown> = {}) {
  return {
    team_id,
    name: "Restored Team",
    branch: "mumbai",
    role: "legal",
    team_leader: "u-001",
    email: null,
    description: null,
    created_at: "2026-05-19T10:00:00.000Z",
    members: ["u-001", "u-002"],
    ...overrides,
  };
}

// ─── Shared-secret auth ──────────────────────────────────────────────

test("POST /auth/recovery/restore — 503 when AUTH_SVC_RECOVERY_RESTORE_KEY unset", async () => {
  unsetEnv(); // override the beforeEach
  const app = buildServer();
  const res = await app.inject({
    method: "POST",
    url: "/auth/recovery/restore",
    headers: { "x-recovery-restore-key": "anything" },
    payload: { entity_type: "user_team", original_id: "t-1", payload: {} },
  });
  assert.equal(res.statusCode, 503);
  assert.equal((res.json() as { error: string }).error, "restore_disabled");
});

test("POST /auth/recovery/restore — 401 when X-Recovery-Restore-Key missing", async () => {
  const app = buildServer();
  const res = await app.inject({
    method: "POST",
    url: "/auth/recovery/restore",
    payload: { entity_type: "user_team", original_id: "t-1", payload: {} },
  });
  assert.equal(res.statusCode, 401);
  assert.equal((res.json() as { error: string }).error, "invalid_restore_key");
});

test("POST /auth/recovery/restore — 401 when key value is wrong", async () => {
  const app = buildServer();
  const res = await app.inject({
    method: "POST",
    url: "/auth/recovery/restore",
    headers: { "x-recovery-restore-key": "wrong-key" },
    payload: { entity_type: "user_team", original_id: "t-1", payload: {} },
  });
  assert.equal(res.statusCode, 401);
});

test("POST /auth/recovery/restore — 401 when key length differs (timing-safe-equal would throw)", async () => {
  const app = buildServer();
  const res = await app.inject({
    method: "POST",
    url: "/auth/recovery/restore",
    headers: { "x-recovery-restore-key": "short" },
    payload: { entity_type: "user_team", original_id: "t-1", payload: {} },
  });
  assert.equal(res.statusCode, 401);
});

// ─── Input validation ────────────────────────────────────────────────

test("POST /auth/recovery/restore — 400 missing fields", async () => {
  const app = buildServer();
  for (const body of [
    {},
    { entity_type: "user_team" },
    { entity_type: "user_team", original_id: "t-1" },
    { entity_type: "user_team", original_id: "t-1", payload: null },
    { entity_type: "user_team", original_id: "t-1", payload: [1, 2] },
  ]) {
    const res = await app.inject({
      method: "POST",
      url: "/auth/recovery/restore",
      headers: { "x-recovery-restore-key": RESTORE_KEY },
      payload: body,
    });
    assert.equal(res.statusCode, 400, `body=${JSON.stringify(body)} → got ${res.statusCode}`);
  }
});

test("POST /auth/recovery/restore — 400 unknown entity_type", async () => {
  const app = buildServer();
  const res = await app.inject({
    method: "POST",
    url: "/auth/recovery/restore",
    headers: { "x-recovery-restore-key": RESTORE_KEY },
    payload: {
      entity_type: "mystery_entity",
      original_id: "x-1",
      payload: { whatever: true },
    },
  });
  assert.equal(res.statusCode, 400);
  assert.equal((res.json() as { error: string }).error, "unknown_entity_type");
});

// ─── user_team restore ───────────────────────────────────────────────

test("POST /auth/recovery/restore user_team — happy path: 201 + team re-inserted with original team_id + members", async () => {
  const app = buildServer();
  const team_id = "team_abc12345";
  const res = await app.inject({
    method: "POST",
    url: "/auth/recovery/restore",
    headers: { "x-recovery-restore-key": RESTORE_KEY },
    payload: {
      entity_type: "user_team",
      original_id: team_id,
      payload: teamPayload(team_id, { members: ["u-001", "u-002", "u-003"] }),
    },
  });
  assert.equal(res.statusCode, 201);
  const body = res.json() as { entity_type: string; original_id: string; restored: boolean };
  assert.equal(body.entity_type, "user_team");
  assert.equal(body.original_id, team_id);
  assert.equal(body.restored, true);

  // Sanity: a fresh login + GET /auth/teams/:team_id sees it.
  const login = await app.inject({
    method: "POST",
    url: "/auth/login",
    payload: { username: "alice.admin", password: "Admin!Pass1" },
  });
  const token = (login.json() as { access_token: string }).access_token;
  const get = await app.inject({
    method: "GET",
    url: `/auth/teams/${team_id}`,
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(get.statusCode, 200);
  const restored = get.json() as { team_id: string; name: string; members: string[] };
  assert.equal(restored.team_id, team_id);
  assert.equal(restored.name, "Restored Team");
  assert.deepEqual(restored.members.sort(), ["u-001", "u-002", "u-003"]);
});

test("POST /auth/recovery/restore user_team — 409 when team_id already exists", async () => {
  const app = buildServer();
  const team_id = "team_dup11111";
  // First restore creates the team.
  const first = await app.inject({
    method: "POST",
    url: "/auth/recovery/restore",
    headers: { "x-recovery-restore-key": RESTORE_KEY },
    payload: { entity_type: "user_team", original_id: team_id, payload: teamPayload(team_id) },
  });
  assert.equal(first.statusCode, 201);
  // Second restore must refuse.
  const second = await app.inject({
    method: "POST",
    url: "/auth/recovery/restore",
    headers: { "x-recovery-restore-key": RESTORE_KEY },
    payload: { entity_type: "user_team", original_id: team_id, payload: teamPayload(team_id) },
  });
  assert.equal(second.statusCode, 409);
  assert.equal((second.json() as { error: string }).error, "team_exists");
});

test("POST /auth/recovery/restore user_team — 400 when payload missing required fields", async () => {
  const app = buildServer();
  const res = await app.inject({
    method: "POST",
    url: "/auth/recovery/restore",
    headers: { "x-recovery-restore-key": RESTORE_KEY },
    payload: {
      entity_type: "user_team",
      original_id: "team_x",
      payload: { team_id: "team_x", name: "Incomplete" }, // missing branch/role/leader/etc.
    },
  });
  assert.equal(res.statusCode, 400);
  assert.equal((res.json() as { error: string }).error, "invalid_payload");
});

test("POST /auth/recovery/restore user_team — 400 when payload.team_id doesn't match original_id", async () => {
  const app = buildServer();
  const res = await app.inject({
    method: "POST",
    url: "/auth/recovery/restore",
    headers: { "x-recovery-restore-key": RESTORE_KEY },
    payload: {
      entity_type: "user_team",
      original_id: "team_aaa",
      payload: teamPayload("team_bbb"), // mismatch
    },
  });
  assert.equal(res.statusCode, 400);
});

// ─── user_team_member restore ────────────────────────────────────────

test("POST /auth/recovery/restore user_team_member — happy path: 201 + member added to existing team", async () => {
  const app = buildServer();
  // Login + create a team to add the member back to.
  const login = await app.inject({
    method: "POST",
    url: "/auth/login",
    payload: { username: "alice.admin", password: "Admin!Pass1" },
  });
  const token = (login.json() as { access_token: string }).access_token;
  const createTeam = await app.inject({
    method: "POST",
    url: "/auth/teams",
    headers: { authorization: `Bearer ${token}` },
    payload: {
      name: "Member-Restore Test Team",
      branch: "delhi",
      role: "legal",
      team_leader: "u-001",
      members: ["u-002"],
    },
  });
  const team_id = (createTeam.json() as { team_id: string }).team_id;

  // Restore a NEW member.
  const res = await app.inject({
    method: "POST",
    url: "/auth/recovery/restore",
    headers: { "x-recovery-restore-key": RESTORE_KEY },
    payload: {
      entity_type: "user_team_member",
      original_id: `${team_id}:u-003`,
      payload: { team_id, user_id: "u-003" },
    },
  });
  assert.equal(res.statusCode, 201);

  // Verify u-003 is in the team's members.
  const get = await app.inject({
    method: "GET",
    url: `/auth/teams/${team_id}`,
    headers: { authorization: `Bearer ${token}` },
  });
  const team = get.json() as { members: string[] };
  assert.ok(team.members.includes("u-003"), `u-003 not in members: ${team.members.join(",")}`);
});

test("POST /auth/recovery/restore user_team_member — 404 when parent team doesn't exist", async () => {
  const app = buildServer();
  const res = await app.inject({
    method: "POST",
    url: "/auth/recovery/restore",
    headers: { "x-recovery-restore-key": RESTORE_KEY },
    payload: {
      entity_type: "user_team_member",
      original_id: "team_gone:u-002",
      payload: { team_id: "team_gone", user_id: "u-002" },
    },
  });
  assert.equal(res.statusCode, 404);
  assert.equal((res.json() as { error: string }).error, "team_not_found");
});

test("POST /auth/recovery/restore user_team_member — 409 when member already exists", async () => {
  const app = buildServer();
  const login = await app.inject({
    method: "POST",
    url: "/auth/login",
    payload: { username: "alice.admin", password: "Admin!Pass1" },
  });
  const token = (login.json() as { access_token: string }).access_token;
  const created = await app.inject({
    method: "POST",
    url: "/auth/teams",
    headers: { authorization: `Bearer ${token}` },
    payload: {
      name: "Dup-member Test",
      branch: "delhi",
      role: "legal",
      team_leader: "u-001",
      members: ["u-002"],
    },
  });
  const team_id = (created.json() as { team_id: string }).team_id;

  // u-002 is already a member — restore must refuse.
  const res = await app.inject({
    method: "POST",
    url: "/auth/recovery/restore",
    headers: { "x-recovery-restore-key": RESTORE_KEY },
    payload: {
      entity_type: "user_team_member",
      original_id: `${team_id}:u-002`,
      payload: { team_id, user_id: "u-002" },
    },
  });
  assert.equal(res.statusCode, 409);
  assert.equal((res.json() as { error: string }).error, "member_exists");
});

test("POST /auth/recovery/restore user_team_member — 400 when original_id ≠ team_id:user_id", async () => {
  const app = buildServer();
  const res = await app.inject({
    method: "POST",
    url: "/auth/recovery/restore",
    headers: { "x-recovery-restore-key": RESTORE_KEY },
    payload: {
      entity_type: "user_team_member",
      // tag says one thing, payload says another — refuse rather than
      // quietly trust either side.
      original_id: "team_aaa:u-002",
      payload: { team_id: "team_bbb", user_id: "u-002" },
    },
  });
  assert.equal(res.statusCode, 400);
});

// ─── Round-trip: archive (Phase 2c) → restore (Phase 2d) ─────────────

test("Round-trip: DELETE team archives via stub, then restore endpoint re-creates it", async () => {
  // 1. Login as admin.
  const app = buildServer();
  const login = await app.inject({
    method: "POST",
    url: "/auth/login",
    payload: { username: "alice.admin", password: "Admin!Pass1" },
  });
  const token = (login.json() as { access_token: string }).access_token;

  // 2. Create a team.
  const created = await app.inject({
    method: "POST",
    url: "/auth/teams",
    headers: { authorization: `Bearer ${token}` },
    payload: {
      name: "Round-trip Test",
      branch: "mumbai",
      role: "legal",
      team_leader: "u-001",
      members: ["u-002", "u-003"],
    },
  });
  assert.equal(created.statusCode, 201);
  const team = created.json() as {
    team_id: string;
    name: string;
    branch: string;
    role: string;
    team_leader: string;
    email: string | null;
    description: string | null;
    created_at: string;
    members: string[];
  };

  // 3. Delete it (Phase 2c archive happens, but with no real BFF
  //    configured the archive is a no-op — we use the team object we
  //    captured at create time as the archive payload).
  const del = await app.inject({
    method: "DELETE",
    url: `/auth/teams/${team.team_id}`,
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(del.statusCode, 204);

  // 4. Verify gone.
  const gone = await app.inject({
    method: "GET",
    url: `/auth/teams/${team.team_id}`,
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(gone.statusCode, 404);

  // 5. Restore via Phase 2d endpoint using the captured snapshot.
  const restore = await app.inject({
    method: "POST",
    url: "/auth/recovery/restore",
    headers: { "x-recovery-restore-key": RESTORE_KEY },
    payload: {
      entity_type: "user_team",
      original_id: team.team_id,
      payload: team,
    },
  });
  assert.equal(restore.statusCode, 201);

  // 6. Team is back with all original fields.
  const back = await app.inject({
    method: "GET",
    url: `/auth/teams/${team.team_id}`,
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(back.statusCode, 200);
  const reborn = back.json() as typeof team;
  assert.equal(reborn.team_id, team.team_id);
  assert.equal(reborn.name, team.name);
  assert.equal(reborn.branch, team.branch);
  assert.equal(reborn.team_leader, team.team_leader);
  assert.deepEqual(reborn.members.sort(), team.members.sort());
});
