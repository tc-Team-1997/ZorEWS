// Disable rate limiting for these tests — several log in as alice.admin
// many times across the suite to exercise admin-only routes, which would
// trip the 5-per-15-min login cap. Safe to set before imports because the
// route handler reads process.env on every request, not at module load.
// Rate limiting itself is tested in rate_limit.test.ts.
process.env.AUTH_SVC_RATE_LIMIT = "off";

import test from "node:test";
import assert from "node:assert/strict";
import { buildServer } from "../server.js";

test("POST /auth/login — happy path issues access + refresh tokens", async () => {
  const app = buildServer();

  const res = await app.inject({
    method: "POST",
    url: "/auth/login",
    payload: { username: "alice.admin", password: "Admin!Pass1" },
  });

  assert.equal(res.statusCode, 200);
  const body = res.json() as Record<string, unknown>;
  assert.equal(body.token_type, "Bearer");
  assert.equal(body.role, "admin");
  assert.ok(typeof body.access_token === "string" && (body.access_token as string).length > 0);
  assert.ok(typeof body.refresh_token === "string" && (body.refresh_token as string).length > 0);

  await app.close();
});

test("POST /auth/login — bad password rejected with 401", async () => {
  const app = buildServer();

  const res = await app.inject({
    method: "POST",
    url: "/auth/login",
    payload: { username: "alice.admin", password: "wrong" },
  });

  assert.equal(res.statusCode, 401);
  const body = res.json() as Record<string, unknown>;
  assert.equal(body.error, "invalid_credentials");

  await app.close();
});

test("POST /auth/register — happy path returns the user and login round-trips", async () => {
  const app = buildServer();
  const stamp = Date.now();
  const username = `tina.test${stamp}`;
  const email = `tina.test${stamp}@apex-ews.test`;

  const reg = await app.inject({
    method: "POST",
    url: "/auth/register",
    payload: {
      username,
      email,
      password: "Tina!Pass99",
      display_name: "Tina Tester",
      role: "risk_analyst",
    },
  });
  assert.equal(reg.statusCode, 201);
  const regBody = reg.json() as Record<string, any>;
  assert.equal(regBody.user.username, username);
  assert.equal(regBody.user.email, email);
  assert.equal(regBody.user.role, "risk_analyst");
  assert.match(regBody.user.id, /^u-[0-9a-f]{8}$/);

  const loginRes = await app.inject({
    method: "POST",
    url: "/auth/login",
    payload: { username, password: "Tina!Pass99" },
  });
  assert.equal(loginRes.statusCode, 200);
  assert.equal((loginRes.json() as Record<string, unknown>).role, "risk_analyst");

  await app.close();
});

test("POST /auth/register — duplicate username rejected with 409", async () => {
  const app = buildServer();
  const res = await app.inject({
    method: "POST",
    url: "/auth/register",
    payload: {
      username: "alice.admin",
      email: `dupe${Date.now()}@apex-ews.test`,
      password: "Other!Pass1",
      display_name: "Imposter",
      role: "field_officer",
    },
  });
  assert.equal(res.statusCode, 409);
  assert.equal((res.json() as Record<string, unknown>).error, "username_taken");
  await app.close();
});

test("POST /auth/register — duplicate email rejected with 409", async () => {
  const app = buildServer();
  const res = await app.inject({
    method: "POST",
    url: "/auth/register",
    payload: {
      username: `dupemail${Date.now()}`,
      email: "alice.admin@apex-ews.test",
      password: "Other!Pass1",
      display_name: "Imposter",
      role: "field_officer",
    },
  });
  assert.equal(res.statusCode, 409);
  assert.equal((res.json() as Record<string, unknown>).error, "email_taken");
  await app.close();
});

test("POST /auth/register — invalid email rejected with 400", async () => {
  const app = buildServer();
  const res = await app.inject({
    method: "POST",
    url: "/auth/register",
    payload: {
      username: `noatsign${Date.now()}`,
      email: "not-an-email",
      password: "Good!Pass1",
      display_name: "Bad Email",
      role: "field_officer",
    },
  });
  assert.equal(res.statusCode, 400);
  assert.equal((res.json() as Record<string, unknown>).error, "email_invalid");
  await app.close();
});

