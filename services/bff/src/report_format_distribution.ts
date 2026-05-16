// services/bff/src/report_format_distribution.ts
//
// T6 M12.11 — Report job format distribution.
//
// M12.5 ships ReportJob analytics with status/format mix counters but
// the format axis is one envelope field among many. M12.10 ships the
// per-report runtime trend. M12.11 is the FORMAT-pivoted view: for
// each of the 4 supported formats (json / csv / pdf / xlsx), produce
// a full breakdown — total_count, by_status (4 keys), success_rate,
// mean_processing_ms over completed jobs, most_recent_at, top-5
// most-used report_ids, distinct_reports count.
//
// Use case: BIL ops admin wants to know "is anyone actually using
// the PDF variant, or could we deprecate it?" The mean_processing_ms
// per format also surfaces "PDF generation is 3× slower than JSON
// — is that affecting SLA?" without an extra round-trip.
//
// Mirror of M5.16 / M11.11 / M7.11 pivot pattern. Pure rollup over
// the M12.1 job store. Includes ALL jobs regardless of status —
// failed/queued jobs still represent a format choice and feed the
// "which formats do people request?" question.

import type {
  JobStatus,
  ReportFormat,
  ReportJob,
  ReportJobStore,
} from './reports_catalog';

// ─── Constants ────────────────────────────────────────────────────────

/** Canonical format order — used for stable rendering + tie-breaks
 *  in most_common_format. Matches the order in `ReportFormat`. */
export const ALL_REPORT_FORMATS: readonly ReportFormat[] = [
  'json',
  'csv',
  'pdf',
  'xlsx',
] as const;

const ALL_STATUSES: readonly JobStatus[] = [
  'queued',
  'running',
  'completed',
  'failed',
] as const;

const DRAIN_PAGE_SIZE = 500;
const DRAIN_PAGE_CAP = 200;

// ─── Public types ─────────────────────────────────────────────────────

export interface ReportFormatRow {
  format: ReportFormat;
  total_count: number;
  /** Per-JobStatus count; every key present at 0 when absent. */
  by_status: Record<JobStatus, number>;
  /** completed / (completed + failed). Queued + running excluded
   *  from the denominator since they haven't reached a terminal
   *  outcome yet. null when no terminal jobs in this format. */
  success_rate: number | null;
  /** Mean of (completed_at - requested_at) ms across COMPLETED jobs
   *  in this format only. null when no completed jobs. */
  mean_processing_ms: number | null;
  /** Newest requested_at across ALL jobs in this format. null when
   *  no jobs requested this format. */
  most_recent_at: string | null;
  /** Top-5 report_ids by job count for this format. Sorted by count
   *  desc with report_id asc tie-break. */
  by_report_id_top: Array<{ report_id: string; count: number }>;
  /** Distinct report_ids that requested this format at least once. */
  distinct_reports: number;
}

export interface ReportFormatDistributionSummary {
  tenant_id: string;
  generated_at: string;
  total_jobs: number;
  /** Every ReportFormat in ALL_REPORT_FORMATS canonical order, even
   *  zero-count formats — stable grid for the SPA. */
  formats: ReportFormatRow[];
  /** Highest total_count format. Ties broken by ALL_REPORT_FORMATS
   *  canonical order (json wins over csv at same count). null when
   *  no jobs in this tenant. */
  most_common_format: ReportFormat | null;
  /** Formats with total_count = 0, in canonical order. */
  unused_formats: ReportFormat[];
}

// ─── Helpers ──────────────────────────────────────────────────────────

function emptyByStatus(): Record<JobStatus, number> {
  return { queued: 0, running: 0, completed: 0, failed: 0 };
}

function emptyRow(format: ReportFormat): ReportFormatRow {
  return {
    format,
    total_count: 0,
    by_status: emptyByStatus(),
    success_rate: null,
    mean_processing_ms: null,
    most_recent_at: null,
    by_report_id_top: [],
    distinct_reports: 0,
  };
}

