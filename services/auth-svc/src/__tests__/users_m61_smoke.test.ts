// services/auth-svc/src/__tests__/users_m61_smoke.test.ts
//
// M6.1 — Users & RBAC smoke
//
// Spec acceptance:
//   1. "Role change takes effect on next request (no logout required)"
//   2. "Deactivated user can't log in"
//
// Routes verified:
//   POST   /auth/users                        (existing — admin-only create)
//   POST   /auth/users/:username/role         (NEW — admin-only role change)
//   POST   /auth/users/:username/{lock,unlock} (existing — deactivate)
//   GET    /auth/me                           (existing — now reads LIVE role
//                                              from store, not JWT)
//   GET    /auth/me/activity                  (existing — self-service)
//   POST   /auth/login                        (acceptance gate: locked → 403)
//   GET    /auth/audit-log                    (audit fan-out check)

process.env.AUTH_SVC_RATE_LIMIT = "off";

import test from "node:test";
import assert from "node:assert/strict";
import { buildServer } from "../server.js";

async function adminToken(app: ReturnType<typeof buildServer>) {
  const res = await app.inject({
    method: "POST",
    url: "/auth/login",
    payload: { username: "alice.admin", password: "Admin!Pass1" },
  });
  assert.equal(res.statusCode, 200);
  return (res.json() as { access_token: string }).access_token;
}

async function loginAs(
  app: ReturnType<typeof buildServer>,
  username: string,
  password: string,
) {
  return app.inject({
    method: "POST",
    url: "/auth/login",
    payload: { username, password },
  });
}

