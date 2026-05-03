// Audit log tests run with rate limiting OFF — the multi-step admin flows
// would otherwise hit the login cap.
process.env.AUTH_SVC_RATE_LIMIT = "off";
process.env.AUTH_SVC_DEBUG_TOKENS = "1";

import test from "node:test";
import assert from "node:assert/strict";
import { AuthAuditLog } from "../audit_log.js";
import { buildServer } from "../server.js";
import { __resetAuthStateForTests } from "../routes/auth.js";

test("AuthAuditLog — append + query newest-first", () => {
  const log = new AuthAuditLog();
  log.append({ type: "login_success", target_username: "alice.admin" });
  log.append({ type: "login_failure", target_username: "alice.admin" });
  log.append({ type: "login_success", target_username: "ravi.risk" });

  const all = log.query();
  assert.equal(all.length, 3);
  assert.equal(all[0]!.target_username, "ravi.risk", "newest first");
  assert.equal(all[2]!.target_username, "alice.admin");
});

test("AuthAuditLog — type and target_username filters AND together", () => {
  const log = new AuthAuditLog();
  log.append({ type: "login_success", target_username: "alice.admin" });
  log.append({ type: "login_failure", target_username: "alice.admin" });
  log.append({ type: "login_failure", target_username: "ravi.risk" });

  const aliceFails = log.query({ type: "login_failure", target_username: "alice.admin" });
  assert.equal(aliceFails.length, 1);
  assert.equal(aliceFails[0]!.target_username, "alice.admin");
  assert.equal(aliceFails[0]!.type, "login_failure");
});

test("AuthAuditLog — ring buffer evicts oldest beyond cap", () => {
  const log = new AuthAuditLog(3);
  for (let i = 0; i < 5; i++) {
    log.append({ type: "login_success", target_username: `user${i}` });
  }
  assert.equal(log.size(), 3);
  const all = log.query();
  // Newest 3 only — user2, user3, user4 (newest-first → user4, user3, user2)
  assert.deepEqual(
    all.map((e) => e.target_username),
    ["user4", "user3", "user2"],
  );
});

test("AuthAuditLog — limit caps the result count", () => {
  const log = new AuthAuditLog();
  for (let i = 0; i < 50; i++) {
    log.append({ type: "login_success", target_username: `user${i}` });
  }
  const limited = log.query({ limit: 5 });
  assert.equal(limited.length, 5);
});

test("GET /auth/audit-log — admin gets newest-first events with type filter", async () => {
  __resetAuthStateForTests();
  const app = buildServer();

  // Generate a mix of events
  await app.inject({
    method: "POST",
    url: "/auth/login",
    payload: { username: "alice.admin", password: "wrong" },
  });
  const aliceOk = await app.inject({
    method: "POST",
    url: "/auth/login",
    payload: { username: "alice.admin", password: "Admin!Pass1" },
  });
  assert.equal(aliceOk.statusCode, 200);
  const adminToken = (aliceOk.json() as { access_token: string }).access_token;

  // Read all
  const allRes = await app.inject({
    method: "GET",
    url: "/auth/audit-log",
    headers: { authorization: `Bearer ${adminToken}` },
  });
  assert.equal(allRes.statusCode, 200);
  const allBody = allRes.json() as { events: Array<{ type: string; target_username: string }> };
  assert.ok(allBody.events.length >= 2);

  // Filter to login_failure only
  const failsRes = await app.inject({
    method: "GET",
    url: "/auth/audit-log?type=login_failure",
    headers: { authorization: `Bearer ${adminToken}` },
  });
  assert.equal(failsRes.statusCode, 200);
  const failsBody = failsRes.json() as { events: Array<{ type: string; target_username: string }> };
  assert.ok(failsBody.events.length >= 1);
  for (const e of failsBody.events) {
    assert.equal(e.type, "login_failure", `expected only login_failure, saw ${e.type}`);
  }

  await app.close();
});

test("GET /auth/audit-log — non-admin rejected with 403", async () => {
  __resetAuthStateForTests();
  const app = buildServer();
  const ravi = await app.inject({
    method: "POST",
    url: "/auth/login",
    payload: { username: "ravi.risk", password: "RiskAnalyst!1" },
  });
  const raviToken = (ravi.json() as { access_token: string }).access_token;
  const res = await app.inject({
    method: "GET",
    url: "/auth/audit-log",
    headers: { authorization: `Bearer ${raviToken}` },
  });
  assert.equal(res.statusCode, 403);
  await app.close();
});

test("GET /auth/audit-log — missing token rejected with 401", async () => {
  __resetAuthStateForTests();
  const app = buildServer();
  const res = await app.inject({ method: "GET", url: "/auth/audit-log" });
  assert.equal(res.statusCode, 401);
  await app.close();
});

