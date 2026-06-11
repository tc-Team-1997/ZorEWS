// services/bff/src/alert_routing_efficiency.ts
// T6 M8.28 — Alert routing efficiency analysis.

import { defaultRoutingLedger, type RoutingLedger } from './alert_routing_analytics';
import type { BilAlertClass } from './bil_alert_classification';

export interface RoutingEfficiencyByClass {
  class: BilAlertClass;
  total: number;
  routed_correctly: number;
  escalated: number;
  routing_efficiency_pct: number;
}

export interface AlertRoutingEfficiencyResult {
  tenant_id: string;
  generated_at: string;
  total_routed: number;
  overall_routing_efficiency_pct: number;
  by_class: RoutingEfficiencyByClass[];
  most_efficient_class: BilAlertClass | null;
  least_efficient_class: BilAlertClass | null;
}

const ALL_CLASSES: BilAlertClass[] = ['red', 'orange', 'yellow', 'green'];

export function buildAlertRoutingEfficiency(
  tenant_id: string,
  now: Date,
  ledger: RoutingLedger = defaultRoutingLedger,
): AlertRoutingEfficiencyResult {
  if (!tenant_id) throw new Error('tenant_id required');

  const records = ledger.list(tenant_id, 200);

  const byClass = new Map<BilAlertClass, { total: number; routed_correctly: number; escalated: number }>();
  for (const cls of ALL_CLASSES) {
    byClass.set(cls, { total: 0, routed_correctly: 0, escalated: 0 });
  }

  for (const r of records) {
    const bucket = byClass.get(r.class);
    if (!bucket) continue;
    bucket.total++;

    if (r.monitor_only) {
      // monitor-only (green) — always "routed correctly"
      bucket.routed_correctly++;
    } else if (r.sla_hours !== null) {
      // has SLA — check if acked on time
      if (r.acked_at !== null) {
        const ageMs = new Date(r.acked_at).getTime() - new Date(r.created_at).getTime();
        const slaMs = r.sla_hours * 3600000;
        if (ageMs <= slaMs) {
          bucket.routed_correctly++;
        } else {
          bucket.escalated++;
        }
      } else {
        // open — check if past SLA
        const ageMs = now.getTime() - new Date(r.created_at).getTime();
        const slaMs = r.sla_hours * 3600000;
        if (ageMs > slaMs) {
          bucket.escalated++;
        } else {
          bucket.routed_correctly++;
        }
      }
    } else {
      // no SLA configured — treat as routed correctly
      bucket.routed_correctly++;
    }
  }

  const by_class: RoutingEfficiencyByClass[] = ALL_CLASSES.map((cls) => {
    const b = byClass.get(cls)!;
    const efficiency_pct =
      b.total === 0 ? 100 : Math.round((b.routed_correctly / b.total) * 100);
    return {
      class: cls,
      total: b.total,
      routed_correctly: b.routed_correctly,
      escalated: b.escalated,
      routing_efficiency_pct: efficiency_pct,
    };
  });

  const total_routed = records.length;
  const total_correct = by_class.reduce((s, c) => s + c.routed_correctly, 0);
  const overall_routing_efficiency_pct =
    total_routed === 0 ? 100 : Math.round((total_correct / total_routed) * 100);

  const withData = by_class.filter((c) => c.total > 0);
  const most_efficient_class =
    withData.length === 0
      ? null
      : withData.reduce((best, c) =>
          c.routing_efficiency_pct > best.routing_efficiency_pct ? c : best,
        ).class;
  const least_efficient_class =
    withData.length === 0
      ? null
      : withData.reduce((worst, c) =>
          c.routing_efficiency_pct < worst.routing_efficiency_pct ? c : worst,
        ).class;

  return {
    tenant_id,
    generated_at: now.toISOString(),
    total_routed,
    overall_routing_efficiency_pct,
    by_class,
    most_efficient_class,
    least_efficient_class,
  };
}
