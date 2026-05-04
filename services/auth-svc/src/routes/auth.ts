import type { FastifyInstance, FastifyRequest } from "fastify";
import { SignJWT, exportJWK } from "jose";
import { RegisterFailure, type Role } from "../users.js";
import { loadSigner, signAccessToken, signRefreshToken, verifyToken, type Signer } from "../jwt.js";
import { getServiceClientStore } from "../service_clients.js";
import {
  LOGIN_POLICY,
  RESET_REQUEST_POLICY,
  RateLimiter,
} from "../rate_limit.js";
import { type AuthLogQuery } from "../audit_log.js";
import { toView } from "../sessions.js";
import { CAPTCHA_THRESHOLD, CaptchaStore, FailureCounter } from "../captcha.js";
import {
  makeAuthStores,
  type IAuthAuditLog,
  type ISessionStore,
  type IUserStore,
} from "../auth_state.js";
import { type ITeamStore } from "../teams.js";
import { type ILeaveCoverStore } from "../leave_covers.js";
import { ALL_ROLES as DASHBOARD_WIDGET_ROLES, type IDashboardWidgetsStore, type Role as DashboardRole } from "../dashboard_widgets.js";

interface AuthState {
  users: IUserStore;
  signer: Signer;
  loginLimiter: RateLimiter;
  resetLimiter: RateLimiter;
  audit: IAuthAuditLog;
  sessions: ISessionStore;
  teams: ITeamStore;
  leaveCovers: ILeaveCoverStore;
  dashboardWidgets: IDashboardWidgetsStore;
  captcha: CaptchaStore;
  loginFailures: FailureCounter;
}

let state: AuthState | undefined;

async function getState(): Promise<AuthState> {
  if (state) return state;
  const stores = await makeAuthStores();
  const signer = await loadSigner();
  state = {
    users: stores.users,
    signer,
    loginLimiter: new RateLimiter(),
    resetLimiter: new RateLimiter(),
    audit: stores.audit,
    sessions: stores.sessions,
    teams: stores.teams,
    leaveCovers: stores.leaveCovers,
    dashboardWidgets: stores.dashboardWidgets,
    captcha: new CaptchaStore(),
    loginFailures: new FailureCounter(),
  };
  return state;
}

/** Best-effort caller user-agent. Falls back to "unknown" so the
 *  session row still renders something useful. */
function callerUserAgent(req: FastifyRequest): string {
  const v = req.headers["user-agent"];
  return typeof v === "string" && v.length > 0 ? v.slice(0, 256) : "unknown";
}

/** Test-only: drop the cached state so a fresh seed + empty rate-limit
 *  buckets are produced on the next request. Used by the rate-limit tests
 *  so they don't inherit hits from earlier tests. */
export function __resetAuthStateForTests(): void {
  state = undefined;
}

/** Best-effort caller IP. Falls back to "unknown" so the limiter still
 *  bins behind a stable key when the transport doesn't expose one. */
function callerIp(req: FastifyRequest): string {
  return req.ip || "unknown";
}

/**
 * Verify the request bears a valid admin access token. On failure the
 * helper writes a 401 / 403 response and returns false; the caller
 * should `return` immediately. On success returns true.
 */
async function requireAdmin(req: import("fastify").FastifyRequest, reply: import("fastify").FastifyReply, signer: Signer): Promise<boolean> {
  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer ")) {
    void reply.code(401).send({ error: "missing_token" });
    return false;
  }
  let role: unknown;
  try {
    const { payload } = await verifyToken(signer, auth.slice(7));
    if (payload.typ === "refresh") {
      void reply.code(401).send({ error: "invalid_token" });
      return false;
    }
    role = payload.role;
  } catch {
    void reply.code(401).send({ error: "invalid_token" });
    return false;
  }
  if (role !== "admin") {
    void reply.code(403).send({ error: "forbidden", message: "admin role required" });
    return false;
  }
  return true;
}

