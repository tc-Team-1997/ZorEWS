// services/auth-svc/src/__tests__/totp.test.ts
//
// TOTP 2FA round-trip coverage (T5 Module 1.1).
//
// Strategy: each test runs against a fresh buildServer(); the in-memory
// 2FA store carries between requests in the same test but `__reset...`
// helpers wipe it between tests. We use the otpauth lib directly to
// generate live codes against the secret returned by /auth/2fa/setup —
// that's the same path a real authenticator app would take.

process.env.AUTH_SVC_RATE_LIMIT = "off";

import test from "node:test";
import assert from "node:assert/strict";
import { Secret, TOTP } from "otpauth";
import { buildServer } from "../server.js";
import { __reset2faForTests } from "../totp.js";
import { __resetAuthStateForTests } from "../routes/auth.js";

function liveCodeFor(secret_base32: string): string {
  return new TOTP({
    issuer: "APEX EWS",
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret: Secret.fromBase32(secret_base32),
  }).generate();
}

async function adminToken(app: ReturnType<typeof buildServer>): Promise<string> {
  const r = await app.inject({
    method: "POST",
    url: "/auth/login",
    payload: { username: "alice.admin", password: "Admin!Pass1" },
  });
  assert.equal(r.statusCode, 200);
  return (r.json() as Record<string, string>).access_token;
}

