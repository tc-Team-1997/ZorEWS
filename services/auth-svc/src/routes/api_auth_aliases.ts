/**
 * `/api/auth/*` route aliases.
 *
 * These match the public API naming in the EWS product spec
 * (login / logout / refresh-token / forgot-password / reset-password /
 * send-mfa / verify-mfa) while the canonical handlers continue to live
 * under `/auth/*`. We thin-forward by calling `fastify.inject()` against
 * the canonical path so there's a single source of truth for the
 * actual auth logic (rate-limit, captcha, MFA partial-token flow,
 * audit-event fan-out, session denylist).
 *
 * `send-mfa` is the only new behavior — the M1.1 TOTP flow doesn't
 * need an OTP-send step (the user reads codes from their authenticator
 * app), so this returns a no-op 200 with a clear `channel: 'totp'`
 * marker. When a SMS or email backup channel is wired (Africa's
 * Talking / SES), the handler grows the actual dispatch.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { InjectOptions, Response as LightMyRequestResponse } from "light-my-request";

interface ForwardSpec {
  method: "GET" | "POST" | "DELETE";
  alias: string;
  target: string;
}

/**
 * Pure forward — the request body, query, and headers are replayed at
 * the canonical path, and the upstream response (status / headers /
 * body) is mirrored back verbatim. Keeps the alias surface a true
 * proxy with zero behavior divergence.
 */
async function forward(
  app: FastifyInstance,
  spec: ForwardSpec,
  req: FastifyRequest,
  reply: FastifyReply,
) {
  const opts: InjectOptions = {
    method: spec.method,
    url: spec.target,
    payload: spec.method === "GET" ? undefined : (req.body as object | string | undefined),
    query: req.query as Record<string, string>,
    headers: req.headers as Record<string, string>,
  };
  const res = (await app.inject(opts)) as LightMyRequestResponse;
  for (const [k, v] of Object.entries(res.headers)) {
    // Avoid copying upstream content-length — fastify recomputes it
    // when we send the buffered payload back through.
    if (k.toLowerCase() === "content-length") continue;
    reply.header(k, v as string | string[]);
  }
  reply.code(res.statusCode);
  // res.body is always a string when payload type is unknown JSON.
  // Re-parse to forward an object so fastify keeps content-type JSON
  // when applicable; fall back to raw string otherwise (e.g. 204 NoContent).
  if (!res.body) return reply.send();
  try {
    return reply.send(JSON.parse(res.body));
  } catch {
    return reply.send(res.body);
  }
}

export function registerApiAuthAliasRoutes(app: FastifyInstance): void {
  const SPECS: ForwardSpec[] = [
    { method: "POST", alias: "/api/auth/login", target: "/auth/login" },
    { method: "POST", alias: "/api/auth/refresh-token", target: "/auth/refresh" },
    { method: "POST", alias: "/api/auth/forgot-password", target: "/auth/password/reset-request" },
    { method: "POST", alias: "/api/auth/reset-password", target: "/auth/password/reset-confirm" },
    { method: "POST", alias: "/api/auth/verify-mfa", target: "/auth/login/verify-2fa" },
  ];
  for (const spec of SPECS) {
    if (spec.method === "POST") {
      app.post(spec.alias, async (req, reply) => forward(app, spec, req, reply));
    } else if (spec.method === "GET") {
      app.get(spec.alias, async (req, reply) => forward(app, spec, req, reply));
    } else if (spec.method === "DELETE") {
      app.delete(spec.alias, async (req, reply) => forward(app, spec, req, reply));
    }
  }

  /**
   * POST /api/auth/logout
   *
   * Revokes the caller's current session if a valid Bearer JWT is
   * supplied, then 200s with `revoked: <bool>`. SPA also drops its
   * local JWT in the same flow — this server-side step closes the
   * session denylist entry so a stolen refresh token can't be used.
   *
   * Anonymous calls (no Bearer) still 200 — logout is idempotent;
   * the client's local-only state is the real source of truth.
   */
  app.post("/api/auth/logout", async (req, reply) => {
    // The current session is encoded in the `sid` claim — we forward
    // a DELETE against /auth/sessions/:sid which already handles
    // ownership + revocation + audit logging.
    const auth = req.headers.authorization;
    if (!auth || !auth.toLowerCase().startsWith("bearer ")) {
      return reply.code(200).send({ ok: true, revoked: false, reason: "no_bearer_token" });
    }
    // Insecurely decode the JWT payload just to read sid — auth-svc
    // doesn't need to verify here because the downstream DELETE
    // handler does. If the JWT is malformed, fall through to the
    // anonymous response.
    try {
      const payload = JSON.parse(
        Buffer.from(auth.slice(7).split(".")[1], "base64url").toString("utf8"),
      ) as { sid?: string };
      if (!payload.sid) return reply.code(200).send({ ok: true, revoked: false, reason: "no_sid" });
      const opts: InjectOptions = {
        method: "DELETE",
        url: `/auth/sessions/${encodeURIComponent(payload.sid)}`,
        headers: req.headers as Record<string, string>,
      };
      const res = (await app.inject(opts)) as LightMyRequestResponse;
      // Forward upstream status if it failed (401/403); otherwise success.
      if (res.statusCode >= 400) {
        return reply.code(200).send({
          ok: true,
          revoked: false,
          upstream_status: res.statusCode,
          reason: "session_already_revoked",
        });
      }
      return reply.code(200).send({ ok: true, revoked: true });
    } catch {
      return reply.code(200).send({ ok: true, revoked: false, reason: "malformed_token" });
    }
  });

  /**
   * POST /api/auth/send-mfa
   *
   * Triggers an out-of-band MFA challenge. ZorEWS uses TOTP today
   * (per M1.1) — the user reads codes from their authenticator app,
   * so no server-side OTP dispatch is required. We return
   * `channel: "totp"` so the SPA knows to prompt for the
   * authenticator-app code rather than waiting for SMS.
   *
   * When a backup SMS/email channel is wired up (Africa's Talking /
   * SES — see docs/vendor-accounts.md), this handler grows the
   * actual provider call + per-user channel preference lookup.
   */
  app.post<{ Body: { username?: string; channel?: "totp" | "sms" | "email" } }>(
    "/api/auth/send-mfa",
    async (req, reply) => {
      const body = req.body ?? {};
      if (!body.username || typeof body.username !== "string") {
        return reply.code(400).send({
          error: "invalid_input",
          message: "username is required",
        });
      }
      // Honour the requested channel if it's supported. Today only
      // 'totp' is wired — any other request returns 200 + a clear
      // marker so the SPA can degrade gracefully.
      const requested = body.channel ?? "totp";
      if (requested !== "totp") {
        return reply.code(200).send({
          ok: true,
          channel: "totp",
          message: `Requested channel '${requested}' is not yet enabled — falling back to TOTP. Open your authenticator app for the code.`,
        });
      }
      return reply.code(200).send({
        ok: true,
        channel: "totp",
        message: "Open your authenticator app and enter the 6-digit code.",
      });
    },
  );
}
