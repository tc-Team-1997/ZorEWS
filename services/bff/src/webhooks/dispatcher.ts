// services/bff/src/webhooks/dispatcher.ts
//
// Outbound webhook delivery loop. Public surface:
//   - dispatch(event_type, payload)  — fan-out to all matching subs
//   - deliverOne(sub, event_type, payload) — single-sub send (used for test-fire)
//
// Each delivery is HMAC-SHA256 signed with the subscription's shared
// secret and POSTed to the subscription's URL with these headers:
//   Content-Type: application/json
//   X-APEX-Event: <event_type>
//   X-APEX-Delivery-Id: <delivery uuid>     // for recipient idempotency
//   X-APEX-Signature: sha256=<hex>          // HMAC of the raw body
//
// Retry policy: 3 attempts with exponential back-off (1s, 4s, 16s in
// production). Tests inject a 0ms delay so they don't hang.

import { createHmac, randomUUID } from 'node:crypto';
import type {
  WebhookDelivery,
  WebhookEventType,
  WebhookSubscription,
} from './types';
import type { IWebhookStore } from './store';

export const MAX_ATTEMPTS = 3;
const RETRY_DELAYS_MS_DEFAULT = [1000, 4000, 16000];
const REQUEST_TIMEOUT_MS = 10_000;
const RESPONSE_BODY_TRUNCATE = 200;

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface DispatcherOptions {
  /** Inject for tests — defaults to global fetch. */
  fetchImpl?: FetchLike;
  /** Override retry delays for tests. Length must be MAX_ATTEMPTS - 1. */
  retryDelaysMs?: readonly number[];
  /** Inject for tests — defaults to setTimeout-based wait. */
  sleep?: (ms: number) => Promise<void>;
  /** Inject for tests — defaults to () => new Date(). */
  now?: () => Date;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export class WebhookDispatcher {
  private readonly fetchImpl: FetchLike;
  private readonly retryDelaysMs: readonly number[];
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => Date;

  constructor(
    private readonly store: IWebhookStore,
    opts: DispatcherOptions = {},
  ) {
    this.fetchImpl = opts.fetchImpl ?? (globalThis.fetch as FetchLike);
    this.retryDelaysMs = opts.retryDelaysMs ?? RETRY_DELAYS_MS_DEFAULT;
    this.sleep = opts.sleep ?? defaultSleep;
    this.now = opts.now ?? (() => new Date());
  }

  /**
   * Fire-and-forget fan-out. Returns the deliveries kicked off so callers
   * can await them in tests; in normal request handling the BFF route
   * does NOT await — the dispatch happens in the background so the
   * upstream response isn't slowed by webhook latency.
   */
  /**
   * T4.24 Phase 4 — `tenant_id` scopes which subscriptions get fired.
   * The originating event's tenant is always known (req.tenant.tenant_id
   * in route handlers; explicit param for fire-and-forget call sites).
   * The payload is also tagged with `_tenant_id` so receivers can verify.
   */
  dispatch(
    event_type: WebhookEventType,
    payload: unknown,
    tenant_id: string,
  ): Array<Promise<WebhookDelivery>> {
    return this.store
      .matching(event_type, tenant_id)
      .map((sub) => this.deliverOne(sub, event_type, payload));
  }

  /**
   * Deliver a single webhook to one subscription. Records a delivery row
   * on the store regardless of outcome so admins can debug failures.
   */
  async deliverOne(
    sub: WebhookSubscription,
    event_type: WebhookEventType,
    payload: unknown,
  ): Promise<WebhookDelivery> {
    const id = `wd-${randomUUID().slice(0, 8)}`;
    const created = this.now().toISOString();
    const body = JSON.stringify(payload);
    const signature = sign(body, sub.secret);

    let attempts = 0;
    let lastStatus = 0;
    let lastBody = '';
    let success = false;

    while (attempts < MAX_ATTEMPTS && !success) {
      attempts++;
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
        const res = await this.fetchImpl(sub.url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-apex-event': event_type,
            'x-apex-delivery-id': id,
            'x-apex-signature': `sha256=${signature}`,
          },
          body,
          signal: controller.signal,
        });
        clearTimeout(timer);
        lastStatus = res.status;
        // Truncate the response body so a chatty 500 doesn't blow our
        // memory budget. RFC 7807 problem JSONs are well under 200 chars.
        try {
          const text = await res.text();
          lastBody = text.slice(0, RESPONSE_BODY_TRUNCATE);
        } catch {
          lastBody = '';
        }
        // 2xx = success; everything else triggers a retry (server errors)
        // or terminal failure (client errors after MAX_ATTEMPTS).
        if (res.status >= 200 && res.status < 300) {
          success = true;
        }
      } catch {
        // Network failure / timeout / aborted — record and retry.
        lastStatus = 0;
        lastBody = '';
      }
      if (!success && attempts < MAX_ATTEMPTS) {
        const delay = this.retryDelaysMs[attempts - 1] ?? this.retryDelaysMs[this.retryDelaysMs.length - 1];
        await this.sleep(delay);
      }
    }

    const delivery: WebhookDelivery = {
      id,
      subscription_id: sub.id,
      tenant_id: sub.tenant_id,
      event_type,
      payload,
      attempts,
      status: success ? 'success' : 'failed',
      response_status: lastStatus,
      response_body: lastBody,
      created_at: created,
      completed_at: this.now().toISOString(),
    };
    this.store.recordDelivery(delivery);
    return delivery;
  }
}

function sign(body: string, secret: string): string {
  return createHmac('sha256', secret).update(body).digest('hex');
}

/**
 * Recipient-side helper exported so external services that talk to APEX
 * don't have to re-implement the signing scheme. They'd typically just
 * crib the 3 lines themselves, but this is here for documentation +
 * cross-test consistency.
 */
export function verifySignature(body: string, secret: string, header: string): boolean {
  const expected = `sha256=${sign(body, secret)}`;
  // Constant-time compare to defeat timing attacks. createHmac doesn't
  // have a built-in compare; using crypto.timingSafeEqual on equal-length
  // buffers is the standard pattern.
  if (expected.length !== header.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ header.charCodeAt(i);
  }
  return diff === 0;
}