test("POST /auth/2fa/setup returns secret + otpauth URL", async () => {
  __reset2faForTests();
  __resetAuthStateForTests();
  const app = buildServer();
  const token = await adminToken(app);
  const setup = await app.inject({
    method: "POST",
    url: "/auth/2fa/setup",
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(setup.statusCode, 200);
  const body = setup.json() as Record<string, unknown>;
  assert.equal(body.algorithm, "SHA1");
  assert.equal(body.digits, 6);
  assert.equal(body.period_seconds, 30);
  assert.match(body.secret_base32 as string, /^[A-Z2-7]+=*$/);
  assert.match(body.otpauth_url as string, /^otpauth:\/\/totp\//);
  assert.ok((body.otpauth_url as string).includes("alice.admin"));
  assert.equal(body.expires_in_seconds, 600);
  await app.close();
});

test("setup → verify flow promotes pending to enrolled + returns backup codes", async () => {
  __reset2faForTests();
  __resetAuthStateForTests();
  const app = buildServer();
  const token = await adminToken(app);

  const setup = await app.inject({
    method: "POST",
    url: "/auth/2fa/setup",
    headers: { authorization: `Bearer ${token}` },
  });
  const { secret_base32 } = setup.json() as Record<string, string>;

  const verify = await app.inject({
    method: "POST",
    url: "/auth/2fa/verify",
    headers: { authorization: `Bearer ${token}` },
    payload: { code: liveCodeFor(secret_base32) },
  });
  assert.equal(verify.statusCode, 200);
  const body = verify.json() as Record<string, unknown>;
  assert.equal(body.ok, true);
  assert.ok(Array.isArray(body.backup_codes));
  assert.equal((body.backup_codes as string[]).length, 10);
  for (const c of body.backup_codes as string[]) {
    assert.match(c, /^[0-9a-f]{10}$/, "10-hex backup code");
  }

  // Status reflects enrolment
  const status = await app.inject({
    method: "GET",
    url: "/auth/2fa/status",
    headers: { authorization: `Bearer ${token}` },
  });
  const s = status.json() as Record<string, unknown>;
  assert.equal(s.enrolled, true);
  assert.equal(s.backup_codes_remaining, 10);
  await app.close();
});

test("verify with wrong code returns 401 invalid_totp_code", async () => {
  __reset2faForTests();
  __resetAuthStateForTests();
  const app = buildServer();
  const token = await adminToken(app);
  await app.inject({
    method: "POST",
    url: "/auth/2fa/setup",
    headers: { authorization: `Bearer ${token}` },
  });
  const verify = await app.inject({
    method: "POST",
    url: "/auth/2fa/verify",
    headers: { authorization: `Bearer ${token}` },
    payload: { code: "000000" }, // basically guaranteed wrong
  });
  assert.equal(verify.statusCode, 401);
  assert.equal((verify.json() as Record<string, unknown>).error, "invalid_totp_code");
  await app.close();
});

test("verify with malformed code returns 400", async () => {
  __reset2faForTests();
  __resetAuthStateForTests();
  const app = buildServer();
  const token = await adminToken(app);
  await app.inject({
    method: "POST",
    url: "/auth/2fa/setup",
    headers: { authorization: `Bearer ${token}` },
  });
  for (const bad of ["12345", "abcdef", "", "1234567"]) {
    const r = await app.inject({
      method: "POST",
      url: "/auth/2fa/verify",
      headers: { authorization: `Bearer ${token}` },
      payload: { code: bad },
    });
    assert.equal(r.statusCode, 400, `code=${bad} should reject 400`);
  }
  await app.close();
});

test("login flow — enrolled user gets requires_2fa partial → /auth/login/verify-2fa exchanges", async () => {
  __reset2faForTests();
  __resetAuthStateForTests();
  const app = buildServer();

  // Enrol
  const token = await adminToken(app);
  const setup = await app.inject({
    method: "POST",
    url: "/auth/2fa/setup",
    headers: { authorization: `Bearer ${token}` },
  });
  const { secret_base32 } = setup.json() as Record<string, string>;
  await app.inject({
    method: "POST",
    url: "/auth/2fa/verify",
    headers: { authorization: `Bearer ${token}` },
    payload: { code: liveCodeFor(secret_base32) },
  });

  // Re-login — should now require 2FA
  const partialLogin = await app.inject({
    method: "POST",
    url: "/auth/login",
    payload: { username: "alice.admin", password: "Admin!Pass1" },
  });
  assert.equal(partialLogin.statusCode, 200);
  const partialBody = partialLogin.json() as Record<string, unknown>;
  assert.equal(partialBody.requires_2fa, true);
  assert.equal(typeof partialBody.partial_token, "string");
  assert.equal(partialBody.access_token, undefined, "no access_token in partial");

  // Exchange partial → full token via TOTP code
  const exchange = await app.inject({
    method: "POST",
    url: "/auth/login/verify-2fa",
    payload: {
      partial_token: partialBody.partial_token,
      code: liveCodeFor(secret_base32),
    },
  });
  assert.equal(exchange.statusCode, 200);
  const final = exchange.json() as Record<string, unknown>;
  assert.equal(typeof final.access_token, "string");
  assert.equal(typeof final.refresh_token, "string");
  assert.equal(final.role, "admin");
  await app.close();
});

test("/auth/login/verify-2fa with wrong code → 401", async () => {
  __reset2faForTests();
  __resetAuthStateForTests();
  const app = buildServer();
  const token = await adminToken(app);
  const setup = await app.inject({
    method: "POST",
    url: "/auth/2fa/setup",
    headers: { authorization: `Bearer ${token}` },
  });
  const { secret_base32 } = setup.json() as Record<string, string>;
  await app.inject({
    method: "POST",
    url: "/auth/2fa/verify",
    headers: { authorization: `Bearer ${token}` },
    payload: { code: liveCodeFor(secret_base32) },
  });
  const partialLogin = await app.inject({
    method: "POST",
    url: "/auth/login",
    payload: { username: "alice.admin", password: "Admin!Pass1" },
  });
  const partialBody = partialLogin.json() as Record<string, string>;
  const exchange = await app.inject({
    method: "POST",
    url: "/auth/login/verify-2fa",
    payload: { partial_token: partialBody.partial_token, code: "000000" },
  });
  assert.equal(exchange.statusCode, 401);
  await app.close();
});

test("backup code is single-use", async () => {
  __reset2faForTests();
  __resetAuthStateForTests();
  const app = buildServer();
  const token = await adminToken(app);
  const setup = await app.inject({
    method: "POST",
    url: "/auth/2fa/setup",
    headers: { authorization: `Bearer ${token}` },
  });
  const { secret_base32 } = setup.json() as Record<string, string>;
  const verify = await app.inject({
    method: "POST",
    url: "/auth/2fa/verify",
    headers: { authorization: `Bearer ${token}` },
    payload: { code: liveCodeFor(secret_base32) },
  });
  const codes = (verify.json() as { backup_codes: string[] }).backup_codes;
  const oneCode = codes[0]!;

  // Login once with backup_code — succeeds, code consumed
  const partial1 = (
    await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { username: "alice.admin", password: "Admin!Pass1" },
    })
  ).json() as Record<string, string>;
  const ok = await app.inject({
    method: "POST",
    url: "/auth/login/verify-2fa",
    payload: { partial_token: partial1.partial_token, backup_code: oneCode },
  });
  assert.equal(ok.statusCode, 200);
  assert.equal((ok.json() as Record<string, number>).backup_codes_remaining, 9);

  // Re-using the same backup code fails
  const partial2 = (
    await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { username: "alice.admin", password: "Admin!Pass1" },
    })
  ).json() as Record<string, string>;
  const replay = await app.inject({
    method: "POST",
    url: "/auth/login/verify-2fa",
    payload: { partial_token: partial2.partial_token, backup_code: oneCode },
  });
  assert.equal(replay.statusCode, 401);
  await app.close();
});

