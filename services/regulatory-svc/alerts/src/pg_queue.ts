// services/regulatory-svc/alerts/src/pg_queue.ts
//
// Postgres-backed SmartQueue. Same public surface as the in-memory
// SmartQueue (queue.ts) so server.ts and the evaluator don't care which
// backend is in use.
//
// Same caching strategy as T4.13–T4.16:
//   - cache-on-init   — load every row from app_alerts.alerts +
//                       reconstruct bucket order from created_at
//   - sync reads      — list/get/snapshot/pullNext never await pg
//   - write-through   — mutations update the cache + fire pg INSERT/UPDATE
//                       in the background (.catch logs the failure)
//
// Schema vs. in-memory mismatch (worth knowing for callers):
//   - Schema status: 'open' | 'acked' | 'closed'.
//     In-memory state: 'queued' | 'assigned' | 'acked' | 'closed'.
//     Both queued and assigned map to status='open'; the assignee column
//     distinguishes them ('assigned' = open with an assignee set).
//   - Schema requires customer_name, rule_name, confidence, exposure,
//     criticality_score (all NOT NULL). The in-memory CanonicalAlert
//     doesn't carry those — we default to '' / 0.000 / 0 / 0.
//     Production would resolve customer_name via mart.customer_360 and
//     rule_name via the rules service before persisting.
//   - Indicators land in the TEXT[] indicators column directly.
//   - app_alerts.queue_assignments is append-only — every assign() (and
//     the initial enqueue) writes a new row.

import type { Pool } from 'pg';
import { bucketFor, fromWireSeverity } from './severity';
import type { Bucket, CanonicalAlert, WireSeverity } from './types';
import type {
  CloseInput,
  QueueEntry,
  QueueListOptions,
  QueueState,
} from './queue';

export class PgSmartQueue {
  private entries = new Map<string, QueueEntry>();
  private bucketOrder: Record<Bucket, string[]> = {
    critical: [],
    medium: [],
    low: [],
  };
  private rrCursor = 0;
  private analysts: string[] = [];

  constructor(
    private readonly pool: Pool,
    analysts: string[] = [],
    private readonly logger: (msg: string, err?: unknown) => void = (m, e) =>
      console.warn(`[pg-smart-queue] ${m}`, e ?? ''),
  ) {
    this.analysts = [...analysts];
  }

  setAnalysts(users: string[]): void {
    this.analysts = [...users];
    this.rrCursor = 0;
  }

  async init(): Promise<void> {
    const rows = await this.pool.query<{
      alert_id: string;
      tenant_id: string;
      severity: string;
      customer_id: string;
      customer_name: string;
      rule_id: string;
      rule_name: string;
      indicators: string[];
      confidence: string; // NUMERIC arrives as string from pg
      customer_exposure_kes: string;
      criticality_score: string;
      assignee: string | null;
      status: 'open' | 'acked' | 'closed';
      created_at: Date;
      acked_at: Date | null;
      closed_at: Date | null;
    }>(
      `SELECT alert_id, tenant_id, severity, customer_id, customer_name, rule_id, rule_name,
              indicators, confidence::text AS confidence,
              customer_exposure_kes::text AS customer_exposure_kes,
              criticality_score::text AS criticality_score,
              assignee, status, created_at, acked_at, closed_at
         FROM app_alerts.alerts
        ORDER BY created_at ASC`,
    );

    this.entries.clear();
    this.bucketOrder = { critical: [], medium: [], low: [] };
    for (const r of rows.rows) {
      const wireSeverity = r.severity.toUpperCase() as WireSeverity;
      const sev = r.severity as
        | 'low'
        | 'medium'
        | 'high'
        | 'critical';
      const bucket = bucketFor(sev);
      // Reconstruct a minimal CanonicalAlert from what the schema preserves.
      // Fields the schema doesn't carry (rule_firings, scoring details, ts,
      // top_reasons, trace_id) get filled with safe defaults — enough for
      // queue state + UI listing, not enough for re-emitting the original
      // canonical event verbatim. That's an acceptable tradeoff: the
      // queue's job is workflow state, not event sourcing.
      const alert: CanonicalAlert = {
        alert_id: r.alert_id,
        raised_at: r.created_at.toISOString(),
        ts: r.created_at.toISOString(),
        customer_id: r.customer_id,
        loan_id: null,
        severity: wireSeverity,
        rule_id: r.rule_id,
        indicators_fired: r.indicators ?? [],
        pd: null,
        risk_level: null,
        top_reasons: [],
        reason_summary: '',
        rule_firings: [],
        scoring: { pd: null, risk_band: null, shap_top: [] },
      };
      // Reconstruct state from (status, assignee). Assigned-but-open is
      // status='open' AND assignee IS NOT NULL.
      const state: QueueState =
        r.status === 'acked'
          ? 'acked'
          : r.status === 'closed'
            ? 'closed'
            : r.assignee
              ? 'assigned'
              : 'queued';
      const entry: QueueEntry = {
        alert,
        tenant_id: r.tenant_id,
        bucket,
        state,
        assignee: r.assignee ?? undefined,
        acked_at: r.acked_at?.toISOString(),
        closed_at: r.closed_at?.toISOString(),
        outcome: undefined, // not persisted in the schema
        note: undefined, //  not persisted in the schema
        enqueued_at: r.created_at.toISOString(),
      };
      this.entries.set(r.alert_id, entry);
      this.bucketOrder[bucket].push(r.alert_id);
    }
  }

