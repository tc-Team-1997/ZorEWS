// services/bff/src/custom_dashboard_widget_count_histogram.ts
//
// T6 M11.19 — Custom dashboard widget-count histogram.
//
// Per-tenant histogram bucketing every saved dashboard by its
// `widgets.length` into 6 canonical buckets answering "are our
// custom dashboards too thin (single-widget) or too dense?"
//
// 6 buckets in canonical density order:
//   empty   — 0 widgets (dashboard exists but no panels;
//             surfaces config-gap / placeholder)
//   minimal — 1 widget
//   small   — 2-3 widgets
//   medium  — 4-6 widgets
//   large   — 7-12 widgets
//   x_large — 13+ widgets (open-ended; SPA-rendering candidate
//             for performance review — too dense to fit one screen)
//
// Strict-< upper bound semantics (4 widgets exactly → medium, not
// small; matches the M5.18 indicator-count + M9.11 case-age pattern).
//
// Distinct from:
//   M11.11 — widget USAGE analytics (per widget_type, fleet-wide)
//   M11.14 — fleet lint summary (validation issues per dashboard)
//   M11.15 — authorship rollup (per created_by)
//   M11.17 — widget × creator cross-tab (per (creator, widget_type))
//   M11.18 — freshness rollup (per dashboard by updated_at age)
//
// Mirror of M5.18 / M4.15 / M9.11 / M8.12 / M7.15 / M3.16 histogram
// pattern for the custom dashboard surface.
//
// Drives BIL governance "do operators build dashboards with the right
// amount of content?" review + "any abandoned single-widget
// dashboards that should be consolidated or deleted?" cleanup.

import type {
  CustomDashboard,
  CustomDashboardStore,
} from './custom_dashboards';

// ---------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------

export type DashboardWidgetCountBucket =
  | 'empty'
  | 'minimal'
  | 'small'
  | 'medium'
  | 'large'
  | 'x_large';

export const ALL_DASHBOARD_WIDGET_COUNT_BUCKETS: readonly DashboardWidgetCountBucket[] = [
  'empty',
  'minimal',
  'small',
  'medium',
  'large',
  'x_large',
] as const;

export const SAMPLE_DASHBOARDS_CAP = 3;

interface BucketMeta {
  bucket: DashboardWidgetCountBucket;
  label: string;
  min: number;
  /** null on the open-ended x_large bucket. */
  max: number | null;
  /** True when max is inclusive (every defined bucket is inclusive
   *  in the [min, max] sense). The histogram emits this so SPA
   *  tooltips can render the band correctly. */
  max_inclusive: boolean;
}

const BUCKET_DEFS: readonly BucketMeta[] = [
  { bucket: 'empty', label: '0 widgets', min: 0, max: 0, max_inclusive: true },
  { bucket: 'minimal', label: '1 widget', min: 1, max: 1, max_inclusive: true },
  { bucket: 'small', label: '2-3 widgets', min: 2, max: 3, max_inclusive: true },
  { bucket: 'medium', label: '4-6 widgets', min: 4, max: 6, max_inclusive: true },
  { bucket: 'large', label: '7-12 widgets', min: 7, max: 12, max_inclusive: true },
  { bucket: 'x_large', label: '13+ widgets', min: 13, max: null, max_inclusive: false },
] as const;

// ---------------------------------------------------------------------
// Pure bucketing helper
// ---------------------------------------------------------------------

/** Bucket a non-negative widget count into one of the 6 canonical
 *  buckets. Returns null on negative / non-integer / NaN / Infinity
 *  (defensive — callers should not produce these, but the histogram
 *  silently skips them rather than throwing). */
export function bucketForWidgetCount(n: number): DashboardWidgetCountBucket | null {
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) return null;
  if (n === 0) return 'empty';
  if (n === 1) return 'minimal';
  if (n <= 3) return 'small';
  if (n <= 6) return 'medium';
  if (n <= 12) return 'large';
  return 'x_large';
}

// ---------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------

export interface DashboardSample {
  dashboard_id: string;
  name: string;
  created_by: string;
  widget_count: number;
}

export interface DashboardWidgetCountBucketRow {
  bucket: DashboardWidgetCountBucket;
  label: string;
  min: number;
  max: number | null;
  max_inclusive: boolean;
  count: number;
  /** Cap 3 sorted widget_count desc + dashboard_id asc tie-break
   *  (most-dense in this band surfaces first). */
  sample_dashboards: DashboardSample[];
}

