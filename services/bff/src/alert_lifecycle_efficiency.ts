// services/bff/src/alert_lifecycle_efficiency.ts
//
// T6 M8.22 — Alert lifecycle SLA efficiency score.
//
// Computes per-class efficiency metrics from the M8.6 routing ledger:
// - met_sla_pct: % of SLA-eligible alerts acked within SLA
// - avg_ack_time_vs_sla_pct: ratio of actual ack time vs SLA (lower=better)
// - efficiency_grade: A/B/C/D/F
// Fleet-wide score (0-100) + per-class breakdown.

import type { RoutedAlertRecord } from './alert_routing_analytics';
import type { BilAlertClass } from './bil_alert_classification';

// ─── Public types ──────────────────────────────────────────────────────

export type EfficiencyGrade = 'A' | 'B' | 'C' | 'D' | 'F';

export interface ClassEfficiency {
  class: BilAlertClass;
  total_records: number;
  sla_eligible: number;
  met_sla_count: number;
  met_sla_pct: number;
  avg_ack_time_ms: number | null;
  avg_sla_ms: number | null;
  avg_ack_time_vs_sla_pct: number | null;
  efficiency_grade: EfficiencyGrade;
}

export interface AlertLifecycleEfficiency {
  tenant_id: string;
  generated_at: string;
  window: number;
  total_records: number;
  by_class: Record<BilAlertClass, ClassEfficiency>;
  fleet_efficiency_score: number;
  most_efficient_class: BilAlertClass | null;
  least_efficient_class: BilAlertClass | null;
}

// ─── Helpers ───────────────────────────────────────────────────────────

function gradeFor(met_pct: number, avg_vs_sla: number | null): EfficiencyGrade {
  // Grade based on SLA compliance rate
  if (met_pct >= 0.95) return 'A';
  if (met_pct >= 0.85) return 'B';
  if (met_pct >= 0.70) return 'C';
  if (met_pct >= 0.50) return 'D';
  return 'F';
}

const BIL_CLASSES: BilAlertClass[] = ['red', 'orange', 'yellow', 'green'];
const GRADE_SCORES: Record<EfficiencyGrade, number> = { A: 100, B: 80, C: 60, D: 40, F: 20 };

// ─── Pure function ─────────────────────────────────────────────────────

export function buildAlertLifecycleEfficiency(
  tenant_id: string,
  records: RoutedAlertRecord[],
  _ackHistory: unknown,
  window: number,
  now: Date,
): AlertLifecycleEfficiency {
  const generated_at = now.toISOString();
  const total_records = records.length;

  const by_class = {} as Record<BilAlertClass, ClassEfficiency>;

  for (const cls of BIL_CLASSES) {
    const classRecords = records.filter(r => r.class === cls);
    const slaEligible = classRecords.filter(r => !r.monitor_only && r.sla_hours != null);

    let metSla = 0;
    const ackTimes: number[] = [];

    for (const r of slaEligible) {
      if (r.acked_at == null) continue;

      const createdMs = new Date(r.created_at).getTime();
      const ackedMs = new Date(r.acked_at).getTime();
      const ackTimeMs = ackedMs - createdMs;
      const slaMs = (r.sla_hours ?? 24) * 3600_000;

      ackTimes.push(ackTimeMs);
      if (ackTimeMs <= slaMs) metSla++;
    }

    const sla_eligible = slaEligible.length;
    const met_sla_pct = sla_eligible > 0 ? metSla / sla_eligible : 0;

    const avg_ack_time_ms = ackTimes.length > 0
      ? Math.round(ackTimes.reduce((s, x) => s + x, 0) / ackTimes.length)
      : null;

    // avg SLA for eligible records
    const slaValues = slaEligible.map(r => (r.sla_hours ?? 24) * 3600_000);
    const avg_sla_ms = slaValues.length > 0
      ? Math.round(slaValues.reduce((s, x) => s + x, 0) / slaValues.length)
      : null;

    const avg_ack_time_vs_sla_pct =
      avg_ack_time_ms != null && avg_sla_ms != null && avg_sla_ms > 0
        ? Math.round((avg_ack_time_ms / avg_sla_ms) * 100)
        : null;

    by_class[cls] = {
      class: cls,
      total_records: classRecords.length,
      sla_eligible,
      met_sla_count: metSla,
      met_sla_pct: Math.round(met_sla_pct * 10000) / 10000,
      avg_ack_time_ms,
      avg_sla_ms,
      avg_ack_time_vs_sla_pct,
      efficiency_grade: gradeFor(met_sla_pct, avg_ack_time_vs_sla_pct),
    };
  }

  // Fleet efficiency score: weighted mean grade score
  // Weight: red=4, orange=3, yellow=2, green=1 (importance)
  const weights: Record<BilAlertClass, number> = { red: 4, orange: 3, yellow: 2, green: 1 };
  let weightedScore = 0;
  let totalWeight = 0;
  for (const cls of BIL_CLASSES) {
    const eff = by_class[cls];
    if (!eff || eff.sla_eligible === 0) continue;
    const w = weights[cls];
    weightedScore += GRADE_SCORES[eff.efficiency_grade] * w;
    totalWeight += w;
  }
  const fleet_efficiency_score = totalWeight > 0
    ? Math.round(weightedScore / totalWeight)
    : 100; // vacuously perfect when no SLA-eligible records

  // Most/least efficient among classes with eligible records
  const eligible_classes = BIL_CLASSES.filter(c => by_class[c].sla_eligible > 0);
  const most_efficient_class = eligible_classes.length > 0
    ? eligible_classes.reduce((best, cls) =>
        by_class[cls].met_sla_pct > by_class[best].met_sla_pct ? cls : best,
      eligible_classes[0]!)
    : null;
  const least_efficient_class = eligible_classes.length > 0
    ? eligible_classes.reduce((worst, cls) =>
        by_class[cls].met_sla_pct < by_class[worst].met_sla_pct ? cls : worst,
      eligible_classes[0]!)
    : null;

  return {
    tenant_id,
    generated_at,
    window,
    total_records,
    by_class,
    fleet_efficiency_score,
    most_efficient_class,
    least_efficient_class,
  };
}
