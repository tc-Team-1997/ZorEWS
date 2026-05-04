// Unit + integration tests for Issue Owner Groups + branch teams
// (T4.21, BAC-A §3.1.7.1.5).
//
// Unit tests run unconditionally against InMemoryTeamStore.
// Pg integration tests are gated on AUTH_SVC_PG_URL.

import test from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";
import {
  InMemoryTeamStore,
  PgTeamStore,
  type ITeamStore,
} from "../teams.js";
import { PgUserStore } from "../pg_user_store.js";

const PG_URL = process.env.AUTH_SVC_PG_URL;
const SKIP = !PG_URL;
const skipMsg = "AUTH_SVC_PG_URL not set — skipping pg integration tests";

function commonHappyPath(store: ITeamStore): UserTeamLike {
  // Returns the created team so the caller can assert on it.
  return store.create({
    name: "Legal Mumbai",
    branch: "mumbai",
    role: "legal",
    team_leader: "u-001",
    email: "legal.mumbai@apex.test",
    description: "Legal counsel for Mumbai branch",
    members: ["u-002", "u-003"],
  });
}

interface UserTeamLike {
  team_id: string;
  members: string[];
  team_leader: string;
}

// ─── In-memory tests ────────────────────────────────────────────────────

test("InMemoryTeamStore — create() seeds team_id + adds leader to members", () => {
  const store = new InMemoryTeamStore();
  const t = commonHappyPath(store);
  assert.match(t.team_id, /^team_/);
  // Leader is implicitly added even though we passed [u-002, u-003].
  assert.ok(t.members.includes("u-001"));
  assert.equal(t.members.length, 3);
});

test("InMemoryTeamStore — duplicate (name, branch) → 409", () => {
  const store = new InMemoryTeamStore();
  commonHappyPath(store);
  assert.throws(
    () =>
      store.create({
        name: "Legal Mumbai",
        branch: "mumbai",
        role: "legal",
        team_leader: "u-001",
      }),
    /already exists/,
  );
});

test("InMemoryTeamStore — list filters by branch + role", () => {
  const store = new InMemoryTeamStore();
  store.create({ name: "Legal Mumbai", branch: "mumbai", role: "legal", team_leader: "u-001" });
  store.create({ name: "Credit Mumbai", branch: "mumbai", role: "credit", team_leader: "u-002" });
  store.create({ name: "Legal Delhi", branch: "delhi", role: "legal", team_leader: "u-003" });

  assert.equal(store.list().length, 3);
  assert.equal(store.list({ branch: "mumbai" }).length, 2);
  assert.equal(store.list({ role: "legal" }).length, 2);
  assert.equal(store.list({ branch: "mumbai", role: "legal" }).length, 1);
});

test("InMemoryTeamStore — addMember + removeMember", () => {
  const store = new InMemoryTeamStore();
  const t = commonHappyPath(store);
  // Idempotent add (already a member returns false).
  assert.equal(store.addMember(t.team_id, "u-002"), false);
  // New member returns true.
  assert.equal(store.addMember(t.team_id, "u-005"), true);
  assert.ok(store.get(t.team_id)?.members.includes("u-005"));
  // Remove non-leader works.
  assert.equal(store.removeMember(t.team_id, "u-002"), true);
  assert.equal(store.get(t.team_id)?.members.includes("u-002"), false);
});

test("InMemoryTeamStore — refuses to remove team_leader (409)", () => {
  const store = new InMemoryTeamStore();
  const t = commonHappyPath(store);
  assert.throws(
    () => store.removeMember(t.team_id, "u-001"),
    /cannot remove team_leader/,
  );
});

test("InMemoryTeamStore — delete + 404 paths", () => {
  const store = new InMemoryTeamStore();
  const t = commonHappyPath(store);
  assert.equal(store.delete(t.team_id), true);
  assert.equal(store.get(t.team_id), undefined);
  assert.equal(store.delete("team_nonexistent"), false);
  assert.equal(store.addMember("team_nonexistent", "u-002"), false);
  assert.equal(store.removeMember("team_nonexistent", "u-002"), false);
});

// ─── Pg integration tests ──────────────────────────────────────────────

