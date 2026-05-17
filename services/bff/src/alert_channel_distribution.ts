// services/bff/src/alert_channel_distribution.ts
//
// T6 M8.13 — Alert channel dispatch distribution.
//
// M8.6 ships the routing ledger with per-alert channel arrays.
// M8.9 ships per-rule channel-coverage analytics. M8.11 ships SLA
// breach detail. M8.12 ships ack-time histogram. M8.13 closes the
// channel side: pivot the routing ledger by notification channel
// and surface dispatch volume + per-class breakdown + ack status.
//
// Use case: BIL ops opens the alerts page and wants "how many
// email vs sms vs in_app vs push dispatches did we send this
// week? are all 4 critical-class alerts going to email + sms as
// the routing matrix dictates?" — answered in one round-trip.
//
// Mirror of M14.27 / M7.13 / M3.13 distribution pattern. Pure
// rollup over RoutedAlertRecord[] + now.

import type { RoutedAlertRecord } from './alert_routing_analytics';
import type { NotificationChannel } from './alert_routing';
import type { BilAlertClass } from './bil_alert_classification';

// ─── Constants ────────────────────────────────────────────────────────

export const ALL_NOTIFICATION_CHANNELS: readonly NotificationChannel[] = [
  'email',
  'sms',
  'in_app',
  'push',
] as const;

const ALL_CLASSES: readonly BilAlertClass[] = ['red', 'orange', 'yellow', 'green'] as const;

// ─── Public types ─────────────────────────────────────────────────────

export interface ChannelDispatchRow {
  channel: NotificationChannel;
  /** Sum of alert dispatches via this channel (one record with
   *  channels=['email','sms'] contributes 1 to email AND 1 to sms). */
  dispatch_count: number;
  /** Distinct alert_ids that included this channel. May differ from
   *  dispatch_count when an alert is re-ingested (multiple records
   *  with the same alert_id). */
  distinct_alerts: number;
  /** Per-BilAlertClass count; every key present at 0 when absent. */
  by_class: Record<BilAlertClass, number>;
  /** Records where acked_at != null + this channel. */
  acked_count: number;
  /** Records still open (acked_at == null) + this channel. */
  open_count: number;
  /** Records with monitor_only=true + this channel (no SLA semantics). */
  monitor_only_count: number;
}

export interface AlertChannelDispatchSummary {
  tenant_id: string;
  generated_at: string;
  window: number;
  total_records: number;
  /** Σ dispatch_count across channels (one record with N channels
   *  contributes N). */
  total_channel_dispatches: number;
  /** Every NotificationChannel in canonical order even when zero. */
  channels: ChannelDispatchRow[];
  /** Highest dispatch_count channel. Canonical tie-break: email >
   *  sms > in_app > push at same count. null when no records. */
  most_used_channel: NotificationChannel | null;
  /** Channels with dispatch_count=0 in canonical order. */
  unused_channels: NotificationChannel[];
}

// ─── Helpers ──────────────────────────────────────────────────────────

function emptyByClass(): Record<BilAlertClass, number> {
  return { red: 0, orange: 0, yellow: 0, green: 0 };
}

interface RowBuilder {
  channel: NotificationChannel;
  dispatch_count: number;
  by_class: Record<BilAlertClass, number>;
  acked_count: number;
  open_count: number;
  monitor_only_count: number;
  alerts: Set<string>;
}

function newBuilder(channel: NotificationChannel): RowBuilder {
  return {
    channel,
    dispatch_count: 0,
    by_class: emptyByClass(),
    acked_count: 0,
    open_count: 0,
    monitor_only_count: 0,
    alerts: new Set(),
  };
}

// ─── Pure resolver ────────────────────────────────────────────────────

export function summarizeAlertChannelDispatch(
  tenant_id: string,
  records: readonly RoutedAlertRecord[],
  window: number,
  now: Date,
): AlertChannelDispatchSummary {
  const builders = new Map<NotificationChannel, RowBuilder>();
  for (const ch of ALL_NOTIFICATION_CHANNELS) builders.set(ch, newBuilder(ch));

  let total_channel_dispatches = 0;

  for (const rec of records) {
    for (const ch of rec.channels) {
      const b = builders.get(ch);
      if (!b) continue; // unknown channel — shouldn't happen
      b.dispatch_count++;
      total_channel_dispatches++;
      if (ALL_CLASSES.includes(rec.class)) b.by_class[rec.class]++;
      if (rec.acked_at !== null) b.acked_count++;
      else b.open_count++;
      if (rec.monitor_only) b.monitor_only_count++;
      b.alerts.add(rec.alert_id);
    }
  }

  const channels: ChannelDispatchRow[] = ALL_NOTIFICATION_CHANNELS.map((ch) => {
    const b = builders.get(ch)!;
    return {
      channel: b.channel,
      dispatch_count: b.dispatch_count,
      distinct_alerts: b.alerts.size,
      by_class: b.by_class,
      acked_count: b.acked_count,
      open_count: b.open_count,
      monitor_only_count: b.monitor_only_count,
    };
  });

  // most_used_channel: highest dispatch_count with canonical tie-break.
  let most_used_channel: NotificationChannel | null = null;
  let mostCount = 0;
  for (const ch of ALL_NOTIFICATION_CHANNELS) {
    const b = builders.get(ch)!;
    if (b.dispatch_count > mostCount) {
      mostCount = b.dispatch_count;
      most_used_channel = ch;
    }
  }
  if (mostCount === 0) most_used_channel = null;

  const unused_channels = ALL_NOTIFICATION_CHANNELS.filter(
    (ch) => builders.get(ch)!.dispatch_count === 0,
  );

  return {
    tenant_id,
    generated_at: now.toISOString(),
    window,
    total_records: records.length,
    total_channel_dispatches,
    channels,
    most_used_channel,
    unused_channels,
  };
}
