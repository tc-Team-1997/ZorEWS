// services/bff/src/notification_ledger_analytics.ts
//
// T6 M10.12 — Notification delivery ledger analytics.
//
// M10.1/M10.2/M10.3 ship email + SMS + push transports each with a
// per-tenant ledger surfaced via `recent(tenant, limit)`. M10.12 is
// the cross-channel rollup: per-channel totals + by-template-id mix
// + top recipients + recency anchors. Lets the SPA show a unified
// "notifications activity" panel ("you've sent 124 emails, 32 SMS,
// and 18 pushes this window — top template is ALERT_RED").
//
// Pure — no I/O. Caller passes the per-channel ledgers.

import type { EmailLedgerEntry } from './notifications/email';
import type { SmsLedgerEntry } from './notifications/sms';
import type { PushLedgerEntry } from './notifications/push';

// ─── Public types ─────────────────────────────────────────────────────

export type LedgerChannel = 'email' | 'sms' | 'push';

export interface TemplateMix {
  template_id: string;
  count: number;
}

export interface RecipientFrequency {
  recipient: string;
  count: number;
}

export interface ChannelAnalytics {
  channel: LedgerChannel;
  total_sent: number;
  /** Most-used templates (cap 5; sorted by count desc + template_id asc). */
  by_template_id: TemplateMix[];
  /** Top recipient addresses (cap 10). Email uses recipient address;
   *  SMS uses E.164 phone; push counts distinct user_ids across
   *  devices. Sorted count desc + recipient asc tie-break. */
  top_recipients: RecipientFrequency[];
  /** ISO timestamp of the newest send. null when total_sent=0. */
  most_recent_at: string | null;
}

export interface NotificationLedgerAnalytics {
  tenant_id: string;
  generated_at: string;
  total_sent_all_channels: number;
  channels: Record<LedgerChannel, ChannelAnalytics>;
}

// ─── Pure aggregator ─────────────────────────────────────────────────

function topN<T extends { count: number }>(
  acc: Map<string, number>,
  keyOf: (s: string) => T,
  n: number,
): T[] {
  return [...acc.entries()]
    .map(([k, count]) => ({ ...keyOf(k), count } as T))
    .sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      // Type-level guarantee that both have count; cast to access string field.
      const aStr = (a as unknown as { [k: string]: unknown });
      const bStr = (b as unknown as { [k: string]: unknown });
      // Find the first non-count string field
      for (const k of Object.keys(aStr)) {
        if (k === 'count') continue;
        const av = aStr[k];
        const bv = bStr[k];
        if (typeof av === 'string' && typeof bv === 'string' && av !== bv) {
          return av < bv ? -1 : 1;
        }
      }
      return 0;
    })
    .slice(0, n);
}

function analyseEmailLedger(entries: readonly EmailLedgerEntry[]): ChannelAnalytics {
  const by_template = new Map<string, number>();
  const by_recipient = new Map<string, number>();
  let mostRecent: string | null = null;
  for (const e of entries) {
    if (e.template_id) {
      by_template.set(e.template_id, (by_template.get(e.template_id) ?? 0) + 1);
    }
    for (const to of e.to) {
      by_recipient.set(to, (by_recipient.get(to) ?? 0) + 1);
    }
    if (mostRecent === null || e.sent_at > mostRecent) mostRecent = e.sent_at;
  }
  return {
    channel: 'email',
    total_sent: entries.length,
    by_template_id: topN<TemplateMix>(by_template, (template_id) => ({ template_id, count: 0 }), 5),
    top_recipients: topN<RecipientFrequency>(by_recipient, (recipient) => ({ recipient, count: 0 }), 10),
    most_recent_at: mostRecent,
  };
}

function analyseSmsLedger(entries: readonly SmsLedgerEntry[]): ChannelAnalytics {
  const by_template = new Map<string, number>();
  const by_recipient = new Map<string, number>();
  let mostRecent: string | null = null;
  for (const e of entries) {
    if (e.template_id) {
      by_template.set(e.template_id, (by_template.get(e.template_id) ?? 0) + 1);
    }
    // SMS `to` is a single E.164 string (not array).
    by_recipient.set(e.to, (by_recipient.get(e.to) ?? 0) + 1);
    if (mostRecent === null || e.sent_at > mostRecent) mostRecent = e.sent_at;
  }
  return {
    channel: 'sms',
    total_sent: entries.length,
    by_template_id: topN<TemplateMix>(by_template, (template_id) => ({ template_id, count: 0 }), 5),
    top_recipients: topN<RecipientFrequency>(by_recipient, (recipient) => ({ recipient, count: 0 }), 10),
    most_recent_at: mostRecent,
  };
}

function analysePushLedger(entries: readonly PushLedgerEntry[]): ChannelAnalytics {
  const by_template = new Map<string, number>();
  const by_user = new Map<string, number>();
  let mostRecent: string | null = null;
  for (const e of entries) {
    if (e.template_id) {
      by_template.set(e.template_id, (by_template.get(e.template_id) ?? 0) + 1);
    }
    // Push fan-outs go to multiple devices; aggregate distinct user_ids
    // (a single push to 2 devices of the same user counts as 1 send per
    // user, since user-level reach is what matters for analytics).
    const distinctUsers = new Set<string>();
    for (const d of e.to) distinctUsers.add(d.user_id);
    for (const u of distinctUsers) {
      by_user.set(u, (by_user.get(u) ?? 0) + 1);
    }
    if (mostRecent === null || e.sent_at > mostRecent) mostRecent = e.sent_at;
  }
  return {
    channel: 'push',
    total_sent: entries.length,
    by_template_id: topN<TemplateMix>(by_template, (template_id) => ({ template_id, count: 0 }), 5),
    top_recipients: topN<RecipientFrequency>(by_user, (recipient) => ({ recipient, count: 0 }), 10),
    most_recent_at: mostRecent,
  };
}

export function analyseNotificationLedgers(
  tenant_id: string,
  emailEntries: readonly EmailLedgerEntry[],
  smsEntries: readonly SmsLedgerEntry[],
  pushEntries: readonly PushLedgerEntry[],
  now: Date,
): NotificationLedgerAnalytics {
  const email = analyseEmailLedger(emailEntries);
  const sms = analyseSmsLedger(smsEntries);
  const push = analysePushLedger(pushEntries);
  return {
    tenant_id,
    generated_at: now.toISOString(),
    total_sent_all_channels: email.total_sent + sms.total_sent + push.total_sent,
    channels: { email, sms, push },
  };
}
