// services/bff/src/webhooks/pg_store.ts
//
// Postgres-backed implementation of the webhook subscription store —
// closes T4.13 / Open Gap A from docs/database-gap-analysis.md.
//
// Design: read-through cache, write-through pg.
//   * On init() — fetch ALL subscriptions + the last 50 deliveries per
//     subscription into in-memory state (mirrors the cap that the
//     in-memory store enforces).
//   * Read methods (list, get, internalGet, matching, deliveriesFor)
//     serve from cache — STAYS SYNC. Caller code (the dispatcher) does
//     not need to await a DB round-trip on every dispatched event.
//   * Write methods (create, delete, recordDelivery) update the cache
//     synchronously, then fire-and-forget the pg INSERT/DELETE/UPDATE.
//     If the pg write fails we log a warning; cache + DB diverge until
//     the next BFF restart, when init() rebuilds the cache from DB
//     (silently dropping the failed write). For a prototype this is
//     acceptable; production needs proper transactional semantics +
//     write-back retries with a dead-letter queue.
//
// The interface is kept identical to WebhookSubscriptionStore so the
// rest of the BFF (dispatcher, server routes) does not change. Both
// implementations satisfy the same shape via duck typing — a shared
// `IWebhookSubscriptionStore` interface is added to store.ts so future
// implementations have a contract to honour.

import { Pool } from 'pg';
import { randomBytes, randomUUID } from 'node:crypto';
import type {
  WebhookDelivery,
  WebhookEventType,
  WebhookSubscription,
  WebhookSubscriptionView,
} from './types';

const DELIVERY_HISTORY_PER_SUB = 50;

function publicView(s: WebhookSubscription): WebhookSubscriptionView {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { secret, ...rest } = s;
  return rest;
}

function rowToSubscription(row: Record<string, unknown>): WebhookSubscription {
  return {
    id: row.subscription_id as string,
    tenant_id: row.tenant_id as string,
    name: row.name as string,
    url: row.url as string,
    secret: row.secret as string,
    events: row.events as WebhookEventType[],
    active: row.active as boolean,
    created_at: (row.created_at as Date).toISOString(),
    last_delivery_at: row.last_delivery_at ? (row.last_delivery_at as Date).toISOString() : null,
    last_delivery_status: (row.last_delivery_status as 'success' | 'failed' | null) ?? null,
  };
}

function rowToDelivery(row: Record<string, unknown>): WebhookDelivery {
  return {
    id: row.delivery_id as string,
    subscription_id: row.subscription_id as string,
    tenant_id: row.tenant_id as string,
    event_type: row.event_type as WebhookEventType,
    payload: row.payload,
    attempts: row.attempts as number,
    status: row.status as 'success' | 'failed',
    response_status: row.response_status as number,
    response_body: (row.response_body as string | null) ?? undefined,
    created_at: (row.created_at as Date).toISOString(),
    completed_at: (row.completed_at as Date).toISOString(),
  };
}

export class PgWebhookSubscriptionStore {
  private readonly subs = new Map<string, WebhookSubscription>();
  private readonly deliveries = new Map<string, WebhookDelivery[]>();
  private initialised = false;

  /**
   * @param pool   shared pg.Pool — caller manages lifecycle (creation + close)
   * @param logger optional injection for warnings (defaults to console.warn);
   *               tests inject a no-op or a spy.
   */
  constructor(
    private readonly pool: Pool,
    private readonly logger: (msg: string, err?: unknown) => void = (m, e) =>
      console.warn(`[webhook-pg-store] ${m}`, e ?? ''),
  ) {}

