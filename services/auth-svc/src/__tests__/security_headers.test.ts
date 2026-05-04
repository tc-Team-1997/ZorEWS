// auth-svc has rate-limiting + audit baked into request handling, but
// the security headers hook applies regardless. Disable rate-limiting
// for this test for parity with the other suites.
process.env.AUTH_SVC_RATE_LIMIT = "off";

import test from "node:test";
import assert from "node:assert/strict";
import { buildServer } from "../server.js";

test("auth-svc — every response carries the OWASP security headers", async () => {
  const app = buildServer();
  const r = await app.inject({ method: "GET", url: "/healthz" });
  assert.equal(r.statusCode, 200);
  assert.match(r.headers["strict-transport-security"] as string, /max-age=31536000/);
  assert.equal(r.headers["x-content-type-options"], "nosniff");
  assert.equal(r.headers["x-frame-options"], "DENY");
  assert.equal(r.headers["referrer-policy"], "strict-origin-when-cross-origin");
  assert.match(r.headers["permissions-policy"] as string, /camera=\(\)/);
  assert.match(r.headers["content-security-policy"] as string, /frame-ancestors 'none'/);
  assert.equal(r.headers["cross-origin-resource-policy"], "same-origin");
  assert.equal(r.headers["cross-origin-opener-policy"], "same-origin");
  await app.close();
});

test("auth-svc — security headers present on 401 error responses", async () => {
  const app = buildServer();
  const r = await app.inject({ method: "GET", url: "/auth/me" });
  assert.equal(r.statusCode, 401);
  assert.equal(r.headers["x-content-type-options"], "nosniff");
  assert.match(r.headers["content-security-policy"] as string, /default-src 'none'/);
  await app.close();
});

test("auth-svc — security headers present on 200 login response", async () => {
  const app = buildServer();
  const r = await app.inject({
    method: "POST",
    url: "/auth/login",
    payload: { username: "alice.admin", password: "Admin!Pass1" },
  });
  assert.equal(r.statusCode, 200);
  assert.equal(r.headers["x-frame-options"], "DENY");
  assert.match(r.headers["strict-transport-security"] as string, /max-age=31536000/);
  await app.close();
});
