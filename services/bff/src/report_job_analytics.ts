// services/bff/src/report_job_analytics.ts
//
// T6 M12.5 — Report job analytics.
//
// M12.1 ships the BIL reports catalog + async job tracker; M12.2/M12.4
// the recurring schedule store. What ops have asked for next: a
// supervisor view over the recent reports-jobs ledger — which reports
// people are actually pulling, how often they fail, who's running
// the heaviest loads.
//
// Design:
//  - Pure resolver over a readonly ReportJob[] window. No I/O, no
//    store coupling. Caller passes the slice — typically
//    `reportJobStore.list(tenant, {}).items` capped at the store's
//    500/tenant retention.
//  - Latency percentiles via the M3.5 linearPercentile (Excel/R
//    type-7) so all of our latency-style summaries stay consistent.
//  - Top requesters surface as a leaderboard, capped at 10 entries —
//    the SPA usually shows the heaviest 5 in a card.
//  - last_failure is the newest failure by `requested_at` (the only
//    monotonically advancing field set on every job, even failed
//    ones where completed_at may be null).

import { linearPercentile } from './connector_run_analytics';
import type {
  JobStatus,
  ReportFormat,
  ReportJob,
} from './reports_catalog';

// ─── Public types ─────────────────────────────────────────────────────

export interface PerReportRollup {
  report_id: string;
  job_count: number;
  completed_count: number;
  failed_count: number;
  /** completed / (completed + failed) — null when both are zero (only
   *  queued/running observed). */
  success_rate: number | null;
  /** Mean processing time across COMPLETED jobs only (ms). null when
   *  no completed jobs. */
  mean_processing_ms: number | null;
}

export interface RequesterRollup {
  requested_by: string;
  job_count: number;
}

export interface ReportJobAnalytics {
  sample_size: number;
  /** Counts across every status; all four keys always present. */
  by_status: Record<JobStatus, number>;
  /** Counts across every format observed. Keys are present for every
   *  format we have at least one job of. */
  by_format: Partial<Record<ReportFormat, number>>;
  /** Per-report rollup, sorted by job_count desc (then report_id asc). */
  per_report: PerReportRollup[];
  /** Top requesters by job_count, cap 10, ties broken by name asc. */
  top_requesters: RequesterRollup[];
  /** Across COMPLETED jobs only. Null fields when none completed. */
  processing_ms: {
    min: number | null;
    mean: number | null;
    p50: number | null;
    p95: number | null;
    max: number | null;
  };
  /** completed_count / (completed_count + failed_count) — null when
   *  no terminal jobs. */
  success_rate: number | null;
  /** Newest failure by requested_at — null when no failures. */
  last_failure: {
    job_id: string;
    report_id: string;
    requested_at: string;
    requested_by: string;
    error_message: string;
  } | null;
}

// ─── Constants ────────────────────────────────────────────────────────

export const TOP_REQUESTER_CAP = 10;

// ─── Helpers ──────────────────────────────────────────────────────────

function emptyByStatus(): Record<JobStatus, number> {
  return { queued: 0, running: 0, completed: 0, failed: 0 };
}

function durationMs(j: ReportJob): number | null {
  if (j.status !== 'completed' || !j.completed_at) return null;
  const start = new Date(j.requested_at).getTime();
  const end = new Date(j.completed_at).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.max(0, end - start);
}

// ─── Pure aggregator ──────────────────────────────────────────────────

/**
 * Roll up a window of ReportJob records into ReportJobAnalytics.
 * Caller is responsible for slicing the window before calling
 * (typically `reportJobStore.list(tenant, filters).items`).
 */
export function summarizeReportJobs(
  jobs: readonly ReportJob[],
): ReportJobAnalytics {
  const by_status = emptyByStatus();
  const by_format: Partial<Record<ReportFormat, number>> = {};
  const perReport = new Map<
    string,
    {
      job_count: number;
      completed_count: number;
      failed_count: number;
      duration_sum_ms: number;
      duration_count: number;
    }
  >();
  const perRequester = new Map<string, number>();

  const completedDurations: number[] = [];
  let completed_count = 0;
  let failed_count = 0;
  let last_failure: ReportJobAnalytics['last_failure'] = null;

  for (const j of jobs) {
    by_status[j.status] += 1;
    by_format[j.format] = (by_format[j.format] ?? 0) + 1;

    let rec = perReport.get(j.report_id);
    if (!rec) {
      rec = {
        job_count: 0,
        completed_count: 0,
        failed_count: 0,
        duration_sum_ms: 0,
        duration_count: 0,
      };
      perReport.set(j.report_id, rec);
    }
    rec.job_count += 1;
    if (j.status === 'completed') {
      rec.completed_count += 1;
      completed_count += 1;
      const d = durationMs(j);
      if (d !== null) {
        rec.duration_sum_ms += d;
        rec.duration_count += 1;
        completedDurations.push(d);
      }
    } else if (j.status === 'failed') {
      rec.failed_count += 1;
      failed_count += 1;
      if (!last_failure || j.requested_at > last_failure.requested_at) {
        last_failure = {
          job_id: j.job_id,
          report_id: j.report_id,
          requested_at: j.requested_at,
          requested_by: j.requested_by,
          error_message: j.error_message ?? '',
        };
      }
    }

    perRequester.set(j.requested_by, (perRequester.get(j.requested_by) ?? 0) + 1);
  }

  const per_report: PerReportRollup[] = [];
  for (const [report_id, rec] of perReport) {
    const terminal = rec.completed_count + rec.failed_count;
    per_report.push({
      report_id,
      job_count: rec.job_count,
      completed_count: rec.completed_count,
      failed_count: rec.failed_count,
      success_rate: terminal === 0 ? null : rec.completed_count / terminal,
      mean_processing_ms:
        rec.duration_count === 0 ? null : rec.duration_sum_ms / rec.duration_count,
    });
  }
  per_report.sort((a, b) => {
    if (b.job_count !== a.job_count) return b.job_count - a.job_count;
    return a.report_id < b.report_id ? -1 : a.report_id > b.report_id ? 1 : 0;
  });

  const top_requesters: RequesterRollup[] = [];
  for (const [requested_by, job_count] of perRequester) {
    top_requesters.push({ requested_by, job_count });
  }
  top_requesters.sort((a, b) => {
    if (b.job_count !== a.job_count) return b.job_count - a.job_count;
    return a.requested_by < b.requested_by ? -1 : a.requested_by > b.requested_by ? 1 : 0;
  });
  const capped_requesters = top_requesters.slice(0, TOP_REQUESTER_CAP);

  completedDurations.sort((a, b) => a - b);
  const meanDur =
    completedDurations.length === 0
      ? null
      : completedDurations.reduce((s, x) => s + x, 0) / completedDurations.length;

  const terminal = completed_count + failed_count;
  const success_rate = terminal === 0 ? null : completed_count / terminal;

  return {
    sample_size: jobs.length,
    by_status,
    by_format,
    per_report,
    top_requesters: capped_requesters,
    processing_ms: {
      min: completedDurations.length === 0 ? null : completedDurations[0]!,
      mean: meanDur,
      p50: linearPercentile(completedDurations, 0.5),
      p95: linearPercentile(completedDurations, 0.95),
      max:
        completedDurations.length === 0
          ? null
          : completedDurations[completedDurations.length - 1]!,
    },
    success_rate,
    last_failure,
  };
}
