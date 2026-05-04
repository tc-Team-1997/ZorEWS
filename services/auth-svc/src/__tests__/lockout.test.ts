// Auto-lockout tests must run with the per-IP rate limiter OFF so that
// the 5 failed-login attempts in each test aren't blocked at 429 before
// the lockout kicks in. The tests for the rate limiter live in
// rate_limit.test.ts; the tests for admin-controlled (manual) locking
// live in auth.test.ts. This file covers automatic lockout only.
process.env.AUTH_SVC_RATE_LIMIT = "off";

import test from "node:test";
import assert from "node:assert/strict";
import { buildServer } from "../server.js";
import { __resetAuthStateForTests } from "../routes/auth.js";

test("login — failed attempts return invalid_credentials with attempts_remaining countdown", async () => {
  __resetAuthStateForTests();
  const app = buildServer();
  const expected = [4, 3, 2, 1];
  for (const remaining of expected) {
    const res = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { username: "alice.admin", password: "wrong" },
    });
    assert.equal(res.statusCode, 401);
    const body = res.json() as Record<string, unknown>;
    assert.equal(body.error, "invalid_credentials");
    assert.equal(body.attempts_remaining, remaining, `expected attempts_remaining=${remaining}`);
  }
  await app.close();
});

test("login — 5th wrong password trips the lock and returns 403 locked_account", async () => {
  __resetAuthStateForTests();
  const app = buildServer();
  // 4 fails — still 401
  for (let i = 0; i < 4; i++) {
    const res = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { username: "alice.admin", password: "wrong" },
    });
    assert.equal(res.statusCode, 401);
  }
  // 5th fail — locks
  const lockRes = await app.inject({
    method: "POST",
    url: "/auth/login",
    payload: { username: "alice.admin", password: "wrong" },
  });
  assert.equal(lockRes.statusCode, 403);
  const lockBody = lockRes.json() as Record<string, unknown>;
  assert.equal(lockBody.error, "locked_account");
  assert.ok(typeof lockBody.auto_unlock_in_sec === "number" && (lockBody.auto_unlock_in_sec as number) > 0);

  // Now even the right password is rejected with locked_account.
  const correctPwAfterLock = await app.inject({
    method: "POST",
    url: "/auth/login",
    payload: { username: "alice.admin", password: "Admin!Pass1" },
  });
  assert.equal(correctPwAfterLock.statusCode, 403);
  assert.equal((correctPwAfterLock.json() as Record<string, unknown>).error, "locked_account");

  await app.close();
});

test("login — successful login resets the failed-attempt counter", async () => {
  __resetAuthStateForTests();
  const app = buildServer();
  // 4 fails (one short of the lock)
  for (let i = 0; i < 4; i++) {
    await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { username: "ravi.risk", password: "wrong" },
    });
  }
  // Correct password succeeds and resets counter
  const ok = await app.inject({
    method: "POST",
    url: "/auth/login",
    payload: { username: "ravi.risk", password: "RiskAnalyst!1" },
  });
  assert.equal(ok.statusCode, 200);

  // Now 4 fresh fails should still be 401 (counter was reset)
  for (let i = 0; i < 4; i++) {
    const res = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { username: "ravi.risk", password: "wrong" },
    });
    assert.equal(res.statusCode, 401, `post-reset attempt ${i + 1} should be 401`);
  }
  await app.close();
});

test("login — admin manual unlock clears the failed-attempt counter and re-enables login", async () => {
  __resetAuthStateForTests();
  const app = buildServer();

  // Lock sue.super via 5 fails
  for (let i = 0; i < 5; i++) {
    await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { username: "sue.super", password: "wrong" },
    });
  }
  const verifyLocked = await app.inject({
    method: "POST",
    url: "/auth/login",
    payload: { username: "sue.super", password: "Super!Pass1" },
  });
  assert.equal(verifyLocked.statusCode, 403);

  // Admin unlocks
  const aliceLogin = await app.inject({
    method: "POST",
    url: "/auth/login",
    payload: { username: "alice.admin", password: "Admin!Pass1" },
  });
  assert.equal(aliceLogin.statusCode, 200);
  const adminToken = (aliceLogin.json() as { access_token: string }).access_token;

  const unlock = await app.inject({
    method: "POST",
    url: "/auth/users/sue.super/unlock",
    headers: { authorization: `Bearer ${adminToken}` },
  });
  assert.equal(unlock.statusCode, 200);

  // Sue can log in normally now
  const sueOk = await app.inject({
    method: "POST",
    url: "/auth/login",
    payload: { username: "sue.super", password: "Super!Pass1" },
  });
  assert.equal(sueOk.statusCode, 200);

  await app.close();
});

test("registerFailedLogin/maybeReleaseAutoLock — pure-function unit test", async () => {
  const { UserStore } = await import("../users.js");
  const store = new UserStore();
  await store.seed();
  const user = store.findByUsername("fiona.field")!;

  // 4 fails — still unlocked
  for (let i = 1; i <= 4; i++) {
    const r = store.registerFailedLogin(user, 5, 30 * 60 * 1000, 1_000_000);
    assert.equal(r.count, i);
    assert.equal(r.just_locked, false);
    assert.equal(user.locked, false);
  }
  // 5th fail — auto-locks
  const fifth = store.registerFailedLogin(user, 5, 30 * 60 * 1000, 1_000_000);
  assert.equal(fifth.just_locked, true);
  assert.equal(user.locked, true);
  assert.equal(user.lockout_until_ms, 1_000_000 + 30 * 60 * 1000);

  // Before the window expires — no release
  assert.equal(store.maybeReleaseAutoLock(user, 1_000_000 + 1000), false);
  assert.equal(user.locked, true);

  // After the window — auto-released, counter reset
  assert.equal(store.maybeReleaseAutoLock(user, 1_000_000 + 30 * 60 * 1000 + 1), true);
  assert.equal(user.locked, false);
  assert.equal(user.failed_login_count, 0);
  assert.equal(user.lockout_until_ms, null);
});

