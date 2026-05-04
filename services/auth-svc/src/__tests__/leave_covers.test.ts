// Unit + integration tests for leave covers
// (T4.22, BAC-A manual §3.1.9.1.3).

import test from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";
import {
  InMemoryLeaveCoverStore,
  PgLeaveCoverStore,
  type ILeaveCoverStore,
} from "../leave_covers.js";
import { PgUserStore } from "../pg_user_store.js";

const PG_URL = process.env.AUTH_SVC_PG_URL;
const SKIP = !PG_URL;
const skipMsg = "AUTH_SVC_PG_URL not set — skipping pg integration tests";

function commonCover(store: ILeaveCoverStore) {
  return store.create({
    applicant_user: "u-001",
    leave_coverer: "u-002",
    role: "risk_analyst",
    start_date: "2026-05-10",
    end_date: "2026-05-20",
    in_office: false,
    comments: "annual leave",
  });
}

// ─── In-memory store ───────────────────────────────────────────────────

test("InMemoryLeaveCoverStore — create + activeCoverFor on dates inside range", () => {
  const store = new InMemoryLeaveCoverStore();
  const cover = commonCover(store);
  assert.match(cover.cover_id, /^lc_/);
  // Inside the range — covers active.
  assert.equal(store.activeCoverFor("u-001", "2026-05-10")?.cover_id, cover.cover_id);
  assert.equal(store.activeCoverFor("u-001", "2026-05-15")?.cover_id, cover.cover_id);
  assert.equal(store.activeCoverFor("u-001", "2026-05-20")?.cover_id, cover.cover_id);
  // Outside the range — undefined.
  assert.equal(store.activeCoverFor("u-001", "2026-05-09"), undefined);
  assert.equal(store.activeCoverFor("u-001", "2026-05-21"), undefined);
  // Wrong user — undefined.
  assert.equal(store.activeCoverFor("u-099", "2026-05-15"), undefined);
});

test("InMemoryLeaveCoverStore — cancel hides cover from activeCoverFor", () => {
  const store = new InMemoryLeaveCoverStore();
  const cover = commonCover(store);
  assert.equal(store.cancel(cover.cover_id), true);
  assert.equal(store.activeCoverFor("u-001", "2026-05-15"), undefined);
  // Re-cancel is a no-op (returns false).
  assert.equal(store.cancel(cover.cover_id), false);
  // The row is still in get() but with cancelled_at set.
  assert.notEqual(store.get(cover.cover_id)?.cancelled_at, null);
});

test("InMemoryLeaveCoverStore — validation rejects invalid input", () => {
  const store = new InMemoryLeaveCoverStore();
  // Same user as applicant + coverer.
  assert.throws(
    () =>
      store.create({
        applicant_user: "u-001",
        leave_coverer: "u-001",
        role: "risk_analyst",
        start_date: "2026-05-10",
        end_date: "2026-05-20",
      }),
    /must differ/,
  );
  // end_date < start_date.
  assert.throws(
    () =>
      store.create({
        applicant_user: "u-001",
        leave_coverer: "u-002",
        role: "risk_analyst",
        start_date: "2026-05-20",
        end_date: "2026-05-10",
      }),
    /end_date must be >= start_date/,
  );
  // Bad date format.
  assert.throws(
    () =>
      store.create({
        applicant_user: "u-001",
        leave_coverer: "u-002",
        role: "risk_analyst",
        start_date: "10/05/2026",
        end_date: "2026-05-20",
      }),
    /YYYY-MM-DD/,
  );
});

test("InMemoryLeaveCoverStore — list filters by applicant + active_only + active_on", () => {
  const store = new InMemoryLeaveCoverStore();
  store.create({
    applicant_user: "u-001",
    leave_coverer: "u-002",
    role: "risk_analyst",
    start_date: "2026-05-10",
    end_date: "2026-05-20",
  });
  const cancelled = store.create({
    applicant_user: "u-001",
    leave_coverer: "u-003",
    role: "supervisor",
    start_date: "2026-06-01",
    end_date: "2026-06-15",
  });
  store.cancel(cancelled.cover_id);
  store.create({
    applicant_user: "u-002",
    leave_coverer: "u-001",
    role: "risk_analyst",
    start_date: "2026-05-15",
    end_date: "2026-05-25",
  });

  // active_only default → cancelled filtered out → 2 rows.
  assert.equal(store.list().length, 2);
  // include cancelled → 3.
  assert.equal(store.list({ active_only: false }).length, 3);
  // applicant filter.
  assert.equal(store.list({ applicant_user: "u-001" }).length, 1);
  // active_on filter — 2026-05-15 is inside the first AND third covers.
  assert.equal(store.list({ active_on: "2026-05-15" }).length, 2);
  // 2026-05-22 is only inside the third cover.
  assert.equal(store.list({ active_on: "2026-05-22" }).length, 1);
});

