// Phase 9 T2 — admin session governance tests.
//
// Covers GET /auth/admin/sessions (filter + decorate) + POST
// /auth/admin/sessions/:sid/revoke (audit fan-out + 409 already-revoked).

process.env.AUTH_SVC_RATE_LIMIT = "off";

import test from "node:test";
import assert from "node:assert/strict";
import { buildServer } from "../server.js";

async function login(
  app: ReturnType<typeof buildServer>,
  username: string,
  password: string,
): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/auth/login",
    payload: { username, password },
  });
  if (res.statusCode !== 200) throw new Error(`login failed: ${res.statusCode} ${res.body}`);
  return (res.json() as { access_token: string }).access_token;
}

async function createUser(
  app: ReturnType<typeof buildServer>,
  adminToken: string,
  suffix: string,
): Promise<string> {
  const username = `t2user${suffix}`;
  const created = await app.inject({
    method: "POST",
    url: "/auth/users",
    headers: { authorization: `Bearer ${adminToken}` },
    payload: {
      username,
      email: `${username}@apex-ews.test`,
      password: "T2!Pass1",
      display_name: "T2 victim",
      role: "field_officer",
    },
  });
  assert.equal(created.statusCode, 201);
  return username;
}

test("GET /auth/admin/sessions — admin gets every active session decorated with user metadata", async () => {
  const app = buildServer();
  const adminToken = await login(app, "alice.admin", "Admin!Pass1");
  // alice has 1 session; create a 2nd user + sign them in to add another.
  const stamp = `${Date.now()}a`;
  const username = await createUser(app, adminToken, stamp);
  await login(app, username, "T2!Pass1");

  const res = await app.inject({
    method: "GET",
    url: "/auth/admin/sessions",
    headers: { authorization: `Bearer ${adminToken}` },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json() as {
    sessions: Array<{ id: string; username: string; role: string; revoked: boolean }>;
    total: number;
    filter: { status: string; limit: number };
  };
  assert.ok(Array.isArray(body.sessions));
  assert.ok(body.total >= 2, `expected ≥ 2 sessions, got ${body.total}`);
  // every row should be decorated with username + role
  for (const s of body.sessions) {
    assert.ok(typeof s.username === "string" || s.username === null);
    assert.ok(typeof s.role === "string" || s.role === null);
    assert.equal(typeof s.revoked, "boolean");
  }
  assert.equal(body.filter.status, "active");

  await app.close();
});

test("GET /auth/admin/sessions?user_id=… filters to one user", async () => {
  const app = buildServer();
  const adminToken = await login(app, "alice.admin", "Admin!Pass1");
  const stamp = `${Date.now()}b`;
  const username = await createUser(app, adminToken, stamp);
  await login(app, username, "T2!Pass1");

  // resolve the created user's id by checking the admin user list
  const list = await app.inject({
    method: "GET",
    url: "/auth/users",
    headers: { authorization: `Bearer ${adminToken}` },
  });
  const target = (list.json() as { users: Array<{ id: string; username: string }> }).users.find(
    (u) => u.username === username,
  )!;

  const res = await app.inject({
    method: "GET",
    url: `/auth/admin/sessions?user_id=${target.id}`,
    headers: { authorization: `Bearer ${adminToken}` },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json() as {
    sessions: Array<{ user_id: string; username: string }>;
  };
  assert.ok(body.sessions.length >= 1);
  for (const s of body.sessions) {
    assert.equal(s.user_id, target.id);
    assert.equal(s.username, username);
  }

  await app.close();
});

test("GET /auth/admin/sessions?status=revoked surfaces revoked sessions; status=all returns both", async () => {
  const app = buildServer();
  const adminToken = await login(app, "alice.admin", "Admin!Pass1");
  const stamp = `${Date.now()}c`;
  const username = await createUser(app, adminToken, stamp);
  const userToken = await login(app, username, "T2!Pass1");

  // Find the user's session sid via the self-service listing
  const mySessions = await app.inject({
    method: "GET",
    url: "/auth/sessions",
    headers: { authorization: `Bearer ${userToken}` },
  });
  const mySid = (
    mySessions.json() as { sessions: Array<{ id: string }> }
  ).sessions[0]!.id;

  // Admin revokes it
  const rev = await app.inject({
    method: "POST",
    url: `/auth/admin/sessions/${mySid}/revoke`,
    headers: { authorization: `Bearer ${adminToken}` },
    payload: { reason: "incident response" },
  });
  assert.equal(rev.statusCode, 200);

  // status=revoked includes it
  const revoked = await app.inject({
    method: "GET",
    url: "/auth/admin/sessions?status=revoked",
    headers: { authorization: `Bearer ${adminToken}` },
  });
  const revBody = revoked.json() as { sessions: Array<{ id: string; revoked: boolean }> };
  const ours = revBody.sessions.find((s) => s.id === mySid);
  assert.ok(ours, "revoked session missing from status=revoked");
  assert.equal(ours!.revoked, true);

  // status=active does NOT include it
  const active = await app.inject({
    method: "GET",
    url: "/auth/admin/sessions?status=active",
    headers: { authorization: `Bearer ${adminToken}` },
  });
  const stillActive = (active.json() as { sessions: Array<{ id: string }> }).sessions.some(
    (s) => s.id === mySid,
  );
  assert.equal(stillActive, false);

  // status=all returns both
  const all = await app.inject({
    method: "GET",
    url: "/auth/admin/sessions?status=all",
    headers: { authorization: `Bearer ${adminToken}` },
  });
  const allBody = all.json() as { sessions: Array<{ id: string }> };
  assert.ok(allBody.sessions.some((s) => s.id === mySid));

  await app.close();
});

test("POST /auth/admin/sessions/:sid/revoke — happy + 404 + 409 already-revoked + audit", async () => {
  const app = buildServer();
  const adminToken = await login(app, "alice.admin", "Admin!Pass1");
  const stamp = `${Date.now()}d`;
  const username = await createUser(app, adminToken, stamp);
  const userToken = await login(app, username, "T2!Pass1");

  const myList = await app.inject({
    method: "GET",
    url: "/auth/sessions",
    headers: { authorization: `Bearer ${userToken}` },
  });
  const mySid = (myList.json() as { sessions: Array<{ id: string }> }).sessions[0]!.id;

  // 1st revoke ok
  const rev1 = await app.inject({
    method: "POST",
    url: `/auth/admin/sessions/${mySid}/revoke`,
    headers: { authorization: `Bearer ${adminToken}` },
    payload: { reason: "leaked refresh token" },
  });
  assert.equal(rev1.statusCode, 200);

  // 2nd revoke → 409 already_revoked
  const rev2 = await app.inject({
    method: "POST",
    url: `/auth/admin/sessions/${mySid}/revoke`,
    headers: { authorization: `Bearer ${adminToken}` },
  });
  assert.equal(rev2.statusCode, 409);
  assert.equal((rev2.json() as Record<string, unknown>).error, "already_revoked");

  // unknown sid → 404
  const rev3 = await app.inject({
    method: "POST",
    url: "/auth/admin/sessions/sid-ghost-xyz/revoke",
    headers: { authorization: `Bearer ${adminToken}` },
  });
  assert.equal(rev3.statusCode, 404);

  // User's old token is now session_revoked
  const me = await app.inject({
    method: "GET",
    url: "/auth/me",
    headers: { authorization: `Bearer ${userToken}` },
  });
  assert.equal(me.statusCode, 401);

  // Audit chain carries the user_force_logout event with single_session scope
  const auditRes = await app.inject({
    method: "GET",
    url: "/auth/audit-log?type=user_force_logout",
    headers: { authorization: `Bearer ${adminToken}` },
  });
  const events = (auditRes.json() as { events: Array<Record<string, unknown>> }).events;
  const ours = events.find(
    (e) =>
      (e.metadata as Record<string, unknown>).revoked_sid === mySid &&
      (e.metadata as Record<string, unknown>).scope === "single_session",
  );
  assert.ok(ours, "single-session audit event missing");
  const meta = ours!.metadata as Record<string, unknown>;
  assert.equal(meta.reason, "leaked refresh token");

  await app.close();
});

test("admin session routes — non-admin → 403, missing token → 401", async () => {
  const app = buildServer();
  const analystToken = await login(app, "ravi.risk", "RiskAnalyst!1");

  for (const url of [
    "/auth/admin/sessions",
    "/auth/admin/sessions/sid-x/revoke",
  ] as const) {
    const method: "GET" | "POST" = url.endsWith("/revoke") ? "POST" : "GET";
    const noauth = await app.inject({ method, url });
    assert.equal(noauth.statusCode, 401);

    const wrong = await app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${analystToken}` },
    });
    assert.equal(wrong.statusCode, 403);
  }

  await app.close();
});
