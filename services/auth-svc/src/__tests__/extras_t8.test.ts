// Phase 9 T8 — admin user-create extra fields acceptance tests.
//
// Covers POST /auth/users body acceptance for `extras.{profile,contact,address}`
// + soft validation (DOB format / gender enum / alternate_email shape) +
// pass-through into the register-result.

process.env.AUTH_SVC_RATE_LIMIT = "off";

import test from "node:test";
import assert from "node:assert/strict";
import { buildServer } from "../server.js";

async function login(
  app: ReturnType<typeof buildServer>,
  username: string,
  password: string,
): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/auth/login",
    payload: { username, password },
  });
  if (res.statusCode !== 200) throw new Error(`login failed: ${res.statusCode} ${res.body}`);
  return (res.json() as { access_token: string }).access_token;
}

test("POST /auth/users — admin can create a user WITH every extras section + pass-through to result", async () => {
  const app = buildServer();
  const adminToken = await login(app, "alice.admin", "Admin!Pass1");
  const username = `t8user${Date.now()}a`;
  const res = await app.inject({
    method: "POST",
    url: "/auth/users",
    headers: { authorization: `Bearer ${adminToken}` },
    payload: {
      username,
      email: `${username}@apex-ews.test`,
      password: "T8!Pass1",
      display_name: "Extra Profile",
      role: "field_officer",
      extras: {
        profile: {
          date_of_birth: "1990-05-15",
          gender: "female",
          joining_date: "2024-01-20",
          employment_type: "Permanent",
          reporting_manager: "alice.admin",
          secondary_skills: "AML,KYC,Risk-Modelling",
        },
        contact: {
          alternate_email: "personal@example.com",
          secondary_mobile: "+91-9876543210",
          emergency_contact_name: "John Doe",
          emergency_contact_phone: "+91-9123456789",
        },
        address: {
          line1: "123 Risk Lane",
          line2: "Apt 4B",
          city: "Mumbai",
          state: "Maharashtra",
          country: "IN",
          postal_code: "400001",
        },
      },
    },
  });
  assert.equal(res.statusCode, 201);
  const body = res.json() as {
    user: {
      username: string;
      extras?: {
        profile?: { date_of_birth?: string; gender?: string; employment_type?: string };
        contact?: { alternate_email?: string; emergency_contact_phone?: string };
        address?: { city?: string; postal_code?: string };
      };
    };
  };
  assert.equal(body.user.username, username);
  assert.ok(body.user.extras, "extras missing from result");
  assert.equal(body.user.extras.profile?.date_of_birth, "1990-05-15");
  assert.equal(body.user.extras.profile?.gender, "female");
  assert.equal(body.user.extras.profile?.employment_type, "Permanent");
  assert.equal(body.user.extras.contact?.alternate_email, "personal@example.com");
  assert.equal(body.user.extras.contact?.emergency_contact_phone, "+91-9123456789");
  assert.equal(body.user.extras.address?.city, "Mumbai");
  assert.equal(body.user.extras.address?.postal_code, "400001");

  await app.close();
});

test("POST /auth/users — extras is fully optional (backwards-compat with M6.1 create)", async () => {
  const app = buildServer();
  const adminToken = await login(app, "alice.admin", "Admin!Pass1");
  const username = `t8user${Date.now()}b`;
  const res = await app.inject({
    method: "POST",
    url: "/auth/users",
    headers: { authorization: `Bearer ${adminToken}` },
    payload: {
      username,
      email: `${username}@apex-ews.test`,
      password: "T8!Pass1",
      display_name: "Bare Bones",
      role: "field_officer",
      // no extras field at all
    },
  });
  assert.equal(res.statusCode, 201);
  const body = res.json() as { user: { extras?: unknown } };
  // extras should be absent (not present + not empty {}) — keeps the
  // response shape unchanged for pre-T8 callers
  assert.equal(body.user.extras, undefined);

  await app.close();
});

