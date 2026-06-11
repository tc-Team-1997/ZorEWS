// services/bff/src/report_schedule_adherence.ts
//
// T6 M12.21 — Report schedule adherence tracking.
//
// For each ENABLED schedule, estimates how many runs were expected
// in the last 30 days based on cadence, then compares to actual
// job submissions (using last_run_at as a proxy for "was a run
// submitted?").
//
// Note: In the prototype, actual_runs_30d is derived from last_run_at
// being within the 30-day window (since we don't have a per-schedule
// job-submission log). Production would count jobs from the job store
// filtered by schedule_id (a future join that doesn't exist yet).

import type { ReportScheduleStore } from './report_schedules';

// ─── Public types ──────────────────────────────────────────────────────

export type AdherenceStatus = 'on_track' | 'behind' | 'ahead';

export interface ScheduleAdherenceRow {
  schedule_id: string;
  name: string;
  cadence: string;
  expected_runs_30d: number;
  /** Proxy: number of times last_run_at falls within the 30-day window. */
  actual_runs_30d: number;
  /** actual / expected, rounded 4 decimals. 0 when expected=0. */
  adherence_rate: number;
  missed_runs: number;
  status: AdherenceStatus;
}

export interface ReportScheduleAdherence {
  tenant_id: string;
  generated_at: string;
  total_enabled_schedules: number;
  /** Sorted adherence_rate asc (worst adherence first). */
  schedules: ScheduleAdherenceRow[];
  worst_adherence: { schedule_id: string; name: string; adherence_rate: number } | null;
  fleet_adherence_rate: number;
}

// ─── Helpers ───────────────────────────────────────────────────────────

function expectedRunsIn30Days(cadence: string): number {
  switch (cadence) {
    case 'daily': return 30;
    case 'weekly': return 4;
    case 'monthly': return 1;
    case 'quarterly': return 0; // might not have a run in 30 days
    case 'last_day_of_month': return 1;
    default: return 0;
  }
}

// ─── Pure function ─────────────────────────────────────────────────────

/**
 * buildScheduleAdherence
 *
 * @param store       ReportScheduleStore
 * @param tenant_id   caller's tenant
 * @param now         current Date
 */
export function buildScheduleAdherence(
  store: ReportScheduleStore,
  tenant_id: string,
  now: Date,
): ReportScheduleAdherence {
  const WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
  const cutoff = now.getTime() - WINDOW_MS;

  // Drain enabled schedules
  const allSchedules: import('./report_schedules').ReportScheduleEntry[] = [];
  for (let page = 1; page <= 100; page++) {
    const result = store.list(tenant_id, page, 500);
    for (const s of result.items) {
      if (s.tenant_id === tenant_id && s.enabled) {
        allSchedules.push(s);
      }
    }
    if (result.items.length < 500) break;
  }

  const rows: ScheduleAdherenceRow[] = [];

  for (const s of allSchedules) {
    const expected_runs_30d = expectedRunsIn30Days(s.cadence);

    // Actual runs: count how many times the schedule ran within the 30-day window
    // In the prototype, we only have last_run_at as a proxy.
    // A real implementation would count jobs filtered by schedule_id.
    let actual_runs_30d = 0;
    if (s.last_run_at) {
      const lastRunMs = Date.parse(s.last_run_at);
      if (Number.isFinite(lastRunMs) && lastRunMs >= cutoff) {
        actual_runs_30d = 1;
      }
    }

    const adherence_rate =
      expected_runs_30d > 0
        ? Math.round((actual_runs_30d / expected_runs_30d) * 10000) / 10000
        : 1; // 0 expected → fully on track (nothing to miss)

    const missed_runs = Math.max(0, expected_runs_30d - actual_runs_30d);

    let status: AdherenceStatus;
    if (adherence_rate >= 1.0) {
      status = actual_runs_30d > expected_runs_30d ? 'ahead' : 'on_track';
    } else {
      status = 'behind';
    }

    rows.push({
      schedule_id: s.schedule_id,
      name: s.name,
      cadence: s.cadence,
      expected_runs_30d,
      actual_runs_30d,
      adherence_rate,
      missed_runs,
      status,
    });
  }

  // Sort: adherence_rate asc (worst first), then schedule_id asc tie-break
  rows.sort((a, b) => {
    if (a.adherence_rate !== b.adherence_rate) return a.adherence_rate - b.adherence_rate;
    return a.schedule_id < b.schedule_id ? -1 : 1;
  });

  const worst_adherence =
    rows.length > 0 && rows[0].status === 'behind'
      ? {
          schedule_id: rows[0].schedule_id,
          name: rows[0].name,
          adherence_rate: rows[0].adherence_rate,
        }
      : null;

  const fleet_adherence_rate =
    rows.length > 0
      ? Math.round(
          (rows.reduce((s, r) => s + r.adherence_rate, 0) / rows.length) * 10000,
        ) / 10000
      : 1;

  return {
    tenant_id,
    generated_at: now.toISOString(),
    total_enabled_schedules: rows.length,
    schedules: rows,
    worst_adherence,
    fleet_adherence_rate,
  };
}
