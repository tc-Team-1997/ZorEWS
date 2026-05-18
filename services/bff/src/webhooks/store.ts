// services/bff/src/webhooks/store.ts
//
// In-memory subscription store. Used as the fallback when BFF_PG_URL is
// not set (test runs, dev-without-DB). When BFF_PG_URL IS set, the
// makeWebhookStore() factory at the bottom returns a PgWebhookSubscriptionStore
// from pg_store.ts which persists subscriptions + deliveries to
// app_bff.{webhook_subscriptions, webhook_deliveries}.
//
// Both classes implement the same shape (duck-typed via the IWebhookStore
// type alias below), so the dispatcher + server routes don't care which
// one they got.

import { Pool } from 'pg';
import { randomBytes, randomUUID } from 'node:crypto';
import type {
  WebhookDelivery,
  WebhookEventType,
  WebhookSubscription,
  WebhookSubscriptionView,
} from './types';
import { PgWebhookSubscriptionStore } from './pg_store';

/**
 * Cap on retained deliveries per subscription. Keeps the dispatcher's
 * memory footprint bounded. Older deliveries scroll off the bottom —
 * adequate for prototype debugging; production would persist these to
 * Postgres + roll up older ones into daily counts.
 */
const DELIVERY_HISTORY_PER_SUB = 50;

function publicView(s: WebhookSubscription): WebhookSubscriptionView {
  // Deliberate property destructure to drop `secret` — TS would flag
  // adding new fields if we used a manual mapping that drifts.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { secret, ...rest } = s;
  return rest;
}

/**
 * T4.24 Phase 4 — every CRUD method is tenant-scoped. Cross-tenant
 * reads return undefined; cross-tenant writes create independent rows.
 * The dispatcher's `matching()` is also tenant-scoped — events from
 * tenant X only fire to subscriptions belonging to tenant X.
 *
 * Pre-Phase-4 callers that didn't pass tenant_id are not supported —
 * the field is required everywhere. Tests pass a literal tenant_id.
 */
export class WebhookSubscriptionStore {
  private readonly subs = new Map<string, WebhookSubscription>();
  private readonly deliveries = new Map<string, WebhookDelivery[]>();

  /**
   * Create a new subscription bound to a tenant. Returns the FULL record
   * (including the generated secret) — callers must persist or display
   * it once because the secret will not be retrievable later.
   */
  create(input: {
    tenant_id: string;
    name: string;
    url: string;
    events: WebhookEventType[];
  }): WebhookSubscription {
    const sub: WebhookSubscription = {
      id: `wh-${randomUUID().slice(0, 8)}`,
      tenant_id: input.tenant_id,
      name: input.name.trim(),
      url: input.url.trim(),
      // 32 bytes = 256 bits, hex-encoded → 64 chars. Strong enough for HMAC.
      secret: randomBytes(32).toString('hex'),
      events: [...input.events],
      active: true,
      created_at: new Date().toISOString(),
      last_delivery_at: null,
      last_delivery_status: null,
    };
    this.subs.set(sub.id, sub);
    return sub;
  }

  /** All subscriptions for the given tenant, newest-first, secret stripped. */
  list(tenant_id: string): WebhookSubscriptionView[] {
    return Array.from(this.subs.values())
      .filter((s) => s.tenant_id === tenant_id)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .map(publicView);
  }

  /**
   * Internal — used by the dispatcher to fetch the secret for signing.
   * NOT tenant-scoped: the dispatcher already knows the subscription
   * matched a tenant-scoped `matching()` call. Callers outside the
   * dispatcher should NOT use this — use `get(id, tenant_id)` instead.
   */
  internalGet(id: string): WebhookSubscription | undefined {
    return this.subs.get(id);
  }

  /**
   * Tenant-scoped get. Returns undefined when the row doesn't exist OR
   * exists but belongs to a different tenant — same shape so admins of
   * tenant A can't enumerate tenant B's IDs by status code.
   */
  get(id: string, tenant_id: string): WebhookSubscriptionView | undefined {
    const s = this.subs.get(id);
    if (!s || s.tenant_id !== tenant_id) return undefined;
    return publicView(s);
  }

