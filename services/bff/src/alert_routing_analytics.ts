// services/bff/src/alert_routing_analytics.ts
//
// T6 M8.6 — Alert auto-routing analytics.
//
// M8.2 ships the routing matrix (severity → class → channels + SLA +
// escalation). M8.3 ships ack lifecycle. M8.4 ships auto-ack rules.
// M8.5 ships the ingest pipeline that composes evaluate + acknowledge.
// M8.6 closes the loop on the SRE side: across the recent window of
// routed alerts, how is the matrix performing?
//
// Surfaces:
//   - channel mix (how many alerts went to email / sms / in_app / push)
//   - class mix  (how many red/orange/yellow/green)
//   - ack rate   (acked / non-monitor) — green class excluded
//   - time-to-ack percentiles (min / mean / p50 / p95 / max)
//   - SLA-breach count (acked-late + still-open past SLA)
//   - escalation-due count (still-open past escalate_after)
//
// Design:
//  - Append-only per-tenant ledger captured at ingest time. FIFO cap
//    200/tenant, mirroring the M14.10 field-visit ledger + M7.5 model
//    performance ledger posture.
//  - Each record snapshots the routing decision (class, channels,
//    sla_hours, escalate_after_hours, monitor_only) AT ROUTING TIME,
//    so later override edits don't retroactively change history.
//  - Pure aggregator over the records + caller-supplied `now`. `now`
//    is needed to count "open + past SLA" without an explicit
//    second-pass walk over the ack store.
//  - linearPercentile re-uses the M3.5 Excel/R type-7 definition so
//    every latency-style summary in the BFF tells a consistent story.

import { linearPercentile } from './connector_run_analytics';
import type { BilAlertClass } from './bil_alert_classification';
import type { NotificationChannel } from './alert_routing';

// ─── Public types ─────────────────────────────────────────────────────

export interface RoutedAlertRecord {
  alert_id: string;
  tenant_id: string;
  /** ISO timestamp when the alert was routed (ingested). */
  created_at: string;
  /** Raw severity that produced the class. */
  severity_in: string;
  /** Class resolved by M8.1 classifier. */
  class: BilAlertClass;
  /** Channels the routing matrix dispatched to (order = priority). */
  channels: NotificationChannel[];
  /** SLA hours snapshotted at routing time. null when monitor_only. */
  sla_hours: number | null;
  /** Escalation window snapshotted at routing time. null when none. */
  escalate_after_hours: number | null;
  /** Whether the class was monitor-only (green). */
  monitor_only: boolean;
  /** ISO timestamp the alert was acked. null when still open. */
  acked_at: string | null;
}

export interface RoutingAnalytics {
  /** Number of routed records the analytics is computed over. */
  sample_size: number;
  /** Per-class counts. Every class key present even when zero. */
  by_class: Record<BilAlertClass, number>;
  /** Per-channel counts (an alert with N channels contributes N). */
  by_channel: Record<NotificationChannel, number>;
  /** Records with monitor_only=true. Excluded from ack_rate + SLA stats. */
  monitor_only_count: number;
  /** acked_at != null / non-monitor records. null when no non-monitor records. */
  ack_rate: number | null;
  /** Time from created_at → acked_at (ms), aggregated over acked
   *  non-monitor records. null fields when the bucket is empty. */
  time_to_ack_ms: {
    min: number | null;
    mean: number | null;
    p50: number | null;
    p95: number | null;
    max: number | null;
  };
  /** SLA breach = acked after SLA window OR (still open AND now > created+sla).
   *  Counted only over non-monitor records with sla_hours != null. */
  sla_breach_count: number;
  /** Non-monitor records with a defined sla_hours — the denominator
   *  for sla_breach_rate. */
  sla_eligible_count: number;
  /** sla_breach_count / sla_eligible_count. null when eligible=0. */
  sla_breach_rate: number | null;
  /** Records still open AND now > created+escalate_after_hours.
   *  Non-monitor only, escalate_after_hours != null. */
  escalation_due_count: number;
}

// ─── Pure aggregator ──────────────────────────────────────────────────

const ALL_CLASSES: BilAlertClass[] = ['red', 'orange', 'yellow', 'green'];
const ALL_CHANNELS: NotificationChannel[] = ['email', 'sms', 'in_app', 'push'];

function emptyByClass(): Record<BilAlertClass, number> {
  return { red: 0, orange: 0, yellow: 0, green: 0 };
}

function emptyByChannel(): Record<NotificationChannel, number> {
  return { email: 0, sms: 0, in_app: 0, push: 0 };
}

function hoursToMs(h: number): number {
  return h * 60 * 60 * 1000;
}

/**
 * Roll up a window of RoutedAlertRecord into RoutingAnalytics.
 * Caller is responsible for slicing the window before calling.
 *
 * `now` is the reference clock for "still-open past SLA" and
 * "still-open past escalate_after_hours" — pass the request time.
 */