export interface DashboardWidgetCountHistogram {
  tenant_id: string;
  generated_at: string;
  total_dashboards: number;
  /** Total widgets across every dashboard (Σ widgets.length). */
  total_widgets: number;
  /** 6 buckets in canonical order. */
  buckets: DashboardWidgetCountBucketRow[];
  /** Highest-count bucket. Canonical iteration tie-break: empty wins
   *  over minimal at tied count. null when zero dashboards. */
  peak_bucket: DashboardWidgetCountBucket | null;
  peak_count: number;
  /** Rounded to 2 decimal places; null when zero dashboards. */
  mean_widgets: number | null;
  /** Min/max widget count observed; null on empty. */
  min_widgets: number | null;
  max_widgets: number | null;
  /** Subset of buckets with count=0 (canonical order). Useful gap
   *  surface for SPA "we have no x_large dashboards" headline. */
  empty_buckets: DashboardWidgetCountBucket[];
}

// ---------------------------------------------------------------------
// Pure resolver
// ---------------------------------------------------------------------

function compareSample(a: DashboardSample, b: DashboardSample): number {
  // Highest widget_count first
  if (b.widget_count !== a.widget_count) return b.widget_count - a.widget_count;
  // Tie-break by dashboard_id asc
  return a.dashboard_id.localeCompare(b.dashboard_id);
}

export function buildDashboardWidgetCountHistogram(
  tenant_id: string,
  dashboards: CustomDashboard[],
  now: Date,
): DashboardWidgetCountHistogram {
  if (!tenant_id || tenant_id.trim() === '') {
    throw new Error('buildDashboardWidgetCountHistogram: tenant_id required');
  }

  // Per-bucket accumulators
  const counts = new Map<DashboardWidgetCountBucket, number>();
  const samples = new Map<DashboardWidgetCountBucket, DashboardSample[]>();
  for (const b of BUCKET_DEFS) {
    counts.set(b.bucket, 0);
    samples.set(b.bucket, []);
  }

  let total_widgets = 0;
  let min_widgets: number | null = null;
  let max_widgets: number | null = null;

  for (const d of dashboards) {
    const wc = d.widgets.length;
    const bucket = bucketForWidgetCount(wc);
    if (bucket === null) continue;
    counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
    total_widgets += wc;
    if (min_widgets === null || wc < min_widgets) min_widgets = wc;
    if (max_widgets === null || wc > max_widgets) max_widgets = wc;
    const arr = samples.get(bucket)!;
    arr.push({
      dashboard_id: d.dashboard_id,
      name: d.name,
      created_by: d.created_by,
      widget_count: wc,
    });
  }

  // Sort + cap each bucket's samples
  for (const arr of samples.values()) {
    arr.sort(compareSample);
    if (arr.length > SAMPLE_DASHBOARDS_CAP) arr.length = SAMPLE_DASHBOARDS_CAP;
  }

  const buckets: DashboardWidgetCountBucketRow[] = BUCKET_DEFS.map((meta) => ({
    bucket: meta.bucket,
    label: meta.label,
    min: meta.min,
    max: meta.max,
    max_inclusive: meta.max_inclusive,
    count: counts.get(meta.bucket) ?? 0,
    sample_dashboards: samples.get(meta.bucket) ?? [],
  }));

  // peak_bucket via canonical iteration (strict > so first scanned wins on ties)
  let peak_bucket: DashboardWidgetCountBucket | null = null;
  let peak_count = 0;
  for (const row of buckets) {
    if (row.count > peak_count) {
      peak_count = row.count;
      peak_bucket = row.bucket;
    }
  }
  // When EVERY bucket is 0, peak_bucket stays null + peak_count stays 0
  if (peak_count === 0) peak_bucket = null;

  const total_dashboards = dashboards.length;
  const mean_widgets =
    total_dashboards === 0
      ? null
      : Math.round((total_widgets / total_dashboards) * 100) / 100;

  const empty_buckets = buckets.filter((r) => r.count === 0).map((r) => r.bucket);

  return {
    tenant_id,
    generated_at: now.toISOString(),
    total_dashboards,
    total_widgets,
    buckets,
    peak_bucket,
    peak_count,
    mean_widgets,
    min_widgets,
    max_widgets,
    empty_buckets,
  };
}

// ---------------------------------------------------------------------
// Store adapter
// ---------------------------------------------------------------------

export function buildDashboardWidgetCountHistogramFromStore(
  store: CustomDashboardStore,
  tenant_id: string,
  now: Date,
): DashboardWidgetCountHistogram {
  const dashboards = store.list(tenant_id);
  return buildDashboardWidgetCountHistogram(tenant_id, dashboards, now);
}