  /** Tenant-scoped delete. Returns false when the row exists in another tenant. */
  delete(id: string, tenant_id: string): boolean {
    const s = this.subs.get(id);
    if (!s || s.tenant_id !== tenant_id) return false;
    this.deliveries.delete(id);
    return this.subs.delete(id);
  }

  /** Re-insert a previously-archived subscription with its original
   *  ID. Used by the recovery adapter to restore from soft-delete.
   *  Returns false when the ID is already taken (the recovery route
   *  surfaces this as a 409 RestoreConflictError). */
  restore(sub: WebhookSubscription): boolean {
    if (this.subs.has(sub.id)) return false;
    this.subs.set(sub.id, { ...sub });
    return true;
  }

  /**
   * All active subscriptions in the given tenant that listen for the
   * given event_type. Tenant-scoped — events fired in tenant A never
   * reach tenant B's subscribers, even if they happen to share an
   * event_type.
   */
  matching(event_type: WebhookEventType, tenant_id: string): WebhookSubscription[] {
    const out: WebhookSubscription[] = [];
    for (const s of this.subs.values()) {
      if (s.active && s.tenant_id === tenant_id && s.events.includes(event_type)) {
        out.push(s);
      }
    }
    return out;
  }

  /** Append a delivery row + bump the subscription's last-delivery fields. */
  recordDelivery(d: WebhookDelivery): void {
    const arr = this.deliveries.get(d.subscription_id) ?? [];
    arr.push(d);
    if (arr.length > DELIVERY_HISTORY_PER_SUB) arr.splice(0, arr.length - DELIVERY_HISTORY_PER_SUB);
    this.deliveries.set(d.subscription_id, arr);
    const sub = this.subs.get(d.subscription_id);
    if (sub) {
      sub.last_delivery_at = d.completed_at;
      sub.last_delivery_status = d.status;
    }
  }

  /**
   * Newest-first delivery history for a subscription. Tenant-scoped —
   * returns an empty array if the subscription belongs to a different
   * tenant (rather than throwing) so the route can return a 404 envelope.
   */
  deliveriesFor(id: string, tenant_id: string): WebhookDelivery[] {
    const sub = this.subs.get(id);
    if (!sub || sub.tenant_id !== tenant_id) return [];
    return [...(this.deliveries.get(id) ?? [])].reverse();
  }

  /** Test-only — clear all subscriptions + deliveries. */
  reset(): void {
    this.subs.clear();
    this.deliveries.clear();
  }
}

export const defaultWebhookStore = new WebhookSubscriptionStore();

/**
 * Shape both store implementations satisfy. Reads are sync; writes are
 * sync-with-fire-and-forget-pg. Server routes + dispatcher take this type
 * so either backend works without code changes.
 */
export type IWebhookStore = WebhookSubscriptionStore | PgWebhookSubscriptionStore;

/**
 * Factory — picks the pg-backed store when `BFF_PG_URL` is set,
 * otherwise falls back to the in-memory implementation. The pg store
 * is async-init: the factory returns a Promise that resolves once the
 * cache is hydrated from app_bff.*.
 *
 * Usage in server bootstrap:
 *
 *   const webhookStore = await makeWebhookStore();
 *   const dispatcher = new WebhookDispatcher(webhookStore);
 *   const { app } = makeApp({ webhookStore, webhookDispatcher: dispatcher });
 *
 * Tests can pass their own store via AppDeps.webhookStore — the factory
 * is only the convenience path for production / dev wiring.
 */
export async function makeWebhookStore(env: NodeJS.ProcessEnv = process.env): Promise<IWebhookStore> {
  const url = env.BFF_PG_URL;
  if (!url) return new WebhookSubscriptionStore();
  const pool = new Pool({ connectionString: url, max: 4 });
  const pgStore = new PgWebhookSubscriptionStore(pool);
  await pgStore.init();
  return pgStore;
}

export { PgWebhookSubscriptionStore };
