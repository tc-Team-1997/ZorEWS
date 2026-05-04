// Password history tests — verify the last-N no-reuse policy. Rate
// limiting OFF so multi-step reset flows aren't capped.
process.env.AUTH_SVC_RATE_LIMIT = "off";
process.env.AUTH_SVC_DEBUG_TOKENS = "1";

import test from "node:test";
import assert from "node:assert/strict";
import { PASSWORD_HISTORY_LIMIT, UserStore, RegisterFailure } from "../users.js";
import { buildServer } from "../server.js";
import { __resetAuthStateForTests } from "../routes/auth.js";

async function getResetToken(
  app: ReturnType<typeof buildServer>,
  username: string,
): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/auth/password/reset-request",
    payload: { username },
  });
  return (res.json() as { debug?: { token: string } }).debug?.token ?? "";
}

test("UserStore.setPassword — refuses to reuse the current password", async () => {
  const store = new UserStore();
  await store.seed();
  const user = store.findByUsername("alice.admin")!;
  await assert.rejects(
    () => store.setPassword(user, "Admin!Pass1"),
    (err: unknown) => err instanceof RegisterFailure && err.code === "password_reused",
  );
});

test("UserStore.setPassword — refuses any of the last 5 historic passwords", async () => {
  const store = new UserStore();
  await store.seed();
  const user = store.findByUsername("ravi.risk")!;
  // Cycle through 5 distinct new passwords.
  const sequence = ["Hist!One1", "Hist!Two2", "Hist!Tre3", "Hist!For4", "Hist!Fiv5"];
  for (const pw of sequence) {
    await store.setPassword(user, pw);
  }
  // History now holds the 5 prior hashes (RiskAnalyst!1 was rotated out
  // since we exceeded the 5-slot history with the latest password). The
  // current password is sequence[4] ("Hist!Fiv5"); history holds
  // [Original, sequence[0..3]] (the original was pushed when sequence[0]
  // was set; cap=5 so all 5 oldest persist until the 6th rotation).
  // Try to reuse each of the historical 5 — all should fail.
  for (const pw of ["RiskAnalyst!1", ...sequence.slice(0, 4)]) {
    await assert.rejects(
      () => store.setPassword(user, pw),
      (err: unknown) => err instanceof RegisterFailure && err.code === "password_reused",
      `expected reuse of "${pw}" to be rejected`,
    );
  }
});

test("UserStore.setPassword — a password older than 5 rotations becomes reusable", async () => {
  const store = new UserStore();
  await store.seed();
  const user = store.findByUsername("sue.super")!;
  const oldest = "Super!Pass1"; // seed
  // Push 6 new passwords — that's PASSWORD_HISTORY_LIMIT + 1 rotations
  // total. After the 6th rotation, the seed hash has been evicted from
  // history (cap = 5 historic + current = 6 total tracked).
  const news = ["Sue!One1", "Sue!Two2", "Sue!Tre3", "Sue!For4", "Sue!Fiv5", "Sue!Six6"];
  for (const pw of news) {
    await store.setPassword(user, pw);
  }
  // Now the original seed should be reusable (it aged out).
  await store.setPassword(user, oldest);
  // sanity: the very recent "Sue!Six6" still rejected (it's the current pw).
  await assert.rejects(() => store.setPassword(user, oldest));
});

test("UserStore.setPassword — history cap is exactly PASSWORD_HISTORY_LIMIT entries", async () => {
  const store = new UserStore();
  await store.seed();
  const user = store.findByUsername("fiona.field")!;
  for (let i = 0; i < PASSWORD_HISTORY_LIMIT + 5; i++) {
    await store.setPassword(user, `RotPwd!${i}1`);
  }
  assert.equal(user.password_history.length, PASSWORD_HISTORY_LIMIT);
});

test("POST /auth/password/reset-confirm — rejects reuse of the current password (400 password_reused)", async () => {
  __resetAuthStateForTests();
  const app = buildServer();
  const token = await getResetToken(app, "fiona.field");
  const res = await app.inject({
    method: "POST",
    url: "/auth/password/reset-confirm",
    payload: { token, password: "Field!Pass1" }, // same as seeded
  });
  assert.equal(res.statusCode, 400);
  const body = res.json() as Record<string, unknown>;
  assert.equal(body.error, "password_reused");
  await app.close();
});

test("POST /auth/password/admin-reset — rejects reuse with 400 password_reused", async () => {
  __resetAuthStateForTests();
  const app = buildServer();
  const adminLogin = await app.inject({
    method: "POST",
    url: "/auth/login",
    payload: { username: "alice.admin", password: "Admin!Pass1" },
  });
  const adminToken = (adminLogin.json() as { access_token: string }).access_token;

  // First admin-reset succeeds (new password).
  const ok = await app.inject({
    method: "POST",
    url: "/auth/password/admin-reset",
    headers: { authorization: `Bearer ${adminToken}` },
    payload: { username: "carl.collect", password: "AdminFresh!1" },
  });
  assert.equal(ok.statusCode, 200);

  // Repeating the same new password fails (now matches current).
  const dupe = await app.inject({
    method: "POST",
    url: "/auth/password/admin-reset",
    headers: { authorization: `Bearer ${adminToken}` },
    payload: { username: "carl.collect", password: "AdminFresh!1" },
  });
  assert.equal(dupe.statusCode, 400);
  assert.equal((dupe.json() as Record<string, unknown>).error, "password_reused");
  await app.close();
});
