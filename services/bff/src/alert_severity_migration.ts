// services/bff/src/alert_severity_migration.ts
// T6 M8.26 — Alert severity migration over time.
// Analyzes BIL class distribution across 3 time windows in the routing ledger.

import { type RoutingLedger } from './alert_routing_analytics';

export type SeverityTrend = 'increasing' | 'decreasing' | 'stable';
export type RiskTrajectory = 'improving' | 'worsening' | 'stable';

export interface SeverityWindow {
  window: 'early' | 'mid' | 'recent';
  red_pct: number;
  orange_pct: number;
  yellow_pct: number;
  green_pct: number;
}

export interface AlertSeverityMigrationResult {
  tenant_id: string;
  generated_at: string;
  total_records: number;
  windows: SeverityWindow[];
  red_trend: SeverityTrend;
  critical_escalation_rate: number; // records where class='red' / total
  risk_trajectory: RiskTrajectory;
}

function pct(count: number, total: number): number {
  if (total === 0) return 0;
  return Math.round((count / total) * 10000) / 10000;
}

function buildWindow(
  label: 'early' | 'mid' | 'recent',
  slice: Array<{ class: string }>,
): SeverityWindow {
  const total = slice.length;
  const red = slice.filter((r) => r.class === 'red').length;
  const orange = slice.filter((r) => r.class === 'orange').length;
  const yellow = slice.filter((r) => r.class === 'yellow').length;
  const green = slice.filter((r) => r.class === 'green').length;
  return {
    window: label,
    red_pct: pct(red, total),
    orange_pct: pct(orange, total),
    yellow_pct: pct(yellow, total),
    green_pct: pct(green, total),
  };
}

export function buildAlertSeverityMigration(
  ledger: RoutingLedger,
  tenant_id: string,
  now: Date,
): AlertSeverityMigrationResult {
  if (!tenant_id) throw new Error('tenant_id required');

  const records = ledger.list(tenant_id, 200);
  const total = records.length;

  if (total === 0) {
    return {
      tenant_id,
      generated_at: now.toISOString(),
      total_records: 0,
      windows: [
        buildWindow('early', []),
        buildWindow('mid', []),
        buildWindow('recent', []),
      ],
      red_trend: 'stable',
      critical_escalation_rate: 0,
      risk_trajectory: 'stable',
    };
  }

  // Split into 3 equal windows
  const third = Math.floor(total / 3);
  const earlySlice = records.slice(0, third);
  const midSlice = records.slice(third, third * 2);
  const recentSlice = records.slice(third * 2);

  const earlyWindow = buildWindow('early', earlySlice);
  const midWindow = buildWindow('mid', midSlice);
  const recentWindow = buildWindow('recent', recentSlice);

  // Red trend: compare early vs recent pct, threshold ±5%
  const redDiff = recentWindow.red_pct - earlyWindow.red_pct;
  let red_trend: SeverityTrend;
  if (redDiff > 0.05) red_trend = 'increasing';
  else if (redDiff < -0.05) red_trend = 'decreasing';
  else red_trend = 'stable';

  const redCount = records.filter((r) => r.class === 'red').length;
  const critical_escalation_rate = pct(redCount, total);

  // risk_trajectory: if red is decreasing → improving, increasing → worsening, stable
  let risk_trajectory: RiskTrajectory;
  if (red_trend === 'decreasing') risk_trajectory = 'improving';
  else if (red_trend === 'increasing') risk_trajectory = 'worsening';
  else risk_trajectory = 'stable';

  return {
    tenant_id,
    generated_at: now.toISOString(),
    total_records: total,
    windows: [earlyWindow, midWindow, recentWindow],
    red_trend,
    critical_escalation_rate,
    risk_trajectory,
  };
}
