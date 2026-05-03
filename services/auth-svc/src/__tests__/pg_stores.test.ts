// Integration tests for PgUserStore + PgSessionStore + PgAuthAuditLog.
//
// Skipped when AUTH_SVC_PG_URL is unset (the default — keeps `npm test`
// hermetic in CI). Run locally with the `apex-ews-pg` container up:
//
//   AUTH_SVC_PG_URL=postgres://apex:apex@localhost:55432/apex_ews \
//     npm test -- src/__tests__/pg_stores.test.ts
//
// Each test calls reset() in its setup which TRUNCATEs the four
// app_iam tables — so this suite WILL wipe app_iam.* manually. That's
// a feature, not a bug; tests need a clean table to assert on counts.

import test from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";
import { PgUserStore } from "../pg_user_store.js";
import { PgSessionStore } from "../pg_session_store.js";
import { PgAuthAuditLog } from "../pg_audit_log.js";
import { PgServiceClientStore } from "../service_clients.js";

const PG_URL = process.env.AUTH_SVC_PG_URL;
const SKIP = !PG_URL;
const skipMsg = "AUTH_SVC_PG_URL not set — skipping pg integration tests";

test("PgUserStore — init() seeds + create persists + restart rehydrates", { skip: SKIP && skipMsg }, async () => {
  const pool = new Pool({ connectionString: PG_URL, max: 2 });
  try {
    const store = new PgUserStore(pool, () => undefined);
    await store.init();
    await store.reset();
    await store.init(); // re-seed empty table

    // The 5 demo users must come back from a fresh init().
    const list = store.listAll();
    assert.equal(list.length, 5);
    assert.ok(list.some((u) => u.username === "alice.admin"));

    // Register a new user — confirm cache + pg both have it after a beat.
    const result = await store.register({
      username: "pg.test.user",
      email: "pg.test@apex-ews.test",
      password: "PgTest!Pass1",
      display_name: "Pg Test",
      role: "risk_analyst",
    });
    assert.equal(result.user.username, "pg.test.user");
    await new Promise((r) => setTimeout(r, 150));

    const r = await pool.query(
      `SELECT username, role FROM app_iam.users WHERE user_id = $1`,
      [result.user.id],
    );
    assert.equal(r.rowCount, 1);
    assert.equal(r.rows[0].username, "pg.test.user");

    // Restart simulation — fresh store should rehydrate the new user.
    const fresh = new PgUserStore(pool, () => undefined);
    await fresh.init();
    const recovered = fresh.findByUsername("pg.test.user");
    assert.ok(recovered);
    assert.equal(recovered!.role, "risk_analyst");
  } finally {
    await pool.end();
  }
});

test("PgUserStore — setPassword writes to app_iam.password_history", { skip: SKIP && skipMsg }, async () => {
  const pool = new Pool({ connectionString: PG_URL, max: 2 });
  try {
    const store = new PgUserStore(pool, () => undefined);
    await store.init();
    await store.reset();
    await store.init();

    const user = store.findByUsername("alice.admin")!;
    const oldHash = user.passwordHash;
    await store.setPassword(user, "NewPass!Word123");
    assert.notEqual(user.passwordHash, oldHash);
    assert.equal(user.password_history.length, 1);
    await new Promise((r) => setTimeout(r, 200));

    const h = await pool.query(
      `SELECT password_hash FROM app_iam.password_history WHERE user_id = $1`,
      [user.id],
    );
    assert.equal(h.rowCount, 1);
    assert.equal(h.rows[0].password_hash, oldHash);

    const u = await pool.query(
      `SELECT password_hash FROM app_iam.users WHERE user_id = $1`,
      [user.id],
    );
    assert.equal(u.rows[0].password_hash, user.passwordHash);
  } finally {
    await pool.end();
  }
});

