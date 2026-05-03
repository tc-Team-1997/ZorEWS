// services/auth-svc/src/pg_user_store.ts
//
// Postgres-backed UserStore. Same public surface as the in-memory
// UserStore so the routes don't care which one they're talking to.
//
// Strategy (cribbed from BFF's PgWebhookSubscriptionStore — see
// docs/database-gap-analysis.md "T4.13 implementation notes"):
//   - cache-on-init   — load every row from app_iam.users + app_iam.password_history
//                       into in-memory Maps so reads stay synchronous
//   - sync reads      — find* / verifyPassword / listAll never await pg
//   - write-through   — mutations update the cache + fire a pg query
//                       in the background (.catch logs the failure)
//
// This pattern means a pg outage degrades to "in-memory only" rather than
// dropping requests on the floor — the cache is authoritative for reads
// during the request, and the next restart will rehydrate from whatever
// pg holds. Acceptable for a prototype; production would either fail
// closed on a write error or use a durable outbox.

import argon2 from "argon2";
import { randomBytes, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import {
  PASSWORD_HISTORY_LIMIT,
  RegisterFailure,
  type PasswordResetTokenIssue,
  type RegisterInput,
  type RegisterResult,
  type Role,
  type User,
  ALL_ROLES,
} from "./users.js";

// Same demo roster the in-memory store seeds. Idempotent INSERT … ON
// CONFLICT DO NOTHING means re-running init() is safe.
const SEED: Array<Omit<User, "passwordHash" | "locked"> & { password: string }> = [
  {
    id: "u-001",
    username: "alice.admin",
    email: "alice.admin@apex-ews.test",
    password: "Admin!Pass1",
    role: "admin",
    display_name: "Alice Mwangi",
    failed_login_count: 0,
    lockout_until_ms: null,
    password_history: [],
    must_change_password: false,
    terms_accepted_at: new Date().toISOString(),
    tenant_id: "BANK_DEMO",
  },
  {
    id: "u-002",
    username: "ravi.risk",
    email: "ravi.risk@apex-ews.test",
    password: "RiskAnalyst!1",
    role: "risk_analyst",
    display_name: "Ravi Otieno",
    failed_login_count: 0,
    lockout_until_ms: null,
    password_history: [],
    must_change_password: false,
    terms_accepted_at: new Date().toISOString(),
    tenant_id: "BANK_DEMO",
  },
  {
    id: "u-003",
    username: "sue.super",
    email: "sue.super@apex-ews.test",
    password: "Super!Pass1",
    role: "supervisor",
    display_name: "Sue Wanjiru",
    failed_login_count: 0,
    lockout_until_ms: null,
    password_history: [],
    must_change_password: false,
    terms_accepted_at: new Date().toISOString(),
    tenant_id: "BANK_DEMO",
  },
  {
    id: "u-004",
    username: "carl.collect",
    email: "carl.collect@apex-ews.test",
    password: "Collect!Pass1",
    role: "collection_officer",
    display_name: "Carl Kamau",
    failed_login_count: 0,
    lockout_until_ms: null,
    password_history: [],
    must_change_password: false,
    terms_accepted_at: new Date().toISOString(),
    tenant_id: "BANK_DEMO",
  },
  {
    id: "u-005",
    username: "fiona.field",
    email: "fiona.field@apex-ews.test",
    password: "Field!Pass1",
    role: "field_officer",
    display_name: "Fiona Achieng",
    failed_login_count: 0,
    lockout_until_ms: null,
    password_history: [],
    must_change_password: false,
    terms_accepted_at: new Date().toISOString(),
    tenant_id: "BANK_DEMO",
  },
  {
    id: "u-006",
    username: "bil.admin",
    email: "bil.admin@bil.test",
    password: "BilAdmin!1",
    role: "admin",
    display_name: "BIL Admin",
    failed_login_count: 0,
    lockout_until_ms: null,
    password_history: [],
    must_change_password: false,
    terms_accepted_at: new Date().toISOString(),
    tenant_id: "BIL",
  },
];

const USERNAME_RE = /^[a-z][a-z0-9._-]{2,31}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function passwordTooWeak(pw: string): boolean {
  if (pw.length < 8) return true;
  if (!/[a-z]/.test(pw)) return true;
  if (!/[A-Z]/.test(pw)) return true;
  if (!/[0-9!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(pw)) return true;
  return false;
}

interface ResetEntry {
  userId: string;
  expiresAtMs: number;
}

const RESET_TOKEN_TTL_MS = 15 * 60 * 1000;
const RESET_LINK_BASE = process.env.APEX_WEB_BASE_URL ?? "http://localhost:5174";

export class PgUserStore {
  private byUsername = new Map<string, User>();
  private resetTokens = new Map<string, ResetEntry>();

  constructor(
    private readonly pool: Pool,
    private readonly logger: (msg: string, err?: unknown) => void = (m, e) =>
      console.warn(`[pg-user-store] ${m}`, e ?? ""),
  ) {}

  /**
   * Loads every row from app_iam.users + app_iam.password_history into
   * memory. Also seeds the demo accounts on first run (idempotent —
   * INSERT … ON CONFLICT DO NOTHING means re-running is a no-op).
   */
  async init(): Promise<void> {
    await this.seedIfEmpty();
    const userRows = await this.pool.query<{
      user_id: string;
      username: string;
      email: string;
      display_name: string;
      role: string;
      password_hash: string;
      failed_login_count: number;
      lockout_until: Date | null;
      must_change_password: boolean;
      terms_accepted_at: Date | null;
      locked: boolean;
      tenant_id: string;
    }>(
      `SELECT user_id, username, email, display_name, role, password_hash,
              failed_login_count, lockout_until, must_change_password,
              terms_accepted_at, locked, tenant_id
         FROM app_iam.users`,
    );
    const historyRows = await this.pool.query<{
      user_id: string;
      password_hash: string;
    }>(
      `SELECT user_id, password_hash FROM app_iam.password_history
        ORDER BY user_id, set_at ASC`,
    );
    const historyByUser = new Map<string, string[]>();
    for (const row of historyRows.rows) {
      const list = historyByUser.get(row.user_id) ?? [];
      list.push(row.password_hash);
      historyByUser.set(row.user_id, list);
    }
    this.byUsername.clear();
    for (const r of userRows.rows) {
      const user: User = {
        id: r.user_id,
        username: r.username,
        email: r.email,
        passwordHash: r.password_hash,
        role: r.role as Role,
        display_name: r.display_name,
        tenant_id: r.tenant_id,
        locked: r.locked,
        failed_login_count: r.failed_login_count,
        lockout_until_ms: r.lockout_until ? r.lockout_until.getTime() : null,
        password_history: (historyByUser.get(r.user_id) ?? []).slice(
          -PASSWORD_HISTORY_LIMIT,
        ),
        must_change_password: r.must_change_password,
        terms_accepted_at: r.terms_accepted_at
          ? r.terms_accepted_at.toISOString()
          : null,
      };
      this.byUsername.set(user.username, user);
    }
  }

  /** Compatibility shim for the in-memory store's seed() — pg variant
   *  does this inside init() so this is a no-op. Kept so the routes can
   *  call seed() unconditionally. */
  async seed(): Promise<void> {
    // already done inside init(); no-op for parity with UserStore
  }

  private async seedIfEmpty(): Promise<void> {
    const r = await this.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM app_iam.users`,
    );
    if (Number(r.rows[0]?.count ?? 0) > 0) return;
    for (const u of SEED) {
      const passwordHash = await argon2.hash(u.password, { type: argon2.argon2id });
      await this.pool.query(
        `INSERT INTO app_iam.users (
            user_id, username, email, display_name, role, password_hash,
            failed_login_count, lockout_until, must_change_password,
            terms_accepted_at, locked, tenant_id
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         ON CONFLICT (user_id) DO NOTHING`,
        [
          u.id,
          u.username,
          u.email,
          u.display_name,
          u.role,
          passwordHash,
          0,
          null,
          false,
          u.terms_accepted_at ? new Date(u.terms_accepted_at) : new Date(),
          false,
          u.tenant_id,
        ],
      );
    }
  }

  // ---------- sync reads ----------

  findByUsername(username: string): User | undefined {
    return this.byUsername.get(username);
  }

  findById(id: string): User | undefined {
    for (const u of this.byUsername.values()) if (u.id === id) return u;
    return undefined;
  }

  findByEmail(email: string): User | undefined {
    const needle = email.trim().toLowerCase();
    for (const u of this.byUsername.values()) if (u.email === needle) return u;
    return undefined;
  }

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

  // ---------- mutations (cache + fire-and-forget pg) ----------

  setLocked(user: User, locked: boolean): void {
    user.locked = locked;
    user.lockout_until_ms = null;
    if (!locked) user.failed_login_count = 0;
    this.persistLockState(user);
  }

  registerFailedLogin(
    user: User,
    threshold = 5,
    lockoutMs = 30 * 60 * 1000,
    nowMs = Date.now(),
  ): { count: number; just_locked: boolean } {
    user.failed_login_count += 1;
    let just_locked = false;
    if (user.failed_login_count >= threshold && !user.locked) {
      user.locked = true;
      user.lockout_until_ms = nowMs + lockoutMs;
      just_locked = true;
    }
    this.persistLockState(user);
    return { count: user.failed_login_count, just_locked };
  }

  resetFailedLogin(user: User): void {
    user.failed_login_count = 0;
    this.persistLockState(user);
  }

  maybeReleaseAutoLock(user: User, nowMs = Date.now()): boolean {
    if (!user.locked) return false;
    if (user.lockout_until_ms === null) return false;
    if (user.lockout_until_ms > nowMs) return false;
    user.locked = false;
    user.lockout_until_ms = null;
    user.failed_login_count = 0;
    this.persistLockState(user);
    return true;
  }

  deleteByUsername(username: string): boolean {
    const u = this.byUsername.get(username);
    if (!u) return false;
    this.byUsername.delete(username);
    for (const [token, entry] of this.resetTokens.entries()) {
      if (entry.userId === u.id) this.resetTokens.delete(token);
    }
    void this.pool
      .query(`DELETE FROM app_iam.users WHERE user_id = $1`, [u.id])
      .catch((err) => this.logger(`failed to delete user ${u.id}`, err));
    return true;
  }

  async setPassword(user: User, newPassword: string): Promise<void> {
    if (!newPassword || passwordTooWeak(newPassword)) {
      throw new RegisterFailure(
        "password_too_weak",
        "password must be ≥8 chars and include lower, upper, and a digit or symbol",
      );
    }
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
    const oldHash = user.passwordHash;
    user.password_history = [
      ...user.password_history.slice(-(PASSWORD_HISTORY_LIMIT - 1)),
      oldHash,
    ];
    user.passwordHash = await argon2.hash(newPassword, { type: argon2.argon2id });

    // Persist: insert old hash into history, update users.password_hash,
    // then trim history beyond the cap. All three are independent so we
    // fire-and-forget; if any fails, the next init() will reconcile.
    void this.pool
      .query(
        `INSERT INTO app_iam.password_history (user_id, password_hash) VALUES ($1, $2)`,
        [user.id, oldHash],
      )
      .catch((err) =>
        this.logger(`failed to insert password_history for ${user.id}`, err),
      );
    void this.pool
      .query(
        `UPDATE app_iam.users SET password_hash = $2 WHERE user_id = $1`,
        [user.id, user.passwordHash],
      )
      .catch((err) =>
        this.logger(`failed to update password_hash for ${user.id}`, err),
      );
    void this.pool
      .query(
        // Keep only the most recent PASSWORD_HISTORY_LIMIT rows for this user.
        `DELETE FROM app_iam.password_history
          WHERE id IN (
            SELECT id FROM app_iam.password_history
             WHERE user_id = $1
             ORDER BY set_at DESC
             OFFSET $2
          )`,
        [user.id, PASSWORD_HISTORY_LIMIT],
      )
      .catch((err) =>
        this.logger(`failed to trim password_history for ${user.id}`, err),
      );
  }

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

  consumeResetToken(token: string): User | null {
    const entry = this.resetTokens.get(token);
    if (!entry) return null;
    this.resetTokens.delete(token);
    if (entry.expiresAtMs < Date.now()) return null;
    return this.findById(entry.userId) ?? null;
  }

  peekLastTokenFor(
    userId: string,
  ): { token: string; reset_link: string; expires_at: string } | null {
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
      throw new RegisterFailure(
        "role_invalid",
        `role must be one of ${ALL_ROLES.join(", ")}`,
      );
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
      must_change_password: mustChange,
      terms_accepted_at: mustChange ? null : new Date().toISOString(),
    };
    this.byUsername.set(username, user);

    void this.pool
      .query(
        `INSERT INTO app_iam.users (
            user_id, username, email, display_name, role, password_hash,
            failed_login_count, lockout_until, must_change_password,
            terms_accepted_at, locked, tenant_id
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          user.id,
          user.username,
          user.email,
          user.display_name,
          user.role,
          user.passwordHash,
          0,
          null,
          user.must_change_password,
          user.terms_accepted_at ? new Date(user.terms_accepted_at) : null,
          false,
          user.tenant_id,
        ],
      )
      .catch((err) => this.logger(`failed to insert user ${user.id}`, err));

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

  async completeFirstLogin(user: User, newPassword: string): Promise<void> {
    await this.setPassword(user, newPassword);
    user.must_change_password = false;
    user.terms_accepted_at = new Date().toISOString();
    user.failed_login_count = 0;
    void this.pool
      .query(
        `UPDATE app_iam.users
            SET must_change_password = $2,
                terms_accepted_at = $3,
                failed_login_count = 0
          WHERE user_id = $1`,
        [user.id, false, new Date(user.terms_accepted_at)],
      )
      .catch((err) =>
        this.logger(`failed to mark first-login complete for ${user.id}`, err),
      );
  }

  /** Truncate both tables — used by the integration tests. Production code
   *  has no business calling this. */
  async reset(): Promise<void> {
    await this.pool.query(
      `TRUNCATE app_iam.password_history, app_iam.users RESTART IDENTITY CASCADE`,
    );
    this.byUsername.clear();
    this.resetTokens.clear();
  }

  // ---------- private helpers ----------

  private persistLockState(user: User): void {
    void this.pool
      .query(
        `UPDATE app_iam.users
            SET failed_login_count = $2,
                locked = $3,
                lockout_until = $4
          WHERE user_id = $1`,
        [
          user.id,
          user.failed_login_count,
          user.locked,
          user.lockout_until_ms ? new Date(user.lockout_until_ms) : null,
        ],
      )
      .catch((err) =>
        this.logger(`failed to persist lock state for ${user.id}`, err),
      );
  }
}
