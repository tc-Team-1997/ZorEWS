// services/bff/src/report_subscription_health.ts
// T6 M12.26 — Report subscription health check.

import { defaultReportScheduleStore, type ReportScheduleStore, type ScheduleCadence } from './report_schedules';

export type SubscriptionStatus = 'healthy' | 'overdue' | 'never_run';

export interface SubscriptionHealthRow {
  schedule_id: string;
  name: string;
  cadence: ScheduleCadence;
  last_run_at: string | null;
  days_since_last_run: number | null;
  status: SubscriptionStatus;
}

export interface ReportSubscriptionHealth {
  tenant_id: string;
  generated_at: string;
  total_enabled: number;
  healthy_count: number;
  overdue_count: number;
  never_run_count: number;
  health_score: number;
  schedules: SubscriptionHealthRow[];
  most_overdue_schedule: SubscriptionHealthRow | null;
}

const CADENCE_INTERVAL_DAYS: Record<ScheduleCadence, number> = {
  daily: 1,
  weekly: 7,
  monthly: 30,
  quarterly: 90,
  last_day_of_month: 30,
};

export function buildReportSubscriptionHealth(
  tenant_id: string,
  store: ReportScheduleStore,
  now: Date,
): ReportSubscriptionHealth {
  const page = store.list(tenant_id, 1, 1000);
  const enabled = page.items.filter((s) => s.enabled);

  const rows: SubscriptionHealthRow[] = enabled.map((s) => {
    if (!s.last_run_at) {
      return { schedule_id: s.schedule_id, name: s.name, cadence: s.cadence, last_run_at: null, days_since_last_run: null, status: 'never_run' };
    }
    const days_since_last_run = Math.round((now.getTime() - new Date(s.last_run_at).getTime()) / 86400000 * 100) / 100;
    const expected_interval = CADENCE_INTERVAL_DAYS[s.cadence] ?? 30;
    const status: SubscriptionStatus = days_since_last_run > expected_interval * 1.5 ? 'overdue' : 'healthy';
    return { schedule_id: s.schedule_id, name: s.name, cadence: s.cadence, last_run_at: s.last_run_at, days_since_last_run, status };
  });

  const healthy_count = rows.filter((r) => r.status === 'healthy').length;
  const overdue_count = rows.filter((r) => r.status === 'overdue').length;
  const never_run_count = rows.filter((r) => r.status === 'never_run').length;
  const health_score = rows.length === 0 ? 100 : Math.round((healthy_count / rows.length) * 10000) / 100;

  const overdueRows = rows.filter((r) => r.status === 'overdue' && r.days_since_last_run !== null);
  const most_overdue_schedule = overdueRows.length > 0
    ? overdueRows.reduce((worst, r) => (r.days_since_last_run! > worst.days_since_last_run! ? r : worst))
    : null;

  return { tenant_id, generated_at: now.toISOString(), total_enabled: enabled.length, healthy_count, overdue_count, never_run_count, health_score, schedules: rows, most_overdue_schedule };
}

export { defaultReportScheduleStore };
