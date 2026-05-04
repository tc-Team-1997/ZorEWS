// CAPTCHA tests — unlike most other suites, rate limiting must be ON
// here because the login route only enforces the captcha gate when the
// AUTH_SVC_RATE_LIMIT toggle is on (test convenience to keep the other
// suites simple). Each test in this file resets state via
// __resetAuthStateForTests() to start with an empty failure counter.
process.env.AUTH_SVC_RATE_LIMIT = "on";

import test from "node:test";
import assert from "node:assert/strict";
import { CaptchaStore, FailureCounter, CAPTCHA_THRESHOLD } from "../captcha.js";
import { buildServer } from "../server.js";
import { __resetAuthStateForTests } from "../routes/auth.js";

// ───────── unit tests ─────────

test("CaptchaStore.issue — returns id, question, expires_at; question parses as a sum", () => {
  const store = new CaptchaStore();
  const c = store.issue();
  assert.match(c.id, /^cap-[A-Za-z0-9_-]+$/);
  assert.match(c.question, /What is \d+ \+ \d+\?/);
  assert.ok(typeof c.expires_at === "string" && c.expires_at.length > 0);
  assert.equal(store.size(), 1);
});

test("CaptchaStore.verify — returns true for the right answer once", () => {
  let now = 1_000_000;
  const store = new CaptchaStore(() => now);
  const c = store.issue();
  // Parse the answer from the question — easier than mocking randomInt.
  const m = c.question.match(/What is (\d+) \+ (\d+)\?/);
  const correct = Number(m![1]) + Number(m![2]);
  assert.equal(store.verify(c.id, correct), true);
  // Single-use: a second verify on the same id always fails.
  assert.equal(store.verify(c.id, correct), false);
});

test("CaptchaStore.verify — wrong answer returns false AND removes the entry (single-use)", () => {
  const store = new CaptchaStore();
  const c = store.issue();
  assert.equal(store.verify(c.id, 999), false);
  // Even the correct answer doesn't work after a wrong attempt — the
  // entry was removed.
  const m = c.question.match(/What is (\d+) \+ (\d+)\?/)!;
  assert.equal(store.verify(c.id, Number(m[1]) + Number(m[2])), false);
});

test("CaptchaStore.verify — expired challenge returns false", () => {
  let now = 1_000_000;
  const store = new CaptchaStore(() => now);
  const c = store.issue();
  const m = c.question.match(/What is (\d+) \+ (\d+)\?/)!;
  const correct = Number(m[1]) + Number(m[2]);
  // Past the 5-min TTL.
  now += 5 * 60 * 1000 + 1;
  assert.equal(store.verify(c.id, correct), false);
});

test("FailureCounter — bump increments per key, reset clears one key only", () => {
  const c = new FailureCounter();
  assert.equal(c.bump("a"), 1);
  assert.equal(c.bump("a"), 2);
  assert.equal(c.bump("b"), 1);
  c.reset("a");
  assert.equal(c.get("a"), 0);
  assert.equal(c.get("b"), 1);
});

// ───────── route-layer integration ─────────

test("GET /auth/captcha/challenge — returns id + parseable question", async () => {
  __resetAuthStateForTests();
  const app = buildServer();
  const r = await app.inject({ method: "GET", url: "/auth/captcha/challenge" });
  assert.equal(r.statusCode, 200);
  const body = r.json() as { id: string; question: string; expires_at: string };
  assert.match(body.id, /^cap-/);
  assert.match(body.question, /What is \d+ \+ \d+\?/);
  await app.close();
});

test("POST /auth/login — first 2 wrong attempts return 401 invalid_credentials, 3rd returns captcha_required", async () => {
  __resetAuthStateForTests();
  const app = buildServer();
  for (let i = 0; i < CAPTCHA_THRESHOLD; i++) {
    const r = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { username: "alice.admin", password: "wrong" },
    });
    assert.equal(r.statusCode, 401, `attempt ${i + 1}: expected 401`);
    assert.equal((r.json() as Record<string, unknown>).error, "invalid_credentials");
  }
  // Next attempt — even with the right password — gets captcha_required
  // because the gate runs before the password check.
  const blocked = await app.inject({
    method: "POST",
    url: "/auth/login",
    payload: { username: "alice.admin", password: "Admin!Pass1" },
  });
  assert.equal(blocked.statusCode, 401);
  assert.equal((blocked.json() as Record<string, unknown>).error, "captcha_required");
  await app.close();
});

