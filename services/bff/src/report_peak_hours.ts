// services/bff/src/report_peak_hours.ts
//
// T6 M12.24 — Report job peak hour analysis.
//
// From all report jobs, bucket by UTC hour-of-day (0-23) of requested_at.
// For each hour: {hour, job_count, format_mix: {json, csv, pdf, xlsx}}.
// Peak hour = highest count.
// Quietest = lowest count.
// Recommended maintenance window = quietest consecutive 4-hour block.
//
// Route: GET /v1/reports/jobs/peak-hours
//   RBAC: audit:read (admin)

import { defaultReportJobStore, type ReportJobStore } from './reports_catalog';

// ─── Public types ─────────────────────────────────────────────────────

export interface HourBucket {
  hour: number;
  job_count: number;
  format_mix: {
    json: number;
    csv: number;
    pdf: number;
    xlsx: number;
  };
}

export interface ReportPeakHoursReport {
  tenant_id: string;
  generated_at: string;
  by_hour: HourBucket[];
  peak_hour: number | null;
  peak_count: number;
  quietest_hour: number | null;
  avg_per_hour: number;
  recommended_maintenance_window: { start_hour: number; end_hour: number } | null;
}

function emptyFormatMix() {
  return { json: 0, csv: 0, pdf: 0, xlsx: 0 };
}

function findQuietestConsecutiveBlock(counts: number[], block_size: number): number {
  let minSum = Infinity;
  let bestStart = 0;
  for (let start = 0; start < 24; start++) {
    let sum = 0;
    for (let i = 0; i < block_size; i++) sum += counts[(start + i) % 24];
    if (sum < minSum) {
      minSum = sum;
      bestStart = start;
    }
  }
  return bestStart;
}

// ─── Pure resolver ────────────────────────────────────────────────────

export function buildReportPeakHours(
  store: ReportJobStore,
  tenant_id: string,
  now: Date,
): ReportPeakHoursReport {
  if (!tenant_id) throw new Error('tenant_id is required');

  const buckets: HourBucket[] = Array.from({ length: 24 }, (_, h) => ({
    hour: h,
    job_count: 0,
    format_mix: emptyFormatMix(),
  }));

  // Drain all jobs
  let page = 1;
  const PAGE_SIZE = 200;
  for (;;) {
    const result = store.list(tenant_id, { page, page_size: PAGE_SIZE });
    for (const job of result.items) {
      const hour = new Date(job.requested_at).getUTCHours();
      buckets[hour].job_count++;
      const fmt = job.format as keyof ReturnType<typeof emptyFormatMix>;
      if (fmt in buckets[hour].format_mix) {
        buckets[hour].format_mix[fmt]++;
      }
    }
    if (result.items.length < PAGE_SIZE) break;
    page++;
    if (page > 200) break;
  }

  const counts = buckets.map((b) => b.job_count);
  const total = counts.reduce((s, c) => s + c, 0);
  const avg_per_hour = Math.round((total / 24) * 100) / 100;

  const maxCount = Math.max(...counts);
  const minCount = Math.min(...counts);

  const peak_hour = total === 0 ? null : counts.indexOf(maxCount);
  const quietest_hour = total === 0 ? null : counts.indexOf(minCount);

  const maintenanceStart = total === 0 ? null : findQuietestConsecutiveBlock(counts, 4);
  const recommended_maintenance_window =
    maintenanceStart === null
      ? null
      : {
          start_hour: maintenanceStart,
          end_hour: (maintenanceStart + 3) % 24,
        };

  return {
    tenant_id,
    generated_at: now.toISOString(),
    by_hour: buckets,
    peak_hour,
    peak_count: maxCount,
    quietest_hour,
    avg_per_hour,
    recommended_maintenance_window,
  };
}
