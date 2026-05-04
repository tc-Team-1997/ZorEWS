// Unit + integration tests for per-role dashboard widget configuration
// (T4.23, BAC-A manual §3.1.9.1.4).

import test from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";
import {
  InMemoryDashboardWidgetsStore,
  PgDashboardWidgetsStore,
} from "../dashboard_widgets.js";

const PG_URL = process.env.AUTH_SVC_PG_URL;
const SKIP = !PG_URL;
const skipMsg = "AUTH_SVC_PG_URL not set — skipping pg integration tests";

// ─── In-memory store ──────────────────────────────────────────────────

test("InMemoryDashboardWidgetsStore — forRole on missing role returns empty", () => {
  const store = new InMemoryDashboardWidgetsStore();
  assert.deepEqual(store.forRole("admin"), []);
});

test("InMemoryDashboardWidgetsStore — replaceForRole stores + sorts by sort_order", () => {
  const store = new InMemoryDashboardWidgetsStore();
  const stored = store.replaceForRole({
    role: "field_officer",
    updated_by: "alice.admin",
    widgets: [
      { widget_id: "task", sort_order: 10, is_visible: true },
      { widget_id: "portfolio", sort_order: 1, is_visible: false },
      { widget_id: "industry", sort_order: 5, is_visible: true },
    ],
  });
  assert.equal(stored.length, 3);
  assert.equal(stored[0].widget_id, "portfolio");
  assert.equal(stored[1].widget_id, "industry");
  assert.equal(stored[2].widget_id, "task");
  assert.equal(stored[0].is_visible, false);
  // forRole returns the same shape
  const reloaded = store.forRole("field_officer");
  assert.deepEqual(
    reloaded.map((w) => w.widget_id),
    ["portfolio", "industry", "task"],
  );
});

test("InMemoryDashboardWidgetsStore — replaceForRole is replace-not-merge", () => {
  const store = new InMemoryDashboardWidgetsStore();
  store.replaceForRole({
    role: "admin",
    updated_by: "alice.admin",
    widgets: [
      { widget_id: "task", sort_order: 1, is_visible: true },
      { widget_id: "portfolio", sort_order: 2, is_visible: true },
    ],
  });
  // Second call should completely replace, not merge.
  store.replaceForRole({
    role: "admin",
    updated_by: "alice.admin",
    widgets: [{ widget_id: "industry", sort_order: 1, is_visible: true }],
  });
  const reloaded = store.forRole("admin");
  assert.equal(reloaded.length, 1);
  assert.equal(reloaded[0].widget_id, "industry");
});

test("InMemoryDashboardWidgetsStore — validation rejects invalid role + duplicate widgets", () => {
  const store = new InMemoryDashboardWidgetsStore();
  assert.throws(
    () =>
      store.replaceForRole({
        role: "made_up_role" as never,
        updated_by: "x",
        widgets: [],
      }),
    /role must be one of/,
  );
  assert.throws(
    () =>
      store.replaceForRole({
        role: "admin",
        updated_by: "x",
        widgets: [
          { widget_id: "task", sort_order: 1, is_visible: true },
          { widget_id: "task", sort_order: 2, is_visible: true },
        ],
      }),
    /duplicate widget_id/,
  );
  assert.throws(
    () =>
      store.replaceForRole({
        role: "admin",
        updated_by: "",
        widgets: [],
      }),
    /updated_by is required/,
  );
});

test("InMemoryDashboardWidgetsStore — empty widgets array is valid (= no override)", () => {
  const store = new InMemoryDashboardWidgetsStore();
  const stored = store.replaceForRole({
    role: "admin",
    updated_by: "alice.admin",
    widgets: [],
  });
  assert.deepEqual(stored, []);
  assert.deepEqual(store.forRole("admin"), []);
});

// ─── Pg integration tests ─────────────────────────────────────────────

test("PgDashboardWidgetsStore — replace persists + restart rehydrates", { skip: SKIP && skipMsg }, async () => {
  const pool = new Pool({ connectionString: PG_URL, max: 2 });
  try {
    const store = new PgDashboardWidgetsStore(pool, () => undefined);
    await store.init();
    await store.reset();

    store.replaceForRole({
      role: "field_officer",
      updated_by: "alice.admin",
      widgets: [
        { widget_id: "task", sort_order: 1, is_visible: true },
        { widget_id: "portfolio", sort_order: 2, is_visible: false },
      ],
    });
    // The pg replace runs in a transaction inside an async IIFE — wait
    // long enough for it to land.
    await new Promise((r) => setTimeout(r, 300));

    const r = await pool.query(
      `SELECT widget_id, sort_order, is_visible, updated_by
         FROM app_iam.role_dashboard_widgets
        WHERE role = $1 ORDER BY sort_order`,
      ["field_officer"],
    );
    assert.equal(r.rowCount, 2);
    assert.equal(r.rows[0].widget_id, "task");
    assert.equal(r.rows[0].is_visible, true);
    assert.equal(r.rows[0].updated_by, "alice.admin");
    assert.equal(r.rows[1].widget_id, "portfolio");
    assert.equal(r.rows[1].is_visible, false);

    // Restart simulation — fresh store rebuilds from pg.
    const fresh = new PgDashboardWidgetsStore(pool, () => undefined);
    await fresh.init();
    const reloaded = fresh.forRole("field_officer");
    assert.equal(reloaded.length, 2);
    assert.equal(reloaded[0].widget_id, "task");
    assert.equal(reloaded[1].widget_id, "portfolio");
    assert.equal(reloaded[1].is_visible, false);
  } finally {
    await pool.end();
  }
});

test("PgDashboardWidgetsStore — replace is transactional (DELETE + INSERT atomic)", { skip: SKIP && skipMsg }, async () => {
  const pool = new Pool({ connectionString: PG_URL, max: 2 });
  try {
    const store = new PgDashboardWidgetsStore(pool, () => undefined);
    await store.init();
    await store.reset();

    // First replace with 3 widgets.
    store.replaceForRole({
      role: "admin",
      updated_by: "alice.admin",
      widgets: [
        { widget_id: "a", sort_order: 1, is_visible: true },
        { widget_id: "b", sort_order: 2, is_visible: true },
        { widget_id: "c", sort_order: 3, is_visible: true },
      ],
    });
    await new Promise((r) => setTimeout(r, 250));

    // Second replace with 1 widget — should leave exactly 1 row.
    store.replaceForRole({
      role: "admin",
      updated_by: "alice.admin",
      widgets: [{ widget_id: "d", sort_order: 1, is_visible: true }],
    });
    await new Promise((r) => setTimeout(r, 250));

    const r = await pool.query(
      `SELECT widget_id FROM app_iam.role_dashboard_widgets WHERE role = $1`,
      ["admin"],
    );
    assert.equal(r.rowCount, 1);
    assert.equal(r.rows[0].widget_id, "d");
  } finally {
    await pool.end();
  }
});

test("PgDashboardWidgetsStore — schema CHECK constraint rejects unknown role", { skip: SKIP && skipMsg }, async () => {
  const pool = new Pool({ connectionString: PG_URL, max: 2 });
  try {
    await assert.rejects(
      pool.query(
        `INSERT INTO app_iam.role_dashboard_widgets (role, widget_id) VALUES ('made_up', 'x')`,
      ),
      /check constraint/,
    );
  } finally {
    await pool.end();
  }
});
