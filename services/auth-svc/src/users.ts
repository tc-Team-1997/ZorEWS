import argon2 from "argon2";
import { randomBytes, randomUUID } from "node:crypto";

export type Role =
  | "admin"
  | "risk_analyst"
  | "supervisor"
  | "collection_officer"
  | "field_officer";

export const ALL_ROLES: readonly Role[] = [
  "admin",
  "risk_analyst",
  "supervisor",
  "collection_officer",
  "field_officer",
];

export interface User {
  id: string;
  username: string;
  email: string;
  passwordHash: string;
  role: Role;
  display_name: string;
  /** Tenant the user belongs to (T4.24 Phase 3). FK to app_iam.tenants.
   *  Used by the access-token claim so the BFF tenant gate can verify
   *  X-Tenant-ID matches the user's tenant. Default 'BANK_DEMO'. */
  tenant_id: string;
  /** Locked accounts cannot log in (403 with locked_account) until an admin unlocks
   *  OR (when set) `lockout_until_ms` passes — see registerFailedLogin(). */
  locked: boolean;
  /** Consecutive wrong-password attempts. Reset to 0 on successful login. */
  failed_login_count: number;
  /** Epoch-ms when an auto-lock auto-releases. null when the lock is admin-set
   *  (manual locks have no auto-release window). */
  lockout_until_ms: number | null;
  /** Most recent argon2 hashes (excluding the current one). Bounded at
   *  PASSWORD_HISTORY_LIMIT — used to refuse password reuse. */
  password_history: string[];
  /** True when the user must change their password before the rest of the
   *  app is usable. Set to true for admin-created users (default password)
   *  and cleared when the first-login wizard completes. Seed users start
   *  with this false so demo logins work without ceremony. */
  must_change_password: boolean;
  /** ISO timestamp of when the user accepted the prototype's T&C, or null
   *  if they haven't yet. Captured during the first-login wizard. */
  terms_accepted_at: string | null;
}

export interface RegisterInput {
  username: string;
  email: string;
  password: string;
  display_name: string;
  role: Role;
  /** Set true for admin-created users so they're forced through the
   *  first-login wizard. Optional — defaults to false (self-signup). */
  must_change_password?: boolean;
  /** Tenant the new user belongs to. Defaults to 'BANK_DEMO'. */
  tenant_id?: string;
}

export interface RegisterResult {
  user: Omit<User, "passwordHash">;
}

export type RegisterErrorCode =
  | "username_taken"
  | "username_invalid"
  | "email_invalid"
  | "email_taken"
  | "password_too_weak"
  | "password_reused"
  | "display_name_required"
  | "role_invalid";

/** Banking standard: keep the most recent N hashes and refuse reuse. */
export const PASSWORD_HISTORY_LIMIT = 5;

export class RegisterFailure extends Error {
  constructor(public readonly code: RegisterErrorCode, message: string) {
    super(message);
    this.name = "RegisterFailure";
  }
}

