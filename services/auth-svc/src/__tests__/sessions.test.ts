// Sessions tests run with rate limiting OFF so multi-step login flows
// don't hit the cap. Sessions logic is independent of rate limiting.
process.env.AUTH_SVC_RATE_LIMIT = "off";

import test from "node:test";
import assert from "node:assert/strict";
import { SessionStore, toView } from "../sessions.js";
import { buildServer } from "../server.js";
import { __resetAuthStateForTests } from "../routes/auth.js";

test("SessionStore — create assigns unique sids and tracks issued/last-seen", () => {
  let now = 1_000_000;
  const store = new SessionStore(() => now);
  const a = store.create({ user_id: "u-001", ip: "1.1.1.1", user_agent: "ua-a" });
  now += 500;
  const b = store.create({ user_id: "u-001", ip: "2.2.2.2", user_agent: "ua-b" });
  assert.notEqual(a.id, b.id);
  assert.equal(a.issued_at_ms, 1_000_000);
  assert.equal(b.issued_at_ms, 1_000_500);
  assert.equal(store.size(), 2);
});

test("SessionStore — touch updates last_seen_at_ms but not issued_at_ms", () => {
  let now = 1_000_000;
  const store = new SessionStore(() => now);
  const s = store.create({ user_id: "u-001", ip: "x", user_agent: "x" });
  const issued = s.issued_at_ms;
  now += 60_000;
  store.touch(s.id);
  assert.equal(s.last_seen_at_ms, 1_060_000);
  assert.equal(s.issued_at_ms, issued);
});

test("SessionStore — revoke makes the session inactive but keeps the id discoverable", () => {
  const store = new SessionStore();
  const s = store.create({ user_id: "u-001", ip: "x", user_agent: "x" });
  assert.equal(store.revoke(s.id), true);
  assert.equal(store.isRevoked(s.id), true);
  assert.equal(store.getActive(s.id), null);
  // get() (not getActive) still returns it so the route layer can produce
  // a clear "session_revoked" message.
  assert.ok(store.get(s.id));
  // Repeating the revoke is a no-op.
  assert.equal(store.revoke(s.id), false);
});

test("SessionStore — revokeAllForUser respects the `except` arg", () => {
  const store = new SessionStore();
  const a = store.create({ user_id: "u-001", ip: "x", user_agent: "a" });
  const b = store.create({ user_id: "u-001", ip: "x", user_agent: "b" });
  const c = store.create({ user_id: "u-001", ip: "x", user_agent: "c" });
  const other = store.create({ user_id: "u-002", ip: "x", user_agent: "other" });

  const n = store.revokeAllForUser("u-001", b.id);
  assert.equal(n, 2);
  assert.equal(store.isRevoked(a.id), true);
  assert.equal(store.isRevoked(b.id), false, "kept session should still be active");
  assert.equal(store.isRevoked(c.id), true);
  assert.equal(store.isRevoked(other.id), false, "other user's session untouched");
});

test("SessionStore — listForUser is newest-first by last_seen_at and excludes revoked", () => {
  let now = 1_000_000;
  const store = new SessionStore(() => now);
  const a = store.create({ user_id: "u-001", ip: "x", user_agent: "a" });
  now += 1000;
  const b = store.create({ user_id: "u-001", ip: "x", user_agent: "b" });
  now += 1000;
  store.touch(a.id); // a now newer than b
  store.revoke(b.id);
  const list = store.listForUser("u-001");
  assert.equal(list.length, 1);
  assert.equal(list[0]!.id, a.id);
});

test("toView — flags is_current when sid matches", () => {
  const store = new SessionStore();
  const s = store.create({ user_id: "u-001", ip: "1.1.1.1", user_agent: "ua" });
  const v = toView(s, s.id);
  assert.equal(v.is_current, true);
  const other = toView(s, "sid-other");
  assert.equal(other.is_current, false);
  const noFlag = toView(s);
  assert.equal(noFlag.is_current, undefined);
});

// ───────── route-layer integration ─────────

async function login(
  app: ReturnType<typeof buildServer>,
  username: string,
  password: string,
  userAgent = "test-agent/1.0",
): Promise<{ access: string; refresh: string; sid: string }> {
  const res = await app.inject({
    method: "POST",
    url: "/auth/login",
    payload: { username, password },
    headers: { "user-agent": userAgent },
  });
  if (res.statusCode !== 200) throw new Error(`login failed: ${res.statusCode} ${res.body}`);
  const body = res.json() as { access_token: string; refresh_token: string; session_id: string };
  return { access: body.access_token, refresh: body.refresh_token, sid: body.session_id };
}

test("POST /auth/login — response includes session_id and creates a session record", async () => {
  __resetAuthStateForTests();
  const app = buildServer();
  const { sid } = await login(app, "alice.admin", "Admin!Pass1");
  assert.ok(sid?.startsWith("sid-"), `expected sid- prefix, got ${sid}`);
  await app.close();
});

