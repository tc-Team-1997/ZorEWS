// services/bff/src/notification_webhook.ts
//
// T6 M10.4 — Notification delivery webhook channel.
//
// M10.1/2/3 ship email/SMS/push channels. M10.4 adds the webhook
// channel: BIL admins register an outbound URL that receives every
// notification as JSON POST. Mirrors the Email/SMS/Push pattern —
// transport interface + stub + dispatch surface.
//
// Stub transport keeps deliveries in an in-memory ledger keyed by
// (tenant, webhook_id) — production swap is the existing
// services/bff/src/webhooks/dispatcher.ts (HMAC-signed delivery
// with retry).

import { randomUUID } from 'node:crypto';

export interface WebhookSubscription {
  webhook_id: string;
  tenant_id: string;
  name: string;
  url: string;
  /** Defaults to true. */
  enabled: boolean;
  created_at: string;
  created_by: string;
}

export interface WebhookDelivery {
  delivery_id: string;
  webhook_id: string;
  tenant_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  delivered_at: string;
  /** Synthesized 2xx status from the stub; production carries the
   *  real HTTP response code. */
  http_status: number;
}

export class WebhookChannelError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'WebhookChannelError';
  }
}

const HTTPS_RE = /^https:\/\/[^\s]+$/;

export interface WebhookSubscriptionInput {
  name: string;
  url: string;
  enabled?: boolean;
}

function validateInput(input: unknown): WebhookSubscriptionInput {
  if (!input || typeof input !== 'object') {
    throw new WebhookChannelError('invalid_input', 'request body required');
  }
  const i = input as Record<string, unknown>;
  if (typeof i.name !== 'string' || !i.name.trim()) {
    throw new WebhookChannelError('invalid_input', 'name is required');
  }
  if (i.name.length > 80) {
    throw new WebhookChannelError('invalid_input', 'name ≤ 80 chars');
  }
  if (typeof i.url !== 'string' || !HTTPS_RE.test(i.url)) {
    throw new WebhookChannelError(
      'invalid_input',
      'url must be a https:// URL',
    );
  }
  if (i.url.length > 500) {
    throw new WebhookChannelError('invalid_input', 'url ≤ 500 chars');
  }
  if (i.enabled !== undefined && typeof i.enabled !== 'boolean') {
    throw new WebhookChannelError('invalid_input', 'enabled must be boolean');
  }
  return {
    name: i.name.trim(),
    url: i.url,
    enabled: i.enabled as boolean | undefined,
  };
}

export interface NotificationWebhookStore {
  list(tenant_id: string): WebhookSubscription[];
  get(tenant_id: string, webhook_id: string): WebhookSubscription | null;
  create(
    tenant_id: string,
    input: unknown,
    created_by: string,
    now: Date,
  ): WebhookSubscription;
  delete(tenant_id: string, webhook_id: string): boolean;
  /** Stub-dispatch: synthesize a 200 delivery for every enabled
   *  webhook and append to the ledger. Returns the delivery rows. */
  send(
    tenant_id: string,
    event_type: string,
    payload: Record<string, unknown>,
    now: Date,
  ): WebhookDelivery[];
  listDeliveries(
    tenant_id: string,
    webhook_id: string,
    limit: number,
  ): WebhookDelivery[];
}

const CAP_PER_TENANT = 25;

export class InMemoryNotificationWebhookStore implements NotificationWebhookStore {
  private readonly subs = new Map<string, WebhookSubscription[]>();
  private readonly deliveries = new Map<string, WebhookDelivery[]>();

  list(tenant_id: string): WebhookSubscription[] {
    return [...(this.subs.get(tenant_id) ?? [])];
  }

  get(tenant_id: string, webhook_id: string): WebhookSubscription | null {
    return (
      this.subs.get(tenant_id)?.find((s) => s.webhook_id === webhook_id) ?? null
    );
  }

  create(
    tenant_id: string,
    input: unknown,
    created_by: string,
    now: Date,
  ): WebhookSubscription {
    if (!created_by || !created_by.trim()) {
      throw new WebhookChannelError('invalid_input', 'created_by required');
    }
    const valid = validateInput(input);
    const arr = this.subs.get(tenant_id) ?? [];
    if (arr.length >= CAP_PER_TENANT) {
      throw new WebhookChannelError(
        'cap_reached',
        `tenant ${tenant_id} already has ${CAP_PER_TENANT} webhook subscriptions`,
      );
    }
    if (arr.find((s) => s.url === valid.url)) {
      throw new WebhookChannelError('duplicate_url', `url already registered`);
    }
    const sub: WebhookSubscription = {
      webhook_id: `whk-${randomUUID()}`,
      tenant_id,
      name: valid.name,
      url: valid.url,
      enabled: valid.enabled ?? true,
      created_at: now.toISOString(),
      created_by: created_by.trim(),
    };
    arr.push(sub);
    this.subs.set(tenant_id, arr);
    return sub;
  }

  delete(tenant_id: string, webhook_id: string): boolean {
    const arr = this.subs.get(tenant_id);
    if (!arr) return false;
    const idx = arr.findIndex((s) => s.webhook_id === webhook_id);
    if (idx < 0) return false;
    arr.splice(idx, 1);
    return true;
  }

  send(
    tenant_id: string,
    event_type: string,
    payload: Record<string, unknown>,
    now: Date,
  ): WebhookDelivery[] {
    if (!event_type || typeof event_type !== 'string') {
      throw new WebhookChannelError('invalid_input', 'event_type required');
    }
    const subs = (this.subs.get(tenant_id) ?? []).filter((s) => s.enabled);
    const out: WebhookDelivery[] = [];
    for (const sub of subs) {
      const delivery: WebhookDelivery = {
        delivery_id: `dlv-${randomUUID()}`,
        webhook_id: sub.webhook_id,
        tenant_id,
        event_type,
        payload,
        delivered_at: now.toISOString(),
        http_status: 200,
      };
      const ledgerKey = `${tenant_id}::${sub.webhook_id}`;
      const ledger = this.deliveries.get(ledgerKey) ?? [];
      ledger.push(delivery);
      // Cap ledger at 200 entries per webhook for memory safety
      if (ledger.length > 200) ledger.splice(0, ledger.length - 200);
      this.deliveries.set(ledgerKey, ledger);
      out.push(delivery);
    }
    return out;
  }

  listDeliveries(
    tenant_id: string,
    webhook_id: string,
    limit: number,
  ): WebhookDelivery[] {
    const arr = this.deliveries.get(`${tenant_id}::${webhook_id}`) ?? [];
    const cap = Math.max(1, Math.min(200, limit));
    return [...arr].reverse().slice(0, cap);
  }
}

export const defaultNotificationWebhookStore: NotificationWebhookStore =
  new InMemoryNotificationWebhookStore();
