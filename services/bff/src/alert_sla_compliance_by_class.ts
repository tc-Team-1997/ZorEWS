// services/bff/src/alert_sla_compliance_by_class.ts
//
// T6 M8.16 — Alert SLA compliance rate by class.
//
// M8.11 ships the SLA breach detail list (per-row classification +
// worst-offender list). M8.12 ships ack-time histogram. M8.13/M8.14
// ship channel + class×channel distributions. M8.15 ships daily volume.
//
// M8.16 lands the PER-CLASS SLA COMPLIANCE RATE rollup over the M8.6
// routing ledger. For each BIL alert class (red/orange/yellow/green),
// compute compliance_rate = on_time / sla_eligible_count over the
// window. Mirror of M14.26 SLA budget pattern for the alert surface.
//
// Distinct from M8.11 (worst-offender row list) by being an aggregate
// rate; distinct from M8.15 (daily volume) by being class-pivoted not
// time-bucketed. Drives "what's our SLA compliance per class? are
// red-class alerts always missing SLA?" view in one round-trip.
//
// Pure resolver — caller passes drained M8.6 routing-ledger window.

import type { RoutedAlertRecord } from './alert_routing_analytics';
import type { BilAlertClass } from './bil_alert_classification';

// ─── Canonical class order (worst-first) ──────────────────────────────

const ALL_CLASSES: readonly BilAlertClass[] = [
  'red',
  'orange',
  'yellow',
  'green',
] as const;

// ─── Public types ──────────────────────────────────────────────────────

export interface AlertSlaComplianceRow {
  class: BilAlertClass;
  /** Total records in this class within the window. */
  total: number;
  /** Records subject to SLA evaluation (sla_hours != null AND
   *  !monitor_only — green's monitor_only=true exclusion). */
  sla_eligible_count: number;
  /** Records acked within their SLA window. */
  on_time_count: number;
  /** Records acked past SLA. */
  late_count: number;
  /** Records still open AND past SLA (open_breached). */
  open_breached_count: number;
  /** Total breaches = late + open_breached. */
  total_breach_count: number;
  /** compliance_rate = on_time / sla_eligible; null when 0. */
  compliance_rate: number | null;
  /** breach_rate = total_breach / sla_eligible; null when 0. */
  breach_rate: number | null;
}

export interface AlertSlaComplianceSummary {
  tenant_id: string;
  generated_at: string;
  window: number;
  total_records: number;
  total_sla_eligible: number;
  total_breaches: number;
  classes: AlertSlaComplianceRow[];
  /** Overall compliance_rate = Σ on_time / Σ sla_eligible; null when 0. */
  overall_compliance_rate: number | null;
  /** Class with the WORST compliance_rate (most failing); canonical
   *  worst-first tie-break (red wins over orange at tied; null when
   *  no eligible). */
  worst_class: BilAlertClass | null;
  /** Class with the BEST compliance_rate; canonical worst-first
   *  tie-break (red wins over orange at tied — keep canonical
   *  semantics consistent); null when no eligible. */
  best_class: BilAlertClass | null;
}

// ─── Helpers ───────────────────────────────────────────────────────────

function emptyRow(cls: BilAlertClass): AlertSlaComplianceRow {
  return {
    class: cls,
    total: 0,
    sla_eligible_count: 0,
    on_time_count: 0,
    late_count: 0,
    open_breached_count: 0,
    total_breach_count: 0,
    compliance_rate: null,
    breach_rate: null,
  };
}

function ageMsAt(record: RoutedAlertRecord, now: Date): number {
  const created = new Date(record.created_at).getTime();
  const refTime = record.acked_at
    ? new Date(record.acked_at).getTime()
    : now.getTime();
  return Math.max(0, refTime - created);
}

// ─── Pure resolver ─────────────────────────────────────────────────────

export function summarizeAlertSlaComplianceByClass(
  tenant_id: string,
  records: readonly RoutedAlertRecord[],
  window: number,
  now: Date,
): AlertSlaComplianceSummary {
  const rows: Record<BilAlertClass, AlertSlaComplianceRow> = {} as never;
  for (const cls of ALL_CLASSES) rows[cls] = emptyRow(cls);

  for (const r of records) {
    if (!ALL_CLASSES.includes(r.class)) continue;
    const row = rows[r.class];
    row.total++;

    // monitor_only OR sla_hours=null excluded from SLA evaluation.
    if (r.monitor_only || r.sla_hours === null) continue;

    row.sla_eligible_count++;
    const slaMs = r.sla_hours * 60 * 60 * 1000;
    const age_ms = ageMsAt(r, now);

    if (r.acked_at) {
      if (age_ms <= slaMs) {
        row.on_time_count++;
      } else {
        row.late_count++;
        row.total_breach_count++;
      }
    } else {
      // open — if past SLA, it's a breach
      if (age_ms > slaMs) {
        row.open_breached_count++;
        row.total_breach_count++;
      } else {
        // still within SLA, counts as "on_time" by definition (not late YET)
        row.on_time_count++;
      }
    }
  }

  // Finalise rates.
  for (const cls of ALL_CLASSES) {
    const row = rows[cls];
    if (row.sla_eligible_count > 0) {
      row.compliance_rate = row.on_time_count / row.sla_eligible_count;
      row.breach_rate = row.total_breach_count / row.sla_eligible_count;
    }
  }

  const classes = ALL_CLASSES.map((cls) => rows[cls]);

  // Aggregate totals.
  const total_records = classes.reduce((acc, r) => acc + r.total, 0);
  const total_sla_eligible = classes.reduce((acc, r) => acc + r.sla_eligible_count, 0);
  const total_breaches = classes.reduce((acc, r) => acc + r.total_breach_count, 0);
  const total_on_time = classes.reduce((acc, r) => acc + r.on_time_count, 0);
  const overall_compliance_rate = total_sla_eligible === 0
    ? null
    : total_on_time / total_sla_eligible;

  // worst_class — lowest compliance_rate among classes with sla_eligible > 0;
  // canonical worst-first tie-break (red wins over orange at tied — keep
  // the canonical semantics consistent across the M8 family).
  let worst_class: BilAlertClass | null = null;
  let worstRate = Infinity;
  for (const cls of ALL_CLASSES) {
    const r = rows[cls];
    if (r.sla_eligible_count === 0) continue;
    if (r.compliance_rate !== null && r.compliance_rate < worstRate) {
      worstRate = r.compliance_rate;
      worst_class = cls;
    }
  }

  // best_class — highest compliance_rate; canonical tie-break.
  let best_class: BilAlertClass | null = null;
  let bestRate = -Infinity;
  for (const cls of ALL_CLASSES) {
    const r = rows[cls];
    if (r.sla_eligible_count === 0) continue;
    if (r.compliance_rate !== null && r.compliance_rate > bestRate) {
      bestRate = r.compliance_rate;
      best_class = cls;
    }
  }

  return {
    tenant_id,
    generated_at: now.toISOString(),
    window,
    total_records,
    total_sla_eligible,
    total_breaches,
    classes,
    overall_compliance_rate,
    worst_class,
    best_class,
  };
}
