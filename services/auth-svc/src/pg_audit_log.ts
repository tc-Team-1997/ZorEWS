// services/auth-svc/src/pg_audit_log.ts
//
// Postgres-backed mirror of AuthAuditLog (audit_log.ts). Same public
// surface — append() + query() — so the routes don't care.
//
// Same caching strategy as the other pg stores: load the most recent
// 1000 rows on init, append in-memory + fire-and-forget INSERT. query()
// reads only the cache (no N round-trips on `/auth/audit-log`).

import type { Pool } from "pg";
import type {
  AuthEvent,
  AuthEventInput,
  AuthLogQuery,
  AuthEventType,
} from "./audit_log.js";
import { AuditEventLogClient, authEventToChain } from "./audit_event_log.js";

const DEFAULT_CAP = 1000;
const MAX_QUERY_LIMIT = 1000;
const DEFAULT_QUERY_LIMIT = 200;

export class PgAuthAuditLog {
  private buf: AuthEvent[] = [];
  private seq = 0;
  /** Optional fan-out client to the hash-chained audit.event_log. When
   *  set, every append() also fires a serialised INSERT into the chain.
   *  Closes Gap 2 from docs/database-gap-analysis.md. */
  private chainClient: AuditEventLogClient | null = null;

  constructor(
    private readonly pool: Pool,
    private readonly cap: number = DEFAULT_CAP,
    private readonly nowFn: () => number = Date.now,
    private readonly logger: (msg: string, err?: unknown) => void = (m, e) =>
      console.warn(`[pg-audit-log] ${m}`, e ?? ""),
  ) {
    // Default ON when the pg backend is in use — fan-out is the whole point
    // of T4.16. Can be disabled via setChainClient(null) for tests that
    // don't want to touch audit.event_log.
    this.chainClient = new AuditEventLogClient(pool, logger);
  }

  /** Replace (or disable, with `null`) the chain fan-out client. Used by
   *  tests that want to assert on chain behaviour with a different logger
   *  or a controlled clock. */
  setChainClient(client: AuditEventLogClient | null): void {
    this.chainClient = client;
  }

  async init(): Promise<void> {
    const rows = await this.pool.query<{
      id: string;
      event_type: string;
      actor_username: string | null;
      target_username: string | null;
      tenant_id: string;
      channel: string | null;
      ip: string | null;
      occurred_at: Date;
      detail: Record<string, unknown> | null;
    }>(
      `SELECT id::text AS id, event_type, actor_username, target_username,
              tenant_id, channel,
              ip::text AS ip, occurred_at, detail
         FROM app_iam.audit_events
        ORDER BY occurred_at DESC
        LIMIT $1`,
      [this.cap],
    );
    // Reverse so the buffer ends up oldest-first (matches the in-memory
    // store's invariant — query() iterates back-to-front).
    this.buf = rows.rows.reverse().map((r) => ({
      id: `ae-${r.id}`,
      ts: r.occurred_at.toISOString(),
      type: r.event_type as AuthEventType,
      target_username: r.target_username,
      actor_username: r.actor_username,
      actor_role: null,
      tenant_id: r.tenant_id,
      channel: r.channel,
      ip: r.ip,
      metadata: r.detail ?? {},
    }));
  }

  append(input: AuthEventInput): AuthEvent {
    const ts = new Date(this.nowFn());
    const event: AuthEvent = {
      id: `ae-${(++this.seq).toString(36)}-${ts.getTime().toString(36)}`,
      ts: ts.toISOString(),
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
    if (this.buf.length > this.cap)
      this.buf.splice(0, this.buf.length - this.cap);
    void this.pool
      .query(
        `INSERT INTO app_iam.audit_events (
            event_type, actor_username, target_username, ip, occurred_at, detail,
            tenant_id, channel
         ) VALUES ($1,$2,$3,$4::inet,$5,$6,$7,$8)`,
        [
          event.type,
          event.actor_username,
          event.target_username,
          ipForPg(event.ip),
          ts,
          JSON.stringify(event.metadata),
          event.tenant_id,
          event.channel,
        ],
      )
      .catch((err) => this.logger(`failed to persist audit event ${event.id}`, err));

    // Fan out to audit.event_log (the hash-chained regulatory trail).
    // Fire-and-forget — the client serialises INSERTs internally so we
    // don't need to await here.
    if (this.chainClient) {
      void this.chainClient.append(authEventToChain(event));
    }
    return event;
  }

  /** Test helper — wait for any pending audit.event_log fan-outs to drain. */
  async flushChain(): Promise<void> {
    if (this.chainClient) await this.chainClient.flush();
  }

  query(filter: AuthLogQuery = {}): AuthEvent[] {
    const limit = Math.min(
      MAX_QUERY_LIMIT,
      Math.max(1, filter.limit ?? DEFAULT_QUERY_LIMIT),
    );
    const out: AuthEvent[] = [];
    for (let i = this.buf.length - 1; i >= 0 && out.length < limit; i--) {
      const e = this.buf[i]!;
      if (filter.type && e.type !== filter.type) continue;
      if (filter.target_username && e.target_username !== filter.target_username)
        continue;
      out.push(e);
    }
    return out;
  }

  /** Test helper. */
  clear(): void {
    this.buf = [];
    this.seq = 0;
  }

  size(): number {
    return this.buf.length;
  }

  /** Truncate the table — used by integration tests only. */
  async reset(): Promise<void> {
    await this.pool.query(`TRUNCATE app_iam.audit_events RESTART IDENTITY`);
    this.buf = [];
    this.seq = 0;
  }
}

function ipForPg(ip: string | null): string | null {
  if (!ip || ip === "unknown") return null;
  if (!/[0-9]/.test(ip) || !(/\./.test(ip) || /:/.test(ip))) return null;
  return ip;
}