test("POST /auth/register — weak password rejected with 400", async () => {
  const app = buildServer();
  const res = await app.inject({
    method: "POST",
    url: "/auth/register",
    payload: {
      username: `weak${Date.now()}`,
      email: `weak${Date.now()}@apex-ews.test`,
      password: "short",
      display_name: "Weak User",
      role: "field_officer",
    },
  });
  assert.equal(res.statusCode, 400);
  assert.equal((res.json() as Record<string, unknown>).error, "password_too_weak");
  await app.close();
});

test("POST /auth/register — invalid role rejected with 400", async () => {
  const app = buildServer();
  const res = await app.inject({
    method: "POST",
    url: "/auth/register",
    payload: {
      username: `badrole${Date.now()}`,
      email: `badrole${Date.now()}@apex-ews.test`,
      password: "Good!Pass1",
      display_name: "Bad Role",
      role: "ceo" as unknown as "admin",
    },
  });
  assert.equal(res.statusCode, 400);
  assert.equal((res.json() as Record<string, unknown>).error, "role_invalid");
  await app.close();
});

test("POST /auth/register — missing fields rejected with 400", async () => {
  const app = buildServer();
  const res = await app.inject({
    method: "POST",
    url: "/auth/register",
    payload: { username: "incomplete" },
  });
  assert.equal(res.statusCode, 400);
  await app.close();
});

// ───────── password reset flow ─────────

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

// Test-only env flag — surfaces the issued token in the reset-request
// response body so we can drive the rest of the flow without parsing logs.
process.env.AUTH_SVC_DEBUG_TOKENS = "1";

test("POST /auth/password/reset-request — known user gets a 202 with a token (debug field)", async () => {
  const app = buildServer();
  const res = await app.inject({
    method: "POST",
    url: "/auth/password/reset-request",
    payload: { username: "alice.admin" },
  });
  assert.equal(res.statusCode, 202);
  const body = res.json() as { ok: boolean; debug?: { token: string; reset_link: string } };
  assert.equal(body.ok, true);
  assert.ok(body.debug?.token, "expected debug.token in response");
  assert.match(body.debug!.reset_link, /\/reset-password\?token=/);
  await app.close();
});

test("POST /auth/password/reset-request — unknown user returns the same 202 (no enumeration)", async () => {
  const app = buildServer();
  const res = await app.inject({
    method: "POST",
    url: "/auth/password/reset-request",
    payload: { username: "nobody.here" },
  });
  assert.equal(res.statusCode, 202);
  assert.equal((res.json() as Record<string, unknown>).ok, true);
  await app.close();
});

test("POST /auth/password/reset-request — accepts email + issues token (round-trips)", async () => {
  const app = buildServer();
  // Register a fresh user so the round-trip doesn't change a seed user's
  // password and break later tests via singleton-store contamination.
  const stamp = Date.now();
  const username = `emaillookup${stamp}`;
  const email = `emaillookup${stamp}@apex-ews.test`;
  await app.inject({
    method: "POST",
    url: "/auth/register",
    payload: {
      username,
      email,
      password: "Original!1",
      display_name: "Email Lookup Tester",
      role: "field_officer",
    },
  });

  const req = await app.inject({
    method: "POST",
    url: "/auth/password/reset-request",
    payload: { email },
  });
  assert.equal(req.statusCode, 202);
  const token = (req.json() as { debug?: { token: string } }).debug?.token ?? "";
  assert.ok(token, "expected a debug token from the email lookup");

  const confirm = await app.inject({
    method: "POST",
    url: "/auth/password/reset-confirm",
    payload: { token, password: "EmailReset!1" },
  });
  assert.equal(confirm.statusCode, 200);
  assert.equal((confirm.json() as { username: string }).username, username);

  await app.close();
});

test("POST /auth/password/reset-request — unknown email returns the same 202 (no enumeration)", async () => {
  const app = buildServer();
  const res = await app.inject({
    method: "POST",
    url: "/auth/password/reset-request",
    payload: { email: "ghost@nowhere.test" },
  });
  assert.equal(res.statusCode, 202);
  // No debug field surfaced for unknown emails — backend doesn't issue a token.
  assert.equal((res.json() as { debug?: unknown }).debug, undefined);
  await app.close();
});

test("POST /auth/password/reset-request — empty body rejected with 400", async () => {
  const app = buildServer();
  const res = await app.inject({
    method: "POST",
    url: "/auth/password/reset-request",
    payload: {},
  });
  assert.equal(res.statusCode, 400);
  await app.close();
});

