// services/auth-svc/src/__tests__/jwks.test.ts
//
// Coverage for GET /.well-known/jwks.json (T4.24 Phase 7).

process.env.AUTH_SVC_RATE_LIMIT = "off";

import test from "node:test";
import assert from "node:assert/strict";
import { buildServer } from "../server.js";

test("GET /.well-known/jwks.json returns the RS256 public key", async () => {
  const app = buildServer();
  const res = await app.inject({
    method: "GET",
    url: "/.well-known/jwks.json",
  });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { keys: Array<Record<string, string>> };
  assert.ok(Array.isArray(body.keys), "must return a JWK Set");
  assert.equal(body.keys.length, 1);
  const jwk = body.keys[0]!;
  assert.equal(jwk.kid, "alias/apex-ews-secret");
  assert.equal(jwk.alg, "RS256");
  assert.equal(jwk.use, "sig");
  assert.equal(jwk.kty, "RSA");
  // Standard JWK RSA fields — n is the modulus (long base64url), e is
  // the exponent (typically AQAB).
  assert.ok(typeof jwk.n === "string" && jwk.n.length > 50);
  assert.ok(typeof jwk.e === "string" && jwk.e.length > 0);
  // Critically: NO private-key fields leak.
  assert.equal(jwk.d, undefined, "private key must not appear in JWKS");
  assert.equal(jwk.p, undefined);
  assert.equal(jwk.q, undefined);
  await app.close();
});

test("JWKS is anonymous — no Authorization required", async () => {
  const app = buildServer();
  const res = await app.inject({
    method: "GET",
    url: "/.well-known/jwks.json",
    // intentionally no auth header
  });
  assert.equal(res.statusCode, 200);
  await app.close();
});

test("JWKS public key verifies an access token minted by /auth/login", async () => {
  const app = buildServer();
  // 1. Login → get an access_token signed by the same signer that the
  //    JWKS endpoint exports.
  const login = await app.inject({
    method: "POST",
    url: "/auth/login",
    payload: { username: "alice.admin", password: "Admin!Pass1" },
  });
  assert.equal(login.statusCode, 200);
  const accessToken = (login.json() as Record<string, string>).access_token;

  // 2. Fetch JWKS.
  const jwksRes = await app.inject({
    method: "GET",
    url: "/.well-known/jwks.json",
  });
  const { keys } = jwksRes.json() as { keys: Array<Record<string, string>> };
  const jwk = keys[0]!;

  // 3. Verify the token using the JWK from the JWKS endpoint.
  const { importJWK, jwtVerify } = await import("jose");
  const key = await importJWK(jwk, jwk.alg);
  const { payload } = await jwtVerify(accessToken, key, {
    issuer: "apex-ews-auth",
    audience: "apex-ews",
  });
  assert.equal(payload.role, "admin");
  assert.equal(payload.tenant_id, "BANK_DEMO");

  await app.close();
});
