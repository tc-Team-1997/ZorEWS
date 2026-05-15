// services/bff/src/report_job_runtime_trend.ts
//
// T6 M12.10 — Report job runtime trend per report_id.
//
// M12.5 ships fleet-wide analytics (status mix, top requesters,
// per-report success rates). M12.10 ships the orthogonal "is
// runtime drifting?" view: per report_id, compute the
// least-squares slope of processing_ms over time. Sign convention
// neutral — positive slope means the report is getting slower
// over the observed window; negative means faster.
//
// Mirror of M7.8 (model performance metric trend) for the
// reports surface. Lets the SPA flag "rbi_quarterly_summary
// processing time has grown 80ms/day for the past month —
// investigate?".
//
// Pure resolver. Companion to M12.5 (aggregate stats); same
// input, different lens.

import type { ReportJob, ReportJobStore } from './reports_catalog';

// ─── Public types ─────────────────────────────────────────────────────

export interface ReportRuntimeTrendRow {
  report_id: string;
  sample_size: number;
  /** Mean across `sample_size` completed jobs. null when 0 samples. */
  mean_processing_ms: number | null;
  /** Oldest completed job's processing_ms + completed_at. */
  first_processing_ms: number | null;
  first_completed_at: string | null;
  /** Newest completed job's processing_ms + completed_at. */
  last_processing_ms: number | null;
  last_completed_at: string | null;
  /** last - first, signed. null when <2 samples. */
  abs_change_ms: number | null;
  /** Least-squares slope in ms per day. null when:
   *  - sample_size < 2
   *  - every sample shares the same completed_at (no time progression). */
  slope_ms_per_day: number | null;
}

export interface ReportRuntimeTrendSummary {
  tenant_id: string;
  generated_at: string;
  total_completed_jobs: number;
  total_report_types: number;
  /** Per-report rows sorted by |slope_ms_per_day| desc (biggest
   *  movers first; nulls last); secondary by sample_size desc;
   *  tertiary by report_id asc. */
  report_trends: ReportRuntimeTrendRow[];
  /** Report_id with the largest positive slope (getting slowest
   *  fastest). null when no positive slope or no samples. */
  biggest_regression_report_id: string | null;
  /** Report_id with the largest negative slope (getting faster).
   *  null when no negative slope. */
  biggest_improvement_report_id: string | null;
}

// ─── Pure helpers ─────────────────────────────────────────────────────

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const DRAIN_PAGE_SIZE = 500;
const DRAIN_PAGE_CAP = 200;

function durationMs(j: ReportJob): number | null {
  if (j.status !== 'completed' || !j.completed_at) return null;
  const start = Date.parse(j.requested_at);
  const end = Date.parse(j.completed_at);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.max(0, end - start);
}

/** Least-squares slope of y against x (where x is days, y is ms).
 *  Returns null when n<2 or every x is identical. */
function lsqSlope(points: Array<{ x_days: number; y_ms: number }>): number | null {
  if (points.length < 2) return null;
  const n = points.length;
  let sumX = 0;
  let sumY = 0;
  for (const p of points) {
    sumX += p.x_days;
    sumY += p.y_ms;
  }
  const meanX = sumX / n;
  const meanY = sumY / n;
  let num = 0;
  let den = 0;
  for (const p of points) {
    const dx = p.x_days - meanX;
    num += dx * (p.y_ms - meanY);
    den += dx * dx;
  }
  if (den === 0) return null; // all timestamps identical
  return num / den;
}

function drainJobs(
  store: ReportJobStore,
  tenant_id: string,
): ReportJob[] {
  const out: ReportJob[] = [];
  for (let page = 1; page <= DRAIN_PAGE_CAP; page++) {
    const result = store.list(tenant_id, { status: 'completed', page, page_size: DRAIN_PAGE_SIZE });
    out.push(...result.items);
    if (result.items.length < DRAIN_PAGE_SIZE) break;
    if (out.length >= result.total) break;
  }
  return out;
}

