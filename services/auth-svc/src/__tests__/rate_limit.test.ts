// Rate limiting MUST be on for these tests. Each test file runs in its
// own process under `node --test`, so this won't bleed into auth.test.ts.
process.env.AUTH_SVC_RATE_LIMIT = "on";
process.env.AUTH_SVC_DEBUG_TOKENS = "1";

import test from "node:test";
import assert from "node:assert/strict";
import {
  LOGIN_POLICY,
  RESET_REQUEST_POLICY,
  RateLimiter,
} from "../rate_limit.js";
import { buildServer } from "../server.js";
import { __resetAuthStateForTests } from "../routes/auth.js";

test("RateLimiter — first N takes succeed, N+1 returns ok=false with retry-after", () => {
  const limiter = new RateLimiter();
  const policy = { limit: 3, windowMs: 60_000 };
  for (let i = 0; i < 3; i++) {
    const d = limiter.take("k", policy);
    assert.equal(d.ok, true, `take ${i} expected ok`);
    assert.equal(d.remaining, 3 - 1 - i);
  }
  const blocked = limiter.take("k", policy);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.remaining, 0);
  assert.ok(blocked.retry_after_sec >= 1);
});

test("RateLimiter — separate keys have separate buckets", () => {
  const limiter = new RateLimiter();
  const policy = { limit: 2, windowMs: 60_000 };
  assert.equal(limiter.take("a", policy).ok, true);
  assert.equal(limiter.take("a", policy).ok, true);
  // 'b' still has full allowance even though 'a' is now exhausted on next.
  assert.equal(limiter.take("a", policy).ok, false);
  assert.equal(limiter.take("b", policy).ok, true);
});

test("RateLimiter — old hits age out of the sliding window", () => {
  let now = 1_000_000;
  const limiter = new RateLimiter(() => now);
  const policy = { limit: 2, windowMs: 1_000 };
  assert.equal(limiter.take("k", policy).ok, true); // t=1_000_000
  assert.equal(limiter.take("k", policy).ok, true); // t=1_000_000
  assert.equal(limiter.take("k", policy).ok, false);
  // Advance past the window — older hits prune, allowance restored.
  now += 1_001;
  assert.equal(limiter.take("k", policy).ok, true);
});

test("RateLimiter — exhausted bucket doesn't push retry-after further out", () => {
  let now = 1_000_000;
  const limiter = new RateLimiter(() => now);
  const policy = { limit: 1, windowMs: 10_000 };
  assert.equal(limiter.take("k", policy).ok, true); // hits=[1_000_000]
  const first = limiter.take("k", policy);
  assert.equal(first.ok, false);
  assert.equal(first.retry_after_sec, 10);
  // 5 seconds later, a second rejected take should report ~5s retry, not 10.
  now += 5_000;
  const second = limiter.take("k", policy);
  assert.equal(second.ok, false);
  assert.ok(second.retry_after_sec <= 5 && second.retry_after_sec >= 4);
});

test("POST /auth/login — 6th successful login within window returns 429 (rate cap is on traffic, not failures)", async () => {
  __resetAuthStateForTests();
  const app = buildServer();

  // 5 successful logins — none trip the lockout since each is correct.
  for (let i = 0; i < LOGIN_POLICY.limit; i++) {
    const res = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { username: "alice.admin", password: "Admin!Pass1" },
    });
    assert.equal(res.statusCode, 200, `login ${i + 1}: expected 200, got ${res.statusCode}`);
  }
  // 6th login — same valid creds — capped by rate limiter.
  const blocked = await app.inject({
    method: "POST",
    url: "/auth/login",
    payload: { username: "alice.admin", password: "Admin!Pass1" },
  });
  assert.equal(blocked.statusCode, 429);
  const body = blocked.json() as Record<string, unknown>;
  assert.equal(body.error, "rate_limited");
  assert.ok(typeof body.retry_after_sec === "number" && (body.retry_after_sec as number) >= 1);
  assert.ok(blocked.headers["retry-after"], "expected Retry-After header");

  await app.close();
});

