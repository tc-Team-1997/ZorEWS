// services/bff/src/notification_channel_cost.ts
//
// T6 M10.24 — Notification channel cost estimate.
//
// Estimate monthly cost per channel based on send volume in recent ledger:
//   email:  $0.0001 per send (SES pricing)
//   sms:    $0.0075 per send (Africa's Talking pricing)
//   push:   $0.00001 per send (FCM/APNS negligible)
//
// Drain last 500 per channel. Compute monthly_projection = volume / days * 30.
//
// Route: GET /v1/notifications/channel-cost-estimate
//   RBAC: audit:read (admin)

import { defaultEmailTransport, type EmailTransport } from './notifications/email';
import { defaultSmsTransport, type SmsTransport } from './notifications/sms';
import { defaultPushTransport, type PushTransport } from './notifications/push';

// ─── Cost constants ───────────────────────────────────────────────────

export const EMAIL_COST_PER_SEND = 0.0001;
export const SMS_COST_PER_SEND = 0.0075;
export const PUSH_COST_PER_SEND = 0.00001;

const SAMPLE_SIZE = 500;
const PROJECTION_DAYS = 30;

// ─── Public types ─────────────────────────────────────────────────────

export interface ChannelCostEstimate {
  sends: number;
  monthly_projection_usd: number;
}

export interface NotificationChannelCostReport {
  tenant_id: string;
  generated_at: string;
  channels: {
    email: ChannelCostEstimate;
    sms: ChannelCostEstimate;
    push: ChannelCostEstimate;
  };
  total_monthly_estimate_usd: number;
  most_expensive_channel: string | null;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function computeEstimate(
  sends: number,
  cost_per_send: number,
  days_observed: number,
): ChannelCostEstimate {
  const rate = days_observed > 0 ? sends / days_observed : sends;
  const monthly_projection_usd = round2(rate * PROJECTION_DAYS * cost_per_send);
  return { sends, monthly_projection_usd };
}

// ─── Pure resolver ────────────────────────────────────────────────────

export function buildNotificationChannelCostEstimate(
  emailTransport: EmailTransport,
  smsTransport: SmsTransport,
  pushTransport: PushTransport,
  tenant_id: string,
  now: Date,
): NotificationChannelCostReport {
  if (!tenant_id) throw new Error('tenant_id is required');

  const emailEntries = emailTransport.recent(tenant_id, SAMPLE_SIZE);
  const smsEntries = smsTransport.recent(tenant_id, SAMPLE_SIZE);
  const pushEntries = pushTransport.recent(tenant_id, SAMPLE_SIZE);

  // Determine days observed from oldest entry in sample
  function daysObserved(entries: Array<{ sent_at: string }>): number {
    if (entries.length === 0) return 1;
    const sorted = [...entries].sort((a, b) => a.sent_at.localeCompare(b.sent_at));
    const oldest = new Date(sorted[0].sent_at).getTime();
    const days = (now.getTime() - oldest) / (1000 * 60 * 60 * 24);
    return Math.max(1, Math.ceil(days));
  }

  const emailDays = daysObserved(emailEntries);
  const smsDays = daysObserved(smsEntries);
  const pushDays = daysObserved(pushEntries);

  const email = computeEstimate(emailEntries.length, EMAIL_COST_PER_SEND, emailDays);
  const sms = computeEstimate(smsEntries.length, SMS_COST_PER_SEND, smsDays);
  const push = computeEstimate(pushEntries.length, PUSH_COST_PER_SEND, pushDays);

  const total_monthly_estimate_usd = round2(
    email.monthly_projection_usd + sms.monthly_projection_usd + push.monthly_projection_usd,
  );

  const channelMap = [
    { name: 'email', cost: email.monthly_projection_usd },
    { name: 'sms', cost: sms.monthly_projection_usd },
    { name: 'push', cost: push.monthly_projection_usd },
  ];
  const maxCost = Math.max(...channelMap.map((c) => c.cost));
  const most_expensive_channel =
    total_monthly_estimate_usd === 0
      ? null
      : channelMap.find((c) => c.cost === maxCost)?.name ?? null;

  return {
    tenant_id,
    generated_at: now.toISOString(),
    channels: { email, sms, push },
    total_monthly_estimate_usd,
    most_expensive_channel,
  };
}