function durationMs(job: ReportJob): number | null {
  if (job.status !== 'completed') return null;
  if (job.completed_at === null) return null;
  const start = new Date(job.requested_at).getTime();
  const end = new Date(job.completed_at).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.max(0, end - start);
}

function drainJobs(store: ReportJobStore, tenant_id: string): ReportJob[] {
  const out: ReportJob[] = [];
  for (let page = 1; page <= DRAIN_PAGE_CAP; page++) {
    const result = store.list(tenant_id, { page, page_size: DRAIN_PAGE_SIZE });
    out.push(...result.items);
    if (result.items.length < DRAIN_PAGE_SIZE) break;
    if (out.length >= result.total) break;
  }
  return out;
}

// ─── Pure resolver ────────────────────────────────────────────────────

export function buildReportFormatDistribution(
  store: ReportJobStore,
  tenant_id: string,
  now: Date,
): ReportFormatDistributionSummary {
  const jobs = drainJobs(store, tenant_id);

  // Initialise rows for every format so the SPA grid is stable.
  const rowByFormat = new Map<ReportFormat, ReportFormatRow>();
  for (const f of ALL_REPORT_FORMATS) rowByFormat.set(f, emptyRow(f));

  // Per-format accumulators for processing-time mean + per-report counters.
  const processingSumByFormat = new Map<ReportFormat, { sum: number; count: number }>();
  const reportCountsByFormat = new Map<ReportFormat, Map<string, number>>();
  for (const f of ALL_REPORT_FORMATS) {
    processingSumByFormat.set(f, { sum: 0, count: 0 });
    reportCountsByFormat.set(f, new Map());
  }

  for (const j of jobs) {
    if (!ALL_REPORT_FORMATS.includes(j.format)) continue;
    const row = rowByFormat.get(j.format)!;
    row.total_count++;
    row.by_status[j.status]++;
    if (!row.most_recent_at || j.requested_at > row.most_recent_at) {
      row.most_recent_at = j.requested_at;
    }
    const reportCounts = reportCountsByFormat.get(j.format)!;
    reportCounts.set(j.report_id, (reportCounts.get(j.report_id) ?? 0) + 1);
    const ms = durationMs(j);
    if (ms !== null) {
      const acc = processingSumByFormat.get(j.format)!;
      acc.sum += ms;
      acc.count++;
    }
  }

  // Finalise per-format derived fields.
  for (const f of ALL_REPORT_FORMATS) {
    const row = rowByFormat.get(f)!;
    const reportCounts = reportCountsByFormat.get(f)!;
    row.distinct_reports = reportCounts.size;
    row.by_report_id_top = [...reportCounts.entries()]
      .sort((a, b) => {
        if (b[1] !== a[1]) return b[1] - a[1];
        return a[0].localeCompare(b[0]);
      })
      .slice(0, 5)
      .map(([report_id, count]) => ({ report_id, count }));

    const terminalEligible = row.by_status.completed + row.by_status.failed;
    row.success_rate = terminalEligible > 0
      ? row.by_status.completed / terminalEligible
      : null;

    const acc = processingSumByFormat.get(f)!;
    row.mean_processing_ms = acc.count > 0 ? Math.round(acc.sum / acc.count) : null;
  }

  const formats = ALL_REPORT_FORMATS.map((f) => rowByFormat.get(f)!);

  // most_common_format: highest total_count; ties broken by canonical
  // order (json wins over csv at same count) via iteration order.
  let most_common_format: ReportFormat | null = null;
  let mostCount = 0;
  for (const f of ALL_REPORT_FORMATS) {
    const row = rowByFormat.get(f)!;
    if (row.total_count > mostCount) {
      mostCount = row.total_count;
      most_common_format = f;
    }
  }
  if (mostCount === 0) most_common_format = null;

  const unused_formats = ALL_REPORT_FORMATS.filter(
    (f) => rowByFormat.get(f)!.total_count === 0,
  );

  return {
    tenant_id,
    generated_at: now.toISOString(),
    total_jobs: jobs.length,
    formats,
    most_common_format,
    unused_formats,
  };
}
