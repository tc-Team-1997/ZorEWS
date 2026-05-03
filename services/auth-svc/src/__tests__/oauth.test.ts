// services/auth-svc/src/__tests__/oauth.test.ts
//
// Coverage for POST /oauth/token (T4.24, Banking API doc §7).
// Uses node's built-in test runner like the rest of auth-svc.

process.env.AUTH_SVC_RATE_LIMIT = "off";

import test from "node:test";
import assert from "node:assert/strict";
import { buildServer } from "../server.js";

test("POST /oauth/token — happy path with seeded BANK_DEMO client", async () => {
  const app = buildServer();
  const res = await app.inject({
    method: "POST",
    url: "/oauth/token",
    payload: {
      grant_type: "client_credentials",
      client_id: "apex-mobile-bank-demo",
      client_secret: "demo-secret-bank",
      tenant_id: "BANK_DEMO",
    },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json() as Record<string, unknown>;
  assert.equal(body.token_type, "Bearer");
  assert.equal(body.tenant_id, "BANK_DEMO");
  assert.equal(typeof body.access_token, "string");
  assert.ok((body.access_token as string).length > 50);
  assert.equal(body.expires_in, 3600);
  await app.close();
});

test("POST /oauth/token — accepts tenant_id from X-Tenant-ID header", async () => {
  const app = buildServer();
  const res = await app.inject({
    method: "POST",
    url: "/oauth/token",
    headers: { "X-Tenant-ID": "BIL" },
    payload: {
      grant_type: "client_credentials",
      client_id: "bil-los-stub",
      client_secret: "demo-secret-bil",
    },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json() as Record<string, unknown>;
  assert.equal(body.tenant_id, "BIL");
  await app.close();
});

test("POST /oauth/token — wrong secret returns invalid_client 401", async () => {
  const app = buildServer();
  const res = await app.inject({
    method: "POST",
    url: "/oauth/token",
    payload: {
      grant_type: "client_credentials",
      client_id: "apex-mobile-bank-demo",
      client_secret: "WRONG",
      tenant_id: "BANK_DEMO",
    },
  });
  assert.equal(res.statusCode, 401);
  const body = res.json() as Record<string, unknown>;
  assert.equal(body.error, "invalid_client");
  await app.close();
});

test("POST /oauth/token — unknown client returns invalid_client 401 (no enumeration leak)", async () => {
  const app = buildServer();
  const res = await app.inject({
    method: "POST",
    url: "/oauth/token",
    payload: {
      grant_type: "client_credentials",
      client_id: "does-not-exist",
      client_secret: "x",
      tenant_id: "BANK_DEMO",
    },
  });
  assert.equal(res.statusCode, 401);
  assert.equal((res.json() as Record<string, unknown>).error, "invalid_client");
  await app.close();
});

test("POST /oauth/token — wrong tenant for valid client returns invalid_client 401", async () => {
  const app = buildServer();
  // The bank client is registered for BANK_DEMO, not BIL.
  const res = await app.inject({
    method: "POST",
    url: "/oauth/token",
    payload: {
      grant_type: "client_credentials",
      client_id: "apex-mobile-bank-demo",
      client_secret: "demo-secret-bank",
      tenant_id: "BIL",
    },
  });
  assert.equal(res.statusCode, 401);
  await app.close();
});

test("POST /oauth/token — rejects unsupported grant_type", async () => {
  const app = buildServer();
  const res = await app.inject({
    method: "POST",
    url: "/oauth/token",
    payload: {
      grant_type: "password",
      client_id: "apex-mobile-bank-demo",
      client_secret: "demo-secret-bank",
      tenant_id: "BANK_DEMO",
    },
  });
  assert.equal(res.statusCode, 400);
  assert.equal((res.json() as Record<string, unknown>).error, "unsupported_grant_type");
  await app.close();
});

test("POST /oauth/token — missing fields return invalid_request 400", async () => {
  const app = buildServer();
  const res = await app.inject({
    method: "POST",
    url: "/oauth/token",
    payload: { grant_type: "client_credentials" },
  });
  assert.equal(res.statusCode, 400);
  assert.equal((res.json() as Record<string, unknown>).error, "invalid_request");
  await app.close();
});
