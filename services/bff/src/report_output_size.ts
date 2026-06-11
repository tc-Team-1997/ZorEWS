// services/bff/src/report_output_size.ts
//
// T6 M12.22 — Report output size distribution.
//
// For each completed report job, estimate the output size in bytes
// based on format. Groups into size buckets.

import { type ReportJobStore, type ReportFormat } from './reports_catalog';

function fnv1a(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = ((h ^ s.charCodeAt(i)) * 16777619) >>> 0;
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let t = seed;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = t;
    r = ((r ^ (r >>> 15)) * (r | 1)) >>> 0;
    r = (r ^ (r + ((r ^ (r >>> 7)) * (r | 61)))) >>> 0;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

const BASE_SIZES: Record<ReportFormat, number> = {
  json: 50 * 1024,
  csv: 35 * 1024,
  pdf: 120 * 1024,
  xlsx: 80 * 1024,
};

type SizeBucket = 'small' | 'medium' | 'large' | 'xlarge';

function getBucket(bytes: number): SizeBucket {
  if (bytes < 50 * 1024) return 'small';
  if (bytes < 100 * 1024) return 'medium';
  if (bytes < 500 * 1024) return 'large';
  return 'xlarge';
}

function estimateSize(job_id: string, format: ReportFormat): number {
  const base = BASE_SIZES[format] ?? 50 * 1024;
  const seed = fnv1a(`size|${job_id}|${format}`);
  const rand = mulberry32(seed);
  return Math.round(base * (1 + rand() * 0.5));
}

export interface ReportOutputSizeResult {
  tenant_id: string;
  generated_at: string;
  total_jobs: number;
  buckets: { small: number; medium: number; large: number; xlarge: number };
  avg_size_bytes: number | null;
  largest_job_id: string | null;
  by_format: Record<ReportFormat, number>;
}

export function buildReportOutputSizeDistribution(
  store: ReportJobStore,
  tenant_id: string,
  now: Date,
): ReportOutputSizeResult {
  if (!tenant_id) throw new Error('tenant_id required');

  // Drain all completed jobs
  const allJobs: Array<{ job_id: string; format: ReportFormat }> = [];
  for (let page = 1; page <= 200; page++) {
    const result = store.list(tenant_id, { status: 'completed', page, page_size: 500 });
    for (const j of result.items) {
      allJobs.push({ job_id: j.job_id, format: j.format });
    }
    if (result.items.length < 500) break;
  }

  const buckets = { small: 0, medium: 0, large: 0, xlarge: 0 };
  const formatTotals: Record<string, { total: number; count: number }> = {};
  let totalBytes = 0;
  let largestBytes = 0;
  let largest_job_id: string | null = null;

  for (const { job_id, format } of allJobs) {
    const bytes = estimateSize(job_id, format);
    const bucket = getBucket(bytes);
    buckets[bucket]++;
    totalBytes += bytes;

    if (!formatTotals[format]) formatTotals[format] = { total: 0, count: 0 };
    formatTotals[format].total += bytes;
    formatTotals[format].count++;

    if (bytes > largestBytes) { largestBytes = bytes; largest_job_id = job_id; }
  }

  const total_jobs = allJobs.length;
  const avg_size_bytes = total_jobs > 0 ? Math.round(totalBytes / total_jobs) : null;

  const by_format: Record<ReportFormat, number> = {
    json: 0,
    csv: 0,
    pdf: 0,
    xlsx: 0,
  };
  for (const [fmt, { total, count }] of Object.entries(formatTotals)) {
    if (count > 0) by_format[fmt as ReportFormat] = Math.round(total / count);
  }

  return {
    tenant_id,
    generated_at: now.toISOString(),
    total_jobs,
    buckets,
    avg_size_bytes,
    largest_job_id: total_jobs > 0 ? largest_job_id : null,
    by_format,
  };
}