export function aggregateRoutingAnalytics(
  records: readonly RoutedAlertRecord[],
  now: Date,
): RoutingAnalytics {
  const by_class = emptyByClass();
  const by_channel = emptyByChannel();
  let monitor_only_count = 0;

  const ackedDurations: number[] = [];
  let nonMonitorCount = 0;
  let ackedNonMonitorCount = 0;

  let sla_eligible_count = 0;
  let sla_breach_count = 0;
  let escalation_due_count = 0;

  const nowMs = now.getTime();

  for (const r of records) {
    if (ALL_CLASSES.includes(r.class)) by_class[r.class] += 1;
    for (const c of r.channels) {
      if (ALL_CHANNELS.includes(c)) by_channel[c] += 1;
    }
    if (r.monitor_only) {
      monitor_only_count += 1;
      continue;
    }
    nonMonitorCount += 1;

    const createdMs = new Date(r.created_at).getTime();
    if (!Number.isFinite(createdMs)) continue;

    if (r.acked_at !== null) {
      const ackedMs = new Date(r.acked_at).getTime();
      if (Number.isFinite(ackedMs) && ackedMs >= createdMs) {
        ackedDurations.push(ackedMs - createdMs);
        ackedNonMonitorCount += 1;
      }
    }

    if (r.sla_hours !== null) {
      sla_eligible_count += 1;
      const slaCutoffMs = createdMs + hoursToMs(r.sla_hours);
      if (r.acked_at !== null) {
        const ackedMs = new Date(r.acked_at).getTime();
        if (Number.isFinite(ackedMs) && ackedMs > slaCutoffMs) {
          sla_breach_count += 1;
        }
      } else if (nowMs > slaCutoffMs) {
        sla_breach_count += 1;
      }
    }

    if (r.acked_at === null && r.escalate_after_hours !== null) {
      const escCutoffMs = createdMs + hoursToMs(r.escalate_after_hours);
      if (nowMs > escCutoffMs) escalation_due_count += 1;
    }
  }

  ackedDurations.sort((a, b) => a - b);
  const meanDur =
    ackedDurations.length === 0
      ? null
      : ackedDurations.reduce((s, x) => s + x, 0) / ackedDurations.length;

  const ack_rate = nonMonitorCount === 0 ? null : ackedNonMonitorCount / nonMonitorCount;
  const sla_breach_rate =
    sla_eligible_count === 0 ? null : sla_breach_count / sla_eligible_count;

  return {
    sample_size: records.length,
    by_class,
    by_channel,
    monitor_only_count,
    ack_rate,
    time_to_ack_ms: {
      min: ackedDurations.length === 0 ? null : ackedDurations[0]!,
      mean: meanDur,
      p50: linearPercentile(ackedDurations, 0.5),
      p95: linearPercentile(ackedDurations, 0.95),
      max:
        ackedDurations.length === 0
          ? null
          : ackedDurations[ackedDurations.length - 1]!,
    },
    sla_breach_count,
    sla_eligible_count,
    sla_breach_rate,
    escalation_due_count,
  };
}

// ─── Ledger ───────────────────────────────────────────────────────────

export interface RoutingLedger {
  /** Append a routing snapshot. Older entries past the cap are evicted. */
  record(record: RoutedAlertRecord): void;
  /** Update the acked_at on a prior record for the same (tenant, alert).
   *  Silently no-ops when the alert isn't in the ledger. */
  markAcked(tenant_id: string, alert_id: string, acked_at: string): void;
  /** Newest-first window for a tenant; window 1..MAX. */
  list(tenant_id: string, window: number): RoutedAlertRecord[];
  /** Test helper. */
  reset(): void;
}

const CAP_PER_TENANT = 200;

export class InMemoryRoutingLedger implements RoutingLedger {
  /** tenant_id → records in insertion order (oldest first). */
  private readonly buckets = new Map<string, RoutedAlertRecord[]>();

  private bucket(tenant_id: string): RoutedAlertRecord[] {
    let arr = this.buckets.get(tenant_id);
    if (!arr) {
      arr = [];
      this.buckets.set(tenant_id, arr);
    }
    return arr;
  }

  record(rec: RoutedAlertRecord): void {
    const arr = this.bucket(rec.tenant_id);
    arr.push({ ...rec, channels: [...rec.channels] });
    if (arr.length > CAP_PER_TENANT) {
      arr.splice(0, arr.length - CAP_PER_TENANT);
    }
  }

  markAcked(tenant_id: string, alert_id: string, acked_at: string): void {
    const arr = this.buckets.get(tenant_id);
    if (!arr) return;
    // Update the latest entry matching alert_id (an alert_id can appear
    // more than once if re-ingested; the most recent snapshot wins).
    for (let i = arr.length - 1; i >= 0; i--) {
      if (arr[i]!.alert_id === alert_id) {
        arr[i] = { ...arr[i]!, acked_at };
        return;
      }
    }
  }

  list(tenant_id: string, window: number): RoutedAlertRecord[] {
    if (!Number.isInteger(window) || window < 1) return [];
    const arr = this.buckets.get(tenant_id);
    if (!arr || arr.length === 0) return [];
    const slice = arr.slice(Math.max(0, arr.length - window));
    return slice
      .slice()
      .reverse()
      .map((r) => ({ ...r, channels: [...r.channels] }));
  }

  reset(): void {
    this.buckets.clear();
  }
}

export const defaultRoutingLedger: RoutingLedger = new InMemoryRoutingLedger();

// ─── Limits surfaced to the route ─────────────────────────────────────

export const ROUTING_ANALYTICS_DEFAULT_WINDOW = 50;
export const ROUTING_ANALYTICS_MAX_WINDOW = 200;
