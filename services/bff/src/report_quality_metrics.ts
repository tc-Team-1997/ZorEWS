// services/bff/src/report_quality_metrics.ts
// T6 M12.25 — Report output quality metrics.
// Computes quality metrics per report_id from completed jobs.

import { type ReportJobStore, defaultReportJobStore } from './reports_catalog';

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

export type QualityGrade = 'A' | 'B' | 'C';

export interface ReportQualityEntry {
  report_id: string;
  completed_count: number;
  avg_row_count: number;      // synthesized 100-10000
  avg_processing_ms: number;  // mean of completed job durations
  data_freshness_score: number; // synthesized 70-100
  quality_grade: QualityGrade;
}

export interface ReportQualityMetricsResult {
  tenant_id: string;
  generated_at: string;
  total_completed: number;
  by_report: ReportQualityEntry[];
  most_data_rich_report: string | null;
  reports_count: number;
}

function gradeFor(freshness: number): QualityGrade {
  if (freshness >= 90) return 'A';
  if (freshness >= 80) return 'B';
  return 'C';
}

export function buildReportQualityMetrics(
  store: ReportJobStore,
  tenant_id: string,
  now: Date,
): ReportQualityMetricsResult {
  if (!tenant_id) throw new Error('tenant_id required');

  const page = store.list(tenant_id, { status: 'completed' });
  const completed = page.items;

  const groups = new Map<string, typeof completed>();
  for (const job of completed) {
    if (!groups.has(job.report_id)) groups.set(job.report_id, []);
    groups.get(job.report_id)!.push(job);
  }

  const dayKey = Math.floor(now.getTime() / 86_400_000);

  const by_report: ReportQualityEntry[] = [];
  for (const [report_id, jobs] of groups) {
    const seed = fnv1a(`${tenant_id}:report_quality:${report_id}:${dayKey}`);
    const rng = mulberry32(seed);

    const avg_row_count = Math.floor(100 + rng() * 9900); // 100-10000

    const totalMs = jobs.reduce((s, j) => {
      if (!j.requested_at || !j.completed_at) return s;
      const diff = new Date(j.completed_at).getTime() - new Date(j.requested_at).getTime();
      return s + Math.max(0, diff);
    }, 0);
    const avg_processing_ms = jobs.length > 0 ? Math.round(totalMs / jobs.length) : 0;

    const data_freshness_score = Math.round(70 + rng() * 30); // 70-100

    by_report.push({
      report_id,
      completed_count: jobs.length,
      avg_row_count,
      avg_processing_ms,
      data_freshness_score,
      quality_grade: gradeFor(data_freshness_score),
    });
  }

  // Sort by avg_row_count desc, report_id asc tie-break
  by_report.sort((a, b) => b.avg_row_count - a.avg_row_count || a.report_id.localeCompare(b.report_id));

  const most_data_rich_report = by_report.length > 0 ? by_report[0].report_id : null;

  return {
    tenant_id,
    generated_at: now.toISOString(),
    total_completed: completed.length,
    by_report,
    most_data_rich_report,
    reports_count: by_report.length,
  };
}
