// /auth/me/activity tests. Rate limiting OFF — multi-step admin flows
// would otherwise trip the cap.
process.env.AUTH_SVC_RATE_LIMIT = "off";

import test from "node:test";
import assert from "node:assert/strict";
import { buildServer } from "../server.js";
import { __resetAuthStateForTests } from "../routes/auth.js";

async function login(
  app: ReturnType<typeof buildServer>,
  username: string,
  password: string,
): Promise<string> {
  const r = await app.inject({
    method: "POST",
    url: "/auth/login",
    payload: { username, password },
  });
  if (r.statusCode !== 200) throw new Error(`login failed: ${r.statusCode}`);
  return (r.json() as { access_token: string }).access_token;
}

test("GET /auth/me/activity — returns the caller's own events only", async () => {
  __resetAuthStateForTests();
  const app = buildServer();

  // Generate events for two different users so we can prove cross-user
  // isolation. ravi.risk has 1 failure + 1 success; alice.admin has 1 success.
  await app.inject({
    method: "POST",
    url: "/auth/login",
    payload: { username: "ravi.risk", password: "wrong" },
  });
  const raviToken = await login(app, "ravi.risk", "RiskAnalyst!1");
  const aliceToken = await login(app, "alice.admin", "Admin!Pass1");

  // Ravi's activity — should include the failure + success, but NOT alice's.
  const raviRes = await app.inject({
    method: "GET",
    url: "/auth/me/activity",
    headers: { authorization: `Bearer ${raviToken}` },
  });
  assert.equal(raviRes.statusCode, 200);
  const raviBody = raviRes.json() as {
    events: Array<{ type: string; target_username: string }>;
    username: string;
  };
  assert.equal(raviBody.username, "ravi.risk");
  assert.ok(raviBody.events.length >= 2);
  for (const e of raviBody.events) {
    assert.equal(e.target_username, "ravi.risk", "no foreign rows");
  }
  const types = raviBody.events.map((e) => e.type);
  assert.ok(types.includes("login_success"));
  assert.ok(types.includes("login_failure"));

  // Alice's activity — only her own.
  const aliceRes = await app.inject({
    method: "GET",
    url: "/auth/me/activity",
    headers: { authorization: `Bearer ${aliceToken}` },
  });
  const aliceBody = aliceRes.json() as { events: Array<{ target_username: string }> };
  for (const e of aliceBody.events) {
    assert.equal(e.target_username, "alice.admin");
  }
  await app.close();
});

test("GET /auth/me/activity — limit param caps the result count", async () => {
  __resetAuthStateForTests();
  const app = buildServer();
  // Generate ≥ 5 events for fiona without tripping the auto-lockout
  // (5 wrong-passwords-in-a-row locks). 3 wrong + 1 right resets the
  // counter, then 3 more wrong stays under the lockout threshold.
  for (let i = 0; i < 3; i++) {
    await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { username: "fiona.field", password: "wrong" },
    });
  }
  await login(app, "fiona.field", "Field!Pass1");
  for (let i = 0; i < 3; i++) {
    await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { username: "fiona.field", password: "wrong" },
    });
  }
  const token = await login(app, "fiona.field", "Field!Pass1");
  const res = await app.inject({
    method: "GET",
    url: "/auth/me/activity?limit=3",
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { events: unknown[] };
  assert.equal(body.events.length, 3);
  await app.close();
});

test("GET /auth/me/activity — works for all roles (not admin-gated)", async () => {
  __resetAuthStateForTests();
  const app = buildServer();
  // field_officer is the lowest-privileged role — confirm it can read its own.
  const fieldToken = await login(app, "fiona.field", "Field!Pass1");
  const res = await app.inject({
    method: "GET",
    url: "/auth/me/activity",
    headers: { authorization: `Bearer ${fieldToken}` },
  });
  assert.equal(res.statusCode, 200);
  await app.close();
});

test("GET /auth/me/activity — missing token rejected with 401", async () => {
  __resetAuthStateForTests();
  const app = buildServer();
  const res = await app.inject({ method: "GET", url: "/auth/me/activity" });
  assert.equal(res.statusCode, 401);
  await app.close();
});
