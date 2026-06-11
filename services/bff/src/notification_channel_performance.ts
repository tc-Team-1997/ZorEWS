// services/bff/src/notification_channel_performance.ts
//
// T6 M10.21 — Notification channel performance comparison.
//
// Cross-channel analytics over the email/SMS/push ledgers for the
// trailing 30 days: per-channel volume, busiest send-hour, most-
// used template, and distinct recipient counts.

import type { EmailLedgerEntry } from './notifications/email';
import type { SmsLedgerEntry } from './notifications/sms';
import type { PushLedgerEntry } from './notifications/push';

// ─── Public types ──────────────────────────────────────────────────────

export interface ChannelPerformanceRow {
  channel: 'email' | 'sms' | 'push';
  total_sent_30d: number;
  avg_per_day: number;
  most_active_template: string | null;
  /** 0-23 UTC hour with the most sends. null when total=0. */
  peak_send_hour: number | null;
  distinct_recipients_30d: number;
}

export interface NotificationChannelPerformance {
  tenant_id: string;
  generated_at: string;
  total_sent_30d: number;
  by_channel: {
    email: ChannelPerformanceRow;
    sms: ChannelPerformanceRow;
    push: ChannelPerformanceRow;
  };
  busiest_channel: 'email' | 'sms' | 'push' | null;
  quietest_channel: 'email' | 'sms' | 'push' | null;
  combined_distinct_recipients: number;
}

// ─── Helpers ───────────────────────────────────────────────────────────

const WINDOW_DAYS = 30;

function isInWindow(sentAt: string, now: Date): boolean {
  const ts = Date.parse(sentAt);
  if (!Number.isFinite(ts)) return false;
  const cutoff = now.getTime() - WINDOW_DAYS * 24 * 60 * 60 * 1000;
  return ts >= cutoff;
}

function templateFrequency(tids: (string | undefined)[]): string | null {
  const counts = new Map<string, number>();
  for (const t of tids) {
    if (!t) continue;
    counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  if (counts.size === 0) return null;
  let best: string | null = null;
  let bestCount = -1;
  for (const [tid, cnt] of counts) {
    if (cnt > bestCount || (cnt === bestCount && best !== null && tid < best)) {
      best = tid;
      bestCount = cnt;
    }
  }
  return best;
}

function peakHour(sentAts: string[]): number | null {
  if (sentAts.length === 0) return null;
  const hourCounts = new Array<number>(24).fill(0);
  for (const s of sentAts) {
    const d = new Date(s);
    if (!Number.isFinite(d.getTime())) continue;
    hourCounts[d.getUTCHours()]++;
  }
  let peak: number | null = null;
  let peakC = -1;
  for (let h = 0; h < 24; h++) {
    if (hourCounts[h] > peakC) {
      peakC = hourCounts[h];
      peak = h;
    }
  }
  return peak;
}

// ─── Pure function ─────────────────────────────────────────────────────

/**
 * buildNotificationChannelPerformance
 *
 * @param tenant_id   caller's tenant
 * @param emailLedger  EmailLedgerEntry[] from emailTransport.recent
 * @param smsLedger    SmsLedgerEntry[] from smsTransport.recent
 * @param pushLedger   PushLedgerEntry[] from pushTransport.recent
 * @param now          current Date
 */
export function buildNotificationChannelPerformance(
  tenant_id: string,
  emailLedger: readonly EmailLedgerEntry[],
  smsLedger: readonly SmsLedgerEntry[],
  pushLedger: readonly PushLedgerEntry[],
  now: Date,
): NotificationChannelPerformance {
  // Filter to tenant + 30-day window
  const emails = emailLedger.filter(
    (e) => e.tenant_id === tenant_id && isInWindow(e.sent_at, now),
  );
  const smss = smsLedger.filter(
    (e) => e.tenant_id === tenant_id && isInWindow(e.sent_at, now),
  );
  const pushes = pushLedger.filter(
    (e) => e.tenant_id === tenant_id && isInWindow(e.sent_at, now),
  );

  // Email metrics
  const emailRecipients = new Set<string>();
  for (const e of emails) {
    for (const addr of e.to ?? []) emailRecipients.add(addr);
  }
  const emailRow: ChannelPerformanceRow = {
    channel: 'email',
    total_sent_30d: emails.length,
    avg_per_day: Math.round((emails.length / WINDOW_DAYS) * 100) / 100,
    most_active_template: templateFrequency(emails.map((e) => e.template_id)),
    peak_send_hour: peakHour(emails.map((e) => e.sent_at)),
    distinct_recipients_30d: emailRecipients.size,
  };

  // SMS metrics
  const smsRecipients = new Set<string>();
  for (const s of smss) smsRecipients.add(s.to);
  const smsRow: ChannelPerformanceRow = {
    channel: 'sms',
    total_sent_30d: smss.length,
    avg_per_day: Math.round((smss.length / WINDOW_DAYS) * 100) / 100,
    most_active_template: templateFrequency(smss.map((e) => e.template_id)),
    peak_send_hour: peakHour(smss.map((e) => e.sent_at)),
    distinct_recipients_30d: smsRecipients.size,
  };

  // Push metrics — distinct by user_id per send
  const pushRecipients = new Set<string>();
  for (const p of pushes) {
    for (const dev of p.to ?? []) pushRecipients.add(dev.user_id);
  }
  const pushRow: ChannelPerformanceRow = {
    channel: 'push',
    total_sent_30d: pushes.length,
    avg_per_day: Math.round((pushes.length / WINDOW_DAYS) * 100) / 100,
    most_active_template: templateFrequency(pushes.map((e) => e.template_id)),
    peak_send_hour: peakHour(pushes.map((e) => e.sent_at)),
    distinct_recipients_30d: pushRecipients.size,
  };

  const total_sent_30d = emailRow.total_sent_30d + smsRow.total_sent_30d + pushRow.total_sent_30d;

  const channels: Array<{ channel: 'email' | 'sms' | 'push'; count: number }> = [
    { channel: 'email', count: emailRow.total_sent_30d },
    { channel: 'sms', count: smsRow.total_sent_30d },
    { channel: 'push', count: pushRow.total_sent_30d },
  ];

  // busiest: highest count, canonical email > sms > push tie-break
  const busiest_channel: 'email' | 'sms' | 'push' | null =
    total_sent_30d > 0
      ? channels.reduce((a, b) => (b.count > a.count ? b : a)).channel
      : null;

  // quietest: lowest count, canonical email > sms > push tie-break
  const quietest_channel: 'email' | 'sms' | 'push' | null =
    total_sent_30d > 0
      ? channels.reduce((a, b) => (b.count < a.count ? b : a)).channel
      : null;

  const combined_distinct_recipients =
    emailRecipients.size + smsRecipients.size + pushRecipients.size;

  return {
    tenant_id,
    generated_at: now.toISOString(),
    total_sent_30d,
    by_channel: {
      email: emailRow,
      sms: smsRow,
      push: pushRow,
    },
    busiest_channel,
    quietest_channel,
    combined_distinct_recipients,
  };
}