test("PgTeamStore — create persists + restart rehydrates members", { skip: SKIP && skipMsg }, async () => {
  const pool = new Pool({ connectionString: PG_URL, max: 2 });
  try {
    // Ensure the demo users exist (FK target).
    const users = new PgUserStore(pool, () => undefined);
    await users.init();
    await users.reset();
    await users.init();

    const store = new PgTeamStore(pool, () => undefined);
    await store.init();
    await store.reset();

    const t = store.create({
      name: "Pg Legal Mumbai",
      branch: "mumbai",
      role: "legal",
      team_leader: "u-001",
      members: ["u-002", "u-003"],
      description: "pg test",
    });
    assert.equal(t.members.length, 3);

    // Wait for fire-and-forget INSERTs to drain.
    await new Promise((r) => setTimeout(r, 250));
    const teamRow = await pool.query(
      `SELECT name, branch, role, team_leader FROM app_iam.user_teams WHERE team_id = $1`,
      [t.team_id],
    );
    assert.equal(teamRow.rowCount, 1);
    assert.equal(teamRow.rows[0].name, "Pg Legal Mumbai");
    assert.equal(teamRow.rows[0].team_leader, "u-001");

    const memberRows = await pool.query(
      `SELECT user_id FROM app_iam.user_team_members WHERE team_id = $1 ORDER BY user_id`,
      [t.team_id],
    );
    assert.equal(memberRows.rowCount, 3);

    // Restart simulation — fresh store rebuilds the cache including members.
    const fresh = new PgTeamStore(pool, () => undefined);
    await fresh.init();
    const recovered = fresh.get(t.team_id);
    assert.ok(recovered);
    assert.equal(recovered!.name, "Pg Legal Mumbai");
    assert.equal(recovered!.members.length, 3);
    assert.ok(recovered!.members.includes("u-001"));
  } finally {
    await pool.end();
  }
});

test("PgTeamStore — addMember + removeMember + delete persist", { skip: SKIP && skipMsg }, async () => {
  const pool = new Pool({ connectionString: PG_URL, max: 2 });
  try {
    const users = new PgUserStore(pool, () => undefined);
    await users.init();
    await users.reset();
    await users.init();

    const store = new PgTeamStore(pool, () => undefined);
    await store.init();
    await store.reset();

    const t = store.create({
      name: "Pg Credit Delhi",
      branch: "delhi",
      role: "credit",
      team_leader: "u-002",
    });
    await new Promise((r) => setTimeout(r, 200));

    assert.equal(store.addMember(t.team_id, "u-003"), true);
    assert.equal(store.addMember(t.team_id, "u-003"), false); // idempotent
    await new Promise((r) => setTimeout(r, 150));
    let r = await pool.query(
      `SELECT count(*)::int AS n FROM app_iam.user_team_members WHERE team_id = $1`,
      [t.team_id],
    );
    assert.equal(r.rows[0].n, 2); // leader + u-003

    assert.equal(store.removeMember(t.team_id, "u-003"), true);
    await new Promise((r) => setTimeout(r, 150));
    r = await pool.query(
      `SELECT count(*)::int AS n FROM app_iam.user_team_members WHERE team_id = $1`,
      [t.team_id],
    );
    assert.equal(r.rows[0].n, 1); // just leader

    // delete cascades through user_team_members.
    assert.equal(store.delete(t.team_id), true);
    await new Promise((r) => setTimeout(r, 150));
    const teamCount = await pool.query(
      `SELECT count(*)::int AS n FROM app_iam.user_teams WHERE team_id = $1`,
      [t.team_id],
    );
    assert.equal(teamCount.rows[0].n, 0);
    const memberCount = await pool.query(
      `SELECT count(*)::int AS n FROM app_iam.user_team_members WHERE team_id = $1`,
      [t.team_id],
    );
    assert.equal(memberCount.rows[0].n, 0);
  } finally {
    await pool.end();
  }
});

test("PgTeamStore — duplicate (name, branch) → 409", { skip: SKIP && skipMsg }, async () => {
  const pool = new Pool({ connectionString: PG_URL, max: 2 });
  try {
    const users = new PgUserStore(pool, () => undefined);
    await users.init();
    await users.reset();
    await users.init();

    const store = new PgTeamStore(pool, () => undefined);
    await store.init();
    await store.reset();

    store.create({
      name: "Pg Dup Test",
      branch: "branch-x",
      role: "legal",
      team_leader: "u-001",
    });
    assert.throws(
      () =>
        store.create({
          name: "Pg Dup Test",
          branch: "branch-x",
          role: "legal",
          team_leader: "u-001",
        }),
      /already exists/,
    );
  } finally {
    await pool.end();
  }
});

test("PgTeamStore — refuses to remove team_leader (409)", { skip: SKIP && skipMsg }, async () => {
  const pool = new Pool({ connectionString: PG_URL, max: 2 });
  try {
    const users = new PgUserStore(pool, () => undefined);
    await users.init();
    await users.reset();
    await users.init();

    const store = new PgTeamStore(pool, () => undefined);
    await store.init();
    await store.reset();

    const t = store.create({
      name: "Pg Leader Test",
      branch: "mumbai",
      role: "legal",
      team_leader: "u-001",
    });
    assert.throws(() => store.removeMember(t.team_id, "u-001"), /cannot remove team_leader/);
  } finally {
    await pool.end();
  }
});
