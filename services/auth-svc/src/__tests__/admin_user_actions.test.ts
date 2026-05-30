// Phase 9 T1 — partial admin actions test: force-logout / disable / enable.
// Lock + unlock are already covered in auth.test.ts; this file covers the
// 3 new sibling routes introduced today.

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
  const username = `t1user${suffix}`;
  const created = await app.inject({
    method: "POST",
    url: "/auth/users",
    headers: { authorization: `Bearer ${adminToken}` },
    payload: {
      username,
      email: `${username}@apex-ews.test`,
      password: "T1!Pass1",
      display_name: "Phase 9 T1 victim",
      role: "field_officer",
    },
  });
  assert.equal(created.statusCode, 201);
  return username;
}

test("POST /auth/users/:username/disable — locks login + emits user_disabled audit", async () => {
  const app = buildServer();
  const adminToken = await login(app, "alice.admin", "Admin!Pass1");
  const username = await createUser(app, adminToken, `${Date.now()}d1`);

  // Login works first.
  const before = await app.inject({
    method: "POST",
    url: "/auth/login",
    payload: { username, password: "T1!Pass1" },
  });
  assert.equal(before.statusCode, 200);

  // Disable with a reason — reason should land in audit metadata.
  const dis = await app.inject({
    method: "POST",
    url: `/auth/users/${username}/disable`,
    headers: { authorization: `Bearer ${adminToken}` },
    payload: { reason: "compliance hold" },
  });
  assert.equal(dis.statusCode, 200);
  assert.equal((dis.json() as { locked: boolean }).locked, true);

  // Login now refused with locked_account (disable + lock share the backend).
  const after = await app.inject({
    method: "POST",
    url: "/auth/login",
    payload: { username, password: "T1!Pass1" },
  });
  assert.equal(after.statusCode, 403);
  assert.equal((after.json() as Record<string, unknown>).error, "locked_account");

  // Audit chain should carry a user_disabled event with the reason.
  const auditRes = await app.inject({
    method: "GET",
    url: "/auth/audit-log?type=user_disabled",
    headers: { authorization: `Bearer ${adminToken}` },
  });
  assert.equal(auditRes.statusCode, 200);
  const events = (auditRes.json() as { events: Array<Record<string, unknown>> }).events;
  const ours = events.find((e) => e.target_username === username);
  assert.ok(ours, "user_disabled event not found in audit chain");
  assert.equal((ours!.metadata as Record<string, unknown>).reason, "compliance hold");

  await app.close();
});

test("POST /auth/users/:username/enable — re-opens login + emits user_enabled audit", async () => {
  const app = buildServer();
  const adminToken = await login(app, "alice.admin", "Admin!Pass1");
  const username = await createUser(app, adminToken, `${Date.now()}e1`);

  // Disable first.
  await app.inject({
    method: "POST",
    url: `/auth/users/${username}/disable`,
    headers: { authorization: `Bearer ${adminToken}` },
    payload: {},
  });

  // Enable.
  const en = await app.inject({
    method: "POST",
    url: `/auth/users/${username}/enable`,
    headers: { authorization: `Bearer ${adminToken}` },
  });
  assert.equal(en.statusCode, 200);
  assert.equal((en.json() as { locked: boolean }).locked, false);

  // Login works again.
  const login2 = await app.inject({
    method: "POST",
    url: "/auth/login",
    payload: { username, password: "T1!Pass1" },
  });
  assert.equal(login2.statusCode, 200);

  // Audit carries a user_enabled event.
  const auditRes = await app.inject({
    method: "GET",
    url: "/auth/audit-log?type=user_enabled",
    headers: { authorization: `Bearer ${adminToken}` },
  });
  const events = (auditRes.json() as { events: Array<Record<string, unknown>> }).events;
  assert.ok(events.some((e) => e.target_username === username));

  await app.close();
});

