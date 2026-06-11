// services/bff/src/alert_sla_achievement.ts
// T6 M8.29 — Alert SLA target achievement rate

import { type RoutingLedger, type RoutedAlertRecord } from './alert_routing_analytics';
import { BIL_CLASS_ORDER, type BilAlertClass } from './bil_alert_classification';

const SLA_HOURS: Record<BilAlertClass, number> = {
  red: 4,
  orange: 24,
  yellow: 72,
  green: 0, // monitor-only, no SLA
};

export interface SlaClassAchievement {
  class: BilAlertClass;
  total_eligible: number;
  sla_met_count: number;
  sla_achievement_pct: number;
  avg_ack_hours: number | null;
  within_sla_avg_hours: number | null;
  breach_avg_hours: number | null;
}

export interface AlertSlaAchievement {
  tenant_id: string;
  generated_at: string;
  by_class: SlaClassAchievement[];
  overall_achievement_pct: number;
  trend: 'improving' | 'declining' | 'stable';
  sla_champion_class: BilAlertClass | null;
  sla_laggard_class: BilAlertClass | null;
}

export function buildAlertSlaAchievement(
  ledger: RoutingLedger,
  tenant_id: string,
  now: Date
): AlertSlaAchievement {
  const generated_at = now.toISOString();
  const records = ledger.list(tenant_id, 200);

  const by_class: SlaClassAchievement[] = BIL_CLASS_ORDER.map((cls) => {
    const sla_hours = SLA_HOURS[cls];
    if (cls === 'green') {
      return {
        class: cls,
        total_eligible: 0,
        sla_met_count: 0,
        sla_achievement_pct: 100,
        avg_ack_hours: null,
        within_sla_avg_hours: null,
        breach_avg_hours: null,
      };
    }

    const eligible = records.filter((r) => r.class === cls && !r.monitor_only && r.sla_hours !== null);
    const ackedRecords = eligible.filter((r) => r.acked_at !== null);

    const sla_met_count = ackedRecords.filter((r) => {
      const ackMs = new Date(r.acked_at!).getTime() - new Date(r.created_at).getTime();
      const ackHours = ackMs / (1000 * 60 * 60);
      return ackHours <= sla_hours;
    }).length;

    const sla_achievement_pct = eligible.length > 0
      ? Math.round((sla_met_count / eligible.length) * 100)
      : 100;

    const ackHoursAll = ackedRecords.map((r) =>
      (new Date(r.acked_at!).getTime() - new Date(r.created_at).getTime()) / (1000 * 60 * 60)
    );
    const avg_ack_hours = ackHoursAll.length > 0
      ? Math.round((ackHoursAll.reduce((s, h) => s + h, 0) / ackHoursAll.length) * 100) / 100
      : null;

    const withinSlaHours = ackedRecords
      .filter((r) => {
        const h = (new Date(r.acked_at!).getTime() - new Date(r.created_at).getTime()) / (1000 * 60 * 60);
        return h <= sla_hours;
      })
      .map((r) => (new Date(r.acked_at!).getTime() - new Date(r.created_at).getTime()) / (1000 * 60 * 60));

    const within_sla_avg_hours = withinSlaHours.length > 0
      ? Math.round((withinSlaHours.reduce((s, h) => s + h, 0) / withinSlaHours.length) * 100) / 100
      : null;

    const breachHours = ackedRecords
      .filter((r) => {
        const h = (new Date(r.acked_at!).getTime() - new Date(r.created_at).getTime()) / (1000 * 60 * 60);
        return h > sla_hours;
      })
      .map((r) => (new Date(r.acked_at!).getTime() - new Date(r.created_at).getTime()) / (1000 * 60 * 60));

    const breach_avg_hours = breachHours.length > 0
      ? Math.round((breachHours.reduce((s, h) => s + h, 0) / breachHours.length) * 100) / 100
      : null;

    return {
      class: cls,
      total_eligible: eligible.length,
      sla_met_count,
      sla_achievement_pct,
      avg_ack_hours,
      within_sla_avg_hours,
      breach_avg_hours,
    };
  });

  const eligibleClasses = by_class.filter((c) => c.total_eligible > 0);
  const overall_achievement_pct = eligibleClasses.length > 0
    ? Math.round(
        eligibleClasses.reduce((s, c) => s + c.sla_achievement_pct, 0) / eligibleClasses.length
      )
    : 100;

  // Trend: compare first half vs second half
  const half = Math.floor(records.length / 2);
  const firstHalf = records.slice(0, half);
  const secondHalf = records.slice(half);

  const achievementForHalf = (recs: RoutedAlertRecord[]) => {
    const eligible = recs.filter((r) => !r.monitor_only && r.acked_at !== null && r.sla_hours !== null);
    if (eligible.length === 0) return 100;
    const met = eligible.filter((r) => {
      const sla = SLA_HOURS[r.class] ?? 0;
      const ackH = (new Date(r.acked_at!).getTime() - new Date(r.created_at).getTime()) / (1000 * 60 * 60);
      return ackH <= sla;
    }).length;
    return (met / eligible.length) * 100;
  };

  const firstAch = achievementForHalf(firstHalf);
  const secondAch = achievementForHalf(secondHalf);
  const diff = secondAch - firstAch;
  const trend: 'improving' | 'declining' | 'stable' =
    diff > 5 ? 'improving' : diff < -5 ? 'declining' : 'stable';

  const nonGreenEligible = by_class.filter((c) => c.class !== 'green' && c.total_eligible > 0);
  const sla_champion_class = nonGreenEligible.length > 0
    ? nonGreenEligible.reduce((best, c) =>
        c.sla_achievement_pct > best.sla_achievement_pct ? c : best
      ).class
    : null;

  const sla_laggard_class = nonGreenEligible.length > 0
    ? nonGreenEligible.reduce((worst, c) =>
        c.sla_achievement_pct < worst.sla_achievement_pct ? c : worst
      ).class
    : null;

  return {
    tenant_id,
    generated_at,
    by_class,
    overall_achievement_pct,
    trend,
    sla_champion_class,
    sla_laggard_class,
  };
}