  /**
   * Load all subscriptions + recent deliveries into the cache. Must be
   * called before the store is used. Idempotent — re-calling rebuilds
   * the cache from scratch (useful for tests).
   */
  async init(): Promise<void> {
    this.subs.clear();
    this.deliveries.clear();

    const subRows = await this.pool.query(
      `SELECT subscription_id, tenant_id, name, url, secret, events, active, created_at,
              last_delivery_at, last_delivery_status
         FROM app_bff.webhook_subscriptions`,
    );
    for (const row of subRows.rows) {
      const sub = rowToSubscription(row);
      this.subs.set(sub.id, sub);
    }

    // Per-sub last N deliveries via window function. ROW_NUMBER over
    // (PARTITION BY subscription_id ORDER BY completed_at DESC) gets us
    // the cap-50 slice in one query.
    const delRows = await this.pool.query(
      `SELECT delivery_id, subscription_id, tenant_id, event_type, payload, attempts,
              status, response_status, response_body, created_at, completed_at
         FROM (
           SELECT *,
                  ROW_NUMBER() OVER (
                    PARTITION BY subscription_id ORDER BY completed_at DESC
                  ) AS rn
             FROM app_bff.webhook_deliveries
         ) t
        WHERE rn <= $1
        ORDER BY subscription_id, completed_at ASC`,
      [DELIVERY_HISTORY_PER_SUB],
    );
    for (const row of delRows.rows) {
      const d = rowToDelivery(row);
      const arr = this.deliveries.get(d.subscription_id) ?? [];
      arr.push(d);
      this.deliveries.set(d.subscription_id, arr);
    }

    this.initialised = true;
  }

  private assertInit(): void {
    if (!this.initialised) {
      throw new Error('PgWebhookSubscriptionStore: call init() before use');
    }
  }

  // ─── Reads (sync, from cache) — tenant-scoped per T4.24 Phase 4 ──

  list(tenant_id: string): WebhookSubscriptionView[] {
    this.assertInit();
    return Array.from(this.subs.values())
      .filter((s) => s.tenant_id === tenant_id)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .map(publicView);
  }

  /**
   * Internal — used by the dispatcher to fetch the secret for signing.
   * NOT tenant-scoped: dispatcher already filtered via matching().
   */
  internalGet(id: string): WebhookSubscription | undefined {
    this.assertInit();
    return this.subs.get(id);
  }

  get(id: string, tenant_id: string): WebhookSubscriptionView | undefined {
    this.assertInit();
    const s = this.subs.get(id);
    if (!s || s.tenant_id !== tenant_id) return undefined;
    return publicView(s);
  }

  matching(event_type: WebhookEventType, tenant_id: string): WebhookSubscription[] {
    this.assertInit();
    const out: WebhookSubscription[] = [];
    for (const s of this.subs.values()) {
      if (s.active && s.tenant_id === tenant_id && s.events.includes(event_type)) {
        out.push(s);
      }
    }
    return out;
  }

  deliveriesFor(id: string, tenant_id: string): WebhookDelivery[] {
    this.assertInit();
    const sub = this.subs.get(id);
    if (!sub || sub.tenant_id !== tenant_id) return [];
    return [...(this.deliveries.get(id) ?? [])].reverse();
  }

  // ─── Writes (sync cache update + fire-and-forget pg) ─────────────

  create(input: {
    tenant_id: string;
    name: string;
    url: string;
    events: WebhookEventType[];
  }): WebhookSubscription {
    this.assertInit();
    const sub: WebhookSubscription = {
      id: `wh-${randomUUID().slice(0, 8)}`,
      tenant_id: input.tenant_id,
      name: input.name.trim(),
      url: input.url.trim(),
      secret: randomBytes(32).toString('hex'),
      events: [...input.events],
      active: true,
      created_at: new Date().toISOString(),
      last_delivery_at: null,
      last_delivery_status: null,
    };
    // Cache update first (sync) so reads see the new sub immediately.
    this.subs.set(sub.id, sub);
    // Persist to pg (fire-and-forget).
    void this.pool
      .query(
        `INSERT INTO app_bff.webhook_subscriptions
           (subscription_id, tenant_id, name, url, secret, events, active, created_at,
            last_delivery_at, last_delivery_status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NULL, NULL)`,
        [sub.id, sub.tenant_id, sub.name, sub.url, sub.secret, sub.events, sub.active, sub.created_at],
      )
      .catch((err) => this.logger(`failed to persist subscription ${sub.id}`, err));
    return sub;
  }