test("POST /auth/login — full precedence: captcha gate > rate limit > lockout > password check", async () => {
  __resetAuthStateForTests();
  const app = buildServer();

  // Attempts 1-2 — under captcha threshold, return 401 invalid_credentials.
  for (let i = 0; i < 2; i++) {
    const res = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { username: "alice.admin", password: "wrong" },
    });
    assert.equal(res.statusCode, 401);
    assert.equal((res.json() as Record<string, unknown>).error, "invalid_credentials");
  }
  // Attempt 3 (no captcha) — captcha gate fires before the password check.
  // The lockout counter does NOT increment here because the password check
  // never ran — this is the intended defense, since otherwise an attacker
  // could lock out victims by spamming wrong passwords without ever
  // proving they're human.
  const third = await app.inject({
    method: "POST",
    url: "/auth/login",
    payload: { username: "alice.admin", password: "wrong" },
  });
  assert.equal(third.statusCode, 401);
  assert.equal((third.json() as Record<string, unknown>).error, "captcha_required");

  // Solve a captcha + send right password → succeeds (and resets the counter).
  const challenge = await app.inject({ method: "GET", url: "/auth/captcha/challenge" });
  const c = challenge.json() as { id: string; question: string };
  const m = c.question.match(/What is (\d+) \+ (\d+)\?/)!;
  const ok = await app.inject({
    method: "POST",
    url: "/auth/login",
    payload: {
      username: "alice.admin",
      password: "Admin!Pass1",
      captcha_id: c.id,
      captcha_answer: Number(m[1]) + Number(m[2]),
    },
  });
  assert.equal(ok.statusCode, 200);

  await app.close();
});

test("POST /auth/login — different username from same IP has its own bucket", async () => {
  __resetAuthStateForTests();
  const app = buildServer();
  // Burn the cap for alice with 5 successful logins.
  for (let i = 0; i < LOGIN_POLICY.limit; i++) {
    await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { username: "alice.admin", password: "Admin!Pass1" },
    });
  }
  const aliceBlocked = await app.inject({
    method: "POST",
    url: "/auth/login",
    payload: { username: "alice.admin", password: "Admin!Pass1" },
  });
  assert.equal(aliceBlocked.statusCode, 429);

  // Ravi from the same IP still has a fresh bucket.
  const raviOk = await app.inject({
    method: "POST",
    url: "/auth/login",
    payload: { username: "ravi.risk", password: "RiskAnalyst!1" },
  });
  assert.equal(raviOk.statusCode, 200);

  await app.close();
});

test("POST /auth/password/reset-request — 4th attempt within window returns 429", async () => {
  __resetAuthStateForTests();
  const app = buildServer();

  for (let i = 0; i < RESET_REQUEST_POLICY.limit; i++) {
    const res = await app.inject({
      method: "POST",
      url: "/auth/password/reset-request",
      payload: { username: "sue.super" },
    });
    assert.equal(res.statusCode, 202, `request ${i + 1}: expected 202, got ${res.statusCode}`);
  }
  const blocked = await app.inject({
    method: "POST",
    url: "/auth/password/reset-request",
    payload: { username: "sue.super" },
  });
  assert.equal(blocked.statusCode, 429);
  const body = blocked.json() as Record<string, unknown>;
  assert.equal(body.error, "rate_limited");
  assert.ok(blocked.headers["retry-after"]);

  await app.close();
});

test("POST /auth/password/reset-request — unknown email is still rate-limited (no enumeration via 429)", async () => {
  __resetAuthStateForTests();
  const app = buildServer();

  // Fire 4 requests against an unknown email — the 4th must 429 just like
  // a real user would, otherwise an attacker can detect "unknown" by the
  // *absence* of throttling.
  for (let i = 0; i < RESET_REQUEST_POLICY.limit; i++) {
    const res = await app.inject({
      method: "POST",
      url: "/auth/password/reset-request",
      payload: { email: "ghost@nowhere.test" },
    });
    assert.equal(res.statusCode, 202);
  }
  const blocked = await app.inject({
    method: "POST",
    url: "/auth/password/reset-request",
    payload: { email: "ghost@nowhere.test" },
  });
  assert.equal(blocked.statusCode, 429);

  await app.close();
});
