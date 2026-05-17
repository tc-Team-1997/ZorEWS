// Integration tests for AuditEventLogClient + PgAuthAuditLog fan-out.
//
// Skipped when AUTH_SVC_PG_URL is unset (the default — keeps `npm test`
// hermetic in CI). Run locally with the `zorews-pg` container up:
//
//   AUTH_SVC_PG_URL=postgres://zorews_user:apex@localhost:55432/zorews \
//     npm test -- src/__tests__/audit_event_log.test.ts
//
// These tests TRUNCATE audit.event_log to assert on counts. The
// hash-chain trigger only fires on row-level INSERT/UPDATE/DELETE, so
// TRUNCATE is permitted and resets the chain to genesis.

import test from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";
import { PgAuthAuditLog } from "../pg_audit_log.js";
import { AuditEventLogClient } from "../audit_event_log.js";

const PG_URL = process.env.AUTH_SVC_PG_URL;
const SKIP = !PG_URL;
const skipMsg = "AUTH_SVC_PG_URL not set — skipping audit.event_log tests";

async function resetChain(pool: Pool): Promise<void> {
  // TRUNCATE is allowed (the no-update / no-delete triggers are FOR EACH
  // ROW, not statement-level). RESTART IDENTITY resets event_id back to 1.
  await pool.query(`TRUNCATE audit.event_log RESTART IDENTITY`);
}

test("AuditEventLogClient — append() fills hash chain via trigger", { skip: SKIP && skipMsg }, async () => {
  const pool = new Pool({ connectionString: PG_URL, max: 2 });
  try {
    await resetChain(pool);
    const client = new AuditEventLogClient(pool, () => undefined);

    await client.append({
      event_type: "LOGIN_SUCCESS",
      actor: "alice.admin",
      subject_id: "alice.admin",
      source_ip: "10.0.0.1",
      payload: { sid: "sid-test-1" },
    });
    await client.append({
      event_type: "LOGIN_FAILURE",
      actor: null,
      subject_id: "ravi.risk",
      source_ip: "10.0.0.2",
      payload: { reason: "wrong_password" },
    });
    await client.flush();

    const rows = await pool.query(
      `SELECT event_id, event_type, actor, subject_id,
              encode(prev_hash, 'hex') AS prev_hex,
              encode(event_hash, 'hex') AS hash_hex
         FROM audit.event_log ORDER BY event_id ASC`,
    );
    assert.equal(rows.rowCount, 2);
    assert.equal(rows.rows[0].event_type, "LOGIN_SUCCESS");
    assert.equal(rows.rows[0].actor, "alice.admin");
    // First row's prev_hash is the genesis (64 zeros).
    assert.equal(rows.rows[0].prev_hex, "0".repeat(64));
    // Second row's prev_hash is the first row's event_hash.
    assert.equal(rows.rows[1].prev_hex, rows.rows[0].hash_hex);
    // Each event_hash is 32 bytes (64 hex chars) and not all zeros.
    assert.equal(rows.rows[0].hash_hex.length, 64);
    assert.notEqual(rows.rows[0].hash_hex, "0".repeat(64));
  } finally {
    await pool.end();
  }
});

test("AuditEventLogClient — null actor coerced to 'anonymous'", { skip: SKIP && skipMsg }, async () => {
  const pool = new Pool({ connectionString: PG_URL, max: 2 });
  try {
    await resetChain(pool);
    const client = new AuditEventLogClient(pool, () => undefined);
    await client.append({
      event_type: "PASSWORD_RESET_REQUEST_UNKNOWN",
      actor: null,
      subject_id: null,
      source_ip: null,
      payload: { lookup_by: "email" },
    });
    await client.flush();
    const r = await pool.query(`SELECT actor, source_ip FROM audit.event_log`);
    assert.equal(r.rowCount, 1);
    assert.equal(r.rows[0].actor, "anonymous");
    assert.equal(r.rows[0].source_ip, null);
  } finally {
    await pool.end();
  }
});