const USERNAME_RE = /^[a-z][a-z0-9._-]{2,31}$/;
// Pragmatic email shape — single @, no spaces, dot in the host. Don't try
// to validate RFC 5321 in regex; production sends a verification email.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Prototype password policy: ≥8 chars, mixed case, plus a digit or symbol.
// Production would centralise this in a security-baseline module.
function passwordTooWeak(pw: string): boolean {
  if (pw.length < 8) return true;
  if (!/[a-z]/.test(pw)) return true;
  if (!/[A-Z]/.test(pw)) return true;
  if (!/[0-9!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(pw)) return true;
  return false;
}

// Stable seed used by local dev / tests. Production stores users in Aurora
// `app.users` with passwords hashed via argon2id.
//
// Phase 3 (T4.24): users 1–5 are BANK_DEMO; user 6 is BIL so the prototype
// can demonstrate cross-tenant scenarios out of the box (e.g. bil.admin
// logs in and the BFF rejects requests carrying X-Tenant-ID: BANK_DEMO).
const SEED: Array<Omit<User, "passwordHash" | "locked"> & { password: string }> = [
  {
    id: "u-001",
    username: "alice.admin",
    email: "alice.admin@apex-ews.test",
    password: "Admin!Pass1",
    role: "admin",
    display_name: "Alice Mwangi",
    tenant_id: "BANK_DEMO",
  },
  {
    id: "u-002",
    username: "ravi.risk",
    email: "ravi.risk@apex-ews.test",
    password: "RiskAnalyst!1",
    role: "risk_analyst",
    display_name: "Ravi Otieno",
    tenant_id: "BANK_DEMO",
  },
  {
    id: "u-003",
    username: "sue.super",
    email: "sue.super@apex-ews.test",
    password: "Super!Pass1",
    role: "supervisor",
    display_name: "Sue Wanjiru",
    tenant_id: "BANK_DEMO",
  },
  {
    id: "u-004",
    username: "carl.collect",
    email: "carl.collect@apex-ews.test",
    password: "Collect!Pass1",
    role: "collection_officer",
    display_name: "Carl Kamau",
    tenant_id: "BANK_DEMO",
  },
  {
    id: "u-005",
    username: "fiona.field",
    email: "fiona.field@apex-ews.test",
    password: "Field!Pass1",
    role: "field_officer",
    display_name: "Fiona Achieng",
    tenant_id: "BANK_DEMO",
  },
  {
    id: "u-006",
    username: "bil.admin",
    email: "bil.admin@bil.test",
    password: "BilAdmin!1",
    role: "admin",
    display_name: "BIL Admin",
    tenant_id: "BIL",
  },
];

export interface PasswordResetTokenIssue {
  token: string;
  /** ISO timestamp at which the token expires. */
  expires_at: string;
  /** Convenience link the dev "email" prints — points at the SPA's reset page. */
  reset_link: string;
}

interface ResetEntry {
  userId: string;
  expiresAtMs: number;
}

const RESET_TOKEN_TTL_MS = 15 * 60 * 1000; // 15 min — short enough to limit blast radius
const RESET_LINK_BASE = process.env.APEX_WEB_BASE_URL ?? "http://localhost:5174";

export class UserStore {
  private byUsername = new Map<string, User>();
  private resetTokens = new Map<string, ResetEntry>();

  async seed(): Promise<void> {
    for (const u of SEED) {
      const passwordHash = await argon2.hash(u.password, { type: argon2.argon2id });
      const user: User = {
        id: u.id,
        username: u.username,
        email: u.email,
        passwordHash,
        role: u.role,
        display_name: u.display_name,
        tenant_id: u.tenant_id,
        locked: false,
        failed_login_count: 0,
        lockout_until_ms: null,
        password_history: [],
        // Seed users skip the first-login wizard so demo logins are frictionless.
        must_change_password: false,
        terms_accepted_at: new Date().toISOString(),
      };
      this.byUsername.set(u.username, user);
    }
  }

  findByUsername(username: string): User | undefined {
    return this.byUsername.get(username);
  }

  findById(id: string): User | undefined {
    for (const u of this.byUsername.values()) {
      if (u.id === id) return u;
    }
    return undefined;
  }

  findByEmail(email: string): User | undefined {
    const needle = email.trim().toLowerCase();
    for (const u of this.byUsername.values()) {
      if (u.email === needle) return u;
    }
    return undefined;
  }

  /**
   * Public-shape projection of every user — id, username, email, role,
   * display_name, locked. Drops passwordHash. Used by the admin Users
   * console.
   */
  listAll(): Array<Omit<User, "passwordHash" | "password_history">> {
    return Array.from(this.byUsername.values())
      .map((u) => ({
        id: u.id,
        username: u.username,
        email: u.email,
        role: u.role,
        display_name: u.display_name,
        locked: u.locked,
        failed_login_count: u.failed_login_count,
        lockout_until_ms: u.lockout_until_ms,
        must_change_password: u.must_change_password,
        terms_accepted_at: u.terms_accepted_at,
      }))
      .sort((a, b) => a.username.localeCompare(b.username));
  }

  async verifyPassword(user: User, password: string): Promise<boolean> {
    return argon2.verify(user.passwordHash, password);
  }

  /** Toggle the locked flag in place. Used by the admin lock/unlock routes.
   *  Admin-set locks clear lockout_until_ms (no auto-release for manual locks).
   *  Admin-unlocking also clears the failed-login counter — the user gets a
   *  clean slate. */
  setLocked(user: User, locked: boolean): void {
    user.locked = locked;
    user.lockout_until_ms = null;
    if (!locked) user.failed_login_count = 0;
  }

  /**
   * Record a wrong-password attempt. After `threshold` consecutive failures
   * the account is auto-locked for `lockoutMs`. Returns the post-update
   * counter and whether this attempt tripped the lock.
   *
   * Why per-attempt instead of a sliding window: banking standard is "5 in
   * a row resets only on success". A user who fails 4×, succeeds, then
   * fails 4× more is not at risk — they presumably know their password.
   */
  registerFailedLogin(
    user: User,
    threshold = 5,
    lockoutMs = 30 * 60 * 1000,
    nowMs = Date.now(),
  ): { count: number; just_locked: boolean } {
    user.failed_login_count += 1;
    if (user.failed_login_count >= threshold && !user.locked) {
      user.locked = true;
      user.lockout_until_ms = nowMs + lockoutMs;
      return { count: user.failed_login_count, just_locked: true };
    }
    return { count: user.failed_login_count, just_locked: false };
  }

  /** Reset the failed-login counter — called on successful login. */
  resetFailedLogin(user: User): void {
    user.failed_login_count = 0;
  }

  /** If the user is auto-locked and the lock window has expired, release the
   *  lock and reset the counter. Returns true if a release occurred. Manual
   *  admin locks (lockout_until_ms === null) are never released by this. */
  maybeReleaseAutoLock(user: User, nowMs = Date.now()): boolean {
    if (!user.locked) return false;
    if (user.lockout_until_ms === null) return false;
    if (user.lockout_until_ms > nowMs) return false;
    user.locked = false;
    user.lockout_until_ms = null;
    user.failed_login_count = 0;
    return true;
  }

  /** Hard-delete a user. Returns true if the username existed. */
  deleteByUsername(username: string): boolean {
    const u = this.byUsername.get(username);
    if (!u) return false;
    this.byUsername.delete(username);
    // Sweep any password-reset tokens belonging to this user.
    for (const [token, entry] of this.resetTokens.entries()) {
      if (entry.userId === u.id) this.resetTokens.delete(token);
    }
    return true;
  }

  /**
   * Replace `user.passwordHash` with the argon2id hash of `newPassword`.
   * Throws RegisterFailure("password_too_weak") if the new password fails
   * the complexity gate, or "password_reused" if it matches the current
   * password or any of the last `PASSWORD_HISTORY_LIMIT` previous ones.
   * The current hash is pushed onto password_history (newest-last; oldest
   * trimmed) before being replaced. Mutates the User object in place.
   *
   * Production would also invalidate any active refresh tokens here; in
   * this prototype tokens are short-lived (900s) so the next refresh just
   * fails and the user re-logs in.
   */
  async setPassword(user: User, newPassword: string): Promise<void> {
    if (!newPassword || passwordTooWeak(newPassword)) {
      throw new RegisterFailure(
        "password_too_weak",
        "password must be ≥8 chars and include lower, upper, and a digit or symbol",
      );
    }
    // Reject reuse against the current hash + last N stored hashes.
    if (await argon2.verify(user.passwordHash, newPassword)) {
      throw new RegisterFailure(
        "password_reused",
        "password matches your current password — choose a new one",
      );
    }
    for (const old of user.password_history) {
      if (await argon2.verify(old, newPassword)) {
        throw new RegisterFailure(
          "password_reused",
          `password matches one of your last ${PASSWORD_HISTORY_LIMIT} passwords — choose a new one`,
        );
      }
    }
    // Push the soon-to-be-old hash onto history, trim to the cap, then rotate.
    user.password_history = [
      ...user.password_history.slice(-(PASSWORD_HISTORY_LIMIT - 1)),
      user.passwordHash,
    ];
    user.passwordHash = await argon2.hash(newPassword, { type: argon2.argon2id });
  }

  /**
   * Issue a single-use password-reset token for `user`. 32 random bytes
   * → URL-safe base64. Token + expiry stored in-memory; consume() removes
   * it. Returns the token, ISO expiry, and a dev "reset link" that the
   * route handler logs (no real SMTP in this prototype).
   */
  issueResetToken(user: User): PasswordResetTokenIssue {
    const token = randomBytes(32).toString("base64url");
    const expiresAtMs = Date.now() + RESET_TOKEN_TTL_MS;
    this.resetTokens.set(token, { userId: user.id, expiresAtMs });
    return {
      token,
      expires_at: new Date(expiresAtMs).toISOString(),
      reset_link: `${RESET_LINK_BASE}/reset-password?token=${token}`,
    };
  }

  /** Consume a reset token: returns the User on success, null otherwise.
   *  Always removes the token if it existed (even when expired) so a
   *  leaked token can't be retried. */
  consumeResetToken(token: string): User | null {
    const entry = this.resetTokens.get(token);
    if (!entry) return null;
    this.resetTokens.delete(token);
    if (entry.expiresAtMs < Date.now()) return null;
    return this.findById(entry.userId) ?? null;
  }

  /** Test-only helper: returns the most recently issued, still-valid
   *  token for `userId`, or null. Used by the route only when the
   *  AUTH_SVC_DEBUG_TOKENS env var is set, so the public response shape
   *  in production is unaffected. */
  peekLastTokenFor(userId: string): { token: string; reset_link: string; expires_at: string } | null {
    let latestToken: string | null = null;
    let latestExpiresMs = -1;
    for (const [token, entry] of this.resetTokens.entries()) {
      if (entry.userId === userId && entry.expiresAtMs > latestExpiresMs) {
        latestToken = token;
        latestExpiresMs = entry.expiresAtMs;
      }
    }
    if (!latestToken) return null;
    return {
      token: latestToken,
      reset_link: `${RESET_LINK_BASE}/reset-password?token=${latestToken}`,
      expires_at: new Date(latestExpiresMs).toISOString(),
    };
  }

  async register(input: RegisterInput): Promise<RegisterResult> {
    const username = input.username?.trim().toLowerCase();
    const email = input.email?.trim().toLowerCase();
    const display_name = input.display_name?.trim();
    const role = input.role;
    const password = input.password;

    if (!username || !USERNAME_RE.test(username)) {
      throw new RegisterFailure(
        "username_invalid",
        "username must be 3–32 chars, lowercase, start with a letter, [a-z0-9._-]",
      );
    }
    if (!email || !EMAIL_RE.test(email)) {
      throw new RegisterFailure("email_invalid", "a valid email is required");
    }
    if (!display_name) {
      throw new RegisterFailure("display_name_required", "display_name required");
    }
    if (!ALL_ROLES.includes(role)) {
      throw new RegisterFailure("role_invalid", `role must be one of ${ALL_ROLES.join(", ")}`);
    }
    if (!password || passwordTooWeak(password)) {
      throw new RegisterFailure(
        "password_too_weak",
        "password must be ≥8 chars and include lower, upper, and a digit or symbol",
      );
    }
    if (this.byUsername.has(username)) {
      throw new RegisterFailure("username_taken", `username ${username} already exists`);
    }
    for (const existing of this.byUsername.values()) {
      if (existing.email === email) {
        throw new RegisterFailure("email_taken", `email ${email} already exists`);
      }
    }

    const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
    const mustChange = input.must_change_password === true;
    const user: User = {
      id: `u-${randomUUID().slice(0, 8)}`,
      username,
      email,
      passwordHash,
      role,
      display_name,
      tenant_id: input.tenant_id ?? "BANK_DEMO",
      locked: false,
      failed_login_count: 0,
      lockout_until_ms: null,
      password_history: [],
      // Self-signup users have agreed to T&C inline (the SPA gates submit
      // on the checkbox); admin-created users haven't, so terms_accepted_at
      // tracks alongside must_change_password.
      must_change_password: mustChange,
      terms_accepted_at: mustChange ? null : new Date().toISOString(),
    };
    this.byUsername.set(username, user);

    return {
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        role: user.role,
        display_name: user.display_name,
        locked: user.locked,
        failed_login_count: user.failed_login_count,
        lockout_until_ms: user.lockout_until_ms,
        password_history: [],
        must_change_password: user.must_change_password,
        terms_accepted_at: user.terms_accepted_at,
      },
    };
  }

  /**
   * Complete the first-login wizard: rotates the password (with the same
   * complexity + no-reuse gates as setPassword) and records T&C acceptance.
   * Throws RegisterFailure on a weak/reused password. Mutates the user
   * in place and returns nothing.
   */
  async completeFirstLogin(user: User, newPassword: string): Promise<void> {
    await this.setPassword(user, newPassword);
    user.must_change_password = false;
    user.terms_accepted_at = new Date().toISOString();
    // Reset failed-login counter as a courtesy — the user has just proven
    // they hold the (admin-shared) initial password and is now setting
    // their own.
    user.failed_login_count = 0;
  }
}