  enqueue(alert: CanonicalAlert, tenant_id: string = 'BANK_DEMO'): QueueEntry {
    const existing = this.entries.get(alert.alert_id);
    if (existing) return existing;
    const sev = fromWireSeverity(alert.severity);
    const bucket = bucketFor(sev);
    const entry: QueueEntry = {
      alert,
      tenant_id,
      bucket,
      state: 'queued',
      enqueued_at: alert.raised_at,
    };
    this.entries.set(alert.alert_id, entry);
    this.bucketOrder[bucket].push(alert.alert_id);

    void this.pool
      .query(
        `INSERT INTO app_alerts.alerts (
            alert_id, tenant_id, severity, customer_id, customer_name, rule_id, rule_name,
            indicators, confidence, customer_exposure_kes, criticality_score,
            assignee, status, created_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         ON CONFLICT (alert_id) DO NOTHING`,
        [
          alert.alert_id,
          tenant_id,
          sev,
          alert.customer_id,
          // customer_name + rule_name are NOT NULL in the schema but the
          // in-memory CanonicalAlert doesn't carry them. Empty string is
          // the cheapest honest answer; production would resolve via
          // mart.customer_360 + the rules service.
          '',
          alert.rule_id,
          '',
          alert.indicators_fired ?? [],
          // Confidence + exposure + criticality_score aren't on the
          // canonical alert wire shape; they're added by the BFF before
          // the alert hits the SPA. Use 0 / 0.000 here — production can
          // backfill via a follow-up UPDATE once the BFF computes them.
          0,
          0,
          0,
          null, // assignee — set on first assign()
          'open',
          new Date(alert.raised_at),
        ],
      )
      .catch((err) =>
        this.logger(`failed to insert alert ${alert.alert_id}`, err),
      );
    // Initial assignment row ("system" enqueue) so the assignment log is
    // a complete audit trail of the alert's life in the queue.
    void this.pool
      .query(
        `INSERT INTO app_alerts.queue_assignments (
            alert_id, queue, assigned_to, assigned_by
         ) VALUES ($1, $2, NULL, 'system')`,
        [alert.alert_id, bucket],
      )
      .catch((err) =>
        this.logger(`failed to insert initial queue assignment ${alert.alert_id}`, err),
      );
    return entry;
  }

  list(opts: QueueListOptions = {}): {
    items: QueueEntry[];
    total: number;
    page: number;
    pageSize: number;
  } {
    const tenant_id = opts.tenant_id ?? 'BANK_DEMO';
    const all = this.snapshot();
    const filtered = all.filter((e) => {
      if ((e.tenant_id ?? 'BANK_DEMO') !== tenant_id) return false;
      if (opts.bucket && e.bucket !== opts.bucket) return false;
      if (opts.assignee && e.assignee !== opts.assignee) return false;
      if (opts.state && e.state !== opts.state) return false;
      return true;
    });
    const pageSize = opts.pageSize ?? 50;
    const page = Math.max(1, opts.page ?? 1);
    const start = (page - 1) * pageSize;
    return {
      items: filtered.slice(start, start + pageSize),
      total: filtered.length,
      page,
      pageSize,
    };
  }

