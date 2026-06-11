// services/bff/src/report_schedule_optimizer.ts
// T6 M12.27 — Report schedule optimization suggestions.

import {
  defaultReportScheduleStore,
  type ReportScheduleStore,
} from './report_schedules';

export type OptimizationFindingType =
  | 'duplicate_schedules'
  | 'over_scheduled'
  | 'underutilized'
  | 'can_consolidate';

export interface OptimizationFinding {
  type: OptimizationFindingType;
  schedule_ids: string[];
  suggestion: string;
  estimated_monthly_savings_usd: number;
}

export interface ReportScheduleOptimizerResult {
  tenant_id: string;
  generated_at: string;
  total_schedules: number;
  findings: OptimizationFinding[];
  total_savings_estimate_usd: number;
  optimization_score: number;
}

export async function buildReportScheduleOptimization(
  tenant_id: string,
  now: Date,
  store: ReportScheduleStore = defaultReportScheduleStore,
): Promise<ReportScheduleOptimizerResult> {
  if (!tenant_id) throw new Error('tenant_id required');

  const page = store.list(tenant_id, 1, 1000);
  const schedules = page.items;
  const findings: OptimizationFinding[] = [];

  // 1. duplicate_schedules: same report_id + cadence + format by different users
  const dupKey = new Map<string, string[]>();
  for (const s of schedules) {
    const key = `${s.report_id}|${s.cadence}|${s.format}`;
    const arr = dupKey.get(key) ?? [];
    arr.push(s.schedule_id);
    dupKey.set(key, arr);
  }
  for (const [, ids] of dupKey.entries()) {
    if (ids.length > 1) {
      findings.push({
        type: 'duplicate_schedules',
        schedule_ids: ids,
        suggestion: `Merge ${ids.length} duplicate schedules for the same report/cadence/format into one.`,
        estimated_monthly_savings_usd: (ids.length - 1) * 5,
      });
    }
  }

  // 2. over_scheduled: report_id with more than 3 schedules
  const byReport = new Map<string, string[]>();
  for (const s of schedules) {
    const arr = byReport.get(s.report_id) ?? [];
    arr.push(s.schedule_id);
    byReport.set(s.report_id, arr);
  }
  for (const [rpt, ids] of byReport.entries()) {
    if (ids.length > 3) {
      findings.push({
        type: 'over_scheduled',
        schedule_ids: ids,
        suggestion: `Report ${rpt} has ${ids.length} schedules — consider consolidating.`,
        estimated_monthly_savings_usd: (ids.length - 3) * 8,
      });
    }
  }

  // 3. underutilized: enabled schedule with no recipients
  const underutilized = schedules.filter((s) => s.enabled && s.recipients.length === 0);
  if (underutilized.length > 0) {
    findings.push({
      type: 'underutilized',
      schedule_ids: underutilized.map((s) => s.schedule_id),
      suggestion: `${underutilized.length} enabled schedule(s) have no recipients and are wasted compute.`,
      estimated_monthly_savings_usd: underutilized.length * 3,
    });
  }

  // 4. can_consolidate: schedules firing within 1 hour of each other with same format
  const withNextRun = schedules.filter((s) => s.enabled && s.next_run_at !== null);
  const sorted = [...withNextRun].sort(
    (a, b) => new Date(a.next_run_at!).getTime() - new Date(b.next_run_at!).getTime(),
  );
  const consolidateIds = new Set<string>();
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i];
    const b = sorted[i + 1];
    const gapMs = new Date(b.next_run_at!).getTime() - new Date(a.next_run_at!).getTime();
    if (gapMs <= 3600000 && a.format === b.format && a.schedule_id !== b.schedule_id) {
      consolidateIds.add(a.schedule_id);
      consolidateIds.add(b.schedule_id);
    }
  }
  if (consolidateIds.size > 0) {
    findings.push({
      type: 'can_consolidate',
      schedule_ids: [...consolidateIds],
      suggestion: `${consolidateIds.size} schedules fire within 1 hour of each other with the same format — stagger or merge.`,
      estimated_monthly_savings_usd: Math.floor(consolidateIds.size / 2) * 4,
    });
  }

  const total_savings_estimate_usd = findings.reduce((s, f) => s + f.estimated_monthly_savings_usd, 0);
  const optimization_score = Math.max(0, 100 - findings.length * 5);

  return {
    tenant_id,
    generated_at: now.toISOString(),
    total_schedules: schedules.length,
    findings,
    total_savings_estimate_usd,
    optimization_score,
  };
}
