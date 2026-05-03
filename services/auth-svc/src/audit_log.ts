/**
 * In-memory ring-buffer audit log for auth events. Prototype-scope — production
 * would persist to an append-only table in Aurora with WORM retention. The
 * shape below maps 1:1 to what the production schema would need so the
 * migration is mechanical.
 */

export type AuthEventType =
  | "login_success"
  | "login_failure"
  | "login_rate_limited"
  | "login_locked"
  | "auto_lockout_triggered"
  | "auto_lockout_released"
  | "password_reset_request"
  | "password_reset_request_unknown"
  | "password_reset_request_rate_limited"
  | "password_reset_complete"
  | "admin_password_reset"
  | "user_created"
  | "user_deleted"
  | "user_locked"
  | "user_unlocked"
  | "register_success";

export interface AuthEvent {
  /** Stable id — useful for downstream dedupe / pagination cursors. */
  id: string;
  /** ISO timestamp. */
  ts: string;
  type: AuthEventType;
  /** Username the event is *about* (target of the action). May be null when
   *  the action targets no specific user (e.g. unknown reset request — we
   *  log just the lookup string). */
  target_username: string | null;
  /** Username that performed the action. null for anonymous (unauthenticated)
   *  endpoints. */
  actor_username: string | null;
  actor_role: string | null;
  /** T4.24 Phase 3 — tenant the event belongs to. Falls back to the
   *  affected user's tenant_id; or 'BANK_DEMO' if unknown. */
  tenant_id: string;
  /** T4.24 Phase 3 — calling channel (X-Channel header). Null for
   *  internal-system events. */
  channel: string | null;
  ip: string | null;
  /** Free-form metadata — kept under 1KB by convention. */
  metadata: Record<string, unknown>;
}

export interface AuthEventInput {
  type: AuthEventType;
  target_username?: string | null;
  actor_username?: string | null;
  actor_role?: string | null;
  /** T4.24 Phase 3 — defaults to 'BANK_DEMO' when caller doesn't pass one. */
  tenant_id?: string;
  channel?: string | null;
  ip?: string | null;
  metadata?: Record<string, unknown>;
}

export interface AuthLogQuery {
  type?: AuthEventType;
  target_username?: string;
  /** Cap on returned rows. Default 200, max 1000. */
  limit?: number;
}

/**
 * Bounded FIFO. When the cap is hit, oldest entries are evicted —
 * acceptable for a prototype since this is not the system of record.
 */
const DEFAULT_CAP = 1000;
const MAX_QUERY_LIMIT = 1000;
const DEFAULT_QUERY_LIMIT = 200;

export class AuthAuditLog {
  private buf: AuthEvent[] = [];
  private seq = 0;
  constructor(
    private readonly cap: number = DEFAULT_CAP,
    private readonly nowFn: () => number = Date.now,
  ) {}

  append(input: AuthEventInput): AuthEvent {
    const event: AuthEvent = {
      id: `ae-${(++this.seq).toString(36)}-${this.nowFn().toString(36)}`,
      ts: new Date(this.nowFn()).toISOString(),
      type: input.type,
      target_username: input.target_username ?? null,
      actor_username: input.actor_username ?? null,
      actor_role: input.actor_role ?? null,
      tenant_id: input.tenant_id ?? "BANK_DEMO",
      channel: input.channel ?? null,
      ip: input.ip ?? null,
      metadata: input.metadata ?? {},
    };
    this.buf.push(event);
    if (this.buf.length > this.cap) this.buf.splice(0, this.buf.length - this.cap);
    return event;
  }

  /**
   * Query with simple filters — newest-first. `limit` defaults to 200,
   * capped at 1000 so an admin polling the endpoint can't blow up the
   * response payload.
   */
  query(filter: AuthLogQuery = {}): AuthEvent[] {
    const limit = Math.min(MAX_QUERY_LIMIT, Math.max(1, filter.limit ?? DEFAULT_QUERY_LIMIT));
    const out: AuthEvent[] = [];
    // Walk newest-first, push until limit reached.
    for (let i = this.buf.length - 1; i >= 0 && out.length < limit; i--) {
      const e = this.buf[i]!;
      if (filter.type && e.type !== filter.type) continue;
      if (filter.target_username && e.target_username !== filter.target_username) continue;
      out.push(e);
    }
    return out;
  }

  /** Test helper — wipes the buffer. */
  clear(): void {
    this.buf = [];
    this.seq = 0;
  }

  /** Exposed for tests. */
  size(): number {
    return this.buf.length;
  }
}