test("InMemoryLeaveCoverStore — multiple overlapping covers: most-recent wins", async () => {
  const store = new InMemoryLeaveCoverStore();
  store.create({
    applicant_user: "u-001",
    leave_coverer: "u-002",
    role: "risk_analyst",
    start_date: "2026-05-10",
    end_date: "2026-05-30",
  });
  // Tiny pause so the second cover has a strictly later created_at.
  await new Promise((r) => setTimeout(r, 5));
  const newer = store.create({
    applicant_user: "u-001",
    leave_coverer: "u-005",
    role: "risk_analyst",
    start_date: "2026-05-15",
    end_date: "2026-05-25",
  });
  // Both active on 2026-05-20; newest wins.
  assert.equal(store.activeCoverFor("u-001", "2026-05-20")?.cover_id, newer.cover_id);
});

// ─── Pg integration tests ──────────────────────────────────────────────

test("PgLeaveCoverStore — create + activeCoverFor + cancel persist; restart rehydrates", { skip: SKIP && skipMsg }, async () => {
  const pool = new Pool({ connectionString: PG_URL, max: 2 });
  try {
    const users = new PgUserStore(pool, () => undefined);
    await users.init();
    await users.reset();
    await users.init();

    const store = new PgLeaveCoverStore(pool, () => undefined);
    await store.init();
    await store.reset();

    const cover = store.create({
      applicant_user: "u-001",
      leave_coverer: "u-002",
      role: "risk_analyst",
      start_date: "2026-05-10",
      end_date: "2026-05-20",
      comments: "pg test",
    });
    await new Promise((r) => setTimeout(r, 200));

    const r = await pool.query(
      `SELECT applicant_user, leave_coverer, role,
              start_date::text AS start_date,
              end_date::text   AS end_date,
              in_office, comments
         FROM app_iam.leave_covers WHERE cover_id = $1`,
      [cover.cover_id],
    );
    assert.equal(r.rowCount, 1);
    assert.equal(r.rows[0].applicant_user, "u-001");
    assert.equal(r.rows[0].leave_coverer, "u-002");
    assert.equal(r.rows[0].start_date, "2026-05-10");
    assert.equal(r.rows[0].end_date, "2026-05-20");
    assert.equal(r.rows[0].in_office, false);
    assert.equal(r.rows[0].comments, "pg test");

    // activeCoverFor works against the cache.
    assert.equal(store.activeCoverFor("u-001", "2026-05-15")?.cover_id, cover.cover_id);

    // Restart simulation — fresh store rebuilds the cache, dates intact.
    const fresh = new PgLeaveCoverStore(pool, () => undefined);
    await fresh.init();
    const recovered = fresh.get(cover.cover_id);
    assert.ok(recovered);
    assert.equal(recovered!.start_date, "2026-05-10");
    assert.equal(recovered!.end_date, "2026-05-20");
    assert.equal(fresh.activeCoverFor("u-001", "2026-05-15")?.cover_id, cover.cover_id);

    // Cancel → row updates in pg + activeCoverFor returns undefined.
    assert.equal(store.cancel(cover.cover_id), true);
    await new Promise((r) => setTimeout(r, 150));
    const r2 = await pool.query(
      `SELECT cancelled_at FROM app_iam.leave_covers WHERE cover_id = $1`,
      [cover.cover_id],
    );
    assert.notEqual(r2.rows[0].cancelled_at, null);
    assert.equal(store.activeCoverFor("u-001", "2026-05-15"), undefined);
  } finally {
    await pool.end();
  }
});

test("PgLeaveCoverStore — schema CHECK rejects applicant=coverer + bad date range", { skip: SKIP && skipMsg }, async () => {
  // Belt-and-braces: even if the app validation were skipped, the DB
  // CHECK constraints catch the same errors. This test bypasses the
  // store wrapper and tries to INSERT directly.
  const pool = new Pool({ connectionString: PG_URL, max: 2 });
  try {
    const users = new PgUserStore(pool, () => undefined);
    await users.init();

    // applicant = coverer
    await assert.rejects(
      pool.query(
        `INSERT INTO app_iam.leave_covers (
            cover_id, applicant_user, leave_coverer, role, start_date, end_date
         ) VALUES ('lc_dup', 'u-001', 'u-001', 'risk_analyst', '2026-05-10', '2026-05-20')`,
      ),
      /check constraint/,
    );
    // end_date < start_date
    await assert.rejects(
      pool.query(
        `INSERT INTO app_iam.leave_covers (
            cover_id, applicant_user, leave_coverer, role, start_date, end_date
         ) VALUES ('lc_bad', 'u-001', 'u-002', 'risk_analyst', '2026-05-20', '2026-05-10')`,
      ),
      /check constraint/,
    );
  } finally {
    await pool.end();
  }
});