async function createUser(
  app: ReturnType<typeof buildServer>,
  adminTok: string,
  username: string,
  role: string,
) {
  return app.inject({
    method: "POST",
    url: "/auth/users",
    headers: { authorization: `Bearer ${adminTok}` },
    payload: {
      username,
      email: `${username}@example.com`,
      password: "Welcome!1Now",
      display_name: username,
      role,
      skip_first_login: true,
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────
// UR-1: Spec acceptance — role change takes effect on /auth/me without logout
// ─────────────────────────────────────────────────────────────────────────
test("UR-1 spec acceptance: role change takes effect on next /auth/me without logout", async () => {
  const app = buildServer();
  const adminTok = await adminToken(app);

  // Create a user with risk_analyst role
  const stamp = Date.now();
  const username = `ur1.user${stamp}`;
  const createRes = await createUser(app, adminTok, username, "risk_analyst");
  assert.equal(createRes.statusCode, 201);

  // User logs in — gets a JWT with role=risk_analyst baked in
  const loginRes = await loginAs(app, username, "Welcome!1Now");
  assert.equal(loginRes.statusCode, 200);
  const userTok = (loginRes.json() as { access_token: string }).access_token;

  // /auth/me — initial role
  const meBefore = await app.inject({
    method: "GET",
    url: "/auth/me",
    headers: { authorization: `Bearer ${userTok}` },
  });
  assert.equal(meBefore.statusCode, 200);
  const mb = meBefore.json() as { role: string };
  assert.equal(mb.role, "risk_analyst");

  // Admin upgrades the user to supervisor
  const roleChange = await app.inject({
    method: "POST",
    url: `/auth/users/${username}/role`,
    headers: { authorization: `Bearer ${adminTok}` },
    payload: { role: "supervisor" },
  });
  assert.equal(roleChange.statusCode, 200);
  const rc = roleChange.json() as { role: string; previous_role: string };
  assert.equal(rc.role, "supervisor");
  assert.equal(rc.previous_role, "risk_analyst");

  // /auth/me with the SAME JWT — should now return supervisor.
  // This is the spec acceptance: NO logout/refresh required.
  const meAfter = await app.inject({
    method: "GET",
    url: "/auth/me",
    headers: { authorization: `Bearer ${userTok}` },
  });
  assert.equal(meAfter.statusCode, 200);
  const ma = meAfter.json() as { role: string; sub: string };
  assert.equal(ma.role, "supervisor", "role change must be visible on /auth/me without logout");
  assert.equal(ma.sub, mb.sub ?? ma.sub, "sub stays stable across role change");

  await app.close();
});

// ─────────────────────────────────────────────────────────────────────────
// UR-2: Spec acceptance — deactivated user cannot log in
// ─────────────────────────────────────────────────────────────────────────
test("UR-2 spec acceptance: locked user cannot log in", async () => {
  const app = buildServer();
  const adminTok = await adminToken(app);

  const stamp = Date.now();
  const username = `ur2.user${stamp}`;
  const createRes = await createUser(app, adminTok, username, "risk_analyst");
  assert.equal(createRes.statusCode, 201);

  // Verify the new user CAN log in
  const ok = await loginAs(app, username, "Welcome!1Now");
  assert.equal(ok.statusCode, 200);

  // Admin locks the account
  const lockRes = await app.inject({
    method: "POST",
    url: `/auth/users/${username}/lock`,
    headers: { authorization: `Bearer ${adminTok}` },
  });
  assert.equal(lockRes.statusCode, 200);

  // The locked user can no longer log in
  const blocked = await loginAs(app, username, "Welcome!1Now");
  assert.equal(blocked.statusCode, 403, "locked user must be refused login");
  const bb = blocked.json() as { error: string };
  assert.equal(bb.error, "locked_account");

  // Unlock and verify login works again — round-trip invariant
  const unlockRes = await app.inject({
    method: "POST",
    url: `/auth/users/${username}/unlock`,
    headers: { authorization: `Bearer ${adminTok}` },
  });
  assert.equal(unlockRes.statusCode, 200);
  const okAgain = await loginAs(app, username, "Welcome!1Now");
  assert.equal(okAgain.statusCode, 200);

  await app.close();
});

// ─────────────────────────────────────────────────────────────────────────
// UR-3: lock takes effect on /auth/me — even with a JWT issued PRE-lock
// ─────────────────────────────────────────────────────────────────────────
test("UR-3 locked user with pre-lock JWT is refused at /auth/me", async () => {
  const app = buildServer();
  const adminTok = await adminToken(app);

  const stamp = Date.now();
  const username = `ur3.user${stamp}`;
  await createUser(app, adminTok, username, "risk_analyst");

  // User logs in BEFORE being locked
  const loginRes = await loginAs(app, username, "Welcome!1Now");
  const userTok = (loginRes.json() as { access_token: string }).access_token;

  // /auth/me — works
  const meBefore = await app.inject({
    method: "GET",
    url: "/auth/me",
    headers: { authorization: `Bearer ${userTok}` },
  });
  assert.equal(meBefore.statusCode, 200);

  // Admin locks the user
  await app.inject({
    method: "POST",
    url: `/auth/users/${username}/lock`,
    headers: { authorization: `Bearer ${adminTok}` },
  });

  // /auth/me with the SAME JWT — should now be 403 locked_account
  const meAfter = await app.inject({
    method: "GET",
    url: "/auth/me",
    headers: { authorization: `Bearer ${userTok}` },
  });
  assert.equal(meAfter.statusCode, 403, "locked user must be refused at /auth/me even with a pre-lock JWT");
  const ma = meAfter.json() as { error: string };
  assert.equal(ma.error, "locked_account");

  await app.close();
});

// ─────────────────────────────────────────────────────────────────────────
// UR-4: role-change endpoint validation
// ─────────────────────────────────────────────────────────────────────────
test("UR-4 POST /auth/users/:username/role validates input + admin gate", async () => {
  const app = buildServer();
  const adminTok = await adminToken(app);

  const stamp = Date.now();
  const username = `ur4.user${stamp}`;
  await createUser(app, adminTok, username, "risk_analyst");

  // 400 on invalid role
  const bad = await app.inject({
    method: "POST",
    url: `/auth/users/${username}/role`,
    headers: { authorization: `Bearer ${adminTok}` },
    payload: { role: "not_a_role" },
  });
  assert.equal(bad.statusCode, 400);

  // 400 on missing role
  const noBody = await app.inject({
    method: "POST",
    url: `/auth/users/${username}/role`,
    headers: { authorization: `Bearer ${adminTok}` },
    payload: {},
  });
  assert.equal(noBody.statusCode, 400);

  // 404 on unknown user
  const unknown = await app.inject({
    method: "POST",
    url: `/auth/users/does-not-exist/role`,
    headers: { authorization: `Bearer ${adminTok}` },
    payload: { role: "supervisor" },
  });
  assert.equal(unknown.statusCode, 404);

  // 403 on non-admin
  const userLogin = await loginAs(app, username, "Welcome!1Now");
  const userTok = (userLogin.json() as { access_token: string }).access_token;
  const noPerm = await app.inject({
    method: "POST",
    url: `/auth/users/${username}/role`,
    headers: { authorization: `Bearer ${userTok}` },
    payload: { role: "admin" },
  });
  assert.equal(noPerm.statusCode, 403);

  // 409 on self-change
  const selfChange = await app.inject({
    method: "POST",
    url: `/auth/users/alice.admin/role`,
    headers: { authorization: `Bearer ${adminTok}` },
    payload: { role: "supervisor" },
  });
  assert.equal(selfChange.statusCode, 409);

  // 401 on missing token
  const noTok = await app.inject({
    method: "POST",
    url: `/auth/users/${username}/role`,
    payload: { role: "supervisor" },
  });
  assert.equal(noTok.statusCode, 401);

  await app.close();
});

// ─────────────────────────────────────────────────────────────────────────
// UR-5: role-change writes audit event
// ─────────────────────────────────────────────────────────────────────────
test("UR-5 role-change writes user_role_changed audit event with prev + new role", async () => {
  const app = buildServer();
  const adminTok = await adminToken(app);

  const stamp = Date.now();
  const username = `ur5.user${stamp}`;
  await createUser(app, adminTok, username, "risk_analyst");

  await app.inject({
    method: "POST",
    url: `/auth/users/${username}/role`,
    headers: { authorization: `Bearer ${adminTok}` },
    payload: { role: "supervisor" },
  });

  // Read the admin audit log filtered to the user
  const logRes = await app.inject({
    method: "GET",
    url: `/auth/audit-log?target_username=${username}&type=user_role_changed&limit=10`,
    headers: { authorization: `Bearer ${adminTok}` },
  });
  assert.equal(logRes.statusCode, 200);
  const events = (logRes.json() as { events: Array<Record<string, unknown>> }).events;
  assert.ok(events.length >= 1, "expected at least 1 user_role_changed event");
  const ev = events[0]!;
  assert.equal(ev.type, "user_role_changed");
  assert.equal(ev.target_username, username);
  const meta = ev.metadata as Record<string, string>;
  assert.equal(meta.previous_role, "risk_analyst");
  assert.equal(meta.new_role, "supervisor");

  await app.close();
});

// ─────────────────────────────────────────────────────────────────────────
// UR-6: /auth/me carries live tenant_id + must_change_password fields
//       (these are net-new fields surfaced for the SPA M6.1 page)
// ─────────────────────────────────────────────────────────────────────────
test("UR-6 /auth/me returns live tenant_id + must_change_password + username", async () => {
  const app = buildServer();
  const adminTok = await adminToken(app);

  const me = await app.inject({
    method: "GET",
    url: "/auth/me",
    headers: { authorization: `Bearer ${adminTok}` },
  });
  assert.equal(me.statusCode, 200);
  const body = me.json() as Record<string, unknown>;
  assert.equal(body.role, "admin");
  assert.equal(body.username, "alice.admin");
  assert.ok(typeof body.tenant_id === "string");
  assert.equal(body.must_change_password, false);
  assert.equal(body.locked, false);

  await app.close();
});

// ─────────────────────────────────────────────────────────────────────────
// UR-7: spec route regression — /auth/users + /auth/teams + /auth/leave-covers
//       all still respond (spec calls for these to exist; they ship via
//       earlier sub-phases — M6.1 must not break them)
// ─────────────────────────────────────────────────────────────────────────
test("UR-7 spec routes regression — /auth/users + /auth/teams + /auth/leave-covers still work", async () => {
  const app = buildServer();
  const adminTok = await adminToken(app);

  const headers = { authorization: `Bearer ${adminTok}` };

  const users = await app.inject({ method: "GET", url: "/auth/users", headers });
  assert.equal(users.statusCode, 200);

  const teams = await app.inject({ method: "GET", url: "/auth/teams", headers });
  assert.equal(teams.statusCode, 200);

  const covers = await app.inject({
    method: "GET",
    url: "/auth/leave-covers",
    headers,
  });
  assert.equal(covers.statusCode, 200);

  await app.close();
});