test("POST /auth/login — solving the captcha unblocks login on the same request", async () => {
  __resetAuthStateForTests();
  const app = buildServer();
  // Burn 2 wrong-password attempts.
  for (let i = 0; i < CAPTCHA_THRESHOLD; i++) {
    await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { username: "alice.admin", password: "wrong" },
    });
  }
  // Fetch a challenge.
  const challenge = await app.inject({ method: "GET", url: "/auth/captcha/challenge" });
  const c = challenge.json() as { id: string; question: string };
  const m = c.question.match(/What is (\d+) \+ (\d+)\?/)!;
  const answer = Number(m[1]) + Number(m[2]);

  // Right password + right captcha → 200.
  const ok = await app.inject({
    method: "POST",
    url: "/auth/login",
    payload: {
      username: "alice.admin",
      password: "Admin!Pass1",
      captcha_id: c.id,
      captcha_answer: answer,
    },
  });
  assert.equal(ok.statusCode, 200);
  await app.close();
});

test("POST /auth/login — wrong captcha returns captcha_failed (separate from captcha_required)", async () => {
  __resetAuthStateForTests();
  const app = buildServer();
  for (let i = 0; i < CAPTCHA_THRESHOLD; i++) {
    await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { username: "ravi.risk", password: "wrong" },
    });
  }
  const challenge = await app.inject({ method: "GET", url: "/auth/captcha/challenge" });
  const c = challenge.json() as { id: string };

  const r = await app.inject({
    method: "POST",
    url: "/auth/login",
    payload: {
      username: "ravi.risk",
      password: "RiskAnalyst!1",
      captcha_id: c.id,
      captcha_answer: 9999,
    },
  });
  assert.equal(r.statusCode, 401);
  assert.equal((r.json() as Record<string, unknown>).error, "captcha_failed");
  await app.close();
});

test("POST /auth/login — successful login resets the captcha counter", async () => {
  __resetAuthStateForTests();
  const app = buildServer();
  // 1 wrong, then 1 right — counter resets, so a NEW first-fail attempt
  // is back to 401 invalid_credentials, not captcha_required.
  await app.inject({
    method: "POST",
    url: "/auth/login",
    payload: { username: "sue.super", password: "wrong" },
  });
  const ok = await app.inject({
    method: "POST",
    url: "/auth/login",
    payload: { username: "sue.super", password: "Super!Pass1" },
  });
  assert.equal(ok.statusCode, 200);
  // 2 fresh wrong attempts — should still be 401 invalid_credentials,
  // not captcha_required, since the counter zeroed.
  for (let i = 0; i < CAPTCHA_THRESHOLD; i++) {
    const r = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { username: "sue.super", password: "wrong" },
    });
    assert.equal(r.statusCode, 401);
    assert.equal((r.json() as Record<string, unknown>).error, "invalid_credentials");
  }
  await app.close();
});

test("POST /auth/login — captcha gate also fires for unknown users (no enumeration)", async () => {
  __resetAuthStateForTests();
  const app = buildServer();
  for (let i = 0; i < CAPTCHA_THRESHOLD; i++) {
    const r = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { username: "ghost.user", password: "anything" },
    });
    assert.equal(r.statusCode, 401);
    assert.equal((r.json() as Record<string, unknown>).error, "invalid_credentials");
  }
  // 3rd attempt against the unknown user — captcha gate still kicks in
  // so the attacker can't tell who exists by which username triggered it.
  const blocked = await app.inject({
    method: "POST",
    url: "/auth/login",
    payload: { username: "ghost.user", password: "anything" },
  });
  assert.equal(blocked.statusCode, 401);
  assert.equal((blocked.json() as Record<string, unknown>).error, "captcha_required");
  await app.close();
});