test("POST /auth/users/:username/force-logout — revokes every session + emits audit", async () => {
  const app = buildServer();
  const adminToken = await login(app, "alice.admin", "Admin!Pass1");
  const username = await createUser(app, adminToken, `${Date.now()}f1`);

  // User logs in 3 times across 3 'devices' — 3 sessions outstanding.
  const tokens: string[] = [];
  for (let i = 0; i < 3; i++) {
    tokens.push(await login(app, username, "T1!Pass1"));
  }
  // Every token resolves /auth/me before force-logout.
  for (const t of tokens) {
    const me = await app.inject({
      method: "GET",
      url: "/auth/me",
      headers: { authorization: `Bearer ${t}` },
    });
    assert.equal(me.statusCode, 200);
  }

  // Admin forces logout.
  const fl = await app.inject({
    method: "POST",
    url: `/auth/users/${username}/force-logout`,
    headers: { authorization: `Bearer ${adminToken}` },
    payload: { reason: "credential exposure suspected" },
  });
  assert.equal(fl.statusCode, 200);
  const body = fl.json() as { revoked_count: number; username: string };
  assert.equal(body.username, username);
  assert.ok(body.revoked_count >= 3, `expected ≥3 revocations, got ${body.revoked_count}`);

  // Every prior token is now rejected with session_revoked.
  for (const t of tokens) {
    const me = await app.inject({
      method: "GET",
      url: "/auth/me",
      headers: { authorization: `Bearer ${t}` },
    });
    assert.equal(me.statusCode, 401);
    assert.equal((me.json() as Record<string, unknown>).error, "session_revoked");
  }

  // Audit chain carries the user_force_logout event with reason + count.
  const auditRes = await app.inject({
    method: "GET",
    url: "/auth/audit-log?type=user_force_logout",
    headers: { authorization: `Bearer ${adminToken}` },
  });
  const events = (auditRes.json() as { events: Array<Record<string, unknown>> }).events;
  const ours = events.find((e) => e.target_username === username);
  assert.ok(ours, "user_force_logout event missing");
  const meta = ours!.metadata as Record<string, unknown>;
  assert.equal(meta.reason, "credential exposure suspected");
  assert.ok(typeof meta.revoked_count === "number" && (meta.revoked_count as number) >= 3);

  await app.close();
});

test("POST /auth/users/:username/disable — admin cannot disable self (409)", async () => {
  const app = buildServer();
  const adminToken = await login(app, "alice.admin", "Admin!Pass1");
  const res = await app.inject({
    method: "POST",
    url: "/auth/users/alice.admin/disable",
    headers: { authorization: `Bearer ${adminToken}` },
  });
  assert.equal(res.statusCode, 409);
  assert.equal((res.json() as Record<string, unknown>).error, "cannot_disable_self");
  await app.close();
});

test("POST /auth/users/:username/force-logout — admin cannot force-logout self (409)", async () => {
  const app = buildServer();
  const adminToken = await login(app, "alice.admin", "Admin!Pass1");
  const res = await app.inject({
    method: "POST",
    url: "/auth/users/alice.admin/force-logout",
    headers: { authorization: `Bearer ${adminToken}` },
  });
  assert.equal(res.statusCode, 409);
  assert.equal((res.json() as Record<string, unknown>).error, "cannot_force_logout_self");
  await app.close();
});

test("POST /auth/users/:username/enable — self-enable allowed (no self-guard)", async () => {
  // Enabling yourself is harmless (you'd have to already be admin AND somehow
  // disabled, which can't both be true since disabled blocks /auth/login).
  // So we don't gate enable behind a self-check. Verify the route accepts it.
  const app = buildServer();
  const adminToken = await login(app, "alice.admin", "Admin!Pass1");
  const res = await app.inject({
    method: "POST",
    url: "/auth/users/alice.admin/enable",
    headers: { authorization: `Bearer ${adminToken}` },
  });
  assert.equal(res.statusCode, 200);
  assert.equal((res.json() as { locked: boolean }).locked, false);
  await app.close();
});

test("3 new routes — unknown user → 404 + non-admin → 403", async () => {
  const app = buildServer();
  const adminToken = await login(app, "alice.admin", "Admin!Pass1");
  const analystToken = await login(app, "ravi.risk", "RiskAnalyst!1");

  for (const action of ["force-logout", "disable", "enable"] as const) {
    // Unknown user
    const unknown = await app.inject({
      method: "POST",
      url: `/auth/users/ghost.user/${action}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    assert.equal(unknown.statusCode, 404, `${action} should 404 on unknown user`);
    assert.equal((unknown.json() as Record<string, unknown>).error, "user_not_found");

    // Non-admin
    const forbidden = await app.inject({
      method: "POST",
      url: `/auth/users/alice.admin/${action}`,
      headers: { authorization: `Bearer ${analystToken}` },
    });
    assert.equal(forbidden.statusCode, 403, `${action} should 403 for non-admin`);
    assert.equal((forbidden.json() as Record<string, unknown>).error, "forbidden");

    // Missing token
    const noauth = await app.inject({
      method: "POST",
      url: `/auth/users/alice.admin/${action}`,
    });
    assert.equal(noauth.statusCode, 401, `${action} should 401 without bearer`);
  }
  await app.close();
});