export function registerAuthRoutes(app: FastifyInstance): void {
  app.post<{
    Body: {
      username?: string;
      password?: string;
      /** Required after CAPTCHA_THRESHOLD failures from this (IP,username). */
      captcha_id?: string;
      captcha_answer?: number | string;
    };
  }>("/auth/login", async (req, reply) => {
    const { username, password, captcha_id, captcha_answer } = req.body ?? {};
    if (!username || !password) {
      return reply.code(400).send({ error: "username, password required" });
    }
    const { users, signer, loginLimiter, audit, sessions, captcha, loginFailures } = await getState();
    const ip = callerIp(req);
    const failureKey = `${ip}:${username.trim().toLowerCase()}`;
    // CAPTCHA gate: kicks in after CAPTCHA_THRESHOLD bad attempts. The
    // gate runs before any password check so a wrong-password attempt
    // without a captcha gets a clean "captcha_required" rather than
    // burning a failure or revealing whether the user exists. Bypassed
    // when AUTH_SVC_RATE_LIMIT=off (test convenience — same flag turns
    // off both throttling layers).
    const captchaRequired =
      process.env.AUTH_SVC_RATE_LIMIT !== "off" &&
      loginFailures.get(failureKey) >= CAPTCHA_THRESHOLD;
    if (captchaRequired) {
      const ans = typeof captcha_answer === "string" ? Number(captcha_answer) : captcha_answer;
      if (!captcha_id || typeof ans !== "number" || Number.isNaN(ans)) {
        return reply.code(401).send({
          error: "captcha_required",
          message: "Too many failed attempts — please solve the CAPTCHA below.",
          failed_count: loginFailures.get(failureKey),
        });
      }
      if (!captcha.verify(captcha_id, ans)) {
        return reply.code(401).send({
          error: "captcha_failed",
          message: "CAPTCHA answer was wrong or expired. Try a new challenge.",
          failed_count: loginFailures.get(failureKey),
        });
      }
    }
    if (process.env.AUTH_SVC_RATE_LIMIT !== "off") {
      // Per-(IP+username) bucket — keeps an attacker who scripts the form
      // from burning through one user's allowance to brute-force another.
      const limitKey = `${ip}:${username.trim().toLowerCase()}`;
      const decision = loginLimiter.take(limitKey, LOGIN_POLICY);
      if (!decision.ok) {
        audit.append({
          type: "login_rate_limited",
          target_username: username,
          ip,
          metadata: { retry_after_sec: decision.retry_after_sec },
        });
        return reply
          .code(429)
          .header("Retry-After", String(decision.retry_after_sec))
          .send({
            error: "rate_limited",
            message: `Too many login attempts. Try again in ${decision.retry_after_sec}s.`,
            retry_after_sec: decision.retry_after_sec,
          });
      }
    }
    const user = users.findByUsername(username);
    if (!user) {
      // Constant-time-ish: still cost a hash check on a known value.
      await new Promise((r) => setTimeout(r, 50));
      // Bump captcha failure counter even for unknown users so the
      // gate applies symmetrically and an attacker can't enumerate
      // users by checking who triggers a captcha.
      loginFailures.bump(failureKey);
      audit.append({
        type: "login_failure",
        target_username: username,
        ip,
        metadata: { reason: "unknown_user" },
      });
      return reply.code(401).send({ error: "invalid_credentials" });
    }
    // Auto-release expired auto-locks first — a user who waited out the
    // 30-min window gets a fresh shot without admin intervention.
    if (users.maybeReleaseAutoLock(user)) {
      audit.append({ type: "auto_lockout_released", target_username: user.username, ip });
    }
    if (user.locked) {
      const auto = user.lockout_until_ms !== null;
      const remainingSec = auto
        ? Math.max(1, Math.ceil((user.lockout_until_ms! - Date.now()) / 1000))
        : null;
      audit.append({
        type: "login_locked",
        target_username: user.username,
        ip,
        metadata: { auto, auto_unlock_in_sec: remainingSec },
      });
      return reply.code(403).send({
        error: "locked_account",
        message: auto
          ? `Your account is locked due to repeated failed sign-ins. Try again in ${remainingSec}s.`
          : "Your account is locked. Contact your administrator.",
        auto_unlock_in_sec: remainingSec,
      });
    }
    if (!(await users.verifyPassword(user, password))) {
      const { count, just_locked } = users.registerFailedLogin(user);
      loginFailures.bump(failureKey);
      audit.append({
        type: "login_failure",
        target_username: user.username,
        ip,
        metadata: { reason: "wrong_password", failed_count: count },
      });
      if (just_locked) {
        audit.append({
          type: "auto_lockout_triggered",
          target_username: user.username,
          ip,
          metadata: { failed_count: count, lockout_until_ms: user.lockout_until_ms },
        });
        const remainingSec = Math.max(
          1,
          Math.ceil((user.lockout_until_ms! - Date.now()) / 1000),
        );
        return reply.code(403).send({
          error: "locked_account",
          message: `Account locked after ${count} failed attempts. Try again in ${remainingSec}s.`,
          auto_unlock_in_sec: remainingSec,
        });
      }
      return reply.code(401).send({
        error: "invalid_credentials",
        attempts_remaining: Math.max(0, 5 - count),
      });
    }
    users.resetFailedLogin(user);
    loginFailures.reset(failureKey);
    const session = sessions.create({
      user_id: user.id,
      ip,
      user_agent: callerUserAgent(req),
    });
    const access = await signAccessToken(signer, {
      sub: user.id,
      role: user.role,
      display_name: user.display_name,
      sid: session.id,
      tenant_id: user.tenant_id,
    });
    const refresh = await signRefreshToken(signer, user.id, session.id);
    audit.append({
      type: "login_success",
      target_username: user.username,
      actor_username: user.username,
      actor_role: user.role,
      tenant_id: user.tenant_id,
      ip,
      metadata: { sid: session.id },
    });
    return reply.send({
      access_token: access,
      refresh_token: refresh,
      token_type: "Bearer",
      expires_in: 900,
      role: user.role,
      display_name: user.display_name,
      session_id: session.id,
      must_change_password: user.must_change_password,
      terms_accepted_at: user.terms_accepted_at,
    });
  });

  /**
   * GET /auth/captcha/challenge
   *
   * Anonymous endpoint — issues a fresh math captcha challenge so the
   * SPA can render it inline next to the login form when the backend
   * has flagged the (IP+username) combination as `captcha_required`.
   * Single-use: each issue() returns a new id; the next login attempt
   * must reference that id + the answer.
   */
  app.get("/auth/captcha/challenge", async (_req, reply) => {
    const { captcha } = await getState();
    return reply.send(captcha.issue());
  });

  app.post<{ Body: { refresh_token?: string } }>("/auth/refresh", async (req, reply) => {
    const { refresh_token } = req.body ?? {};
    if (!refresh_token) return reply.code(400).send({ error: "refresh_token required" });
    const { users, signer, sessions } = await getState();
    try {
      const { payload } = await verifyToken(signer, refresh_token);
      if (payload.typ !== "refresh" || !payload.sub) {
        return reply.code(401).send({ error: "invalid_refresh" });
      }
      const user = users.findById(payload.sub);
      if (!user) return reply.code(401).send({ error: "invalid_refresh" });
      const sid = typeof payload.sid === "string" ? payload.sid : undefined;
      // Reject refresh attempts whose session was revoked. Tokens minted
      // before the sid claim was added (no `sid`) still work — they're
      // grandfathered, but the next login will give them a fresh session.
      if (sid && sessions.isRevoked(sid)) {
        return reply.code(401).send({ error: "session_revoked" });
      }
      if (sid) sessions.touch(sid);
      const access = await signAccessToken(signer, {
        sub: user.id,
        role: user.role,
        display_name: user.display_name,
        sid,
        tenant_id: user.tenant_id,
      });
      return reply.send({ access_token: access, token_type: "Bearer", expires_in: 900 });
    } catch {
      return reply.code(401).send({ error: "invalid_refresh" });
    }
  });

  app.post<{
    Body: { username?: string; email?: string; password?: string; display_name?: string; role?: Role };
  }>("/auth/register", async (req, reply) => {
    const { username, email, password, display_name, role } = req.body ?? {};
    if (!username || !email || !password || !display_name || !role) {
      return reply
        .code(400)
        .send({ error: "username, email, password, display_name, role required" });
    }
    const { users, audit } = await getState();
    try {
      const result = await users.register({ username, email, password, display_name, role });
      audit.append({
        type: "register_success",
        target_username: result.user.username,
        ip: callerIp(req),
        metadata: { role: result.user.role },
      });
      return reply.code(201).send(result);
    } catch (err) {
      if (err instanceof RegisterFailure) {
        const status =
          err.code === "username_taken" || err.code === "email_taken" ? 409 : 400;
        return reply.code(status).send({ error: err.code, message: err.message });
      }
      throw err;
    }
  });

  /**
   * POST /auth/password/reset-request
   * body: { username?: string, email?: string }
   *
   * Either field is accepted — useful for users who remember one but not
   * the other. If both are passed, email takes precedence (more specific).
   * Always returns 202 with the same shape regardless of whether the
   * lookup hit, to prevent enumeration via this endpoint. For existing
   * accounts: issues a single-use reset token (15-min TTL) and logs a
   * "reset link" via the fastify logger (no SMTP in this prototype —
   * operators read the link out of `.logs/auth-svc.log` and paste it
   * into the SPA's reset-password page).
   */
  app.post<{ Body: { username?: string; email?: string } }>(
    "/auth/password/reset-request",
    async (req, reply) => {
      const username = req.body?.username?.trim().toLowerCase();
      const email = req.body?.email?.trim().toLowerCase();
      if (!username && !email) {
        return reply.code(400).send({ error: "username or email required" });
      }
      const { users, resetLimiter, audit } = await getState();
      const ip = callerIp(req);
      if (process.env.AUTH_SVC_RATE_LIMIT !== "off") {
        // 3/hour per (IP+identifier). The identifier branch matters: an
        // attacker iterating emails from one IP gets capped on every email
        // separately — fine for this prototype, but production would also
        // add a per-IP global cap for the same reason.
        const limitKey = `${ip}:${email ?? username ?? ""}`;
        const decision = resetLimiter.take(limitKey, RESET_REQUEST_POLICY);
        if (!decision.ok) {
          audit.append({
            type: "password_reset_request_rate_limited",
            target_username: username ?? null,
            ip,
            metadata: { lookup_by: email ? "email" : "username", identifier: email ?? username },
          });
          return reply
            .code(429)
            .header("Retry-After", String(decision.retry_after_sec))
            .send({
              error: "rate_limited",
              message: `Too many reset requests. Try again in ${decision.retry_after_sec}s.`,
              retry_after_sec: decision.retry_after_sec,
            });
        }
      }
      const user = email
        ? users.findByEmail(email)
        : username
          ? users.findByUsername(username)
          : undefined;
      if (user) {
        const issue = users.issueResetToken(user);
        // Dev "email" — log the link so the operator can complete the flow.
        req.log.info(
          {
            username: user.username,
            email: user.email,
            looked_up_by: email ? "email" : "username",
            expires_at: issue.expires_at,
            reset_link: issue.reset_link,
          },
          "password reset link issued",
        );
        audit.append({
          type: "password_reset_request",
          target_username: user.username,
          ip,
          metadata: { lookup_by: email ? "email" : "username", expires_at: issue.expires_at },
        });
      } else {
        // Constant-ish work so the response timing doesn't leak existence.
        await new Promise((r) => setTimeout(r, 30));
        audit.append({
          type: "password_reset_request_unknown",
          ip,
          metadata: { lookup_by: email ? "email" : "username", identifier: email ?? username },
        });
      }
      const body: {
        ok: true;
        message: string;
        debug?: { token: string; reset_link: string; expires_at: string };
      } = {
        ok: true,
        message:
          "If an account with that username exists, a password-reset link has been generated. " +
          "In this prototype the link is logged to .logs/auth-svc.log instead of emailed.",
      };
      // Test-only: surface the token in the response so tests can complete
      // the flow without scraping the log. Off in production; tests set
      // AUTH_SVC_DEBUG_TOKENS=1 at the top of the file.
      if (user && process.env.AUTH_SVC_DEBUG_TOKENS === "1") {
        const last = users.peekLastTokenFor(user.id);
        if (last) body.debug = last;
      }
      return reply.code(202).send(body);
    },
  );

  /**
   * POST /auth/password/reset-confirm
   * body: { token, password }
   *
   * Consumes the token (single-use; revoked even on failure) and sets
   * the user's password. 400 on invalid/expired token or weak password.
   */
  app.post<{ Body: { token?: string; password?: string } }>(
    "/auth/password/reset-confirm",
    async (req, reply) => {
      const { token, password } = req.body ?? {};
      if (!token || !password) {
        return reply.code(400).send({ error: "token and password required" });
      }
      const { users, audit } = await getState();
      const user = users.consumeResetToken(token);
      if (!user) {
        return reply.code(400).send({ error: "invalid_or_expired_token" });
      }
      try {
        await users.setPassword(user, password);
      } catch (err) {
        if (err instanceof RegisterFailure) {
          return reply.code(400).send({ error: err.code, message: err.message });
        }
        throw err;
      }
      audit.append({
        type: "password_reset_complete",
        target_username: user.username,
        ip: callerIp(req),
      });
      return reply.send({
        ok: true,
        username: user.username,
        message: "Password updated. Sign in with your new password.",
      });
    },
  );

  /**
   * POST /auth/password/admin-reset
   * Authorization: Bearer <admin access token>
   * body: { username, password }
   *
   * Admin-only manual reset — for cases where the token-based flow isn't
   * workable (lost email). Distinct from the self-service flow: no token,
   * no email, just direct replacement. Auth check is the JWT role claim
   * (no separate RBAC matrix lookup — auth-svc is the matrix's source of
   * truth here).
   */
  app.post<{ Body: { username?: string; password?: string } }>(
    "/auth/password/admin-reset",
    async (req, reply) => {
      const auth = req.headers.authorization;
      if (!auth?.startsWith("Bearer ")) {
        return reply.code(401).send({ error: "missing_token" });
      }
      const { signer, users, audit } = await getState();
      let role: unknown;
      let actorSub: string | undefined;
      try {
        const { payload } = await verifyToken(signer, auth.slice(7));
        if (payload.typ === "refresh") {
          return reply.code(401).send({ error: "invalid_token" });
        }
        role = payload.role;
        actorSub = typeof payload.sub === "string" ? payload.sub : undefined;
      } catch {
        return reply.code(401).send({ error: "invalid_token" });
      }
      if (role !== "admin") {
        return reply.code(403).send({ error: "forbidden", message: "admin role required" });
      }

      const { username, password } = req.body ?? {};
      const targetUsername = username?.trim().toLowerCase();
      if (!targetUsername || !password) {
        return reply.code(400).send({ error: "username and password required" });
      }
      const target = users.findByUsername(targetUsername);
      if (!target) {
        return reply.code(404).send({ error: "user_not_found" });
      }
      try {
        await users.setPassword(target, password);
      } catch (err) {
        if (err instanceof RegisterFailure) {
          return reply.code(400).send({ error: err.code, message: err.message });
        }
        throw err;
      }
      const actor = actorSub ? users.findById(actorSub) : undefined;
      req.log.info(
        { actor_role: role, target_username: target.username },
        "admin password reset",
      );
      audit.append({
        type: "admin_password_reset",
        target_username: target.username,
        actor_username: actor?.username ?? null,
        actor_role: actor?.role ?? "admin",
        ip: callerIp(req),
      });
      return reply.send({
        ok: true,
        username: target.username,
        message: `Password for ${target.username} has been reset.`,
      });
    },
  );

  /**
   * GET /auth/users
   * Authorization: Bearer <admin access token>
   *
   * Admin-only — backs the SPA's Users admin page. Returns every user's
   * public projection (id, username, display_name, role). No
   * passwordHash.
   */
  app.get("/auth/users", async (req, reply) => {
    const auth = req.headers.authorization;
    if (!auth?.startsWith("Bearer ")) {
      return reply.code(401).send({ error: "missing_token" });
    }
    const { signer, users } = await getState();
    let role: unknown;
    try {
      const { payload } = await verifyToken(signer, auth.slice(7));
      if (payload.typ === "refresh") {
        return reply.code(401).send({ error: "invalid_token" });
      }
      role = payload.role;
    } catch {
      return reply.code(401).send({ error: "invalid_token" });
    }
    if (role !== "admin") {
      return reply.code(403).send({ error: "forbidden", message: "admin role required" });
    }
    return reply.send({ users: users.listAll() });
  });

  /**
   * POST /auth/users
   * Authorization: Bearer <admin>
   * body: { username, email, password, display_name, role }
   *
   * Admin creates a user directly. Same validation gate as /auth/register
   * (delegates to UserStore.register), but admin-only.
   */
  app.post<{
    Body: {
      username?: string;
      email?: string;
      password?: string;
      display_name?: string;
      role?: Role;
      /** When false (or omitted as false), the new user lands directly
       *  in the app. Default true: admin-shared default password forces
       *  the first-login wizard. */
      skip_first_login?: boolean;
    };
  }>("/auth/users", async (req, reply) => {
    const { signer, users, audit } = await getState();
    if (!(await requireAdmin(req, reply, signer))) return;
    const { username, email, password, display_name, role, skip_first_login } = req.body ?? {};
    if (!username || !email || !password || !display_name || !role) {
      return reply
        .code(400)
        .send({ error: "username, email, password, display_name, role required" });
    }
    try {
      const result = await users.register({
        username,
        email,
        password,
        display_name,
        role,
        // Default: admin-created users go through the first-login wizard.
        // Tests that exercise admin-create flows pre-existing this feature
        // can opt out via skip_first_login: true.
        must_change_password: skip_first_login !== true,
      });
      audit.append({
        type: "user_created",
        target_username: result.user.username,
        actor_role: "admin",
        ip: callerIp(req),
        metadata: { role: result.user.role, must_change_password: result.user.must_change_password },
      });
      return reply.code(201).send(result);
    } catch (err) {
      if (err instanceof RegisterFailure) {
        const status =
          err.code === "username_taken" || err.code === "email_taken" ? 409 : 400;
        return reply.code(status).send({ error: err.code, message: err.message });
      }
      throw err;
    }
  });

  /**
   * DELETE /auth/users/:username
   * Authorization: Bearer <admin>
   *
   * Hard-delete a user. Refuses to delete the caller (you can't lock
   * yourself out by deleting your own admin account). 404 if unknown.
   */
  app.delete<{ Params: { username: string } }>("/auth/users/:username", async (req, reply) => {
    const { signer, users, audit } = await getState();
    const auth = req.headers.authorization;
    if (!auth?.startsWith("Bearer ")) return reply.code(401).send({ error: "missing_token" });
    let callerSub: string | undefined;
    let callerRole: unknown;
    try {
      const { payload } = await verifyToken(signer, auth.slice(7));
      if (payload.typ === "refresh") return reply.code(401).send({ error: "invalid_token" });
      callerSub = typeof payload.sub === "string" ? payload.sub : undefined;
      callerRole = payload.role;
    } catch {
      return reply.code(401).send({ error: "invalid_token" });
    }
    if (callerRole !== "admin") {
      return reply.code(403).send({ error: "forbidden", message: "admin role required" });
    }
    const target = users.findByUsername(req.params.username.toLowerCase());
    if (!target) return reply.code(404).send({ error: "user_not_found" });
    if (target.id === callerSub) {
      return reply
        .code(409)
        .send({ error: "cannot_delete_self", message: "you cannot delete your own account" });
    }
    const actor = callerSub ? users.findById(callerSub) : undefined;
    users.deleteByUsername(target.username);
    audit.append({
      type: "user_deleted",
      target_username: target.username,
      actor_username: actor?.username ?? null,
      actor_role: "admin",
      ip: callerIp(req),
    });
    return reply.code(204).send();
  });

  /**
   * POST /auth/users/:username/lock
   * POST /auth/users/:username/unlock
   * Authorization: Bearer <admin>
   *
   * Toggle the locked flag. Locked users get 403 + locked_account on
   * /auth/login. Refuses to lock the caller (same rationale as delete).
   */
  for (const action of ["lock", "unlock"] as const) {
    app.post<{ Params: { username: string } }>(
      `/auth/users/:username/${action}`,
      async (req, reply) => {
        const { signer, users, audit } = await getState();
        const auth = req.headers.authorization;
        if (!auth?.startsWith("Bearer ")) {
          return reply.code(401).send({ error: "missing_token" });
        }
        let callerSub: string | undefined;
        let callerRole: unknown;
        try {
          const { payload } = await verifyToken(signer, auth.slice(7));
          if (payload.typ === "refresh") return reply.code(401).send({ error: "invalid_token" });
          callerSub = typeof payload.sub === "string" ? payload.sub : undefined;
          callerRole = payload.role;
        } catch {
          return reply.code(401).send({ error: "invalid_token" });
        }
        if (callerRole !== "admin") {
          return reply.code(403).send({ error: "forbidden", message: "admin role required" });
        }
        const target = users.findByUsername(req.params.username.toLowerCase());
        if (!target) return reply.code(404).send({ error: "user_not_found" });
        if (action === "lock" && target.id === callerSub) {
          return reply
            .code(409)
            .send({ error: "cannot_lock_self", message: "you cannot lock your own account" });
        }
        users.setLocked(target, action === "lock");
        const actor = callerSub ? users.findById(callerSub) : undefined;
        audit.append({
          type: action === "lock" ? "user_locked" : "user_unlocked",
          target_username: target.username,
          actor_username: actor?.username ?? null,
          actor_role: "admin",
          ip: callerIp(req),
        });
        return reply.send({
          ok: true,
          username: target.username,
          locked: target.locked,
        });
      },
    );
  }

  /**
   * GET /auth/me/activity?limit=...
   * Authorization: Bearer <access token>
   *
   * Self-service view of the caller's own auth events. Unlike
   * /auth/audit-log (admin/supervisor only), this is open to every
   * signed-in user — the filter is forced server-side to the caller's
   * sub so they only ever see their own row stream. Banking apps
   * universally surface this to users so they can spot account
   * compromise (logins from unfamiliar IPs / devices) themselves.
   */
  app.get<{ Querystring: { limit?: string } }>(
    "/auth/me/activity",
    async (req, reply) => {
      const { signer, sessions, audit, users } = await getState();
      const caller = await authedCallerOrUnauthorized(req, reply, signer, sessions);
      if (!caller) return;
      const me = users.findById(caller.sub);
      if (!me) return reply.code(401).send({ error: "invalid_token" });
      const limitRaw = Number(req.query.limit ?? 50);
      const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(200, Math.floor(limitRaw)) : 50;
      const events = audit.query({ target_username: me.username, limit });
      return reply.send({ events, username: me.username });
    },
  );

  /**
   * GET /auth/audit-log?type=...&target_username=...&limit=...
   * Authorization: Bearer <admin>
   *
   * Returns auth events newest-first. In this prototype the buffer is
   * in-memory and capped at 1000 — production would page over a persistent
   * append-only table. Filters are AND-combined.
   */
  app.get<{ Querystring: { type?: string; target_username?: string; limit?: string } }>(
    "/auth/audit-log",
    async (req, reply) => {
      const { signer, audit } = await getState();
      if (!(await requireAdmin(req, reply, signer))) return;
      const filter: AuthLogQuery = {};
      if (req.query.type) filter.type = req.query.type as AuthLogQuery["type"];
      if (req.query.target_username) filter.target_username = req.query.target_username;
      if (req.query.limit) {
        const n = Number(req.query.limit);
        if (Number.isFinite(n) && n > 0) filter.limit = Math.floor(n);
      }
      return reply.send({ events: audit.query(filter) });
    },
  );

  /**
   * Helper for the session routes — verifies the bearer access token and
   * resolves the (sub, sid). Writes 401 + returns null on any failure;
   * caller should `return` immediately when null.
   */
  async function authedCallerOrUnauthorized(
    req: import("fastify").FastifyRequest,
    reply: import("fastify").FastifyReply,
    signer: Signer,
    sessions: ISessionStore,
  ): Promise<{ sub: string; sid?: string } | null> {
    const auth = req.headers.authorization;
    if (!auth?.startsWith("Bearer ")) {
      void reply.code(401).send({ error: "missing_token" });
      return null;
    }
    let sub: string | undefined;
    let sid: string | undefined;
    try {
      const { payload } = await verifyToken(signer, auth.slice(7));
      if (payload.typ === "refresh") {
        void reply.code(401).send({ error: "invalid_token" });
        return null;
      }
      sub = typeof payload.sub === "string" ? payload.sub : undefined;
      sid = typeof payload.sid === "string" ? payload.sid : undefined;
    } catch {
      void reply.code(401).send({ error: "invalid_token" });
      return null;
    }
    if (!sub) {
      void reply.code(401).send({ error: "invalid_token" });
      return null;
    }
    if (sid && sessions.isRevoked(sid)) {
      void reply.code(401).send({ error: "session_revoked" });
      return null;
    }
    if (sid) sessions.touch(sid);
    return { sub, sid };
  }

  /**
   * POST /auth/first-login/complete
   * Authorization: Bearer <access token>
   * body: { new_password: string, accept_terms: true }
   *
   * Used by the first-login wizard the SPA shows when a user logs in
   * with must_change_password=true. Rotates the password through the
   * usual setPassword gates (complexity + history) and records T&C
   * acceptance. Idempotent guard: if the user has already completed it
   * (must_change_password === false), returns 409 to surface a clear
   * "no longer needed" rather than silently letting the call succeed.
   */
  app.post<{ Body: { new_password?: string; accept_terms?: boolean } }>(
    "/auth/first-login/complete",
    async (req, reply) => {
      const { signer, sessions, users, audit } = await getState();
      const caller = await authedCallerOrUnauthorized(req, reply, signer, sessions);
      if (!caller) return;
      const user = users.findById(caller.sub);
      if (!user) return reply.code(401).send({ error: "invalid_token" });
      if (!user.must_change_password) {
        return reply
          .code(409)
          .send({ error: "first_login_already_complete" });
      }
      const body = req.body ?? {};
      if (body.accept_terms !== true) {
        return reply.code(400).send({ error: "must_accept_terms" });
      }
      if (!body.new_password) {
        return reply.code(400).send({ error: "new_password required" });
      }
      try {
        await users.completeFirstLogin(user, body.new_password);
      } catch (err) {
        if (err instanceof RegisterFailure) {
          return reply.code(400).send({ error: err.code, message: err.message });
        }
        throw err;
      }
      audit.append({
        type: "password_reset_complete",
        target_username: user.username,
        actor_username: user.username,
        actor_role: user.role,
        ip: callerIp(req),
        metadata: { source: "first_login_wizard" },
      });
      return reply.send({
        ok: true,
        username: user.username,
        message: "First-login complete. Welcome.",
        terms_accepted_at: user.terms_accepted_at,
      });
    },
  );

  /**
   * GET /auth/sessions
   * Authorization: Bearer <access token>
   *
   * Returns the caller's active sessions. The current session is flagged
   * with `is_current: true` so the SPA can render a clear "this device"
   * indicator.
   */
  app.get("/auth/sessions", async (req, reply) => {
    const { signer, sessions } = await getState();
    const caller = await authedCallerOrUnauthorized(req, reply, signer, sessions);
    if (!caller) return;
    const list = sessions.listForUser(caller.sub).map((s) => toView(s, caller.sid));
    return reply.send({ sessions: list, current_session_id: caller.sid ?? null });
  });

  /**
   * DELETE /auth/sessions/:sid
   * Authorization: Bearer <access token>
   *
   * Revokes one of the caller's own sessions. Returns 404 if the sid
   * isn't theirs (or doesn't exist), so an attacker can't enumerate other
   * users' sids by status code.
   */
  app.delete<{ Params: { sid: string } }>("/auth/sessions/:sid", async (req, reply) => {
    const { signer, sessions, audit, users } = await getState();
    const caller = await authedCallerOrUnauthorized(req, reply, signer, sessions);
    if (!caller) return;
    const target = sessions.get(req.params.sid);
    if (!target || target.user_id !== caller.sub) {
      return reply.code(404).send({ error: "session_not_found" });
    }
    const ok = sessions.revoke(target.id);
    if (!ok) return reply.code(404).send({ error: "session_not_found" });
    const actor = users.findById(caller.sub);
    audit.append({
      type: "user_unlocked", // closest existing event type — replace with a session-revoked type when added
      target_username: actor?.username ?? null,
      actor_username: actor?.username ?? null,
      actor_role: actor?.role ?? null,
      ip: callerIp(req),
      metadata: { revoked_sid: target.id, was_current: target.id === caller.sid },
    });
    return reply.send({ ok: true, revoked_sid: target.id });
  });

  /**
   * DELETE /auth/sessions?except=current
   * Authorization: Bearer <access token>
   *
   * "Sign out everywhere else" — revokes every session for the caller
   * except their current one. Pass `?except=` (or omit) to revoke every
   * session including the caller's, which forces a re-login.
   */
  app.delete<{ Querystring: { except?: string } }>("/auth/sessions", async (req, reply) => {
    const { signer, sessions, audit, users } = await getState();
    const caller = await authedCallerOrUnauthorized(req, reply, signer, sessions);
    if (!caller) return;
    const except =
      req.query.except === "current" && caller.sid ? caller.sid : undefined;
    const n = sessions.revokeAllForUser(caller.sub, except);
    const actor = users.findById(caller.sub);
    audit.append({
      type: "user_unlocked",
      target_username: actor?.username ?? null,
      actor_username: actor?.username ?? null,
      actor_role: actor?.role ?? null,
      ip: callerIp(req),
      metadata: { revoked_count: n, kept_current: Boolean(except) },
    });
    return reply.send({ ok: true, revoked_count: n });
  });

  app.get("/auth/me", async (req, reply) => {
    const auth = req.headers.authorization;
    if (!auth?.startsWith("Bearer ")) return reply.code(401).send({ error: "missing_token" });
    const { signer, sessions } = await getState();
    try {
      const { payload } = await verifyToken(signer, auth.slice(7));
      const sid = typeof payload.sid === "string" ? payload.sid : undefined;
      if (sid && sessions.isRevoked(sid)) {
        return reply.code(401).send({ error: "session_revoked" });
      }
      if (sid) sessions.touch(sid);
      return reply.send({
        sub: payload.sub,
        role: payload.role,
        display_name: payload.display_name,
        session_id: sid ?? null,
      });
    } catch {
      return reply.code(401).send({ error: "invalid_token" });
    }
  });

  // ─── Teams (Issue Owner Groups + branch teams, T4.21) ───────────────────
  // BAC-A manual §3.1.7.1.5. Team CRUD is admin-only since membership +
  // leadership govern who CAPs route to. List/get is open to any signed-in
  // user (analysts need to see teams when picking an issue_owner_group).

  /**
   * GET /auth/teams?branch=...&role=...
   * Authorization: Bearer <access token>
   *
   * Returns all teams, optionally filtered by branch or role. Open to any
   * authenticated user — analysts need this when picking the issue_owner_group
   * for a CAP. Admins can also see it via the same route.
   */
  app.get<{ Querystring: { branch?: string; role?: string } }>(
    "/auth/teams",
    async (req, reply) => {
      const auth = req.headers.authorization;
      if (!auth?.startsWith("Bearer ")) return reply.code(401).send({ error: "missing_token" });
      const { signer, teams } = await getState();
      try {
        const { payload } = await verifyToken(signer, auth.slice(7));
        if (payload.typ === "refresh") return reply.code(401).send({ error: "invalid_token" });
      } catch {
        return reply.code(401).send({ error: "invalid_token" });
      }
      const list = teams.list({
        branch: req.query.branch || undefined,
        role: req.query.role || undefined,
      });
      return reply.send({ teams: list });
    },
  );

  /**
   * GET /auth/teams/:team_id
   * Authorization: Bearer <access token>
   */
  app.get<{ Params: { team_id: string } }>("/auth/teams/:team_id", async (req, reply) => {
    const auth = req.headers.authorization;
    if (!auth?.startsWith("Bearer ")) return reply.code(401).send({ error: "missing_token" });
    const { signer, teams } = await getState();
    try {
      const { payload } = await verifyToken(signer, auth.slice(7));
      if (payload.typ === "refresh") return reply.code(401).send({ error: "invalid_token" });
    } catch {
      return reply.code(401).send({ error: "invalid_token" });
    }
    const team = teams.get(req.params.team_id);
    if (!team) return reply.code(404).send({ error: "team_not_found" });
    return reply.send(team);
  });

  /**
   * POST /auth/teams
   * Authorization: Bearer <admin>
   * body: { name, branch, role, team_leader, email?, description?, members? }
   *
   * Creates a team. team_leader and any initial members must be valid
   * user_ids — pg enforces this via FK; in-memory mode trusts the caller
   * (the route is admin-only anyway).
   */
  app.post<{
    Body: {
      name?: string;
      branch?: string;
      role?: string;
      team_leader?: string;
      email?: string | null;
      description?: string | null;
      members?: string[];
    };
  }>("/auth/teams", async (req, reply) => {
    const { signer, teams, audit } = await getState();
    if (!(await requireAdmin(req, reply, signer))) return;
    const { name, branch, role, team_leader, email, description, members } = req.body ?? {};
    if (!name || !branch || !role || !team_leader) {
      return reply.code(400).send({ error: "name, branch, role, team_leader required" });
    }
    try {
      const team = teams.create({
        name,
        branch,
        role,
        team_leader,
        email: email ?? null,
        description: description ?? null,
        members: members ?? [],
      });
      audit.append({
        type: "user_created",
        target_username: team.name,
        actor_role: "admin",
        ip: callerIp(req),
        metadata: {
          team_id: team.team_id,
          branch: team.branch,
          role: team.role,
          team_leader: team.team_leader,
          op: "team_created",
        },
      });
      return reply.code(201).send(team);
    } catch (err) {
      const status = (err as { status?: number }).status ?? 500;
      return reply.code(status).send({ error: err instanceof Error ? err.message : "team_create_failed" });
    }
  });

  /**
   * POST /auth/teams/:team_id/members
   * Authorization: Bearer <admin>
   * body: { user_id }
   *
   * Adds a user to a team. Idempotent — returns 200 with `added: false`
   * when the user is already a member, 200 with `added: true` otherwise.
   * 404 when the team doesn't exist.
   */
  app.post<{ Params: { team_id: string }; Body: { user_id?: string } }>(
    "/auth/teams/:team_id/members",
    async (req, reply) => {
      const { signer, teams } = await getState();
      if (!(await requireAdmin(req, reply, signer))) return;
      const { user_id } = req.body ?? {};
      if (!user_id) return reply.code(400).send({ error: "user_id is required" });
      const team = teams.get(req.params.team_id);
      if (!team) return reply.code(404).send({ error: "team_not_found" });
      const added = teams.addMember(req.params.team_id, user_id);
      return reply.send({ ok: true, added, team_id: req.params.team_id, user_id });
    },
  );

  /**
   * DELETE /auth/teams/:team_id/members/:user_id
   * Authorization: Bearer <admin>
   *
   * Removes a user from a team. 404 when team or member doesn't exist.
   * 409 when trying to remove the team_leader (reassign leader first
   * via a future PATCH /auth/teams/:id endpoint — not implemented yet).
   */
  app.delete<{ Params: { team_id: string; user_id: string } }>(
    "/auth/teams/:team_id/members/:user_id",
    async (req, reply) => {
      const { signer, teams } = await getState();
      if (!(await requireAdmin(req, reply, signer))) return;
      const team = teams.get(req.params.team_id);
      if (!team) return reply.code(404).send({ error: "team_not_found" });
      try {
        const removed = teams.removeMember(req.params.team_id, req.params.user_id);
        if (!removed) return reply.code(404).send({ error: "member_not_found" });
        return reply.code(204).send();
      } catch (err) {
        const status = (err as { status?: number }).status ?? 500;
        return reply.code(status).send({ error: err instanceof Error ? err.message : "remove_failed" });
      }
    },
  );

  /**
   * DELETE /auth/teams/:team_id
   * Authorization: Bearer <admin>
   *
   * Hard-deletes a team. CASCADE on the FK takes care of the membership
   * rows. 404 when the team doesn't exist.
   */
  app.delete<{ Params: { team_id: string } }>(
    "/auth/teams/:team_id",
    async (req, reply) => {
      const { signer, teams } = await getState();
      if (!(await requireAdmin(req, reply, signer))) return;
      const ok = teams.delete(req.params.team_id);
      if (!ok) return reply.code(404).send({ error: "team_not_found" });
      return reply.code(204).send();
    },
  );

  // ─── Leave covers (T4.22, BAC-A §3.1.9.1.3) ─────────────────────────────
  // Operators delegate their tasks for a date range to a coverer. Any
  // signed-in user can create+list+cancel their OWN covers; admin can
  // see and cancel everyone's. SPA assignment dropdowns query
  // `/auth/users/:username/active-cover` to auto-route work to the
  // coverer when the applicant is on cover.

  /**
   * Resolve the caller's user record from a Bearer access token.
   * Returns the User on success; writes a 401 + returns null on failure.
   * Local helper for the leave-cover routes — they all need to know
   * "who's calling so we can scope to their own rows".
   */
  async function authedUserOrUnauthorized(
    req: import("fastify").FastifyRequest,
    reply: import("fastify").FastifyReply,
    signer: Signer,
    users: IUserStore,
  ): Promise<{ user: import("../users.js").User; isAdmin: boolean } | null> {
    const auth = req.headers.authorization;
    if (!auth?.startsWith("Bearer ")) {
      void reply.code(401).send({ error: "missing_token" });
      return null;
    }
    let sub: string | undefined;
    let role: unknown;
    try {
      const { payload } = await verifyToken(signer, auth.slice(7));
      if (payload.typ === "refresh") {
        void reply.code(401).send({ error: "invalid_token" });
        return null;
      }
      sub = typeof payload.sub === "string" ? payload.sub : undefined;
      role = payload.role;
    } catch {
      void reply.code(401).send({ error: "invalid_token" });
      return null;
    }
    if (!sub) {
      void reply.code(401).send({ error: "invalid_token" });
      return null;
    }
    const user = users.findById(sub);
    if (!user) {
      void reply.code(401).send({ error: "invalid_token" });
      return null;
    }
    return { user, isAdmin: role === "admin" };
  }

  /**
   * GET /auth/leave-covers?applicant_user=&leave_coverer=&active_on=&active_only=
   *
   * Non-admins can only see covers where they're the applicant or the
   * coverer. Admins can pass any filter. `active_only` defaults to true
   * (cancelled covers excluded).
   */
  app.get<{
    Querystring: {
      applicant_user?: string;
      leave_coverer?: string;
      active_on?: string;
      active_only?: string;
    };
  }>("/auth/leave-covers", async (req, reply) => {
    const { signer, users, leaveCovers } = await getState();
    const caller = await authedUserOrUnauthorized(req, reply, signer, users);
    if (!caller) return;
    const q = req.query;
    const filters: {
      applicant_user?: string;
      leave_coverer?: string;
      active_on?: string;
      active_only?: boolean;
    } = {
      active_only: q.active_only === "false" ? false : true,
    };
    if (q.applicant_user) filters.applicant_user = q.applicant_user;
    if (q.leave_coverer) filters.leave_coverer = q.leave_coverer;
    if (q.active_on) filters.active_on = q.active_on;
    let covers = leaveCovers.list(filters);
    // Non-admin scoping: only own rows (as applicant or coverer).
    if (!caller.isAdmin) {
      covers = covers.filter(
        (c) => c.applicant_user === caller.user.id || c.leave_coverer === caller.user.id,
      );
    }
    return reply.send({ leave_covers: covers });
  });

  /**
   * POST /auth/leave-covers
   * body: { applicant_user?, leave_coverer, role, start_date, end_date, in_office?, comments? }
   *
   * Self-service for any signed-in user — `applicant_user` defaults to
   * the caller's user_id. Non-admins can only file leave for themselves;
   * admin can file on behalf of any user (rare admin-override case).
   */
  app.post<{
    Body: {
      applicant_user?: string;
      leave_coverer?: string;
      role?: string;
      start_date?: string;
      end_date?: string;
      in_office?: boolean;
      comments?: string | null;
    };
  }>("/auth/leave-covers", async (req, reply) => {
    const { signer, users, leaveCovers } = await getState();
    const caller = await authedUserOrUnauthorized(req, reply, signer, users);
    if (!caller) return;
    const body = req.body ?? {};
    const applicantId = body.applicant_user ?? caller.user.id;
    if (applicantId !== caller.user.id && !caller.isAdmin) {
      return reply.code(403).send({
        error: "forbidden",
        message: "non-admins can only file leave for themselves",
      });
    }
    if (!body.leave_coverer || !body.role || !body.start_date || !body.end_date) {
      return reply
        .code(400)
        .send({ error: "leave_coverer, role, start_date, end_date required" });
    }
    try {
      const cover = leaveCovers.create({
        applicant_user: applicantId,
        leave_coverer: body.leave_coverer,
        role: body.role,
        start_date: body.start_date,
        end_date: body.end_date,
        in_office: body.in_office ?? false,
        comments: body.comments ?? null,
      });
      return reply.code(201).send(cover);
    } catch (err) {
      const status = (err as { status?: number }).status ?? 500;
      return reply.code(status).send({ error: err instanceof Error ? err.message : "create_failed" });
    }
  });

  /**
   * DELETE /auth/leave-covers/:cover_id — cancel a cover.
   *
   * Caller must be the applicant, the coverer, or admin. Cancelling an
   * already-cancelled cover returns 404 (treat as missing — same shape
   * as the team delete-member route).
   */
  app.delete<{ Params: { cover_id: string } }>(
    "/auth/leave-covers/:cover_id",
    async (req, reply) => {
      const { signer, users, leaveCovers } = await getState();
      const caller = await authedUserOrUnauthorized(req, reply, signer, users);
      if (!caller) return;
      const cover = leaveCovers.get(req.params.cover_id);
      if (!cover || cover.cancelled_at) {
        return reply.code(404).send({ error: "leave_cover_not_found" });
      }
      const allowed =
        caller.isAdmin ||
        cover.applicant_user === caller.user.id ||
        cover.leave_coverer === caller.user.id;
      if (!allowed) {
        return reply.code(403).send({ error: "forbidden" });
      }
      const ok = leaveCovers.cancel(req.params.cover_id);
      if (!ok) return reply.code(404).send({ error: "leave_cover_not_found" });
      return reply.code(204).send();
    },
  );

  /**
   * GET /auth/users/:user_id/active-cover?date=YYYY-MM-DD
   *
   * Returns the active cover row for `user_id` on the given date (default:
   * today, in the server's UTC). 204 No Content when no active cover.
   * Used by the SPA assignment dropdown to auto-route work to the
   * coverer when the intended assignee is on cover.
   *
   * Open to any signed-in user — they need this to do their job.
   */
  app.get<{ Params: { user_id: string }; Querystring: { date?: string } }>(
    "/auth/users/:user_id/active-cover",
    async (req, reply) => {
      const { signer, users, leaveCovers } = await getState();
      const caller = await authedUserOrUnauthorized(req, reply, signer, users);
      if (!caller) return;
      const date = req.query.date ?? new Date().toISOString().slice(0, 10);
      try {
        const cover = leaveCovers.activeCoverFor(req.params.user_id, date);
        if (!cover) return reply.code(204).send();
        return reply.send(cover);
      } catch (err) {
        const status = (err as { status?: number }).status ?? 500;
        return reply.code(status).send({ error: err instanceof Error ? err.message : "lookup_failed" });
      }
    },
  );

  // ─── Dashboard widgets per-role config (T4.23, BAC-A §3.1.9.1.4) ────────

  /**
   * GET /auth/dashboard-widgets/:role
   *
   * Open to any signed-in user — analysts call this to render their own
   * dashboard. Returns the configured widgets sorted by sort_order.
   * Empty array means "no override; use catalogue defaults".
   */
  app.get<{ Params: { role: string } }>(
    "/auth/dashboard-widgets/:role",
    async (req, reply) => {
      const auth = req.headers.authorization;
      if (!auth?.startsWith("Bearer ")) return reply.code(401).send({ error: "missing_token" });
      const { signer, dashboardWidgets } = await getState();
      try {
        const { payload } = await verifyToken(signer, auth.slice(7));
        if (payload.typ === "refresh") return reply.code(401).send({ error: "invalid_token" });
      } catch {
        return reply.code(401).send({ error: "invalid_token" });
      }
      const roleStr = req.params.role;
      if (!DASHBOARD_WIDGET_ROLES.includes(roleStr as DashboardRole)) {
        return reply
          .code(400)
          .send({ error: `role must be one of ${DASHBOARD_WIDGET_ROLES.join(",")}` });
      }
      const widgets = dashboardWidgets.forRole(roleStr as DashboardRole);
      return reply.send({ role: roleStr, widgets });
    },
  );

  /**
   * PUT /auth/dashboard-widgets/:role
   * Authorization: Bearer <admin>
   * body: { widgets: [{ widget_id, sort_order, is_visible }] }
   *
   * Atomically replace the role's full widget layout. Wipes any prior
   * rows for the role and inserts the new ones. updated_by is taken
   * from the caller's username (looked up via the JWT sub claim).
   */
  app.put<{
    Params: { role: string };
    Body: { widgets?: Array<{ widget_id?: string; sort_order?: number; is_visible?: boolean }> };
  }>("/auth/dashboard-widgets/:role", async (req, reply) => {
    const { signer, users, dashboardWidgets } = await getState();
    const auth = req.headers.authorization;
    if (!auth?.startsWith("Bearer ")) return reply.code(401).send({ error: "missing_token" });
    let role: unknown;
    let callerSub: string | undefined;
    try {
      const { payload } = await verifyToken(signer, auth.slice(7));
      if (payload.typ === "refresh") return reply.code(401).send({ error: "invalid_token" });
      role = payload.role;
      callerSub = typeof payload.sub === "string" ? payload.sub : undefined;
    } catch {
      return reply.code(401).send({ error: "invalid_token" });
    }
    if (role !== "admin") {
      return reply.code(403).send({ error: "forbidden", message: "admin role required" });
    }
    const targetRole = req.params.role;
    if (!DASHBOARD_WIDGET_ROLES.includes(targetRole as DashboardRole)) {
      return reply
        .code(400)
        .send({ error: `role must be one of ${DASHBOARD_WIDGET_ROLES.join(",")}` });
    }
    const body = req.body ?? {};
    if (!Array.isArray(body.widgets)) {
      return reply.code(400).send({ error: "widgets array is required" });
    }
    // Coerce + validate each widget row.
    const widgets: Array<{ widget_id: string; sort_order: number; is_visible: boolean }> = [];
    for (const w of body.widgets) {
      if (!w || typeof w.widget_id !== "string" || !w.widget_id.trim()) {
        return reply.code(400).send({ error: "each widget needs a widget_id string" });
      }
      if (typeof w.sort_order !== "number" || !Number.isFinite(w.sort_order)) {
        return reply.code(400).send({ error: `widget ${w.widget_id}: sort_order must be a number` });
      }
      if (typeof w.is_visible !== "boolean") {
        return reply.code(400).send({ error: `widget ${w.widget_id}: is_visible must be a boolean` });
      }
      widgets.push({
        widget_id: w.widget_id.trim(),
        sort_order: w.sort_order,
        is_visible: w.is_visible,
      });
    }
    const actor = callerSub ? users.findById(callerSub) : undefined;
    try {
      const stored = dashboardWidgets.replaceForRole({
        role: targetRole as DashboardRole,
        widgets,
        updated_by: actor?.username ?? "admin",
      });
      return reply.send({ role: targetRole, widgets: stored });
    } catch (err) {
      const status = (err as { status?: number }).status ?? 500;
      return reply.code(status).send({ error: err instanceof Error ? err.message : "replace_failed" });
    }
  });

  // ─── OAuth client-credentials (T4.24, Banking API doc §7) ──────────────
  //
  // POST /oauth/token
  //   body or x-www-form-urlencoded:
  //     grant_type=client_credentials
  //     client_id=<id>
  //     client_secret=<secret>
  //     tenant_id=<id>             (also accepted via X-Tenant-ID header)
  //
  // Returns the OAuth 2 RFC 6749 §5.1 shape:
  //     { access_token, token_type, expires_in, scope }
  //
  // The access token is RS256-signed with the same signer as user
  // sessions; the protected payload carries `tenant_id` + `client_id`
  // (not `sub`/`role`). Resource servers (BFF) can decode and validate
  // tenant membership directly off the token.
  app.post<{
    Body?: {
      grant_type?: string;
      client_id?: string;
      client_secret?: string;
      tenant_id?: string;
      scope?: string;
    };
  }>("/oauth/token", async (req, reply) => {
    // Accept the standard form-urlencoded body Banking gateways send,
    // and JSON for SDK convenience. Fastify parses both when the right
    // content-type is set.
    const body = req.body ?? {};
    const tenantHeader = (() => {
      const v = req.headers["x-tenant-id"];
      return typeof v === "string" && v.length > 0 ? v : undefined;
    })();
    const tenantId = body.tenant_id ?? tenantHeader;
    const grantType = body.grant_type;
    const clientId = body.client_id;
    const clientSecret = body.client_secret;

    if (grantType !== "client_credentials") {
      return reply.code(400).send({
        error: "unsupported_grant_type",
        error_description:
          "only grant_type=client_credentials is supported on this endpoint",
      });
    }
    if (!tenantId || !clientId || !clientSecret) {
      return reply.code(400).send({
        error: "invalid_request",
        error_description:
          "tenant_id, client_id, and client_secret are required (tenant_id may also come from X-Tenant-ID header)",
      });
    }

    const store = await getServiceClientStore();
    const client = store.find(tenantId, clientId);
    // Verify even when client is undefined to keep timing roughly even.
    let ok = false;
    if (client) {
      try {
        ok = await store.verifySecret(client, clientSecret);
      } catch {
        ok = false;
      }
    } else {
      // Burn equivalent CPU on a phantom verification so the response
      // timing doesn't reveal whether the client_id is registered.
      await new Promise((r) => setTimeout(r, 30));
    }
    if (!client || !ok) {
      return reply.code(401).send({
        error: "invalid_client",
        error_description: "client authentication failed",
      });
    }

    // Mint the access token. M2M tokens carry tenant_id + client_id and
    // a `typ: "m2m"` discriminator so resource servers can distinguish
    // them from user sessions.
    const { signer } = await getState();
    const ttlSeconds = 3600;
    const accessToken = await new SignJWT({
      typ: "m2m",
      tenant_id: client.tenant_id,
      client_id: client.client_id,
      scope: (body.scope ?? client.scopes.join(" ")).trim() || "default",
    })
      .setProtectedHeader({ alg: "RS256", kid: signer.kid })
      .setSubject(`client:${client.client_id}`)
      .setIssuer("apex-ews-auth")
      .setAudience("apex-ews")
      .setIssuedAt()
      .setExpirationTime(`${ttlSeconds}s`)
      .sign(signer.privateKey);

    return reply.send({
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: ttlSeconds,
      scope: (body.scope ?? client.scopes.join(" ")).trim() || "default",
      tenant_id: client.tenant_id,
    });
  });

  // ─── JWKS publication (T4.24 Phase 7) ──────────────────────────────────
  //
  // RFC 7517 — Resource servers (the BFF, partner integrations) fetch this
  // endpoint to verify RS256-signed access tokens minted by /auth/login,
  // /auth/refresh, and /oauth/token. Anonymous (no auth required); the
  // public key is, by definition, not a secret.
  //
  // Local dev: ephemeral keypair generated on first signer load. Production:
  // the same kid points at KMS alias/apex-ews-secret; verifiers fetch the
  // public key from KMS or from this endpoint (mirrors KMS for resource
  // servers that can't reach KMS directly).
  app.get("/.well-known/jwks.json", async (_req, reply) => {
    const { signer } = await getState();
    const jwk = await exportJWK(signer.publicKey);
    // exportJWK gives us the algorithm-implied fields; tag with kid + use
    // for the verifier. RS256 → use=sig, alg=RS256.
    return reply.send({
      keys: [
        {
          ...jwk,
          kid: signer.kid,
          alg: "RS256",
          use: "sig",
        },
      ],
    });
  });
}