  delete(id: string, tenant_id: string): boolean {
    this.assertInit();
    const existing = this.subs.get(id);
    if (!existing || existing.tenant_id !== tenant_id) return false;
    this.subs.delete(id);
    this.deliveries.delete(id);
    void this.pool
      .query(`DELETE FROM app_bff.webhook_subscriptions WHERE subscription_id = $1`, [id])
      .catch((err) => this.logger(`failed to delete subscription ${id}`, err));
    return true;
  }

  /** Re-insert a previously-archived subscription with its original ID.
   *  Called by the recovery adapter. Returns false on cache conflict.
   *  PG INSERT uses ON CONFLICT DO NOTHING for defence-in-depth. */
  restore(sub: WebhookSubscription): boolean {
    this.assertInit();
    if (this.subs.has(sub.id)) return false;
    this.subs.set(sub.id, { ...sub });
    void this.pool
      .query(
        `INSERT INTO app_bff.webhook_subscriptions
           (subscription_id, tenant_id, name, url, secret, events, active,
            created_at, last_delivery_at, last_delivery_status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (subscription_id) DO NOTHING`,
        [
          sub.id,
          sub.tenant_id,
          sub.name,
          sub.url,
          sub.secret,
          sub.events,
          sub.active,
          sub.created_at,
          sub.last_delivery_at,
          sub.last_delivery_status,
        ],
      )
      .catch((err) => this.logger(`failed to restore subscription ${sub.id}`, err));
    return true;
  }

  recordDelivery(d: WebhookDelivery): void {
    this.assertInit();
    // Update cache (with cap)
    const arr = this.deliveries.get(d.subscription_id) ?? [];
    arr.push(d);
    if (arr.length > DELIVERY_HISTORY_PER_SUB) {
      arr.splice(0, arr.length - DELIVERY_HISTORY_PER_SUB);
    }
    this.deliveries.set(d.subscription_id, arr);
    const sub = this.subs.get(d.subscription_id);
    if (sub) {
      sub.last_delivery_at = d.completed_at;
      sub.last_delivery_status = d.status;
    }
    // Persist delivery + bump subscription's last_delivery_* (fire-and-forget).
    void this.pool
      .query(
        `INSERT INTO app_bff.webhook_deliveries
           (delivery_id, subscription_id, tenant_id, event_type, payload, attempts,
            status, response_status, response_body, created_at, completed_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11)`,
        [
          d.id,
          d.subscription_id,
          d.tenant_id,
          d.event_type,
          JSON.stringify(d.payload),
          d.attempts,
          d.status,
          d.response_status,
          d.response_body ?? null,
          d.created_at,
          d.completed_at,
        ],
      )
      .catch((err) => this.logger(`failed to persist delivery ${d.id}`, err));
    if (sub) {
      void this.pool
        .query(
          `UPDATE app_bff.webhook_subscriptions
              SET last_delivery_at = $2, last_delivery_status = $3
            WHERE subscription_id = $1`,
          [sub.id, sub.last_delivery_at, sub.last_delivery_status],
        )
        .catch((err) => this.logger(`failed to bump last_delivery for ${sub.id}`, err));
    }
  }

  /**
   * Test-only — clears the cache AND truncates the pg tables. Production
   * never calls this; tests call it before each scenario.
   */
  async reset(): Promise<void> {
    this.subs.clear();
    this.deliveries.clear();
    await this.pool.query(
      `TRUNCATE app_bff.webhook_deliveries, app_bff.webhook_subscriptions CASCADE`,
    );
    this.initialised = true;
  }
}