test("AuditEventLogClient — concurrent appends serialise correctly", { skip: SKIP && skipMsg }, async () => {
  const pool = new Pool({ connectionString: PG_URL, max: 4 });
  try {
    await resetChain(pool);
    const client = new AuditEventLogClient(pool, () => undefined);
    // Fire 10 appends concurrently (no awaits between). The client's
    // internal queue must serialise them so the chain trigger doesn't
    // see two rows competing for the same prev_hash.
    const promises: Promise<void>[] = [];
    for (let i = 0; i < 10; i++) {
      promises.push(
        client.append({
          event_type: "LOGIN_SUCCESS",
          actor: `user-${i}`,
          subject_id: `user-${i}`,
          source_ip: "127.0.0.1",
          payload: { i },
        }),
      );
    }
    await Promise.all(promises);
    await client.flush();
    // All 10 rows landed AND the chain is intact.
    const r = await pool.query(`SELECT count(*)::int AS n FROM audit.event_log`);
    assert.equal(r.rows[0].n, 10);
    // Spot-check the chain: row N's prev_hash equals row N-1's event_hash.
    const chain = await pool.query(
      `SELECT encode(prev_hash, 'hex') AS prev,
              encode(event_hash, 'hex') AS hash
         FROM audit.event_log ORDER BY event_id ASC`,
    );
    for (let i = 1; i < chain.rowCount; i++) {
      assert.equal(
        chain.rows[i].prev,
        chain.rows[i - 1].hash,
        `chain broken at row ${i}`,
      );
    }
  } finally {
    await pool.end();
  }
});

test("PgAuthAuditLog.append() fans out to audit.event_log", { skip: SKIP && skipMsg }, async () => {
  const pool = new Pool({ connectionString: PG_URL, max: 2 });
  try {
    await resetChain(pool);
    await pool.query(`TRUNCATE app_iam.audit_events RESTART IDENTITY`);
    const audit = new PgAuthAuditLog(pool, 100, Date.now, () => undefined);
    await audit.init();

    audit.append({
      type: "login_success",
      target_username: "alice.admin",
      actor_username: "alice.admin",
      actor_role: "admin",
      ip: "10.0.0.1",
      metadata: { sid: "sid-fanout" },
    });
    audit.append({
      type: "login_failure",
      target_username: "ravi.risk",
      ip: "10.0.0.2",
      metadata: { reason: "wrong_password" },
    });

    // Wait for the local INSERT into app_iam.audit_events.
    await new Promise((r) => setTimeout(r, 200));
    // Wait for the chained INSERTs into audit.event_log.
    await audit.flushChain();

    const local = await pool.query(
      `SELECT event_type, target_username FROM app_iam.audit_events ORDER BY occurred_at ASC`,
    );
    assert.equal(local.rowCount, 2);
    assert.equal(local.rows[0].event_type, "login_success");

    const chain = await pool.query(
      `SELECT event_type, actor, subject_id,
              payload->>'_service' AS service,
              payload->>'_local_event_id' AS local_id
         FROM audit.event_log ORDER BY event_id ASC`,
    );
    assert.equal(chain.rowCount, 2);
    assert.equal(chain.rows[0].event_type, "LOGIN_SUCCESS");
    assert.equal(chain.rows[0].actor, "alice.admin");
    assert.equal(chain.rows[0].subject_id, "alice.admin");
    assert.equal(chain.rows[0].service, "auth-svc");
    assert.match(chain.rows[0].local_id, /^ae-/);
    assert.equal(chain.rows[1].event_type, "LOGIN_FAILURE");
    // login_failure has no actor_username — actor falls back to target_username.
    assert.equal(chain.rows[1].actor, "ravi.risk");
  } finally {
    await pool.end();
  }
});

test("PgAuthAuditLog.setChainClient(null) disables fan-out", { skip: SKIP && skipMsg }, async () => {
  const pool = new Pool({ connectionString: PG_URL, max: 2 });
  try {
    await resetChain(pool);
    await pool.query(`TRUNCATE app_iam.audit_events RESTART IDENTITY`);
    const audit = new PgAuthAuditLog(pool, 100, Date.now, () => undefined);
    await audit.init();
    audit.setChainClient(null);

    audit.append({
      type: "login_success",
      target_username: "alice.admin",
      actor_username: "alice.admin",
      actor_role: "admin",
      ip: "10.0.0.1",
      metadata: { sid: "sid-no-fanout" },
    });
    await new Promise((r) => setTimeout(r, 200));
    await audit.flushChain(); // no-op when client is null

    const local = await pool.query(
      `SELECT count(*)::int AS n FROM app_iam.audit_events`,
    );
    assert.equal(local.rows[0].n, 1);
    const chain = await pool.query(
      `SELECT count(*)::int AS n FROM audit.event_log`,
    );
    assert.equal(chain.rows[0].n, 0);
  } finally {
    await pool.end();
  }
});
