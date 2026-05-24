// web/src/modules/reports/schedulerApi.ts
//
// Module 3.3 — scheduler tick + schedule listing for the SPA. Wraps
// the M3.3 POST /v1/reports/schedules/tick + existing M12.2 list +
// upcoming routes used by the ReportsPage SchedulerPanel.

import { http } from '@/lib/http';
import type { EnvelopeBody } from '@/lib/api';

export type ScheduleCadence =
  | 'daily'
  | 'weekly'
  | 'monthly'
  | 'quarterly'
  | 'last_day_of_month';

export type ReportFormat = 'json' | 'csv' | 'pdf' | 'xlsx';

export interface ScheduleRetryState {
  attempt: number;
  last_failure_at: string;
  last_failure_message: string;
  next_retry_at: string;
  parked: boolean;
}

export interface ReportScheduleEntry {
  schedule_id: string;
  tenant_id: string;
  report_id: string;
  format: ReportFormat;
  name: string;
  cadence: ScheduleCadence;
  hour_utc: number;
  day_of_week: number | null;
  day_of_month: number | null;
  recipients: string[];
  enabled: boolean;
  parameters: Record<string, unknown>;
  created_by: string;
  created_at: string;
  updated_at: string;
  next_run_at: string;
  last_run_at: string | null;
  tz: string;
  retry_state?: ScheduleRetryState | null;
}

export interface SchedulerTickResult {
  tenant_id: string;
  generated_at: string;
  as_of: string;
  tolerance_minutes: number;
  max_retries: number;
  backoff_minutes: number;
  dry_run: boolean;
  total_considered: number;
  would_fire: number;
  candidates?: ReportScheduleEntry[];
  fired: Array<{
    schedule_id: string;
    name: string;
    report_id: string;
    job_id: string;
    next_run_at: string;
  }>;
  retried_later: Array<{
    schedule_id: string;
    name: string;
    report_id: string;
    attempt: number;
    next_retry_at: string;
    error: string;
  }>;
  parked: Array<{
    schedule_id: string;
    name: string;
    report_id: string;
    attempt: number;
    error: string;
  }>;
  errors: Array<{ schedule_id: string; code: string; message: string }>;
}

export const reportsSchedulerApi = {
  listSchedules: (page = 1, page_size = 50) =>
    http
      .get<EnvelopeBody<{ items: ReportScheduleEntry[]; page: number; page_size: number; total: number }>>(
        '/v1/reports/schedules',
        { params: { page, page_size } },
      )
      .then((r) => r.data),

  upcoming: (n = 10) =>
    http
      .get<EnvelopeBody<{ items: Array<{ schedule_id: string; name: string; report_id: string; fire_at: string }> }>>(
        '/v1/reports/schedules/upcoming',
        { params: { n } },
      )
      .then((r) => r.data),

  // M3.3 — scheduler tick (admin-only). dry_run=true returns the
  // candidate list without mutating. simulate_failures is a test
  // hook accepted by the BFF — omit in production.
  tick: (opts: {
    dry_run?: boolean;
    tolerance_minutes?: number;
    max_retries?: number;
    backoff_minutes?: number;
    as_of?: string;
    simulate_failures?: string[];
  } = {}) =>
    http
      .post<EnvelopeBody<SchedulerTickResult>>('/v1/reports/schedules/tick', {
        dry_run: opts.dry_run ?? false,
        tolerance_minutes: opts.tolerance_minutes,
        max_retries: opts.max_retries,
        backoff_minutes: opts.backoff_minutes,
        as_of: opts.as_of,
        simulate_failures: opts.simulate_failures,
      })
      .then((r) => r.data),
};