  get(alertId: string, tenant_id: string = 'BANK_DEMO'): QueueEntry | undefined {
    const e = this.entries.get(alertId);
    return e && (e.tenant_id ?? 'BANK_DEMO') === tenant_id ? e : undefined;
  }

  pullNext(tenant_id: string = 'BANK_DEMO', forUser?: string): QueueEntry | undefined {
    for (const b of ['critical', 'medium', 'low'] as Bucket[]) {
      for (const id of this.bucketOrder[b]) {
        const e = this.entries.get(id);
        if (e && e.state === 'queued' && (e.tenant_id ?? 'BANK_DEMO') === tenant_id) {
          const assignee = forUser ?? this.nextAnalyst();
          return assignee ? this.assign(id, assignee, tenant_id) : e;
        }
      }
    }
    return undefined;
  }

  assign(alertId: string, userId: string, tenant_id: string = 'BANK_DEMO'): QueueEntry {
    const e = this.requireEntry(alertId, tenant_id);
    if (e.state === 'closed') throw httpError(409, `alert ${alertId} already closed`);
    e.assignee = userId;
    e.state = 'assigned';
    void this.pool
      .query(
        `UPDATE app_alerts.alerts SET assignee = $2 WHERE alert_id = $1`,
        [alertId, userId],
      )
      .catch((err) => this.logger(`failed to update assignee ${alertId}`, err));
    void this.pool
      .query(
        `INSERT INTO app_alerts.queue_assignments (
            alert_id, queue, assigned_to, assigned_by
         ) VALUES ($1, $2, $3, 'system')`,
        [alertId, e.bucket, userId],
      )
      .catch((err) =>
        this.logger(`failed to insert queue assignment ${alertId}`, err),
      );
    return e;
  }

  ack(alertId: string, tenant_id: string = 'BANK_DEMO'): QueueEntry {
    const e = this.requireEntry(alertId, tenant_id);
    if (e.state === 'closed') throw httpError(409, `alert ${alertId} already closed`);
    e.state = 'acked';
    e.acked_at = new Date().toISOString();
    void this.pool
      .query(
        `UPDATE app_alerts.alerts SET status = 'acked', acked_at = $2 WHERE alert_id = $1`,
        [alertId, new Date(e.acked_at)],
      )
      .catch((err) => this.logger(`failed to ack alert ${alertId}`, err));
    return e;
  }

  close(alertId: string, input: CloseInput, tenant_id: string = 'BANK_DEMO'): QueueEntry {
    if (!input.outcome) throw httpError(400, 'outcome is required to close an alert');
    const e = this.requireEntry(alertId, tenant_id);
    e.state = 'closed';
    e.outcome = input.outcome;
    e.note = input.note;
    e.closed_at = new Date().toISOString();
    void this.pool
      .query(
        `UPDATE app_alerts.alerts SET status = 'closed', closed_at = $2 WHERE alert_id = $1`,
        [alertId, new Date(e.closed_at)],
      )
      .catch((err) => this.logger(`failed to close alert ${alertId}`, err));
    return e;
  }

  snapshot(): QueueEntry[] {
    const out: QueueEntry[] = [];
    for (const b of ['critical', 'medium', 'low'] as Bucket[]) {
      for (const id of this.bucketOrder[b]) {
        const e = this.entries.get(id);
        if (e) out.push(e);
      }
    }
    return out;
  }

  /** Truncate both tables — used by integration tests only. */
  async reset(): Promise<void> {
    await this.pool.query(
      `TRUNCATE app_alerts.queue_assignments, app_alerts.alerts RESTART IDENTITY CASCADE`,
    );
    this.entries.clear();
    this.bucketOrder = { critical: [], medium: [], low: [] };
  }

  private nextAnalyst(): string | undefined {
    if (this.analysts.length === 0) return undefined;
    const u = this.analysts[this.rrCursor % this.analysts.length];
    this.rrCursor = (this.rrCursor + 1) % this.analysts.length;
    return u;
  }

  private requireEntry(id: string, tenant_id: string = 'BANK_DEMO'): QueueEntry {
    const e = this.entries.get(id);
    if (!e || (e.tenant_id ?? 'BANK_DEMO') !== tenant_id) {
      throw httpError(404, `alert ${id} not found`);
    }
    return e;
  }
}

function httpError(status: number, message: string): Error & { status: number } {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}