// ─── Pure resolver ────────────────────────────────────────────────────

export function buildReportRuntimeTrend(
  store: ReportJobStore,
  tenant_id: string,
  now: Date,
): ReportRuntimeTrendSummary {
  const jobs = drainJobs(store, tenant_id);

  // Bucket completed jobs by report_id; collect (completed_at, ms) pairs.
  const byReport = new Map<string, ReportJob[]>();
  for (const j of jobs) {
    let arr = byReport.get(j.report_id);
    if (!arr) {
      arr = [];
      byReport.set(j.report_id, arr);
    }
    arr.push(j);
  }

  const rows: ReportRuntimeTrendRow[] = [];
  let totalCompleted = 0;

  for (const [report_id, list] of byReport.entries()) {
    // Sort oldest-first by completed_at (only completed jobs landed here
    // so completed_at is set).
    const sorted = [...list].sort((a, b) => (a.completed_at! < b.completed_at! ? -1 : 1));
    const durations = sorted
      .map((j) => ({ j, ms: durationMs(j) }))
      .filter((x) => x.ms !== null) as Array<{ j: ReportJob; ms: number }>;
    const sample_size = durations.length;
    totalCompleted += sample_size;

    if (sample_size === 0) {
      rows.push({
        report_id,
        sample_size: 0,
        mean_processing_ms: null,
        first_processing_ms: null,
        first_completed_at: null,
        last_processing_ms: null,
        last_completed_at: null,
        abs_change_ms: null,
        slope_ms_per_day: null,
      });
      continue;
    }

    const first = durations[0]!;
    const last = durations[durations.length - 1]!;
    const mean_processing_ms = durations.reduce((acc, d) => acc + d.ms, 0) / sample_size;

    // Build (x_days, y_ms) points anchored at the first completed_at.
    const anchor = Date.parse(first.j.completed_at!);
    const points = durations.map((d) => ({
      x_days: (Date.parse(d.j.completed_at!) - anchor) / MS_PER_DAY,
      y_ms: d.ms,
    }));
    const slope_ms_per_day = lsqSlope(points);

    rows.push({
      report_id,
      sample_size,
      mean_processing_ms,
      first_processing_ms: first.ms,
      first_completed_at: first.j.completed_at,
      last_processing_ms: last.ms,
      last_completed_at: last.j.completed_at,
      abs_change_ms: sample_size >= 2 ? last.ms - first.ms : null,
      slope_ms_per_day,
    });
  }

  // Sort: |slope| desc with nulls last, sample_size desc, report_id asc.
  rows.sort((a, b) => {
    const aSlope = a.slope_ms_per_day === null ? -Infinity : Math.abs(a.slope_ms_per_day);
    const bSlope = b.slope_ms_per_day === null ? -Infinity : Math.abs(b.slope_ms_per_day);
    if (aSlope !== bSlope) return bSlope - aSlope;
    if (b.sample_size !== a.sample_size) return b.sample_size - a.sample_size;
    return a.report_id.localeCompare(b.report_id);
  });

  // Biggest regression / improvement: most positive / most negative slope.
  let biggest_regression_report_id: string | null = null;
  let biggest_regression_slope = 0;
  let biggest_improvement_report_id: string | null = null;
  let biggest_improvement_slope = 0;
  for (const r of rows) {
    if (r.slope_ms_per_day === null) continue;
    if (r.slope_ms_per_day > biggest_regression_slope) {
      biggest_regression_slope = r.slope_ms_per_day;
      biggest_regression_report_id = r.report_id;
    }
    if (r.slope_ms_per_day < biggest_improvement_slope) {
      biggest_improvement_slope = r.slope_ms_per_day;
      biggest_improvement_report_id = r.report_id;
    }
  }

  return {
    tenant_id,
    generated_at: now.toISOString(),
    total_completed_jobs: totalCompleted,
    total_report_types: rows.length,
    report_trends: rows,
    biggest_regression_report_id,
    biggest_improvement_report_id,
  };
}
