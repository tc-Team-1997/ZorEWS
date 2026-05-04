// services/auth-svc/src/__tests__/service_clients_crud.test.ts
//
// Coverage for GET/POST/DELETE /auth/service-clients (T4.24 Phase 11).
//
// All endpoints require admin via Bearer JWT. We log in as alice.admin
// in each test to mint the token, then exercise the CRUD path. The
// in-memory service-client store is shared across requests in the
// process, so tests that create a client also clean it up via DELETE.

process.env.AUTH_SVC_RATE_LIMIT = "off";

import test from "node:test";
import assert from "node:assert/strict";
import { buildServer } from "../server.js";
import {
  __resetServiceClientStoreForTests,
} from "../service_clients.js";

async function adminToken(app: ReturnType<typeof buildServer>): Promise<string> {
  const r = await app.inject({
    method: "POST",
    url: "/auth/login",
    payload: { username: "alice.admin", password: "Admin!Pass1" },
  });
  assert.equal(r.statusCode, 200);
  return (r.json() as Record<string, string>).access_token;
}

test("GET /auth/service-clients lists seeded clients (admin)", async () => {
  __resetServiceClientStoreForTests();
  const app = buildServer();
  const token = await adminToken(app);

  const res = await app.inject({
    method: "GET",
    url: "/auth/service-clients",
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json() as {
    items: Array<{ client_id: string; tenant_id: string; client_secret_hash?: string }>;
    total: number;
  };
  assert.ok(body.total >= 2, "at least the 2 seed clients");
  const ids = body.items.map((c) => `${c.tenant_id}:${c.client_id}`).sort();
  assert.ok(ids.includes("BANK_DEMO:apex-mobile-bank-demo"));
  assert.ok(ids.includes("BIL:bil-los-stub"));
  // Crucially: no secret hashes leaked
  for (const it of body.items) {
    assert.equal(it.client_secret_hash, undefined, "list must not leak secret hashes");
  }
  await app.close();
});

test("GET /auth/service-clients?tenant_id=BIL filters to one tenant", async () => {
  __resetServiceClientStoreForTests();
  const app = buildServer();
  const token = await adminToken(app);

  const res = await app.inject({
    method: "GET",
    url: "/auth/service-clients?tenant_id=BIL",
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { items: Array<{ tenant_id: string }>; total: number };
  assert.ok(body.total >= 1);
  for (const it of body.items) {
    assert.equal(it.tenant_id, "BIL");
  }
  await app.close();
});

test("GET /auth/service-clients without admin token → 401", async () => {
  __resetServiceClientStoreForTests();
  const app = buildServer();
  const res = await app.inject({
    method: "GET",
    url: "/auth/service-clients",
  });
  assert.equal(res.statusCode, 401);
  await app.close();
});

test("POST /auth/service-clients — happy path returns secret ONCE + token verifies", async () => {
  __resetServiceClientStoreForTests();
  const app = buildServer();
  const token = await adminToken(app);

  const created = await app.inject({
    method: "POST",
    url: "/auth/service-clients",
    headers: { authorization: `Bearer ${token}` },
    payload: {
      tenant_id: "BANK_DEMO",
      client_id: "ci-test-client",
      display_name: "CI test client",
      scopes: [],
    },
  });
  assert.equal(created.statusCode, 201);
  const body = created.json() as Record<string, unknown>;
  assert.equal(body.tenant_id, "BANK_DEMO");
  assert.equal(body.client_id, "ci-test-client");
  // Plaintext secret returned exactly once.
  assert.ok(typeof body.client_secret === "string" && (body.client_secret as string).length === 64);

  // Round-trip: the new client can mint a token via /oauth/token.
  const tokenRes = await app.inject({
    method: "POST",
    url: "/oauth/token",
    payload: {
      grant_type: "client_credentials",
      client_id: "ci-test-client",
      client_secret: body.client_secret,
      tenant_id: "BANK_DEMO",
    },
  });
  assert.equal(tokenRes.statusCode, 200);
  assert.equal((tokenRes.json() as Record<string, string>).tenant_id, "BANK_DEMO");

  // Subsequent list does NOT include the secret hash.
  const list = await app.inject({
    method: "GET",
    url: "/auth/service-clients?tenant_id=BANK_DEMO",
    headers: { authorization: `Bearer ${token}` },
  });
  const items = (list.json() as { items: Record<string, unknown>[] }).items;
  const ours = items.find((c) => c.client_id === "ci-test-client");
  assert.ok(ours);
  assert.equal(ours.client_secret_hash, undefined);
  assert.equal(ours.client_secret, undefined);

  // Cleanup
  await app.inject({
    method: "DELETE",
    url: "/auth/service-clients/BANK_DEMO/ci-test-client",
    headers: { authorization: `Bearer ${token}` },
  });
  await app.close();
});

test("POST /auth/service-clients — 409 on duplicate (tenant_id, client_id)", async () => {
  __resetServiceClientStoreForTests();
  const app = buildServer();
  const token = await adminToken(app);

  // The seed already contains apex-mobile-bank-demo for BANK_DEMO.
  const dup = await app.inject({
    method: "POST",
    url: "/auth/service-clients",
    headers: { authorization: `Bearer ${token}` },
    payload: {
      tenant_id: "BANK_DEMO",
      client_id: "apex-mobile-bank-demo",
      display_name: "Duplicate attempt",
    },
  });
  assert.equal(dup.statusCode, 409);
  const body = dup.json() as Record<string, unknown>;
  assert.equal(body.error, "client_exists");
  assert.equal(body.tenant_id, "BANK_DEMO");
  assert.equal(body.client_id, "apex-mobile-bank-demo");
  await app.close();
});

test("POST /auth/service-clients — 400 on malformed client_id", async () => {
  __resetServiceClientStoreForTests();
  const app = buildServer();
  const token = await adminToken(app);

  const r = await app.inject({
    method: "POST",
    url: "/auth/service-clients",
    headers: { authorization: `Bearer ${token}` },
    payload: {
      tenant_id: "BANK_DEMO",
      client_id: "BAD-UPPERCASE", // must be lowercase regex
      display_name: "X",
    },
  });
  assert.equal(r.statusCode, 400);
  await app.close();
});

test("DELETE /auth/service-clients/:tenant/:client — 204 then 404", async () => {
  __resetServiceClientStoreForTests();
  const app = buildServer();
  const token = await adminToken(app);

  // Create a deletable one.
  await app.inject({
    method: "POST",
    url: "/auth/service-clients",
    headers: { authorization: `Bearer ${token}` },
    payload: {
      tenant_id: "BIL",
      client_id: "ci-temp-bil",
      display_name: "Temp BIL",
    },
  });
  const d1 = await app.inject({
    method: "DELETE",
    url: "/auth/service-clients/BIL/ci-temp-bil",
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(d1.statusCode, 204);
  const d2 = await app.inject({
    method: "DELETE",
    url: "/auth/service-clients/BIL/ci-temp-bil",
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(d2.statusCode, 404);
  await app.close();
});

test("non-admin cannot manage service clients", async () => {
  __resetServiceClientStoreForTests();
  const app = buildServer();
  // Login as a non-admin (ravi.risk = risk_analyst)
  const r = await app.inject({
    method: "POST",
    url: "/auth/login",
    payload: { username: "ravi.risk", password: "RiskAnalyst!1" },
  });
  const token = (r.json() as Record<string, string>).access_token;
  const list = await app.inject({
    method: "GET",
    url: "/auth/service-clients",
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(list.statusCode, 403);
  await app.close();
});
