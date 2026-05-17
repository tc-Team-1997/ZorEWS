// services/bff/src/report_job_error_patterns.ts
//
// T6 M12.15 — Report job error pattern clustering.
//
// M12.1 ships the catalog + async job tracker; M12.5 ships fleet
// analytics (status mix + per-report rollup). M12.13 ships daily volume.
// M12.14 ships the format × status cross-tab. M12.15 lands the FAILURE
// FORENSICS view: cluster failed report jobs by normalised
// error_message template so ops can see "what failure templates dominate
// my report jobs this week?" rather than scrolling individual rows.
//
// Mirror of M3.6 connector run failure pattern clustering — same
// normalisation regex chain (UUIDs, ISO timestamps, quoted strings,
// POSIX paths, long hex runs, numbers) so the SPA can render the
// same "Failure Templates" panel across the connector + reports
// surfaces.
//
// REUSES `normaliseError` from connector_run_failure_patterns to avoid
// drift between the connector + report cluster engines.
//
// Pure resolver — caller passes drained job list, no I/O.

import { normaliseError } from './connector_run_failure_patterns';
import type { ReportJob, ReportJobStore } from './reports_catalog';

// ─── Public types ──────────────────────────────────────────────────────

export interface ReportJobFailurePattern {
  /** Normalised template (variable parts replaced with placeholders). */
  pattern: string;
  /** How many failed report jobs matched this pattern. */
  count: number;
  /** Up to 3 raw error_message strings — newest first. */
  recent_messages: string[];
  /** ISO timestamp of the newest failed job in this cluster
   *  (completed_at falls back to requested_at). */
  last_failed_at: string;
  /** job_id of the newest failed job — useful for drilling in. */
  sample_job_id: string;
  /** Distinct report_ids contributing to this pattern, sorted asc. */
  report_ids: string[];
}

export interface ReportJobFailurePatternsResult {
  tenant_id: string;
  generated_at: string;
  /** Total jobs scanned (across all statuses). */
  sample_size: number;
  /** Total failed jobs with a non-empty error_message. */
  failure_count: number;
  /** Distinct patterns observed (before cap). */
  distinct_patterns: number;
  /** Top clusters, by count desc → last_failed_at desc, capped. */
  clusters: ReportJobFailurePattern[];
}

export const REPORT_FAILURE_CLUSTERS_CAP = 10;
const EXEMPLAR_CAP = 3;

// ─── Helpers ───────────────────────────────────────────────────────────

function drainAllJobs(
  store: ReportJobStore,
  tenant_id: string,
): ReportJob[] {
  const PAGE = 500;
  const out: ReportJob[] = [];
  for (let page = 1; page <= 200; page++) {
    const result = store.list(tenant_id, { page, page_size: PAGE });
    out.push(...result.items);
    if (result.items.length < PAGE) break;
  }
  return out;
}

function failedAt(job: ReportJob): string | null {
  // completed_at is set when status flips to failed via markFailed;
  // fall back to requested_at as a last resort.
  return job.completed_at ?? job.requested_at ?? null;
}

// ─── Pure resolver ─────────────────────────────────────────────────────

export function clusterReportJobFailures(
  store: ReportJobStore,
  tenant_id: string,
  now: Date,
): ReportJobFailurePatternsResult {
  const jobs = drainAllJobs(store, tenant_id);

  type Bucket = {
    pattern: string;
    count: number;
    recent_messages: { msg: string; at: string }[];
    last_failed_at: string;
    sample_job_id: string;
    report_ids: Set<string>;
  };
  const buckets = new Map<string, Bucket>();
  let failure_count = 0;

  for (const j of jobs) {
    if (j.status !== 'failed') continue;
    const msg = (j.error_message ?? '').trim();
    if (!msg) continue;
    const at = failedAt(j);
    if (!at) continue;
    failure_count += 1;
    const pattern = normaliseError(msg) || '(empty)';
    let b = buckets.get(pattern);
    if (!b) {
      b = {
        pattern,
        count: 0,
        recent_messages: [],
        last_failed_at: at,
        sample_job_id: j.job_id,
        report_ids: new Set<string>(),
      };
      buckets.set(pattern, b);
    }
    b.count += 1;
    b.recent_messages.push({ msg, at });
    if (at > b.last_failed_at) {
      b.last_failed_at = at;
      b.sample_job_id = j.job_id;
    }
    b.report_ids.add(j.report_id);
  }

  for (const b of buckets.values()) {
    b.recent_messages.sort((a, c) => (a.at < c.at ? 1 : a.at > c.at ? -1 : 0));
    b.recent_messages.length = Math.min(b.recent_messages.length, EXEMPLAR_CAP);
  }

  const clusters: ReportJobFailurePattern[] = [...buckets.values()]
    .map((b) => ({
      pattern: b.pattern,
      count: b.count,
      recent_messages: b.recent_messages.map((m) => m.msg),
      last_failed_at: b.last_failed_at,
      sample_job_id: b.sample_job_id,
      report_ids: [...b.report_ids].sort(),
    }))
    .sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      // tie-break by last_failed_at desc
      return a.last_failed_at < b.last_failed_at
        ? 1
        : a.last_failed_at > b.last_failed_at
          ? -1
          : 0;
    })
    .slice(0, REPORT_FAILURE_CLUSTERS_CAP);

  return {
    tenant_id,
    generated_at: now.toISOString(),
    sample_size: jobs.length,
    failure_count,
    distinct_patterns: buckets.size,
    clusters,
  };
}
