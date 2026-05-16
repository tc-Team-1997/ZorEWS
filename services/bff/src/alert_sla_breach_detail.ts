// services/bff/src/alert_sla_breach_detail.ts
//
// T6 M8.11 — Alert SLA breach detail.
//
// M8.6 ships ROUTING ANALYTICS over the recent ledger window — counts
// alerts by class + channel + monitor_only + ack_rate + p50/p95 ack
// latency + sla_breach_count + escalation_due_count. The numbers
// answer "how is the routing matrix performing?" but they don't tell
// the operator WHICH alerts are breaching or escalation-due. The SPA
// has to render a detail panel that lists the actual rows; today that
// surface doesn't exist and the supervisor falls back to scrolling
// /v1/alerts.
//
// M8.11 closes the gap: a per-record classification + sorted detail
// lists for the SPA to render directly. Each routed-alert record is
// classified into one of 7 status buckets based on (sla_hours,
// escalate_after_hours, acked_at, now), with derived deadline
// timestamps + signed ms_past_sla. Breaching alerts (open_breached
// + acked_late) and escalation-due alerts (open + past escalate but
// within SLA) are surfaced as separate sorted lists.
//
// Pure resolver over RoutedAlertRecord[] + now. The route drains the
// existing routing ledger; no new persistence surface.
//
// Mirror of M9.5 (case SLA breach) for alerts.

import type { BilAlertClass } from './bil_alert_classification';
import type { NotificationChannel } from './alert_routing';
import type { RoutedAlertRecord } from './alert_routing_analytics';

// ─── Public types ─────────────────────────────────────────────────────

export type AlertBreachStatus =
  /** acked_at present, ack happened within sla_hours of created_at. */
  | 'acked_on_time'
  /** acked_at present, ack happened AFTER sla_hours window. */
  | 'acked_late'
  /** Still open; now - created < escalate_after (or escalate_after null). */
  | 'open_within_sla'
  /** Still open; now - created ≥ escalate_after AND < sla_hours.
   *  Supervisor's "respond now" signal — not yet a breach. */
  | 'open_escalation_due'
  /** Still open; now - created ≥ sla_hours. The actual breach. */
  | 'open_breached'
  /** Green-class / monitor_only=true. No SLA semantics. */
  | 'monitor_only'
  /** Non-monitor record but sla_hours is null (operator override
   *  cleared the SLA). No breach computable. */
  | 'no_sla_configured';

export const ALL_BREACH_STATUSES: readonly AlertBreachStatus[] = [
  'acked_on_time',
  'acked_late',
  'open_within_sla',
  'open_escalation_due',
  'open_breached',
  'monitor_only',
  'no_sla_configured',
] as const;

export interface AlertBreachRow {
  alert_id: string;
  class: BilAlertClass;
  severity_in: string;
  created_at: string;
  channels: NotificationChannel[];
  sla_hours: number | null;
  escalate_after_hours: number | null;
  acked_at: string | null;
  /** ms elapsed since `created_at`: created → acked when acked,
   *  else created → now. Always ≥ 0. */
  age_ms: number;
  /** `created + sla_hours` ISO. null when no SLA or monitor_only. */
  sla_deadline_at: string | null;
  /** `created + escalate_after_hours` ISO. null when no escalation
   *  window or monitor_only. */
  escalation_deadline_at: string | null;
  /** Signed milliseconds past the SLA deadline (age − sla_hours).
   *  Positive → breached, negative → within window. null when no
   *  SLA or monitor_only. For acked rows this is acked_at − deadline. */
  ms_past_sla: number | null;
  status: AlertBreachStatus;
}

export interface AlertSlaBreachSummary {
  tenant_id: string;
  generated_at: string;
  /** Newest-first window the resolver scanned. */
  window: number;
  sample_size: number;
  /** Count per status. Every ALL_BREACH_STATUSES key present at 0
   *  when absent (stable SPA grid). */
  by_status: Record<AlertBreachStatus, number>;
  /** Per-class counts among BREACHING rows only (open_breached +
   *  acked_late). Every class key present at 0 when absent. */
  breaching_by_class: Record<BilAlertClass, number>;
  /** Hard breach list = open_breached + acked_late. Sorted by
   *  ms_past_sla desc (worst first), with alert_id asc tie-break. */
  breaching: AlertBreachRow[];
  /** Open-and-escalation-due list = open_escalation_due. Sorted by
   *  created_at asc (oldest first — needs supervisor first), then
   *  alert_id asc tie-break. */
  escalation_due: AlertBreachRow[];
  /** Top row of `breaching` (highest ms_past_sla). null when empty. */
  worst_offender: {
    alert_id: string;
    class: BilAlertClass;
    ms_past_sla: number;
  } | null;
}