test("POST /auth/password/reset-confirm — token round-trips: old password fails, new password works", async () => {
  const app = buildServer();
  const req = await app.inject({
    method: "POST",
    url: "/auth/password/reset-request",
    payload: { username: "ravi.risk" },
  });
  const token = (req.json() as { debug?: { token: string } }).debug?.token ?? "";
  assert.ok(token, "expected a token from the request step");

  const confirm = await app.inject({
    method: "POST",
    url: "/auth/password/reset-confirm",
    payload: { token, password: "BrandNew!1" },
  });
  assert.equal(confirm.statusCode, 200);

  // Old password should now fail
  const oldLogin = await app.inject({
    method: "POST",
    url: "/auth/login",
    payload: { username: "ravi.risk", password: "RiskAnalyst!1" },
  });
  assert.equal(oldLogin.statusCode, 401);

  // New password should succeed
  const newLogin = await app.inject({
    method: "POST",
    url: "/auth/login",
    payload: { username: "ravi.risk", password: "BrandNew!1" },
  });
  assert.equal(newLogin.statusCode, 200);

  await app.close();
});

test("POST /auth/password/reset-confirm — unknown token rejected with 400", async () => {
  const app = buildServer();
  const res = await app.inject({
    method: "POST",
    url: "/auth/password/reset-confirm",
    payload: { token: "bogus", password: "Whatever!1" },
  });
  assert.equal(res.statusCode, 400);
  assert.equal((res.json() as Record<string, unknown>).error, "invalid_or_expired_token");
  await app.close();
});

test("POST /auth/password/reset-confirm — token is single-use", async () => {
  const app = buildServer();
  const req = await app.inject({
    method: "POST",
    url: "/auth/password/reset-request",
    payload: { username: "sue.super" },
  });
  const token = (req.json() as { debug?: { token: string } }).debug?.token ?? "";
  assert.ok(token);

  const first = await app.inject({
    method: "POST",
    url: "/auth/password/reset-confirm",
    payload: { token, password: "SuperFresh!1" },
  });
  assert.equal(first.statusCode, 200);

  const second = await app.inject({
    method: "POST",
    url: "/auth/password/reset-confirm",
    payload: { token, password: "Another!1" },
  });
  assert.equal(second.statusCode, 400);
  await app.close();
});

test("POST /auth/password/reset-confirm — weak password rejected with 400", async () => {
  const app = buildServer();
  const req = await app.inject({
    method: "POST",
    url: "/auth/password/reset-request",
    payload: { username: "fiona.field" },
  });
  const token = (req.json() as { debug?: { token: string } }).debug?.token ?? "";
  assert.ok(token);

  const res = await app.inject({
    method: "POST",
    url: "/auth/password/reset-confirm",
    payload: { token, password: "short" },
  });
  assert.equal(res.statusCode, 400);
  assert.equal((res.json() as Record<string, unknown>).error, "password_too_weak");
  await app.close();
});

test("POST /auth/password/admin-reset — admin can reset any user's password", async () => {
  const app = buildServer();
  const adminToken = await login(app, "alice.admin", "Admin!Pass1");

  const res = await app.inject({
    method: "POST",
    url: "/auth/password/admin-reset",
    headers: { authorization: `Bearer ${adminToken}` },
    payload: { username: "carl.collect", password: "ResetByAdmin!1" },
  });
  assert.equal(res.statusCode, 200);

  // Verify the new password works
  const newLogin = await app.inject({
    method: "POST",
    url: "/auth/login",
    payload: { username: "carl.collect", password: "ResetByAdmin!1" },
  });
  assert.equal(newLogin.statusCode, 200);

  await app.close();
});

test("POST /auth/password/admin-reset — non-admin rejected with 403", async () => {
  const app = buildServer();
  // Register a fresh user — earlier tests permanently mutate the seed
  // users' passwords via the singleton UserStore.
  const username = `nonadmin${Date.now()}`;
  const reg = await app.inject({
    method: "POST",
    url: "/auth/register",
    payload: {
      username,
      email: `${username}@apex-ews.test`,
      password: "Pass!Word1",
      display_name: "Non Admin",
      role: "field_officer",
    },
  });
  assert.equal(reg.statusCode, 201);
  const fieldToken = await login(app, username, "Pass!Word1");

  const res = await app.inject({
    method: "POST",
    url: "/auth/password/admin-reset",
    headers: { authorization: `Bearer ${fieldToken}` },
    payload: { username: "carl.collect", password: "Whatever!1" },
  });
  assert.equal(res.statusCode, 403);
  assert.equal((res.json() as Record<string, unknown>).error, "forbidden");
  await app.close();
});

