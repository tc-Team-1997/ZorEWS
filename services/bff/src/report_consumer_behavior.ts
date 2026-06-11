// services/bff/src/report_consumer_behavior.ts
// T6 M12.28 — Report consumer behavior analysis

import { type ReportJobStore } from './reports_catalog';

export type EngagementTier = 'high' | 'medium' | 'low';

export interface RequesterCount {
  requester: string;
  count: number;
}

export interface FormatPreference {
  format: string;
  count: number;
}

export interface ReportConsumerBehavior {
  tenant_id: string;
  generated_at: string;
  total_jobs: number;
  unique_requesters: number;
  repeat_requesters: number;
  format_preference: FormatPreference[];
  peak_request_day: string;
  top_requesters: RequesterCount[];
  engagement_score: number;
  engagement_tier: EngagementTier;
}

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function buildReportConsumerBehavior(
  store: ReportJobStore,
  tenant_id: string,
  now: Date
): ReportConsumerBehavior {
  const generated_at = now.toISOString();
  const page = store.list(tenant_id, { page_size: 500 });
  const jobs = page.items;

  const requesterCounts = new Map<string, number>();
  const formatCounts = new Map<string, number>();
  const dayCounts = new Map<number, number>(); // 0=Sun..6=Sat

  for (const job of jobs) {
    const rb = job.requested_by;
    requesterCounts.set(rb, (requesterCounts.get(rb) ?? 0) + 1);
    formatCounts.set(job.format, (formatCounts.get(job.format) ?? 0) + 1);
    const day = new Date(job.requested_at).getUTCDay();
    dayCounts.set(day, (dayCounts.get(day) ?? 0) + 1);
  }

  const unique_requesters = requesterCounts.size;
  const repeat_requesters = Array.from(requesterCounts.values()).filter((c) => c > 1).length;

  const format_preference: FormatPreference[] = Array.from(formatCounts.entries())
    .map(([format, count]) => ({ format, count }))
    .sort((a, b) => b.count - a.count);

  let peakDayNum = 1; // default Monday
  let peakDayCount = 0;
  for (const [day, count] of dayCounts.entries()) {
    if (count > peakDayCount) {
      peakDayCount = count;
      peakDayNum = day;
    }
  }
  const peak_request_day = DAYS[peakDayNum] ?? 'Monday';

  const top_requesters: RequesterCount[] = Array.from(requesterCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([requester, count]) => ({ requester, count }));

  const format_diversity = formatCounts.size;
  const engagement_score = Math.min(100, unique_requesters * 15 + format_diversity * 20 + repeat_requesters * 5);

  let engagement_tier: EngagementTier;
  if (engagement_score >= 60) engagement_tier = 'high';
  else if (engagement_score >= 30) engagement_tier = 'medium';
  else engagement_tier = 'low';

  return {
    tenant_id,
    generated_at,
    total_jobs: jobs.length,
    unique_requesters,
    repeat_requesters,
    format_preference,
    peak_request_day,
    top_requesters,
    engagement_score,
    engagement_tier,
  };
}