test("DELETE /auth/2fa disables for the caller", async () => {
  __reset2faForTests();
  __resetAuthStateForTests();
  const app = buildServer();
  const token = await adminToken(app);
  const setup = await app.inject({
    method: "POST",
    url: "/auth/2fa/setup",
    headers: { authorization: `Bearer ${token}` },
  });
  const { secret_base32 } = setup.json() as Record<string, string>;
  await app.inject({
    method: "POST",
    url: "/auth/2fa/verify",
    headers: { authorization: `Bearer ${token}` },
    payload: { code: liveCodeFor(secret_base32) },
  });

  const del = await app.inject({
    method: "DELETE",
    url: "/auth/2fa",
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(del.statusCode, 204);

  // Login no longer requires 2FA
  const login = await app.inject({
    method: "POST",
    url: "/auth/login",
    payload: { username: "alice.admin", password: "Admin!Pass1" },
  });
  const body = login.json() as Record<string, unknown>;
  assert.equal(body.requires_2fa, undefined, "after disable, 2FA gate is off");
  assert.equal(typeof body.access_token, "string");
  await app.close();
});

test("non-admin cannot disable 2FA for another user", async () => {
  __reset2faForTests();
  __resetAuthStateForTests();
  const app = buildServer();
  // login as risk_analyst
  const r = await app.inject({
    method: "POST",
    url: "/auth/login",
    payload: { username: "ravi.risk", password: "RiskAnalyst!1" },
  });
  const ravi = (r.json() as Record<string, string>).access_token;
  const del = await app.inject({
    method: "DELETE",
    url: "/auth/2fa?username=alice.admin",
    headers: { authorization: `Bearer ${ravi}` },
  });
  assert.equal(del.statusCode, 403);
  await app.close();
});

test("setup is rejected with 409 when already enrolled", async () => {
  __reset2faForTests();
  __resetAuthStateForTests();
  const app = buildServer();
  const token = await adminToken(app);
  const setup1 = await app.inject({
    method: "POST",
    url: "/auth/2fa/setup",
    headers: { authorization: `Bearer ${token}` },
  });
  const { secret_base32 } = setup1.json() as Record<string, string>;
  await app.inject({
    method: "POST",
    url: "/auth/2fa/verify",
    headers: { authorization: `Bearer ${token}` },
    payload: { code: liveCodeFor(secret_base32) },
  });
  const setup2 = await app.inject({
    method: "POST",
    url: "/auth/2fa/setup",
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(setup2.statusCode, 409);
  assert.equal((setup2.json() as Record<string, unknown>).error, "already_enrolled");
  await app.close();
});