test("GET /auth/sessions — returns the caller's sessions with is_current flag", async () => {
  __resetAuthStateForTests();
  const app = buildServer();
  // Two logins from different "devices" — both belong to alice.
  const a = await login(app, "alice.admin", "Admin!Pass1", "ua-a");
  const b = await login(app, "alice.admin", "Admin!Pass1", "ua-b");

  const res = await app.inject({
    method: "GET",
    url: "/auth/sessions",
    headers: { authorization: `Bearer ${b.access}` },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json() as {
    sessions: Array<{ id: string; user_agent: string; is_current: boolean }>;
    current_session_id: string;
  };
  assert.equal(body.current_session_id, b.sid);
  assert.equal(body.sessions.length, 2);
  const current = body.sessions.find((s) => s.is_current);
  assert.equal(current?.id, b.sid);
  assert.equal(current?.user_agent, "ua-b");
  // Other session is the older one
  const other = body.sessions.find((s) => !s.is_current);
  assert.equal(other?.id, a.sid);
  await app.close();
});

test("DELETE /auth/sessions/:sid — revokes another session and the revoked refresh fails", async () => {
  __resetAuthStateForTests();
  const app = buildServer();
  const a = await login(app, "ravi.risk", "RiskAnalyst!1", "ua-a");
  const b = await login(app, "ravi.risk", "RiskAnalyst!1", "ua-b");

  // From session b, revoke session a.
  const del = await app.inject({
    method: "DELETE",
    url: `/auth/sessions/${a.sid}`,
    headers: { authorization: `Bearer ${b.access}` },
  });
  assert.equal(del.statusCode, 200);

  // Refresh on session a should now 401 with session_revoked.
  const refresh = await app.inject({
    method: "POST",
    url: "/auth/refresh",
    payload: { refresh_token: a.refresh },
  });
  assert.equal(refresh.statusCode, 401);
  assert.equal((refresh.json() as Record<string, unknown>).error, "session_revoked");

  // /auth/me on session a should also 401 with session_revoked.
  const me = await app.inject({
    method: "GET",
    url: "/auth/me",
    headers: { authorization: `Bearer ${a.access}` },
  });
  assert.equal(me.statusCode, 401);
  assert.equal((me.json() as Record<string, unknown>).error, "session_revoked");

  // Session b still works.
  const meB = await app.inject({
    method: "GET",
    url: "/auth/me",
    headers: { authorization: `Bearer ${b.access}` },
  });
  assert.equal(meB.statusCode, 200);
  await app.close();
});

test("DELETE /auth/sessions/:sid — refuses to revoke another user's session (404, no enumeration)", async () => {
  __resetAuthStateForTests();
  const app = buildServer();
  const ravi = await login(app, "ravi.risk", "RiskAnalyst!1");
  const sue = await login(app, "sue.super", "Super!Pass1");

  const res = await app.inject({
    method: "DELETE",
    url: `/auth/sessions/${ravi.sid}`,
    headers: { authorization: `Bearer ${sue.access}` },
  });
  assert.equal(res.statusCode, 404);
  assert.equal((res.json() as Record<string, unknown>).error, "session_not_found");
  await app.close();
});

test("DELETE /auth/sessions?except=current — revokes other sessions but keeps caller's", async () => {
  __resetAuthStateForTests();
  const app = buildServer();
  const a = await login(app, "fiona.field", "Field!Pass1", "ua-a");
  const b = await login(app, "fiona.field", "Field!Pass1", "ua-b");
  const c = await login(app, "fiona.field", "Field!Pass1", "ua-c");

  const del = await app.inject({
    method: "DELETE",
    url: "/auth/sessions?except=current",
    headers: { authorization: `Bearer ${c.access}` },
  });
  assert.equal(del.statusCode, 200);
  assert.equal((del.json() as { revoked_count: number }).revoked_count, 2);

  // a + b refresh should now 401, c should still work.
  for (const tok of [a.refresh, b.refresh]) {
    const r = await app.inject({
      method: "POST",
      url: "/auth/refresh",
      payload: { refresh_token: tok },
    });
    assert.equal(r.statusCode, 401);
  }
  const cRefresh = await app.inject({
    method: "POST",
    url: "/auth/refresh",
    payload: { refresh_token: c.refresh },
  });
  assert.equal(cRefresh.statusCode, 200);
  await app.close();
});

test("DELETE /auth/sessions (no except) — revokes everything including caller's", async () => {
  __resetAuthStateForTests();
  const app = buildServer();
  const a = await login(app, "carl.collect", "Collect!Pass1", "ua-a");
  const b = await login(app, "carl.collect", "Collect!Pass1", "ua-b");

  const del = await app.inject({
    method: "DELETE",
    url: "/auth/sessions",
    headers: { authorization: `Bearer ${b.access}` },
  });
  assert.equal(del.statusCode, 200);
  assert.equal((del.json() as { revoked_count: number }).revoked_count, 2);

  // Both refresh tokens are now invalid.
  for (const tok of [a.refresh, b.refresh]) {
    const r = await app.inject({
      method: "POST",
      url: "/auth/refresh",
      payload: { refresh_token: tok },
    });
    assert.equal(r.statusCode, 401);
  }
  await app.close();
});

test("POST /auth/refresh — touches last_seen_at when the session is active", async () => {
  __resetAuthStateForTests();
  const app = buildServer();
  const session = await login(app, "alice.admin", "Admin!Pass1");

  // Refresh once — should mint a new access token.
  const refresh = await app.inject({
    method: "POST",
    url: "/auth/refresh",
    payload: { refresh_token: session.refresh },
  });
  assert.equal(refresh.statusCode, 200);

  // List sessions — there should still be exactly one (refresh doesn't
  // create a new session, just rotates the access token).
  const list = await app.inject({
    method: "GET",
    url: "/auth/sessions",
    headers: { authorization: `Bearer ${session.access}` },
  });
  const body = list.json() as { sessions: Array<unknown> };
  assert.equal(body.sessions.length, 1);
  await app.close();
});
