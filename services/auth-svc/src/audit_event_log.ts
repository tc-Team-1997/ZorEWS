// services/auth-svc/src/audit_event_log.ts
//
// Thin client for `audit.event_log` — the hash-chained regulatory trail.
// Closes Gap 2 (docs/database-gap-analysis.md) by fanning auth events out
// to the regulatory chain in addition to `app_iam.audit_events`.
//
// Why a separate client (vs. inlining the INSERT in PgAuthAuditLog):
//   1. The hash-chain trigger means every INSERT depends on the previous
//      row's event_hash. Two concurrent INSERTs both read the same
//      `last_hash` and the second one will fail with "chain broken". We
//      serialise INSERTs through a per-process promise queue so this
//      can't happen.
//   2. The same client will be reused by cases + alerts when T4.17 wires
//      them in. Keeping it isolated here means it can graduate to
//      `@apex-ews/audit` once the second consumer lands.
//
// Trigger contract (data/schema/003_audit_table.sql):
//   - prev_hash + event_hash can be NULL — the BEFORE INSERT trigger
//     populates them based on the previous row's event_hash. We always
//     pass NULL.
//   - event_type, actor, payload are NOT NULL.
//   - source_ip is INET; "unknown" / non-IP strings have to be NULL.
//
// Mapping from auth events → audit chain (auth_event_log_mapping.ts
// pattern, kept inline here for now):
//   event_type       → uppercase (LOGIN_SUCCESS, LOGIN_FAILURE, …)
//   actor            → actor_username || target_username || 'anonymous'
//                      (the chain requires NOT NULL — anonymous endpoints
//                      get the literal string "anonymous")
//   subject_id       → target_username
//   source_ip        → ip (with the INET coercion from the other pg stores)
//   payload          → in-memory metadata + the cross-reference id

import type { Pool } from 'pg';

export interface AuditChainEvent {
  event_type: string;
  actor: string | null;
  subject_id: string | null;
  source_ip: string | null;
  correlation_id?: string | null;
  /** T4.24 Phase 3 — tenant the event belongs to. Defaults to BANK_DEMO
   *  on insert when caller doesn't pass one (preserves backward compat
   *  with pre-Phase-3 callers). */
  tenant_id?: string | null;
  /** T4.24 Phase 3 — calling channel (X-Channel header) when the event
   *  came from an HTTP request. NULL for system-internal events. */
  channel?: string | null;
  payload: Record<string, unknown>;
}

export class AuditEventLogClient {
  /** Promise queue tail. Each append() chains onto the previous one so
   *  INSERTs serialise — the hash-chain trigger requires it. */
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly pool: Pool,
    private readonly logger: (msg: string, err?: unknown) => void = (m, e) =>
      console.warn(`[audit-event-log] ${m}`, e ?? ''),
  ) {}

  /**
   * Append an event to the hash-chained log. Returns a Promise that
   * resolves when this row has either landed or failed; callers can fire
   * and forget if they prefer.
   */
  append(event: AuditChainEvent): Promise<void> {
    const next = this.chain.then(async () => {
      try {
        await this.pool.query(
          `INSERT INTO audit.event_log (
              event_type, actor, subject_id, correlation_id,
              source_ip, payload, tenant_id, channel, prev_hash, event_hash
           ) VALUES ($1, $2, $3, $4, $5::inet, $6::jsonb, $7, $8, NULL, NULL)`,
          [
            event.event_type,
            event.actor ?? 'anonymous',
            event.subject_id,
            event.correlation_id ?? null,
            ipForChain(event.source_ip),
            JSON.stringify(event.payload),
            event.tenant_id ?? 'BANK_DEMO',
            event.channel ?? null,
          ],
        );
      } catch (err) {
        this.logger(`failed to append event_type=${event.event_type}`, err);
        // Don't rethrow — keep the chain queue alive so subsequent appends
        // don't all fail because of one transient pg error. The chain
        // trigger is the source of truth; a missed row degrades durability
        // but doesn't break correctness for the rows that did land.
      }
    });
    // Keep the queue tail intact even if `next` rejects (we already swallow
    // the error above, so `.catch` here is belt-and-braces).
    this.chain = next.catch(() => undefined);
    return next;
  }

  /** Test helper — wait for any pending appends to drain. */
  async flush(): Promise<void> {
    await this.chain;
  }
}

function ipForChain(ip: string | null | undefined): string | null {
  if (!ip || ip === 'unknown') return null;
  if (!/[0-9]/.test(ip) || !(/\./.test(ip) || /:/.test(ip))) return null;
  return ip;
}

/**
 * Mapping helper: convert an auth-svc AuthEvent into the chain's
 * AuditChainEvent shape. Kept here so any future audit-fan-out site
 * (cases, alerts) can either reuse or override.
 */
export function authEventToChain(input: {
  /** The in-memory event id — useful as a cross-reference between
   *  app_iam.audit_events and audit.event_log. */
  id: string;
  ts: string;
  type: string;
  target_username: string | null;
  actor_username: string | null;
  actor_role: string | null;
  /** T4.24 Phase 3 — passed through to the chain row. */
  tenant_id?: string | null;
  channel?: string | null;
  ip: string | null;
  metadata: Record<string, unknown>;
}): AuditChainEvent {
  return {
    event_type: input.type.toUpperCase(),
    actor: input.actor_username ?? input.target_username ?? null,
    subject_id: input.target_username,
    source_ip: input.ip,
    tenant_id: input.tenant_id ?? null,
    channel: input.channel ?? null,
    payload: {
      ...input.metadata,
      _service: 'auth-svc',
      _local_event_id: input.id,
      _local_ts: input.ts,
      actor_role: input.actor_role,
    },
  };
}