test("login_success + login_failure events captured with target_username and ip", async () => {
  __resetAuthStateForTests();
  const app = buildServer();

  await app.inject({
    method: "POST",
    url: "/auth/login",
    payload: { username: "ravi.risk", password: "wrong" },
  });
  const ok = await app.inject({
    method: "POST",
    url: "/auth/login",
    payload: { username: "ravi.risk", password: "RiskAnalyst!1" },
  });
  const adminLogin = await app.inject({
    method: "POST",
    url: "/auth/login",
    payload: { username: "alice.admin", password: "Admin!Pass1" },
  });
  const adminToken = (adminLogin.json() as { access_token: string }).access_token;

  const res = await app.inject({
    method: "GET",
    url: "/auth/audit-log?target_username=ravi.risk",
    headers: { authorization: `Bearer ${adminToken}` },
  });
  const body = res.json() as { events: Array<{ type: string; ip: string }> };
  const types = body.events.map((e) => e.type);
  assert.ok(types.includes("login_success"), `expected login_success, got ${JSON.stringify(types)}`);
  assert.ok(types.includes("login_failure"));
  for (const e of body.events) {
    assert.ok(typeof e.ip === "string" && e.ip.length > 0, "ip should be populated");
  }
  assert.equal(ok.statusCode, 200);
});

test("password_reset_complete + admin_password_reset events captured", async () => {
  __resetAuthStateForTests();
  const app = buildServer();

  // Self-service reset
  const reqRes = await app.inject({
    method: "POST",
    url: "/auth/password/reset-request",
    payload: { username: "fiona.field" },
  });
  const token = (reqRes.json() as { debug?: { token: string } }).debug?.token ?? "";
  await app.inject({
    method: "POST",
    url: "/auth/password/reset-confirm",
    payload: { token, password: "NewField!2" },
  });

  // Admin reset
  const aliceOk = await app.inject({
    method: "POST",
    url: "/auth/login",
    payload: { username: "alice.admin", password: "Admin!Pass1" },
  });
  const adminToken = (aliceOk.json() as { access_token: string }).access_token;
  await app.inject({
    method: "POST",
    url: "/auth/password/admin-reset",
    headers: { authorization: `Bearer ${adminToken}` },
    payload: { username: "carl.collect", password: "AdminSet!1" },
  });

  const allRes = await app.inject({
    method: "GET",
    url: "/auth/audit-log?limit=1000",
    headers: { authorization: `Bearer ${adminToken}` },
  });
  const events = (allRes.json() as { events: Array<{ type: string; target_username: string }> }).events;
  const types = events.map((e) => e.type);
  assert.ok(types.includes("password_reset_request"));
  assert.ok(types.includes("password_reset_complete"));
  assert.ok(types.includes("admin_password_reset"));
  const adminResetEv = events.find((e) => e.type === "admin_password_reset");
  assert.equal(adminResetEv?.target_username, "carl.collect");
});

// T4.24 Phase 3 — tenant_id + channel
test("AuthAuditLog — tenant_id defaults to BANK_DEMO when not supplied", () => {
  const log = new AuthAuditLog();
  log.append({ type: "login_success", target_username: "alice.admin" });
  const e = log.query()[0]!;
  assert.equal(e.tenant_id, "BANK_DEMO");
  assert.equal(e.channel, null);
});

test("AuthAuditLog — tenant_id + channel are persisted on the event", () => {
  const log = new AuthAuditLog();
  log.append({
    type: "login_success",
    target_username: "bil.admin",
    tenant_id: "BIL",
    channel: "AGENT_PORTAL",
  });
  const e = log.query()[0]!;
  assert.equal(e.tenant_id, "BIL");
  assert.equal(e.channel, "AGENT_PORTAL");
});

test("login flow stamps the user's tenant_id on the success event", async () => {
  __resetAuthStateForTests();
  const app = buildServer();
  const r1 = await app.inject({
    method: "POST",
    url: "/auth/login",
    payload: { username: "alice.admin", password: "Admin!Pass1" },
  });
  assert.equal(r1.statusCode, 200);

  const r2 = await app.inject({
    method: "POST",
    url: "/auth/login",
    payload: { username: "bil.admin", password: "BilAdmin!1" },
  });
  assert.equal(r2.statusCode, 200);
  const access = (r2.json() as Record<string, string>).access_token;
  // The access token's payload (middle segment) should carry tenant_id=BIL.
  const payloadB64 = access.split(".")[1]!;
  const padded = payloadB64 + "=".repeat((4 - (payloadB64.length % 4)) % 4);
  const payload = JSON.parse(
    Buffer.from(padded.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"),
  );
  assert.equal(payload.tenant_id, "BIL");
  assert.equal(payload.role, "admin");

  // Confirm BANK_DEMO user gets BANK_DEMO in their JWT.
  const aliceAccess = (r1.json() as Record<string, string>).access_token;
  const aliceP64 = aliceAccess.split(".")[1]!;
  const aliceP = JSON.parse(
    Buffer.from(
      (aliceP64 + "=".repeat((4 - (aliceP64.length % 4)) % 4))
        .replace(/-/g, "+")
        .replace(/_/g, "/"),
      "base64",
    ).toString("utf8"),
  );
  assert.equal(aliceP.tenant_id, "BANK_DEMO");

  // Audit fetch — bil's success event should carry tenant_id=BIL.
  const audit = await app.inject({
    method: "GET",
    url: "/auth/audit-log?type=login_success",
    headers: { authorization: `Bearer ${aliceAccess}` },
  });
  assert.equal(audit.statusCode, 200);
  const events = (audit.json() as { events: Array<Record<string, unknown>> }).events;
  const bilEvent = events.find((e) => e.target_username === "bil.admin");
  assert.equal(bilEvent?.tenant_id, "BIL");
  await app.close();
});
