// First-login wizard tests. Rate limiting OFF (multi-step admin flows).
process.env.AUTH_SVC_RATE_LIMIT = "off";

import test from "node:test";
import assert from "node:assert/strict";
import { buildServer } from "../server.js";
import { __resetAuthStateForTests } from "../routes/auth.js";

async function adminLogin(app: ReturnType<typeof buildServer>): Promise<string> {
  const r = await app.inject({
    method: "POST",
    url: "/auth/login",
    payload: { username: "alice.admin", password: "Admin!Pass1" },
  });
  return (r.json() as { access_token: string }).access_token;
}

test("seed users have must_change_password=false (frictionless demo logins)", async () => {
  __resetAuthStateForTests();
  const app = buildServer();
  const r = await app.inject({
    method: "POST",
    url: "/auth/login",
    payload: { username: "alice.admin", password: "Admin!Pass1" },
  });
  assert.equal(r.statusCode, 200);
  const body = r.json() as Record<string, unknown>;
  assert.equal(body.must_change_password, false);
  assert.ok(typeof body.terms_accepted_at === "string");
  await app.close();
});

test("admin-created user defaults must_change_password=true; first login surfaces the flag", async () => {
  __resetAuthStateForTests();
  const app = buildServer();
  const adminToken = await adminLogin(app);
  const stamp = Date.now();
  const username = `firstlogin${stamp}`;

  const create = await app.inject({
    method: "POST",
    url: "/auth/users",
    headers: { authorization: `Bearer ${adminToken}` },
    payload: {
      username,
      email: `${username}@apex-ews.test`,
      password: "Initial!Pass1",
      display_name: "First Login Tester",
      role: "field_officer",
    },
  });
  assert.equal(create.statusCode, 201);
  const created = create.json() as { user: { must_change_password: boolean } };
  assert.equal(created.user.must_change_password, true);

  const login = await app.inject({
    method: "POST",
    url: "/auth/login",
    payload: { username, password: "Initial!Pass1" },
  });
  assert.equal(login.statusCode, 200);
  const body = login.json() as Record<string, unknown>;
  assert.equal(body.must_change_password, true);
  assert.equal(body.terms_accepted_at, null);
  await app.close();
});

test("admin can opt out of must_change_password via skip_first_login: true", async () => {
  __resetAuthStateForTests();
  const app = buildServer();
  const adminToken = await adminLogin(app);
  const stamp = Date.now();
  const username = `skipflow${stamp}`;
  const create = await app.inject({
    method: "POST",
    url: "/auth/users",
    headers: { authorization: `Bearer ${adminToken}` },
    payload: {
      username,
      email: `${username}@apex-ews.test`,
      password: "NoChange!1",
      display_name: "No Change",
      role: "field_officer",
      skip_first_login: true,
    },
  });
  const created = create.json() as { user: { must_change_password: boolean } };
  assert.equal(created.user.must_change_password, false);
  await app.close();
});

test("POST /auth/first-login/complete — happy path: rotates password + records T&C", async () => {
  __resetAuthStateForTests();
  const app = buildServer();
  const adminToken = await adminLogin(app);
  const stamp = Date.now();
  const username = `rotated${stamp}`;
  await app.inject({
    method: "POST",
    url: "/auth/users",
    headers: { authorization: `Bearer ${adminToken}` },
    payload: {
      username,
      email: `${username}@apex-ews.test`,
      password: "Initial!Pass1",
      display_name: "Rotated User",
      role: "risk_analyst",
    },
  });

  const login = await app.inject({
    method: "POST",
    url: "/auth/login",
    payload: { username, password: "Initial!Pass1" },
  });
  const access = (login.json() as { access_token: string }).access_token;

  const complete = await app.inject({
    method: "POST",
    url: "/auth/first-login/complete",
    headers: { authorization: `Bearer ${access}` },
    payload: { new_password: "ChosenByMe!2", accept_terms: true },
  });
  assert.equal(complete.statusCode, 200);
  const body = complete.json() as Record<string, unknown>;
  assert.equal(body.ok, true);
  assert.ok(typeof body.terms_accepted_at === "string");

  // Subsequent login should now use the new password and report flag cleared.
  const newLogin = await app.inject({
    method: "POST",
    url: "/auth/login",
    payload: { username, password: "ChosenByMe!2" },
  });
  assert.equal(newLogin.statusCode, 200);
  assert.equal((newLogin.json() as Record<string, unknown>).must_change_password, false);

  // Old password should not work.
  const old = await app.inject({
    method: "POST",
    url: "/auth/login",
    payload: { username, password: "Initial!Pass1" },
  });
  assert.equal(old.statusCode, 401);

  await app.close();
});