test("POST /auth/users — empty extras sections collapse out (trimmed empty strings drop)", async () => {
  const app = buildServer();
  const adminToken = await login(app, "alice.admin", "Admin!Pass1");
  const username = `t8user${Date.now()}c`;
  const res = await app.inject({
    method: "POST",
    url: "/auth/users",
    headers: { authorization: `Bearer ${adminToken}` },
    payload: {
      username,
      email: `${username}@apex-ews.test`,
      password: "T8!Pass1",
      display_name: "Whitespace Test",
      role: "field_officer",
      extras: {
        profile: { date_of_birth: "  ", gender: "" },
        contact: { alternate_email: "" },
        address: { city: "", line1: "" },
      },
    },
  });
  assert.equal(res.statusCode, 201);
  const body = res.json() as { user: { extras?: unknown } };
  // every field whitespace/empty → entire extras collapses to undefined
  assert.equal(body.user.extras, undefined);

  await app.close();
});

test("POST /auth/users — partial extras: only fills what's provided", async () => {
  const app = buildServer();
  const adminToken = await login(app, "alice.admin", "Admin!Pass1");
  const username = `t8user${Date.now()}d`;
  const res = await app.inject({
    method: "POST",
    url: "/auth/users",
    headers: { authorization: `Bearer ${adminToken}` },
    payload: {
      username,
      email: `${username}@apex-ews.test`,
      password: "T8!Pass1",
      display_name: "Partial",
      role: "field_officer",
      extras: {
        profile: { date_of_birth: "1985-12-25" },
        // no contact, no address
      },
    },
  });
  assert.equal(res.statusCode, 201);
  const body = res.json() as {
    user: { extras?: { profile?: { date_of_birth?: string }; contact?: unknown; address?: unknown } };
  };
  assert.ok(body.user.extras);
  assert.equal(body.user.extras.profile?.date_of_birth, "1985-12-25");
  assert.equal(body.user.extras.contact, undefined);
  assert.equal(body.user.extras.address, undefined);

  await app.close();
});

test("POST /auth/users — malformed DOB rejected with role_invalid 400", async () => {
  const app = buildServer();
  const adminToken = await login(app, "alice.admin", "Admin!Pass1");
  const res = await app.inject({
    method: "POST",
    url: "/auth/users",
    headers: { authorization: `Bearer ${adminToken}` },
    payload: {
      username: `t8e${Date.now()}`,
      email: `t8e${Date.now()}@apex-ews.test`,
      password: "T8!Pass1",
      display_name: "Bad DOB",
      role: "field_officer",
      extras: {
        profile: { date_of_birth: "15/05/1990" }, // wrong format
      },
    },
  });
  assert.equal(res.statusCode, 400);
  const body = res.json() as { error?: string; message?: string };
  assert.equal(body.error, "role_invalid");
  assert.match(body.message ?? "", /YYYY-MM-DD/);

  await app.close();
});

test("POST /auth/users — invalid gender rejected", async () => {
  const app = buildServer();
  const adminToken = await login(app, "alice.admin", "Admin!Pass1");
  const res = await app.inject({
    method: "POST",
    url: "/auth/users",
    headers: { authorization: `Bearer ${adminToken}` },
    payload: {
      username: `t8e${Date.now()}f`,
      email: `t8e${Date.now()}f@apex-ews.test`,
      password: "T8!Pass1",
      display_name: "Bad Gender",
      role: "field_officer",
      extras: { profile: { gender: "yes" as never } },
    },
  });
  assert.equal(res.statusCode, 400);
  const body = res.json() as { error?: string };
  assert.equal(body.error, "role_invalid");

  await app.close();
});

test("POST /auth/users — malformed alternate_email rejected with email_invalid 400", async () => {
  const app = buildServer();
  const adminToken = await login(app, "alice.admin", "Admin!Pass1");
  const res = await app.inject({
    method: "POST",
    url: "/auth/users",
    headers: { authorization: `Bearer ${adminToken}` },
    payload: {
      username: `t8e${Date.now()}g`,
      email: `t8e${Date.now()}g@apex-ews.test`,
      password: "T8!Pass1",
      display_name: "Bad Email",
      role: "field_officer",
      extras: {
        contact: { alternate_email: "not-an-email" },
      },
    },
  });
  assert.equal(res.statusCode, 400);
  const body = res.json() as { error?: string };
  assert.equal(body.error, "email_invalid");

  await app.close();
});
