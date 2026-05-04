// services/regulatory-svc/alerts/src/queue.ts
//
// Smart-prioritisation queue for alerts (T2.7).
//
// 3 buckets — Critical / Medium / Low. Within each bucket, FIFO. When a
// queue listener pulls an alert without specifying an analyst, the queue
// round-robins across the registered analyst pool.
//
// Persistence: NDJSON tail at .queue/queue.ndjson. The queue file is the
// system of record for the prototype; in production this would be an Aurora
// table with a `queue_state` enum + index on (severity, raised_at).

import * as fs from 'node:fs';
import * as path from 'node:path';
import { Pool } from 'pg';
import { bucketFor, fromWireSeverity } from './severity';
import type { Bucket, CanonicalAlert } from './types';
import { PgSmartQueue } from './pg_queue';

export type QueueState = 'queued' | 'assigned' | 'acked' | 'closed';

export interface QueueEntry {
  alert: CanonicalAlert;
  /** T4.24 Phase 6 — tenant the alert belongs to. Set by enqueue();
   *  list / get / pullNext / assign / ack / close all filter on it.
   *  Defaults to 'BANK_DEMO' for pre-Phase-6 rows. */
  tenant_id: string;
  bucket: Bucket;
  state: QueueState;
  assignee?: string;
  acked_at?: string;
  closed_at?: string;
  outcome?: string;
  note?: string;
  enqueued_at: string;
}

export interface CloseInput {
  outcome: string;
  note?: string;
}

export interface QueueListOptions {
  /** T4.24 Phase 6 — tenant filter. Defaults to 'BANK_DEMO' when omitted
   *  for backward compat. The route handler reads it from X-Tenant-ID. */
  tenant_id?: string;
  bucket?: Bucket;
  assignee?: string;
  state?: QueueState;
  page?: number;
  pageSize?: number;
}

export class SmartQueue {
  private entries = new Map<string, QueueEntry>();
  /** Insertion-order index per bucket — FIFO within each bucket. */
  private bucketOrder: Record<Bucket, string[]> = {
    critical: [],
    medium: [],
    low: [],
  };
  /** Round-robin cursor over the analyst pool. */
  private rrCursor = 0;
  private analysts: string[] = [];

  constructor(
    private readonly persistPath?: string,
    analysts: string[] = [],
  ) {
    this.analysts = [...analysts];
    if (persistPath) this.loadFromDisk();
  }

  setAnalysts(users: string[]): void {
    this.analysts = [...users];
    this.rrCursor = 0;
  }

  /** Enqueue an alert. Idempotent on alert_id (re-deliveries are no-ops). */
  enqueue(alert: CanonicalAlert, tenant_id: string = 'BANK_DEMO'): QueueEntry {
    const existing = this.entries.get(alert.alert_id);
    if (existing) return existing;
    const bucket = bucketFor(fromWireSeverity(alert.severity));
    const entry: QueueEntry = {
      alert,
      tenant_id,
      bucket,
      state: 'queued',
      enqueued_at: alert.raised_at,
    };
    this.entries.set(alert.alert_id, entry);
    this.bucketOrder[bucket].push(alert.alert_id);
    this.persist(entry);
    return entry;
  }

  list(opts: QueueListOptions = {}): { items: QueueEntry[]; total: number; page: number; pageSize: number } {
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
    const t = e?.tenant_id ?? 'BANK_DEMO';
    return e && t === tenant_id ? e : undefined;
  }

  /**
   * Pull next from the queue (highest-priority bucket first), scoped to
   * the given tenant. Round-robin assigns to an analyst from the
   * configured pool unless `forUser` is provided.
   */
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
    this.persist(e);
    return e;
  }

  ack(alertId: string, tenant_id: string = 'BANK_DEMO'): QueueEntry {
    const e = this.requireEntry(alertId, tenant_id);
    if (e.state === 'closed') throw httpError(409, `alert ${alertId} already closed`);
    e.state = 'acked';
    e.acked_at = new Date().toISOString();
    this.persist(e);
    return e;
  }

  close(alertId: string, input: CloseInput, tenant_id: string = 'BANK_DEMO'): QueueEntry {
    if (!input.outcome) throw httpError(400, 'outcome is required to close an alert');
    const e = this.requireEntry(alertId, tenant_id);
    e.state = 'closed';
    e.outcome = input.outcome;
    e.note = input.note;
    e.closed_at = new Date().toISOString();
    this.persist(e);
    return e;
  }

  /** Total snapshot in priority+FIFO order. */
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

  private nextAnalyst(): string | undefined {
    if (this.analysts.length === 0) return undefined;
    const u = this.analysts[this.rrCursor % this.analysts.length];
    this.rrCursor = (this.rrCursor + 1) % this.analysts.length;
    return u;
  }

  private requireEntry(id: string, tenant_id: string = 'BANK_DEMO'): QueueEntry {
    const e = this.entries.get(id);
    // Cross-tenant lookups return 404 (no enumeration leak), same shape
    // as a missing id.
    if (!e || (e.tenant_id ?? 'BANK_DEMO') !== tenant_id) {
      throw httpError(404, `alert ${id} not found`);
    }
    return e;
  }

  private persist(entry: QueueEntry): void {
    if (!this.persistPath) return;
    fs.mkdirSync(path.dirname(this.persistPath), { recursive: true });
    fs.appendFileSync(this.persistPath, JSON.stringify(entry) + '\n', { encoding: 'utf8' });
  }

  private loadFromDisk(): void {
    if (!this.persistPath || !fs.existsSync(this.persistPath)) return;
    const txt = fs.readFileSync(this.persistPath, 'utf8');
    for (const line of txt.split('\n')) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as QueueEntry;
        const id = entry.alert.alert_id;
        const wasNew = !this.entries.has(id);
        this.entries.set(id, entry);
        if (wasNew) this.bucketOrder[entry.bucket].push(id);
      } catch {
        // skip malformed line
      }
    }
  }
}

function httpError(status: number, message: string): Error & { status: number } {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}

/** Either backend exposes the same shape — server.ts and the evaluator
 *  duck-type against this. */
export type IQueue = SmartQueue | PgSmartQueue;

/**
 * Build the queue based on env. ALERTS_PG_URL set → pg; unset → NDJSON
 * (the existing default — keeps `npm test` and the dev wizard hermetic).
 */
export async function makeQueue(
  env: NodeJS.ProcessEnv = process.env,
  fallbackPath?: string,
  analysts: string[] = [],
): Promise<{ queue: IQueue; pool: Pool | null }> {
  const url = env.ALERTS_PG_URL;
  if (!url) {
    const p =
      fallbackPath ??
      env.APEX_QUEUE_PATH ??
      path.resolve(__dirname, '..', '.queue', 'queue.ndjson');
    return { queue: new SmartQueue(p, analysts), pool: null };
  }
  const pool = new Pool({ connectionString: url, max: 4 });
  const queue = new PgSmartQueue(pool, analysts);
  await queue.init();
  return { queue, pool };
}

export { PgSmartQueue };
