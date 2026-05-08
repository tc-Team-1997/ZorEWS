// services/bff/src/webhooks/types.ts
//
// Outbound webhook subsystem — lets external systems (AML hub, collection
// platform, branch ops dashboard, etc.) subscribe to alert + scenario
// events from APEX EWS. Recipients verify the HMAC-SHA256 signature in
// the X-APEX-Signature header against their shared secret.
//
// Domain shape mirrors the contract documented in
// integrations/aml/contract.md so downstream teams already know the wire
// format. The contract calls for: 3 retries with exponential back-off
// (1s/4s/16s), shared-secret HMAC signing, and a delivery log surfaced
// to the admin who owns the subscription.

/** Event types emitted by the BFF that a webhook subscription can listen for. */
export type WebhookEventType =
  | 'alert.created'
  | 'alert.updated'
  | 'case.assigned'
  | 'case.closed'
  | 'scenario.run'
  | 'webhook.test'
  | 'user_access_override.approved'
  | 'user_access_override.rejected'
  | 'user_access_override.revoked';

/**
 * Registered subscription. One per URL+events combination — admins can
 * register multiple URLs (e.g., one to AML, one to collection) and each
 * subscribes to its own subset of event types.
 */
export interface WebhookSubscription {
  id: string;
  /**
   * T4.24 Phase 4 — tenant the subscription belongs to. Admins only see
   * and manage their own tenant's subscriptions; the dispatcher only
   * fires events to subscriptions matching the originating tenant of
   * the event.
   */
  tenant_id: string;
  /** Human-readable label shown in the admin UI. */
  name: string;
  /** Destination URL — must be https in production; http allowed in dev. */
  url: string;
  /**
   * Shared secret used to sign delivery payloads (HMAC-SHA256). Generated
   * server-side at create-time so admins cannot accidentally use a weak
   * secret. Returned ONCE in the create response and never again — admins
   * who lose it must rotate the subscription.
   */
  secret: string;
  /** Subset of WebhookEventType this subscription wants to receive. */
  events: WebhookEventType[];
  /** When false, dispatcher skips this subscription. */
  active: boolean;
  created_at: string;
  /** Updated by the dispatcher on each fire attempt — null if never delivered. */
  last_delivery_at: string | null;
  last_delivery_status: 'success' | 'failed' | null;
}

/**
 * Public projection of a subscription — used everywhere except the
 * create endpoint. The secret is intentionally NOT included so it isn't
 * leaked into list responses or audit logs.
 */
export type WebhookSubscriptionView = Omit<WebhookSubscription, 'secret'>;

/**
 * One row in the per-subscription delivery log. Recent deliveries are
 * kept in a ring buffer; older entries are dropped to bound memory.
 */
export interface WebhookDelivery {
  id: string;
  subscription_id: string;
  /** T4.24 Phase 4 — denormalised from the subscription. Lets admin
   *  delivery-log queries scope by tenant without a JOIN. */
  tenant_id: string;
  event_type: WebhookEventType;
  /** Payload that was POSTed (after signing). */
  payload: unknown;
  /** Number of HTTP attempts made; max = MAX_ATTEMPTS in dispatcher.ts. */
  attempts: number;
  /** Final outcome of the delivery loop. */
  status: 'success' | 'failed';
  /** HTTP status of the last attempt (0 if connection failed). */
  response_status: number;
  /** Truncated response body of the last attempt (≤ 200 chars). */
  response_body?: string;
  created_at: string;
  /** When the dispatcher gave up (success or final failure). */
  completed_at: string;
}