test("POST /auth/first-login/complete — accept_terms must be true (400)", async () => {
  __resetAuthStateForTests();
  const app = buildServer();
  const adminToken = await adminLogin(app);
  const stamp = Date.now();
  const username = `notermsacc${stamp}`;
  await app.inject({
    method: "POST",
    url: "/auth/users",
    headers: { authorization: `Bearer ${adminToken}` },
    payload: {
      username,
      email: `${username}@apex-ews.test`,
      password: "Initial!Pass1",
      display_name: "No T&C",
      role: "field_officer",
    },
  });
  const login = await app.inject({
    method: "POST",
    url: "/auth/login",
    payload: { username, password: "Initial!Pass1" },
  });
  const access = (login.json() as { access_token: string }).access_token;

  const r = await app.inject({
    method: "POST",
    url: "/auth/first-login/complete",
    headers: { authorization: `Bearer ${access}` },
    payload: { new_password: "Other!Pass2", accept_terms: false },
  });
  assert.equal(r.statusCode, 400);
  assert.equal((r.json() as Record<string, unknown>).error, "must_accept_terms");
  await app.close();
});

test("POST /auth/first-login/complete — reusing the initial password (400 password_reused)", async () => {
  __resetAuthStateForTests();
  const app = buildServer();
  const adminToken = await adminLogin(app);
  const stamp = Date.now();
  const username = `samepw${stamp}`;
  await app.inject({
    method: "POST",
    url: "/auth/users",
    headers: { authorization: `Bearer ${adminToken}` },
    payload: {
      username,
      email: `${username}@apex-ews.test`,
      password: "Initial!Pass1",
      display_name: "Same PW",
      role: "field_officer",
    },
  });
  const login = await app.inject({
    method: "POST",
    url: "/auth/login",
    payload: { username, password: "Initial!Pass1" },
  });
  const access = (login.json() as { access_token: string }).access_token;

  const r = await app.inject({
    method: "POST",
    url: "/auth/first-login/complete",
    headers: { authorization: `Bearer ${access}` },
    payload: { new_password: "Initial!Pass1", accept_terms: true },
  });
  assert.equal(r.statusCode, 400);
  assert.equal((r.json() as Record<string, unknown>).error, "password_reused");
  await app.close();
});

test("POST /auth/first-login/complete — already-completed user gets 409", async () => {
  __resetAuthStateForTests();
  const app = buildServer();
  // Seed users start with must_change_password=false, so trying to
  // complete first-login as one of them should 409.
  const login = await app.inject({
    method: "POST",
    url: "/auth/login",
    payload: { username: "alice.admin", password: "Admin!Pass1" },
  });
  const access = (login.json() as { access_token: string }).access_token;

  const r = await app.inject({
    method: "POST",
    url: "/auth/first-login/complete",
    headers: { authorization: `Bearer ${access}` },
    payload: { new_password: "Brand!New123", accept_terms: true },
  });
  assert.equal(r.statusCode, 409);
  assert.equal((r.json() as Record<string, unknown>).error, "first_login_already_complete");
  await app.close();
});
