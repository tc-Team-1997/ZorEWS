/**
 * In-memory active-session registry. Each entry corresponds to one login
 * — the `sid` claim embedded in the access + refresh tokens points back
 * to one of these records. Revoking a session removes the record AND
 * adds the sid to the denylist so anybody reusing the still-valid JWT
 * gets rejected on /auth/me + /auth/refresh.
 *
 * Production swap: the registry would be a Postgres table (sessions:
 * id, user_id, ip, ua, issued_at, last_seen_at, revoked_at) and the
 * denylist would be Redis (`SET sid:revoked:{id} 1 EX <ttl>` so it
 * expires when the JWT itself would).
 */

import { randomBytes } from "node:crypto";

export interface Session {
  id: string;
  user_id: string;
  /** Epoch-ms — set at creation, never updated. */
  issued_at_ms: number;
  /** Epoch-ms — bumped each time the session sees /auth/me or /auth/refresh. */
  last_seen_at_ms: number;
  ip: string;
  user_agent: string;
}

/** Public projection — same fields as Session, ISO timestamps for the API. */
export interface SessionView {
  id: string;
  user_id: string;
  issued_at: string;
  last_seen_at: string;
  ip: string;
  user_agent: string;
  /** Convenience flag set by the route layer when filtering by caller sid. */
  is_current?: boolean;
}

function newSid(): string {
  return `sid-${randomBytes(8).toString("base64url")}`;
}

export class SessionStore {
  private byId = new Map<string, Session>();
  /** Sids that have been revoked but whose JWT may still be presented.
   *  Bounded by the JWT's natural TTL (15 min for access, 7d for refresh)
   *  — production would expire entries via Redis EX. */
  private revoked = new Set<string>();

  constructor(private readonly nowFn: () => number = Date.now) {}

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
    return session;
  }

  get(id: string): Session | undefined {
    return this.byId.get(id);
  }

  /** Returns the session if it exists AND is not revoked. */
  getActive(id: string): Session | null {
    if (this.revoked.has(id)) return null;
    return this.byId.get(id) ?? null;
  }

  isRevoked(id: string): boolean {
    return this.revoked.has(id);
  }

  /** Update last_seen_at. No-op for unknown / revoked sessions. */
  touch(id: string): void {
    const s = this.byId.get(id);
    if (!s || this.revoked.has(id)) return;
    s.last_seen_at_ms = this.nowFn();
  }

  /** Returns all active sessions for a user, newest-first. */
  listForUser(user_id: string): Session[] {
    return Array.from(this.byId.values())
      .filter((s) => s.user_id === user_id && !this.revoked.has(s.id))
      .sort((a, b) => b.last_seen_at_ms - a.last_seen_at_ms);
  }

  /** Revoke a specific session by id. Returns true if it was active.
   *  The record stays in `byId` for one cycle so any in-flight refresh
   *  request still resolves to a clear "session_revoked" rather than
   *  "session_not_found". */
  revoke(id: string): boolean {
    if (!this.byId.has(id) || this.revoked.has(id)) return false;
    this.revoked.add(id);
    return true;
  }

  /** Revoke every session for a user EXCEPT optionally one (the caller's
   *  current session, so "sign out everywhere else" doesn't sign out the
   *  current tab). Returns the count revoked. */
  revokeAllForUser(user_id: string, except?: string): number {
    let n = 0;
    for (const s of this.byId.values()) {
      if (s.user_id !== user_id) continue;
      if (s.id === except) continue;
      if (this.revoked.has(s.id)) continue;
      this.revoked.add(s.id);
      n += 1;
    }
    return n;
  }

  /** Test helper. */
  clear(): void {
    this.byId.clear();
    this.revoked.clear();
  }

  /** Test helper — count of active (non-revoked) sessions. */
  size(): number {
    let n = 0;
    for (const s of this.byId.values()) {
      if (!this.revoked.has(s.id)) n += 1;
    }
    return n;
  }
}

export function toView(s: Session, currentSid?: string): SessionView {
  return {
    id: s.id,
    user_id: s.user_id,
    issued_at: new Date(s.issued_at_ms).toISOString(),
    last_seen_at: new Date(s.last_seen_at_ms).toISOString(),
    ip: s.ip,
    user_agent: s.user_agent,
    is_current: currentSid !== undefined ? s.id === currentSid : undefined,
  };
}
