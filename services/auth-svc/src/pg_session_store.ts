// services/auth-svc/src/pg_session_store.ts
//
// Postgres-backed session registry. Same public surface as SessionStore
// (sessions.ts) so the routes don't care which one they're talking to.
//
// Same caching strategy as PgUserStore — load on init, sync reads, fire-
// and-forget writes. Sessions are short-lived (7d refresh TTL) so the
// cached set stays small even with thousands of users.

import { randomBytes } from "node:crypto";
import type { Pool } from "pg";
import type { Session } from "./sessions.js";

// Session expiry mirrors the refresh-token TTL so /auth/refresh can't
// resurrect a session whose row already expired in pg.
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function newSid(): string {
  return `sid-${randomBytes(8).toString("base64url")}`;
}

export class PgSessionStore {
  private byId = new Map<string, Session>();
  private revoked = new Set<string>();

  constructor(
    private readonly pool: Pool,
    private readonly nowFn: () => number = Date.now,
    private readonly logger: (msg: string, err?: unknown) => void = (m, e) =>
      console.warn(`[pg-session-store] ${m}`, e ?? ""),
  ) {}

  /**
   * Load every non-expired session row from app_iam.sessions into memory.
   * Revoked rows are loaded too (they need to stay in `revoked` so a
   * presented JWT bearing the revoked sid is rejected, not treated as a
   * fresh login).
   */
  async init(): Promise<void> {
    const rows = await this.pool.query<{
      sid: string;
      user_id: string;
      issued_at: Date;
      last_seen_at: Date;
      ip: string | null;
      user_agent: string | null;
      revoked: boolean;
    }>(
      `SELECT sid, user_id, issued_at, last_seen_at, ip::text AS ip, user_agent, revoked
         FROM app_iam.sessions
        WHERE expires_at > now()`,
    );
    this.byId.clear();
    this.revoked.clear();
    for (const r of rows.rows) {
      const session: Session = {
        id: r.sid,
        user_id: r.user_id,
        issued_at_ms: r.issued_at.getTime(),
        last_seen_at_ms: r.last_seen_at.getTime(),
        ip: r.ip ?? "unknown",
        user_agent: r.user_agent ?? "unknown",
      };
      this.byId.set(session.id, session);
      if (r.revoked) this.revoked.add(session.id);
    }
  }

  create(input: { user_id: string; ip: string; user_agent: string }): Session {
    const now = this.nowFn();
    const session: Session = {
      id: newSid(),
      user_id: input.user_id,
      issued_at_ms: now,
      last_seen_at_ms: now,
      ip: input.ip,
      user_agent: input.user_agent,
    };
    this.byId.set(session.id, session);
    void this.pool
      .query(
        `INSERT INTO app_iam.sessions (
            sid, user_id, issued_at, last_seen_at, expires_at, ip, user_agent
         ) VALUES ($1,$2,$3,$3,$4,$5::inet,$6)`,
        [
          session.id,
          session.user_id,
          new Date(now),
          new Date(now + SESSION_TTL_MS),
          ipForPg(input.ip),
          input.user_agent.slice(0, 256),
        ],
      )
      .catch((err) =>
        this.logger(`failed to persist session ${session.id}`, err),
      );
    return session;
  }

  get(id: string): Session | undefined {
    return this.byId.get(id);
  }

  getActive(id: string): Session | null {
    if (this.revoked.has(id)) return null;
    return this.byId.get(id) ?? null;
  }

  isRevoked(id: string): boolean {
    return this.revoked.has(id);
  }

  touch(id: string): void {
    const s = this.byId.get(id);
    if (!s || this.revoked.has(id)) return;
    const now = this.nowFn();
    s.last_seen_at_ms = now;
    void this.pool
      .query(
        `UPDATE app_iam.sessions SET last_seen_at = $2 WHERE sid = $1`,
        [id, new Date(now)],
      )
      .catch((err) => this.logger(`failed to touch session ${id}`, err));
  }

  listForUser(user_id: string): Session[] {
    return Array.from(this.byId.values())
      .filter((s) => s.user_id === user_id && !this.revoked.has(s.id))
      .sort((a, b) => b.last_seen_at_ms - a.last_seen_at_ms);
  }

  revoke(id: string): boolean {
    if (!this.byId.has(id) || this.revoked.has(id)) return false;
    this.revoked.add(id);
    void this.pool
      .query(
        `UPDATE app_iam.sessions
            SET revoked = TRUE, revoked_at = now(), revoked_reason = 'user_revoked'
          WHERE sid = $1`,
        [id],
      )
      .catch((err) => this.logger(`failed to revoke session ${id}`, err));
    return true;
  }

  revokeAllForUser(user_id: string, except?: string): number {
    let n = 0;
    const ids: string[] = [];
    for (const s of this.byId.values()) {
      if (s.user_id !== user_id) continue;
      if (s.id === except) continue;
      if (this.revoked.has(s.id)) continue;
      this.revoked.add(s.id);
      ids.push(s.id);
      n += 1;
    }
    if (ids.length > 0) {
      void this.pool
        .query(
          `UPDATE app_iam.sessions
              SET revoked = TRUE, revoked_at = now(), revoked_reason = 'bulk_revoke'
            WHERE sid = ANY($1::text[])`,
          [ids],
        )
        .catch((err) =>
          this.logger(`failed bulk-revoke ${ids.length} sessions`, err),
        );
    }
    return n;
  }

  /** Test helper. */
  clear(): void {
    this.byId.clear();
    this.revoked.clear();
  }

  size(): number {
    let n = 0;
    for (const s of this.byId.values()) {
      if (!this.revoked.has(s.id)) n += 1;
    }
    return n;
  }

  /** Truncate the sessions table — used by integration tests only. */
  async reset(): Promise<void> {
    await this.pool.query(`TRUNCATE app_iam.sessions RESTART IDENTITY CASCADE`);
    this.byId.clear();
    this.revoked.clear();
  }
}

/** Strip anything that wouldn't parse as INET — fall back to NULL.
 *  The session.ip field can be "unknown" when fastify can't resolve one;
 *  pg's INET type rejects that, so we coerce. */
function ipForPg(ip: string): string | null {
  if (!ip || ip === "unknown") return null;
  // Quick smell test: must contain a digit and a dot OR a colon.
  if (!/[0-9]/.test(ip) || !(/\./.test(ip) || /:/.test(ip))) return null;
  return ip;
}