// ─── Helpers ──────────────────────────────────────────────────────────

const MS_PER_HOUR = 60 * 60 * 1000;

function emptyByStatus(): Record<AlertBreachStatus, number> {
  return {
    acked_on_time: 0,
    acked_late: 0,
    open_within_sla: 0,
    open_escalation_due: 0,
    open_breached: 0,
    monitor_only: 0,
    no_sla_configured: 0,
  };
}

function emptyByClass(): Record<BilAlertClass, number> {
  return { red: 0, orange: 0, yellow: 0, green: 0 };
}

function addHoursIso(base: string, hours: number): string {
  return new Date(new Date(base).getTime() + hours * MS_PER_HOUR).toISOString();
}

function classifyRecord(rec: RoutedAlertRecord, now: Date): AlertBreachRow {
  const created = new Date(rec.created_at).getTime();
  const nowMs = now.getTime();
  const acked = rec.acked_at !== null ? new Date(rec.acked_at).getTime() : null;
  const age_ms = Math.max(0, (acked !== null ? acked : nowMs) - created);

  const sla_deadline_at = rec.monitor_only || rec.sla_hours === null
    ? null
    : addHoursIso(rec.created_at, rec.sla_hours);
  const escalation_deadline_at = rec.monitor_only || rec.escalate_after_hours === null
    ? null
    : addHoursIso(rec.created_at, rec.escalate_after_hours);

  let ms_past_sla: number | null = null;
  if (!rec.monitor_only && rec.sla_hours !== null) {
    const slaMs = rec.sla_hours * MS_PER_HOUR;
    ms_past_sla = age_ms - slaMs;
  }

  let status: AlertBreachStatus;
  if (rec.monitor_only) {
    status = 'monitor_only';
  } else if (rec.sla_hours === null) {
    status = 'no_sla_configured';
  } else if (acked !== null) {
    status = ms_past_sla! > 0 ? 'acked_late' : 'acked_on_time';
  } else {
    // Open. Check breach first, then escalation, then within_sla.
    if (ms_past_sla! >= 0) {
      status = 'open_breached';
    } else if (
      rec.escalate_after_hours !== null
      && age_ms >= rec.escalate_after_hours * MS_PER_HOUR
    ) {
      status = 'open_escalation_due';
    } else {
      status = 'open_within_sla';
    }
  }

  return {
    alert_id: rec.alert_id,
    class: rec.class,
    severity_in: rec.severity_in,
    created_at: rec.created_at,
    channels: [...rec.channels],
    sla_hours: rec.sla_hours,
    escalate_after_hours: rec.escalate_after_hours,
    acked_at: rec.acked_at,
    age_ms,
    sla_deadline_at,
    escalation_deadline_at,
    ms_past_sla,
    status,
  };
}

// ─── Pure resolver ────────────────────────────────────────────────────

export function summarizeAlertSlaBreaches(
  tenant_id: string,
  records: readonly RoutedAlertRecord[],
  window: number,
  now: Date,
): AlertSlaBreachSummary {
  const rows = records.map((r) => classifyRecord(r, now));
  const by_status = emptyByStatus();
  const breaching_by_class = emptyByClass();
  const breaching: AlertBreachRow[] = [];
  const escalation_due: AlertBreachRow[] = [];

  for (const row of rows) {
    by_status[row.status]++;
    if (row.status === 'open_breached' || row.status === 'acked_late') {
      breaching.push(row);
      breaching_by_class[row.class]++;
    } else if (row.status === 'open_escalation_due') {
      escalation_due.push(row);
    }
  }

  // breaching: ms_past_sla desc with alert_id asc tie-break.
  // ms_past_sla guaranteed non-null on every breaching row by status above.
  breaching.sort((a, b) => {
    const da = a.ms_past_sla!;
    const db = b.ms_past_sla!;
    if (db !== da) return db - da;
    return a.alert_id.localeCompare(b.alert_id);
  });

  // escalation_due: created_at asc (oldest first), alert_id asc tie.
  escalation_due.sort((a, b) => {
    if (a.created_at !== b.created_at) return a.created_at < b.created_at ? -1 : 1;
    return a.alert_id.localeCompare(b.alert_id);
  });

  const worst_offender = breaching.length > 0
    ? {
        alert_id: breaching[0]!.alert_id,
        class: breaching[0]!.class,
        ms_past_sla: breaching[0]!.ms_past_sla!,
      }
    : null;

  return {
    tenant_id,
    generated_at: now.toISOString(),
    window,
    sample_size: rows.length,
    by_status,
    breaching_by_class,
    breaching,
    escalation_due,
    worst_offender,
  };
}
