// services/bff/src/config_best_practices.ts
// T6 M13.28 — Config best practices compliance

import { type ConfigStore } from './admin_config';

export type PracticeImpact = 'high' | 'medium' | 'low';

export interface BestPractice {
  practice_id: string;
  description: string;
  passed: boolean;
  current_value: unknown;
  recommended_value: unknown;
  impact: PracticeImpact;
}

export interface ConfigBestPractices {
  tenant_id: string;
  generated_at: string;
  compliance_score: number;
  practices: BestPractice[];
  passed_count: number;
  failed_count: number;
  high_impact_failures: string[];
}

export function buildConfigBestPractices(
  store: ConfigStore,
  tenant_id: string,
  now: Date
): ConfigBestPractices {
  const generated_at = now.toISOString();
  const entries = store.list(tenant_id);
  const byKey = new Map(entries.map((e) => [e.key, e.value]));

  const practices: BestPractice[] = [];

  // 1. red_sla_hours <= 4 (aggressive monitoring)
  const redSla = byKey.get('alerts.red_sla_hours');
  practices.push({
    practice_id: 'red_sla_aggressive',
    description: 'Red alert SLA should be ≤ 4 hours for aggressive monitoring.',
    passed: typeof redSla === 'number' && redSla <= 4,
    current_value: redSla,
    recommended_value: 4,
    impact: 'high',
  });

  // 2. yellow_sla_hours >= 48
  const yellowSla = byKey.get('alerts.yellow_sla_hours');
  practices.push({
    practice_id: 'yellow_sla_not_too_aggressive',
    description: 'Yellow alert SLA should be ≥ 48 hours (not too aggressive for low-priority).',
    passed: typeof yellowSla === 'number' && yellowSla >= 48,
    current_value: yellowSla,
    recommended_value: 48,
    impact: 'medium',
  });

  // 3. retention_days >= 90
  const retention = byKey.get('reporting.retention_days');
  practices.push({
    practice_id: 'retention_compliance_minimum',
    description: 'Retention days should be ≥ 90 for compliance minimum.',
    passed: typeof retention === 'number' && retention >= 90,
    current_value: retention,
    recommended_value: 90,
    impact: 'high',
  });

  // 4. maker_checker enabled
  const makerChecker = byKey.get('features.maker_checker_enabled');
  practices.push({
    practice_id: 'maker_checker_enabled',
    description: 'Maker-checker should be enabled for regulatory compliance.',
    passed: makerChecker === true,
    current_value: makerChecker,
    recommended_value: true,
    impact: 'high',
  });

  // 5. daily_report_time_utc in range "04:00"-"08:00" (off-peak)
  const reportTime = byKey.get('reporting.daily_report_time_utc');
  const inOffPeak = typeof reportTime === 'string' && reportTime >= '04:00' && reportTime <= '08:00';
  practices.push({
    practice_id: 'report_time_off_peak',
    description: 'Daily report time should be in 04:00–08:00 UTC (off-peak hours).',
    passed: inOffPeak,
    current_value: reportTime,
    recommended_value: '06:00',
    impact: 'low',
  });

  const passed_count = practices.filter((p) => p.passed).length;
  const failed_count = practices.filter((p) => !p.passed).length;
  const compliance_score = Math.round((passed_count / practices.length) * 100);

  const high_impact_failures = practices
    .filter((p) => !p.passed && p.impact === 'high')
    .map((p) => p.practice_id);

  return {
    tenant_id,
    generated_at,
    compliance_score,
    practices,
    passed_count,
    failed_count,
    high_impact_failures,
  };
}
