// services/bff/src/report_job_format_size.ts
//
// T6 M12.20 — Report job output format size distribution.
//
// Computes estimated output sizes for completed report jobs, grouped
// by format. Drives the ops "how much storage is our report output
// consuming? which format produces the largest files?" question.
//
// Output size estimation is deterministic, seeded by (job_id, format)
// using a simple hash — the actual file content is not inspected.
// Production swap = read real file sizes from the download_url storage.
//
// Distinct from:
//   M12.11 — format distribution (job counts, not file sizes)
//   M12.13 — daily volume timeline (time series, not format distribution)
//   M12.14 — format × status matrix (status breakdown, not sizes)
//
// Mirror of M12.11 pivot pattern but for output storage analytics.

import type { ReportFormat, ReportJob, ReportJobStore } from './reports_catalog';

// ─── Constants ────────────────────────────────────────────────────────

const DRAIN_PAGE_SIZE = 500;
const DRAIN_PAGE_CAP = 200;

/** Size ranges in KB (min, max) per format based on typical output sizes. */
const SIZE_RANGE_KB: Record<ReportFormat, [number, number]> = {
  json: [50, 500],
  csv: [100, 2048],
  pdf: [500, 5120],
  xlsx: [200, 3072],
};

// ─── Public types ─────────────────────────────────────────────────────

export interface ReportFormatSizeRow {
  format: ReportFormat;
  /** Number of completed jobs for this format. */
  job_count: number;
  /** Average estimated size in KB (0 when no jobs). */
  avg_size_kb: number;
  /** Median estimated size in KB (0 when no jobs). */
  median_size_kb: number;
  /** Total estimated size in KB across all jobs. */
  total_size_kb: number;
  /** Job with the largest estimated output. null when no jobs. */
  largest_job: { job_id: string; estimated_size_kb: number } | null;
}

export interface ReportFormatSizeDistribution {
  tenant_id: string;
  generated_at: string;
  /** Total completed jobs considered. */
  total_completed: number;
  /** Per-format rows sorted by total_size_kb desc. */
  formats: ReportFormatSizeRow[];
  /** Format with the highest total estimated storage. null when no jobs. */
  largest_format: string | null;
  /** Sum of all format total_size_kb. */
  total_estimated_storage_kb: number;
}

// ─── Size estimation ──────────────────────────────────────────────────

/** Deterministic size estimate based on job_id + format using FNV-1a. */
function estimateSizeKb(job_id: string, format: ReportFormat): number {
  let h = 2166136261;
  for (let i = 0; i < job_id.length; i++) {
    h = h ^ job_id.charCodeAt(i);
    h = (((h >>> 0) * 16777619) >>> 0);
  }
  // Incorporate format character
  const fchar = format.charCodeAt(0);
  h = h ^ fchar;
  h = (((h >>> 0) * 16777619) >>> 0);

  const [minKb, maxKb] = SIZE_RANGE_KB[format];
  const range = maxKb - minKb;
  const frac = (h >>> 0) / 4294967295;
  return Math.round((minKb + frac * range) * 10) / 10;
}

// ─── Pure function ────────────────────────────────────────────────────

export function buildReportFormatSizeDistribution(
  jobs: ReportJob[],
  tenant_id: string,
  now: Date,
): ReportFormatSizeDistribution {
  if (!tenant_id) throw new Error('tenant_id is required');

  // Filter to completed jobs only
  const completed = jobs.filter(j => j.status === 'completed' && j.tenant_id === tenant_id);

  const formatData = new Map<ReportFormat, { sizes: number[]; jobs: ReportJob[] }>();
  const ALL_FORMATS: ReportFormat[] = ['json', 'csv', 'pdf', 'xlsx'];
  for (const fmt of ALL_FORMATS) {
    formatData.set(fmt, { sizes: [], jobs: [] });
  }

  for (const job of completed) {
    const fmt = job.format as ReportFormat;
    if (!formatData.has(fmt)) continue;
    const sizeKb = estimateSizeKb(job.job_id, fmt);
    formatData.get(fmt)!.sizes.push(sizeKb);
    formatData.get(fmt)!.jobs.push(job);
  }

  const rows: ReportFormatSizeRow[] = [];
  for (const fmt of ALL_FORMATS) {
    const { sizes, jobs: fmtJobs } = formatData.get(fmt)!;
    const job_count = sizes.length;
    const total_size_kb = sizes.reduce((s, v) => s + v, 0);
    const avg_size_kb = job_count > 0 ? Math.round((total_size_kb / job_count) * 10) / 10 : 0;

    // Median
    let median_size_kb = 0;
    if (job_count > 0) {
      const sorted = [...sizes].sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      median_size_kb = sorted.length % 2 === 0
        ? Math.round(((sorted[mid - 1] + sorted[mid]) / 2) * 10) / 10
        : sorted[mid];
    }

    // Largest job
    let largest_job: { job_id: string; estimated_size_kb: number } | null = null;
    if (job_count > 0) {
      let maxSize = -Infinity;
      let maxJob: ReportJob | null = null;
      for (let i = 0; i < fmtJobs.length; i++) {
        if (sizes[i] > maxSize) {
          maxSize = sizes[i];
          maxJob = fmtJobs[i];
        }
      }
      largest_job = maxJob ? { job_id: maxJob.job_id, estimated_size_kb: maxSize } : null;
    }

    rows.push({
      format: fmt,
      job_count,
      avg_size_kb,
      median_size_kb,
      total_size_kb: Math.round(total_size_kb * 10) / 10,
      largest_job,
    });
  }

  // Sort by total_size_kb desc
  rows.sort((a, b) => b.total_size_kb - a.total_size_kb);

  const total_estimated_storage_kb = Math.round(
    rows.reduce((s, r) => s + r.total_size_kb, 0) * 10
  ) / 10;

  const usedRows = rows.filter(r => r.job_count > 0);
  const largest_format = usedRows.length > 0 ? usedRows[0].format : null;
  const total_completed = completed.length;

  return {
    tenant_id,
    generated_at: now.toISOString(),
    total_completed,
    formats: rows,
    largest_format,
    total_estimated_storage_kb,
  };
}

// ─── Store adapter ────────────────────────────────────────────────────

export async function buildReportFormatSizeDistributionFromStore(
  store: ReportJobStore,
  tenant_id: string,
  now: Date,
): Promise<ReportFormatSizeDistribution> {
  const jobs: ReportJob[] = [];
  for (let page = 1; page <= DRAIN_PAGE_CAP; page++) {
    const result = store.list(tenant_id, {
      status: 'completed',
      page,
      page_size: DRAIN_PAGE_SIZE,
    });
    jobs.push(...result.items);
    if (result.items.length < DRAIN_PAGE_SIZE) break;
  }
  return buildReportFormatSizeDistribution(jobs, tenant_id, now);
}
