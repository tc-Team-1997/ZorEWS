// services/notification-svc/src/types.ts
//
// Internal type contracts for the notification service. The Alert shape mirrors
// apex.regulatory.events.v2.json (the canonical alert agent-alert produces).

export type Channel = 'email' | 'sms' | 'inapp';

export type WireSeverity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export interface AlertSummary {
  alert_id: string;
  customer_id: string;
  severity: WireSeverity;
  rule_id?: string;
  reason_summary?: string;
  pd?: number | null;
  risk_level?: 'Low' | 'Medium' | 'High' | null;
  raised_at: string;
}

export interface NotifyTarget {
  /** Optional contact info; if missing the adapter uses its env-default. */
  email?: string;
  phone?: string;
  /** Display name for templates. */
  display_name?: string;
}

export interface NotifyMessage {
  subject: string;
  /** Plain-text or HTML, channel-dependent. */
  body: string;
}

export interface SendInput {
  channel: Channel;
  target: NotifyTarget;
  message: NotifyMessage;
  /** For trace correlation. */
  alert_id?: string;
}

export interface SendResult {
  channel: Channel;
  ok: boolean;
  adapter: string;
  /** Provider-specific message id when available. */
  provider_message_id?: string;
  error?: string;
}

export interface Adapter {
  /** Channel this adapter handles. */
  channel: Channel;
  /** Adapter implementation name (e.g. "ses", "africas-talking", "logging"). */
  name: string;
  send(input: SendInput): Promise<SendResult>;
}
