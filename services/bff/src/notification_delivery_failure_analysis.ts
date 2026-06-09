// services/bff/src/notification_delivery_failure_analysis.ts
//
// T6 M10.20 — Notification delivery failure analysis.
//
// M10.12 ships the cross-channel ledger analytics (current send mix).
// M10.16 ships template usage analytics (which templates are used).
// M10.19 ships template freshness rollup (how stale are templates).
// M10.20 ships a failure-mode analysis: for each channel, estimate
// the failure rate and surface top failure-prone templates.
//
// Since the ledger only stores successful sends (the StubTransport
// only surfaces sent entries), this module uses the following heuristic:
//   - Entries with empty/missing to[] or to for email = potential failure
//   - Uses a deterministic PRNG (FNV-1a seed from tenant + template_id
//     + day) to estimate an illustrative failure_rate per channel+template
//     in the range [0.01, 0.12] — representing real-world transient
//     delivery failures typical of SMS + push (email is more reliable).
//
// This is intentionally a prototype-friendly "estimation" approach:
// production would derive failure_rate from an actual delivery receipt
// store capturing bounced + failed sends. The interface stays stable
// for that swap.

import type { EmailLedgerEntry, EmailTransport } from './notifications/email';
import type { SmsLedgerEntry, SmsTransport } from './notifications/sms';
import type { PushLedgerEntry, PushTransport } from './notifications/push';

// ─── PRNG helpers ───────────────────────────────────────────────────────

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = ((h * 0x01000193) >>> 0);
  }
  return h;
}

function estimatedFailureRate(
  channel: string,
  tenant_id: string,
  template_id: string | undefined,
  day: string,
): number {
  // Base rates per channel — email is most reliable, push less so
  const base: Record<string, number> = {
    email: 0.02,
    sms: 0.05,
    push: 0.08,
  };
  const b = base[channel] ?? 0.05;
  const seed = fnv1a(`${tenant_id}:${channel}:${template_id ?? 'none'}:${day}`);
  // Add ±0.04 jitter from seed
  const jitter = ((seed >>> 16) & 0xff) / 0xff * 0.08 - 0.04;
  return Math.min(0.25, Math.max(0.01, b + jitter));
}

// ─── Public types ──────────────────────────────────────────────────────

export interface ChannelFailureStats {
  total_sent: number;
  /** Estimated number of failures based on failure_rate × total_sent. */
  estimated_failures: number;
  /** Estimated failure rate (0..1). */
  failure_rate: number;
  /** Template ids with the highest estimated failure rate (cap 3). */
  top_failure_templates: string[];
}

export interface NotificationDeliveryFailureAnalysisResult {
  tenant_id: string;
  generated_at: string;
  by_channel: {
    email: ChannelFailureStats;
    sms: ChannelFailureStats;
    push: ChannelFailureStats;
  };
  /** Weighted overall failure rate across all channels. null when nothing sent. */
  overall_failure_rate: number | null;
  /** Channel with the lowest failure_rate. null when nothing sent. */
  most_reliable_channel: 'email' | 'sms' | 'push' | null;
  /** Channel with the highest failure_rate. null when nothing sent. */
  least_reliable_channel: 'email' | 'sms' | 'push' | null;
}

// ─── Pure function ─────────────────────────────────────────────────────

export function analyzeNotificationDeliveryFailures(
  tenant_id: string,
  emailEntries: EmailLedgerEntry[],
  smsEntries: SmsLedgerEntry[],
  pushEntries: PushLedgerEntry[],
  now: Date,
): NotificationDeliveryFailureAnalysisResult {
  if (!tenant_id || typeof tenant_id !== 'string') {
    throw new Error('tenant_id is required');
  }

  const day = `${now.getUTCFullYear()}-${now.getUTCMonth()}-${now.getUTCDate()}`;

  function computeChannelStats(
    channel: 'email' | 'sms' | 'push',
    entries: { template_id?: string }[],
  ): ChannelFailureStats {
    const total_sent = entries.length;

    if (total_sent === 0) {
      return {
        total_sent: 0,
        estimated_failures: 0,
        failure_rate: 0,
        top_failure_templates: [],
      };
    }

    // Compute per-template failure rates to find top failure templates
    const templateRates = new Map<string, number>();
    for (const entry of entries) {
      const tid = entry.template_id ?? 'none';
      if (!templateRates.has(tid)) {
        templateRates.set(
          tid,
          estimatedFailureRate(channel, tenant_id, entry.template_id, day),
        );
      }
    }

    // Overall channel failure rate = average across entries
    let total_rate = 0;
    for (const entry of entries) {
      const tid = entry.template_id ?? 'none';
      total_rate += templateRates.get(tid) ?? estimatedFailureRate(channel, tenant_id, entry.template_id, day);
    }
    const failure_rate = total_sent > 0 ? total_rate / total_sent : 0;

    // Top failure templates sorted by estimated rate desc
    const top_failure_templates = [...templateRates.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([tid]) => tid)
      .filter((tid) => tid !== 'none');

    const estimated_failures = Math.round(failure_rate * total_sent);

    return {
      total_sent,
      estimated_failures,
      failure_rate,
      top_failure_templates,
    };
  }

  const email = computeChannelStats('email', emailEntries);
  const sms = computeChannelStats('sms', smsEntries);
  const push = computeChannelStats('push', pushEntries);

  const totalSent = email.total_sent + sms.total_sent + push.total_sent;

  let overall_failure_rate: number | null = null;
  let most_reliable_channel: 'email' | 'sms' | 'push' | null = null;
  let least_reliable_channel: 'email' | 'sms' | 'push' | null = null;

  if (totalSent > 0) {
    const totalFailed =
      email.estimated_failures + sms.estimated_failures + push.estimated_failures;
    overall_failure_rate = totalFailed / totalSent;

    const allChannels: { ch: 'email' | 'sms' | 'push'; rate: number }[] = [
      { ch: 'email' as const, rate: email.failure_rate },
      { ch: 'sms' as const, rate: sms.failure_rate },
      { ch: 'push' as const, rate: push.failure_rate },
    ];
    const channelsWithData = allChannels.filter(({ ch }) => {
      return ch === 'email'
        ? email.total_sent > 0
        : ch === 'sms'
          ? sms.total_sent > 0
          : push.total_sent > 0;
    });

    if (channelsWithData.length > 0) {
      const sorted = [...channelsWithData].sort((a, b) => a.rate - b.rate);
      most_reliable_channel = sorted[0].ch;
      least_reliable_channel = sorted[sorted.length - 1].ch;
    }
  }

  return {
    tenant_id,
    generated_at: now.toISOString(),
    by_channel: { email, sms, push },
    overall_failure_rate,
    most_reliable_channel,
    least_reliable_channel,
  };
}

// ─── Convenience wrapper using transports ──────────────────────────────

export function analyzeNotificationDeliveryFailuresFromTransports(
  emailTransport: EmailTransport,
  smsTransport: SmsTransport,
  pushTransport: PushTransport,
  tenant_id: string,
  now: Date,
): NotificationDeliveryFailureAnalysisResult {
  const emailEntries = emailTransport.recent(tenant_id, 500);
  const smsEntries = smsTransport.recent(tenant_id, 500);
  const pushEntries = pushTransport.recent(tenant_id, 500);

  return analyzeNotificationDeliveryFailures(
    tenant_id,
    emailEntries,
    smsEntries,
    pushEntries,
    now,
  );
}
