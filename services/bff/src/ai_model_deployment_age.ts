// services/bff/src/ai_model_deployment_age.ts
//
// T6 M7.11 — Model deployment age histogram.
//
// M7.1 ships the registry; M7.9 surfaces stale + aging
// retirement candidates. M7.11 is the histogram view: bucket
// every non-retired model by days_since_deployed into 5
// canonical operational buckets (< 30d / 30-90d / 90-180d /
// 180-365d / 365d+) plus a "never_deployed" tail and emit
// counts + sample drill-throughs per bucket.
//
// Mirror of M9.11 (investigation age buckets) for AI models.
// Companion to M7.9 (binary stale/aging classifier) — M7.11
// is the FULL-spectrum distribution view.
//
// Pure rollup — single pass over the M7.1 registry list.

import type { AiModelRegistry, ModelStatus, ModelVersion } from './ai_model_registry';

// ─── Public types ─────────────────────────────────────────────────────

export type DeploymentAgeBucket =
  | 'under_30d'
  | '30_to_90d'
  | '90_to_180d'
  | '180_to_365d'
  | '365d_plus'
  | 'never_deployed';

interface BucketDef {
  bucket: DeploymentAgeBucket;
  label: string;
  /** Inclusive lower bound, exclusive upper bound. null = open. */
  min_days: number | null;
  max_days: number | null;
}

const BUCKETS: readonly BucketDef[] = [
  { bucket: 'under_30d', label: '< 30 days', min_days: 0, max_days: 30 },
  { bucket: '30_to_90d', label: '30-90 days', min_days: 30, max_days: 90 },
  { bucket: '90_to_180d', label: '90-180 days', min_days: 90, max_days: 180 },
  { bucket: '180_to_365d', label: '180-365 days', min_days: 180, max_days: 365 },
  { bucket: '365d_plus', label: '365 days+', min_days: 365, max_days: null },
  { bucket: 'never_deployed', label: 'Never deployed', min_days: null, max_days: null },
] as const;

export interface DeploymentAgeBucketRow {
  bucket: DeploymentAgeBucket;
  label: string;
  min_days: number | null;
  max_days: number | null;
  count: number;
  /** Up to 3 oldest models in this bucket (sorted by days_since_deployed
   *  desc with model_id asc tie-break). For the never_deployed bucket,
   *  sort by days_since_trained desc instead. */
  samples: Array<{
    model_id: string;
    name: string;
    type: ModelVersion['type'];
    status: ModelStatus;
    days_since_deployed: number | null;
  }>;
}

export interface ModelDeploymentAgeHistogram {
  generated_at: string;
  total_models_considered: number;
  /** Number of registered models (incl. retired — they're excluded
   *  separately below). Useful denominator for the SPA chart. */
  total_models_in_registry: number;
  /** Retired models — excluded from bucket counts. */
  total_retired_excluded: number;
  /** Bucket rows in canonical order. */
  buckets: DeploymentAgeBucketRow[];
  /** Bucket with the highest count. Ties broken by canonical
   *  BUCKETS order. null when total_models_considered === 0. */
  dominant_bucket: DeploymentAgeBucket | null;
}

// ─── Pure resolver ────────────────────────────────────────────────────

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function daysSince(iso: string | null, now: Date): number | null {
  if (!iso) return null;
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return null;
  return Math.floor((now.getTime() - ts) / MS_PER_DAY);
}

function bucketFor(days: number | null): DeploymentAgeBucket {
  if (days === null) return 'never_deployed';
  if (days < 30) return 'under_30d';
  if (days < 90) return '30_to_90d';
  if (days < 180) return '90_to_180d';
  if (days < 365) return '180_to_365d';
  return '365d_plus';
}

export function bucketModelsByDeploymentAge(
  registry: AiModelRegistry,
  now: Date,
): ModelDeploymentAgeHistogram {
  const allModels = registry.list();
  const considered = allModels.filter((m) => m.status !== 'retired');
  const total_retired_excluded = allModels.length - considered.length;

  // Pre-fill every canonical bucket so the SPA gets a stable row count.
  const rows = new Map<DeploymentAgeBucket, DeploymentAgeBucketRow>();
  for (const b of BUCKETS) {
    rows.set(b.bucket, {
      bucket: b.bucket,
      label: b.label,
      min_days: b.min_days,
      max_days: b.max_days,
      count: 0,
      samples: [],
    });
  }

  // Build per-bucket candidate lists with their sort metric, then trim.
  const candidates = new Map<DeploymentAgeBucket, Array<{
    row: DeploymentAgeBucketRow['samples'][number];
    sort_metric: number;
  }>>();
  for (const b of BUCKETS) candidates.set(b.bucket, []);

  for (const m of considered) {
    const days = daysSince(m.deployed_at, now);
    const bucket = bucketFor(days);
    const row = rows.get(bucket)!;
    row.count++;
    // Sort metric: days desc within deployed buckets (oldest first);
    // for never_deployed use days_since_trained desc.
    let sort_metric = days ?? -Infinity;
    if (bucket === 'never_deployed') {
      const trainedDays = daysSince(m.trained_at, now);
      sort_metric = trainedDays ?? -Infinity;
    }
    candidates.get(bucket)!.push({
      row: {
        model_id: m.model_id,
        name: m.name,
        type: m.type,
        status: m.status,
        days_since_deployed: days,
      },
      sort_metric,
    });
  }

  // Trim each bucket's candidates to top 3 by sort_metric desc with
  // model_id asc tie-break.
  for (const [bucket, list] of candidates.entries()) {
    list.sort((a, b) => {
      if (b.sort_metric !== a.sort_metric) return b.sort_metric - a.sort_metric;
      return a.row.model_id.localeCompare(b.row.model_id);
    });
    rows.get(bucket)!.samples = list.slice(0, 3).map((x) => x.row);
  }

  const orderedRows: DeploymentAgeBucketRow[] = BUCKETS.map((b) => rows.get(b.bucket)!);

  let dominant_bucket: DeploymentAgeBucket | null = null;
  let mostCount = 0;
  for (const r of orderedRows) {
    if (r.count > mostCount) {
      mostCount = r.count;
      dominant_bucket = r.bucket;
    }
    // Iteration follows BUCKETS canonical order — ties resolve to first-seen.
  }

  return {
    generated_at: now.toISOString(),
    total_models_considered: considered.length,
    total_models_in_registry: allModels.length,
    total_retired_excluded,
    buckets: orderedRows,
    dominant_bucket,
  };
}