test("PgUserStore — registerFailedLogin persists lock state", { skip: SKIP && skipMsg }, async () => {
  const pool = new Pool({ connectionString: PG_URL, max: 2 });
  try {
    const store = new PgUserStore(pool, () => undefined);
    await store.init();
    await store.reset();
    await store.init();

    const user = store.findByUsername("ravi.risk")!;
    // Space the failed-login calls so the fire-and-forget UPDATEs land
    // in order — in production they're separated by a network round-trip
    // + argon2.verify (~50-100ms), which is plenty for the prior write
    // to drain. Synchronous bursts (as used here for the in-memory test)
    // would race on the pool; the cache stays correct but pg sees a
    // non-deterministic final value. A 50ms gap mirrors real-world spacing.
    for (let i = 0; i < 5; i++) {
      store.registerFailedLogin(user);
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(user.locked, true);
    assert.notEqual(user.lockout_until_ms, null);
    await new Promise((r) => setTimeout(r, 200));

    const r = await pool.query(
      `SELECT failed_login_count, locked, lockout_until FROM app_iam.users WHERE user_id = $1`,
      [user.id],
    );
    assert.equal(r.rows[0].failed_login_count, 5);
    assert.equal(r.rows[0].locked, true);
    assert.notEqual(r.rows[0].lockout_until, null);
  } finally {
    await pool.end();
  }
});

test("PgSessionStore — create persists + revoke writes revoked_at", { skip: SKIP && skipMsg }, async () => {
  const pool = new Pool({ connectionString: PG_URL, max: 2 });
  try {
    const userStore = new PgUserStore(pool, () => undefined);
    await userStore.init();
    await userStore.reset();
    await userStore.init();

    const sessionStore = new PgSessionStore(pool, Date.now, () => undefined);
    await sessionStore.init();
    await sessionStore.reset();

    const sess = sessionStore.create({
      user_id: "u-001",
      ip: "127.0.0.1",
      user_agent: "test-ua",
    });
    assert.match(sess.id, /^sid-/);
    await new Promise((r) => setTimeout(r, 150));

    const a = await pool.query(
      `SELECT user_id, ip::text AS ip, user_agent, revoked
         FROM app_iam.sessions WHERE sid = $1`,
      [sess.id],
    );
    assert.equal(a.rowCount, 1);
    assert.equal(a.rows[0].user_id, "u-001");
    assert.equal(a.rows[0].user_agent, "test-ua");
    assert.equal(a.rows[0].revoked, false);

    assert.equal(sessionStore.revoke(sess.id), true);
    await new Promise((r) => setTimeout(r, 150));
    const b = await pool.query(
      `SELECT revoked, revoked_at, revoked_reason FROM app_iam.sessions WHERE sid = $1`,
      [sess.id],
    );
    assert.equal(b.rows[0].revoked, true);
    assert.notEqual(b.rows[0].revoked_at, null);
    assert.equal(b.rows[0].revoked_reason, "user_revoked");

    // Restart simulation — revoked status survives.
    const fresh = new PgSessionStore(pool, Date.now, () => undefined);
    await fresh.init();
    assert.equal(fresh.isRevoked(sess.id), true);
  } finally {
    await pool.end();
  }
});

test("PgAuthAuditLog — append persists + rehydrates via init()", { skip: SKIP && skipMsg }, async () => {
  const pool = new Pool({ connectionString: PG_URL, max: 2 });
  try {
    const audit = new PgAuthAuditLog(pool, 1000, Date.now, () => undefined);
    await audit.init();
    await audit.reset();

    audit.append({
      type: "login_success",
      target_username: "alice.admin",
      actor_username: "alice.admin",
      actor_role: "admin",
      ip: "10.0.0.1",
      metadata: { sid: "sid-test" },
    });
    audit.append({
      type: "login_failure",
      target_username: "ravi.risk",
      ip: "10.0.0.2",
      metadata: { reason: "wrong_password" },
    });
    await new Promise((r) => setTimeout(r, 200));

    const r = await pool.query(
      `SELECT event_type, target_username, ip::text AS ip, detail
         FROM app_iam.audit_events ORDER BY occurred_at ASC`,
    );
    assert.equal(r.rowCount, 2);
    assert.equal(r.rows[0].event_type, "login_success");
    assert.equal(r.rows[0].target_username, "alice.admin");
    assert.equal(r.rows[0].detail.sid, "sid-test");
    assert.equal(r.rows[1].event_type, "login_failure");

    // Fresh log re-loads the recent rows.
    const fresh = new PgAuthAuditLog(pool, 1000, Date.now, () => undefined);
    await fresh.init();
    const events = fresh.query({ target_username: "alice.admin" });
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "login_success");
  } finally {
    await pool.end();
  }
});

test(
  "PgServiceClientStore — init() seeds + cache rehydrates + verifySecret round-trips",
  { skip: SKIP && skipMsg },
  async () => {
    const pool = new Pool({ connectionString: PG_URL, max: 2 });
    try {
      // Force a clean slate so the seed path is exercised. The 005
      // migration creates the table; we just need it empty for this test.
      await pool.query(`DELETE FROM app_iam.service_clients`);

      const store = new PgServiceClientStore(pool);
      await store.init();

      // Both seed clients should be discoverable.
      const bank = store.find("BANK_DEMO", "apex-mobile-bank-demo");
      assert.ok(bank, "BANK_DEMO seed client must hydrate");
      assert.equal(bank!.display_name, "APEX Mobile (BANK_DEMO)");
      const bil = store.find("BIL", "bil-los-stub");
      assert.ok(bil, "BIL seed client must hydrate");

      // verifySecret should accept the seeded secret + reject a wrong one.
      assert.equal(await store.verifySecret(bank!, "demo-secret-bank"), true);
      assert.equal(await store.verifySecret(bank!, "wrong-secret"), false);

      // Wrong tenant for a valid client_id is undefined (composite key).
      assert.equal(store.find("BIL", "apex-mobile-bank-demo"), undefined);

      // A second store sharing the same pool should pick up the same rows
      // without re-seeding (ON CONFLICT DO NOTHING means counts stay at 2).
      const fresh = new PgServiceClientStore(pool);
      await fresh.init();
      const r = await pool.query<{ n: string }>(
        `SELECT count(*) AS n FROM app_iam.service_clients`,
      );
      assert.equal(Number(r.rows[0].n), 2);
    } finally {
      await pool.end();
    }
  },
);
