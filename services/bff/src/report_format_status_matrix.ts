// services/bff/src/report_format_status_matrix.ts
//
// T6 M12.14 — Report job format × status cross-tab matrix.
//
// M12.11 ships 1D format distribution (per-format row with by_status
// nested inside). M12.14 elevates to the proper 2D matrix:
// rows = 4 ReportFormat × cols = 4 JobStatus = 16 cells.
//
// Cells count JOBS — each ReportJob lives in exactly one cell
// (its format + current status). Mirror of M14.28 / M8.14 / M5.17 /
// M13.15 / M3.14 / M7.14 matrix pattern.
//
// Pure resolver — drains every job from the M12.1 store via paginated
// listing. Tenant-scoped at the caller via store.list(tenant_id, …).
//
// Drives "are PDF jobs failing more than CSV? where are jobs piling
// up (queued cells × format)?".

import {
  type JobStatus,
  type ReportFormat,
  type ReportJob,
  type ReportJobStore,
} from './reports_catalog';
import { ALL_REPORT_FORMATS } from './report_format_distribution';

// ─── Canonical enum order ─────────────────────────────────────────────

export const ALL_JOB_STATUSES: readonly JobStatus[] = [
  'queued',
  'running',
  'completed',
  'failed',
] as const;

// ─── Public types ─────────────────────────────────────────────────────

export interface ReportFormatStatusCell {
  format: ReportFormat;
  status: JobStatus;
  count: number;
}

export interface ReportFormatRow {
  format: ReportFormat;
  total: number;
  by_status: Record<JobStatus, number>;
  /** Statuses never seen for this format. Sorted in canonical
   *  ALL_JOB_STATUSES order — coverage-gap per format. */
  statuses_without: JobStatus[];
}

export interface ReportStatusColumn {
  status: JobStatus;
  total: number;
  by_format: Record<ReportFormat, number>;
  /** Formats never seen in this status. Sorted in canonical
   *  ALL_REPORT_FORMATS order — coverage-gap per status. */
  formats_without: ReportFormat[];
}

export interface ReportFormatStatusMatrix {
  tenant_id: string;
  generated_at: string;
  total_jobs: number;
  rows: ReportFormatRow[];
  columns: ReportStatusColumn[];
  /** Peak cell — highest count (format, status). Canonical iteration
   *  tie-break (formats in ALL_REPORT_FORMATS order × statuses in
   *  ALL_JOB_STATUSES order). null when no jobs. */
  peak_cell: ReportFormatStatusCell | null;
  /** Zero-count (format, status) pairs in canonical row-major order. */
  empty_cells: Array<{ format: ReportFormat; status: JobStatus }>;
  /** Format with the most distinct non-zero statuses. Canonical
   *  format-order tie-break. null when no jobs. */
  most_active_format: { format: ReportFormat; statuses_seen: number } | null;
  /** Status with the most distinct non-zero formats. Canonical
   *  status-order tie-break. null when no jobs. */
  most_distributed_status: { status: JobStatus; formats_seen: number } | null;
}

// ─── Helpers ──────────────────────────────────────────────────────────

const DRAIN_PAGE_SIZE = 500;
const DRAIN_PAGE_CAP = 200;

function emptyByStatus(): Record<JobStatus, number> {
  const out: Partial<Record<JobStatus, number>> = {};
  for (const s of ALL_JOB_STATUSES) out[s] = 0;
  return out as Record<JobStatus, number>;
}

function emptyByFormat(): Record<ReportFormat, number> {
  const out: Partial<Record<ReportFormat, number>> = {};
  for (const f of ALL_REPORT_FORMATS) out[f] = 0;
  return out as Record<ReportFormat, number>;
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

export function buildReportFormatStatusMatrix(
  store: ReportJobStore,
  tenant_id: string,
  now: Date,
): ReportFormatStatusMatrix {
  const cell = new Map<ReportFormat, Map<JobStatus, number>>();
  for (const f of ALL_REPORT_FORMATS) cell.set(f, new Map());

  const jobs = drainJobs(store, tenant_id);
  let total_jobs = 0;
  for (const j of jobs) {
    if (!ALL_REPORT_FORMATS.includes(j.format)) continue;
    if (!ALL_JOB_STATUSES.includes(j.status)) continue;
    const inner = cell.get(j.format)!;
    inner.set(j.status, (inner.get(j.status) ?? 0) + 1);
    total_jobs++;
  }

  // Rows (formats × all statuses).
  const rows: ReportFormatRow[] = ALL_REPORT_FORMATS.map((format) => {
    const inner = cell.get(format)!;
    const by_status = emptyByStatus();
    let total = 0;
    for (const s of ALL_JOB_STATUSES) {
      const c = inner.get(s) ?? 0;
      by_status[s] = c;
      total += c;
    }
    const statuses_without = ALL_JOB_STATUSES.filter((s) => by_status[s] === 0);
    return { format, total, by_status, statuses_without };
  });

  // Columns (statuses × all formats).
  const columns: ReportStatusColumn[] = ALL_JOB_STATUSES.map((status) => {
    const by_format = emptyByFormat();
    let total = 0;
    for (const f of ALL_REPORT_FORMATS) {
      const c = cell.get(f)!.get(status) ?? 0;
      by_format[f] = c;
      total += c;
    }
    const formats_without = ALL_REPORT_FORMATS.filter((f) => by_format[f] === 0);
    return { status, total, by_format, formats_without };
  });

  // peak_cell — canonical iteration tie-break.
  let peak: ReportFormatStatusCell | null = null;
  for (const f of ALL_REPORT_FORMATS) {
    for (const s of ALL_JOB_STATUSES) {
      const count = cell.get(f)!.get(s) ?? 0;
      if (count > 0 && (!peak || count > peak.count)) {
        peak = { format: f, status: s, count };
      }
    }
  }

  // empty_cells canonical row-major (format × status).
  const empty_cells: Array<{ format: ReportFormat; status: JobStatus }> = [];
  for (const f of ALL_REPORT_FORMATS) {
    for (const s of ALL_JOB_STATUSES) {
      const count = cell.get(f)!.get(s) ?? 0;
      if (count === 0) empty_cells.push({ format: f, status: s });
    }
  }

  // most_active_format — highest distinct non-zero by_status count.
  let bestFmtSpan = 0;
  let mostActiveFmt: ReportFormatRow | null = null;
  for (const row of rows) {
    const span = ALL_JOB_STATUSES.filter((s) => row.by_status[s] > 0).length;
    if (span > bestFmtSpan) {
      bestFmtSpan = span;
      mostActiveFmt = row;
    }
  }
  const most_active_format = mostActiveFmt
    ? { format: mostActiveFmt.format, statuses_seen: bestFmtSpan }
    : null;

  // most_distributed_status — highest distinct non-zero by_format count.
  let bestStSpan = 0;
  let mostDistSt: ReportStatusColumn | null = null;
  for (const col of columns) {
    const span = ALL_REPORT_FORMATS.filter((f) => col.by_format[f] > 0).length;
    if (span > bestStSpan) {
      bestStSpan = span;
      mostDistSt = col;
    }
  }
  const most_distributed_status = mostDistSt
    ? { status: mostDistSt.status, formats_seen: bestStSpan }
    : null;

  return {
    tenant_id,
    generated_at: now.toISOString(),
    total_jobs,
    rows,
    columns,
    peak_cell: peak,
    empty_cells,
    most_active_format,
    most_distributed_status,
  };
}