test("POST /auth/password/admin-reset — missing token rejected with 401", async () => {
  const app = buildServer();
  const res = await app.inject({
    method: "POST",
    url: "/auth/password/admin-reset",
    payload: { username: "carl.collect", password: "Whatever!1" },
  });
  assert.equal(res.statusCode, 401);
  await app.close();
});

test("POST /auth/password/admin-reset — unknown user returns 404", async () => {
  const app = buildServer();
  const adminToken = await login(app, "alice.admin", "Admin!Pass1");
  const res = await app.inject({
    method: "POST",
    url: "/auth/password/admin-reset",
    headers: { authorization: `Bearer ${adminToken}` },
    payload: { username: "ghost.user", password: "Whatever!1" },
  });
  assert.equal(res.statusCode, 404);
  await app.close();
});

test("GET /auth/users — admin gets the list with public-shape projection", async () => {
  const app = buildServer();
  const adminToken = await login(app, "alice.admin", "Admin!Pass1");

  const res = await app.inject({
    method: "GET",
    url: "/auth/users",
    headers: { authorization: `Bearer ${adminToken}` },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { users: Array<{ id: string; username: string; role: string; display_name: string }> };
  assert.ok(Array.isArray(body.users));
  // All 5 seed users + any registered during this test run
  assert.ok(body.users.length >= 5, `expected ≥5 users, got ${body.users.length}`);
  const alice = body.users.find((u) => u.username === "alice.admin");
  assert.ok(alice);
  assert.equal(alice!.role, "admin");
  // Sanity: no sensitive fields leak
  assert.ok(!("passwordHash" in alice!));
  await app.close();
});

test("GET /auth/users — non-admin rejected with 403", async () => {
  const app = buildServer();
  const username = `nonadmin${Date.now()}`;
  const reg = await app.inject({
    method: "POST",
    url: "/auth/register",
    payload: {
      username,
      email: `${username}@apex-ews.test`,
      password: "Pass!Word1",
      display_name: "Non Admin",
      role: "risk_analyst",
    },
  });
  assert.equal(reg.statusCode, 201);
  const fieldToken = await login(app, username, "Pass!Word1");

  const res = await app.inject({
    method: "GET",
    url: "/auth/users",
    headers: { authorization: `Bearer ${fieldToken}` },
  });
  assert.equal(res.statusCode, 403);
  await app.close();
});

test("POST /auth/users — admin creates a user with email", async () => {
  const app = buildServer();
  const adminToken = await login(app, "alice.admin", "Admin!Pass1");
  const stamp = Date.now();
  const res = await app.inject({
    method: "POST",
    url: "/auth/users",
    headers: { authorization: `Bearer ${adminToken}` },
    payload: {
      username: `admincreated${stamp}`,
      email: `admincreated${stamp}@apex-ews.test`,
      password: "Admin!Made1",
      display_name: "Admin Created",
      role: "field_officer",
    },
  });
  assert.equal(res.statusCode, 201);
  const body = res.json() as Record<string, any>;
  assert.equal(body.user.role, "field_officer");
  assert.equal(body.user.username, `admincreated${stamp}`);
  await app.close();
});

test("POST /auth/users — non-admin rejected with 403", async () => {
  const app = buildServer();
  const username = `creator${Date.now()}`;
  const reg = await app.inject({
    method: "POST",
    url: "/auth/register",
    payload: {
      username,
      email: `${username}@apex-ews.test`,
      password: "Pass!Word1",
      display_name: "Wannabe Creator",
      role: "risk_analyst",
    },
  });
  assert.equal(reg.statusCode, 201);
  const fieldToken = await login(app, username, "Pass!Word1");
  const res = await app.inject({
    method: "POST",
    url: "/auth/users",
    headers: { authorization: `Bearer ${fieldToken}` },
    payload: {
      username: "shouldnt.exist",
      email: "shouldnt.exist@apex-ews.test",
      password: "Whatever!1",
      display_name: "Nope",
      role: "field_officer",
    },
  });
  assert.equal(res.statusCode, 403);
  await app.close();
});

test("DELETE /auth/users/:username — admin deletes a user", async () => {
  const app = buildServer();
  const adminToken = await login(app, "alice.admin", "Admin!Pass1");
  const stamp = Date.now();
  // Create then delete
  const created = await app.inject({
    method: "POST",
    url: "/auth/users",
    headers: { authorization: `Bearer ${adminToken}` },
    payload: {
      username: `todelete${stamp}`,
      email: `todelete${stamp}@apex-ews.test`,
      password: "Delete!Me1",
      display_name: "Will Be Deleted",
      role: "field_officer",
    },
  });
  assert.equal(created.statusCode, 201);
  const del = await app.inject({
    method: "DELETE",
    url: `/auth/users/todelete${stamp}`,
    headers: { authorization: `Bearer ${adminToken}` },
  });
  assert.equal(del.statusCode, 204);
  await app.close();
});

test("DELETE /auth/users/:username — admin cannot delete self (409)", async () => {
  const app = buildServer();
  const adminToken = await login(app, "alice.admin", "Admin!Pass1");
  const res = await app.inject({
    method: "DELETE",
    url: "/auth/users/alice.admin",
    headers: { authorization: `Bearer ${adminToken}` },
  });
  assert.equal(res.statusCode, 409);
  assert.equal((res.json() as Record<string, unknown>).error, "cannot_delete_self");
  await app.close();
});

test("DELETE /auth/users/:username — unknown user returns 404", async () => {
  const app = buildServer();
  const adminToken = await login(app, "alice.admin", "Admin!Pass1");
  const res = await app.inject({
    method: "DELETE",
    url: "/auth/users/ghost.user",
    headers: { authorization: `Bearer ${adminToken}` },
  });
  assert.equal(res.statusCode, 404);
  await app.close();
});

test("POST /auth/users/:username/lock + login — locked user gets 403 locked_account", async () => {
  const app = buildServer();
  const adminToken = await login(app, "alice.admin", "Admin!Pass1");
  const stamp = Date.now();
  // Create a fresh user to lock so we don't impact other tests' logins.
  const created = await app.inject({
    method: "POST",
    url: "/auth/users",
    headers: { authorization: `Bearer ${adminToken}` },
    payload: {
      username: `tolock${stamp}`,
      email: `tolock${stamp}@apex-ews.test`,
      password: "Lock!Me1",
      display_name: "Will Be Locked",
      role: "field_officer",
    },
  });
  assert.equal(created.statusCode, 201);
  // Verify login works first
  const before = await app.inject({
    method: "POST",
    url: "/auth/login",
    payload: { username: `tolock${stamp}`, password: "Lock!Me1" },
  });
  assert.equal(before.statusCode, 200);

  // Lock
  const lock = await app.inject({
    method: "POST",
    url: `/auth/users/tolock${stamp}/lock`,
    headers: { authorization: `Bearer ${adminToken}` },
  });
  assert.equal(lock.statusCode, 200);
  assert.equal((lock.json() as { locked: boolean }).locked, true);

  // Login should now 403
  const after = await app.inject({
    method: "POST",
    url: "/auth/login",
    payload: { username: `tolock${stamp}`, password: "Lock!Me1" },
  });
  assert.equal(after.statusCode, 403);
  assert.equal((after.json() as Record<string, unknown>).error, "locked_account");

  // Unlock and verify login works again
  const unlock = await app.inject({
    method: "POST",
    url: `/auth/users/tolock${stamp}/unlock`,
    headers: { authorization: `Bearer ${adminToken}` },
  });
  assert.equal(unlock.statusCode, 200);
  assert.equal((unlock.json() as { locked: boolean }).locked, false);

  const afterUnlock = await app.inject({
    method: "POST",
    url: "/auth/login",
    payload: { username: `tolock${stamp}`, password: "Lock!Me1" },
  });
  assert.equal(afterUnlock.statusCode, 200);

  await app.close();
});

test("POST /auth/users/:username/lock — admin cannot lock self (409)", async () => {
  const app = buildServer();
  const adminToken = await login(app, "alice.admin", "Admin!Pass1");
  const res = await app.inject({
    method: "POST",
    url: "/auth/users/alice.admin/lock",
    headers: { authorization: `Bearer ${adminToken}` },
  });
  assert.equal(res.statusCode, 409);
  assert.equal((res.json() as Record<string, unknown>).error, "cannot_lock_self");
  await app.close();
});

test("GET /auth/users — missing token rejected with 401", async () => {
  const app = buildServer();
  const res = await app.inject({ method: "GET", url: "/auth/users" });
  assert.equal(res.statusCode, 401);
  await app.close();
});
