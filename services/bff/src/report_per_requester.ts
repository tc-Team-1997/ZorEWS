// services/bff/src/report_per_requester.ts
//
// T6 M12.12 — Report job per-requester rollup.
//
// M12.5 ships fleet-wide ReportJob analytics with `top_requesters`
// (cap-10 count list inside the envelope). M12.12 ships the FULL
// pivot-by-requester view: for each distinct requested_by username,
// produce a row with by_status + by_format + by_report_id_top +
// distinct_reports + most_recent_at.
//
// Use case: BIL ops admin wants "who's our heaviest report user
// — should we onboard them to scheduled reports (M12.2)?", or
// "who has the highest failure rate — investigate their parameters?"
// M12.5's top_requesters answers part of the first question with
// counts only; M12.12 adds the per-format / per-status drill-down.
//
// Mirror of M15.8 (audit per-actor activity) for the reports surface.
// Pure rollup over the M12.1 job store; tenant-scoped at the caller.

import type {
  JobStatus,
  ReportFormat,
  ReportJob,
  ReportJobStore,
} from './reports_catalog';

// ─── Constants ────────────────────────────────────────────────────────

const ALL_STATUSES: readonly JobStatus[] = [
  'queued',
  'running',
  'completed',
  'failed',
] as const;

const ALL_FORMATS: readonly ReportFormat[] = [
  'json',
  'csv',
  'pdf',
  'xlsx',
] as const;

const DRAIN_PAGE_SIZE = 500;
const DRAIN_PAGE_CAP = 200;
const TOP_REPORT_CAP = 5;

// ─── Public types ─────────────────────────────────────────────────────

export interface RequesterRow {
  requested_by: string;
  total_jobs: number;
  /** Per-JobStatus count; every key present at 0 when absent. */
  by_status: Record<JobStatus, number>;
  /** Per-ReportFormat count; every key present at 0 when absent. */
  by_format: Record<ReportFormat, number>;
  /** Top-5 report_ids this requester ran. Sorted count desc with
   *  report_id asc tie-break. */
  by_report_id_top: Array<{ report_id: string; count: number }>;
  /** Distinct report_ids this requester submitted. */
  distinct_reports: number;
  /** Newest requested_at across all this requester's jobs. */
  most_recent_at: string | null;
  /** Whether this requester has at least one failed job. */
  has_failure: boolean;
}

export interface ReportPerRequesterSummary {
  tenant_id: string;
  generated_at: string;
  total_jobs: number;
  total_requesters: number;
  /** Sorted by total_jobs desc with requested_by asc tie-break. */
  requesters: RequesterRow[];
  /** Top row by total_jobs. null when no jobs in tenant. */
  most_active_requester: {
    requested_by: string;
    total_jobs: number;
  } | null;
  /** Requesters with at least one failed job. Sorted by
   *  by_status.failed desc with requested_by asc tie-break. */
  requesters_with_failures: Array<{
    requested_by: string;
    failed_count: number;
  }>;
}

// ─── Helpers ──────────────────────────────────────────────────────────

function emptyByStatus(): Record<JobStatus, number> {
  return { queued: 0, running: 0, completed: 0, failed: 0 };
}

function emptyByFormat(): Record<ReportFormat, number> {
  return { json: 0, csv: 0, pdf: 0, xlsx: 0 };
}

interface RowBuilder {
  requested_by: string;
  total_jobs: number;
  by_status: Record<JobStatus, number>;
  by_format: Record<ReportFormat, number>;
  by_report_count: Map<string, number>;
  most_recent_at: string | null;
}

function newBuilder(requested_by: string): RowBuilder {
  return {
    requested_by,
    total_jobs: 0,
    by_status: emptyByStatus(),
    by_format: emptyByFormat(),
    by_report_count: new Map(),
    most_recent_at: null,
  };
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

function finaliseRow(b: RowBuilder): RequesterRow {
  const by_report_id_top = [...b.by_report_count.entries()]
    .sort((a, c) => {
      if (c[1] !== a[1]) return c[1] - a[1];
      return a[0].localeCompare(c[0]);
    })
    .slice(0, TOP_REPORT_CAP)
    .map(([report_id, count]) => ({ report_id, count }));

  return {
    requested_by: b.requested_by,
    total_jobs: b.total_jobs,
    by_status: b.by_status,
    by_format: b.by_format,
    by_report_id_top,
    distinct_reports: b.by_report_count.size,
    most_recent_at: b.most_recent_at,
    has_failure: b.by_status.failed > 0,
  };
}

// ─── Pure resolver ────────────────────────────────────────────────────

export function buildReportPerRequester(
  store: ReportJobStore,
  tenant_id: string,
  now: Date,
): ReportPerRequesterSummary {
  const jobs = drainJobs(store, tenant_id);
  const builders = new Map<string, RowBuilder>();

  for (const j of jobs) {
    let b = builders.get(j.requested_by);
    if (!b) {
      b = newBuilder(j.requested_by);
      builders.set(j.requested_by, b);
    }
    b.total_jobs++;
    if (ALL_STATUSES.includes(j.status)) b.by_status[j.status]++;
    if (ALL_FORMATS.includes(j.format)) b.by_format[j.format]++;
    b.by_report_count.set(j.report_id, (b.by_report_count.get(j.report_id) ?? 0) + 1);
    if (!b.most_recent_at || j.requested_at > b.most_recent_at) {
      b.most_recent_at = j.requested_at;
    }
  }

  const requesters = [...builders.values()]
    .map(finaliseRow)
    .sort((a, b) => {
      if (b.total_jobs !== a.total_jobs) return b.total_jobs - a.total_jobs;
      return a.requested_by.localeCompare(b.requested_by);
    });

  const most_active_requester = requesters.length > 0
    ? {
        requested_by: requesters[0]!.requested_by,
        total_jobs: requesters[0]!.total_jobs,
      }
    : null;

  const requesters_with_failures = requesters
    .filter((r) => r.has_failure)
    .map((r) => ({
      requested_by: r.requested_by,
      failed_count: r.by_status.failed,
    }))
    .sort((a, b) => {
      if (b.failed_count !== a.failed_count) return b.failed_count - a.failed_count;
      return a.requested_by.localeCompare(b.requested_by);
    });

  return {
    tenant_id,
    generated_at: now.toISOString(),
    total_jobs: jobs.length,
    total_requesters: requesters.length,
    requesters,
    most_active_requester,
    requesters_with_failures,
  };
}
