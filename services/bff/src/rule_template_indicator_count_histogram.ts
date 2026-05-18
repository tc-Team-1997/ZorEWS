// services/bff/src/rule_template_indicator_count_histogram.ts
//
// T6 M5.18 — Rule template supporting_indicators count histogram.
//
// M5.14 ships the template × indicator coverage CHECK (validates
// every supporting_indicators id exists in the M6.2 catalog). M5.15
// ships recommended-action inventory (BY-ACTION pivot). M5.16 ships
// severity distribution (BY-SEVERITY pivot). M5.17 ships category ×
// vertical 2D matrix.
//
// M5.18 ships the HISTOGRAM view answering "what's the SHAPE of
// indicator usage per template? are our templates too narrow (single
// indicator) or too broad (10+ indicators)?". 5 canonical buckets:
//
//   - minimal       (1 indicator)
//   - low           (2-3 indicators)
//   - medium        (4-6 indicators)
//   - high          (7-10 indicators)
//   - comprehensive (> 10 indicators)
//
// Per-bucket carries by_category + by_vertical breakdowns so an admin
// can spot "every fraud_detection template uses 1-2 indicators (narrow)
// but every risk_monitoring template uses 4+ (broad)" type patterns.
//
// Mirror of M4.15 (indicator weight histogram) + M9.11 (case age) + M8.12
// (alert ack-time) + M7.15 (promotion latency) histogram pattern for the
// rule template surface. Platform-static — same response across tenants.

import {
  RULE_TEMPLATES,
  listCategories,
  type RuleTemplate,
  type RuleTemplateCategory,
  type RuleTemplateVertical,
} from './rule_templates';
import { ALL_RULE_TEMPLATE_VERTICALS } from './rule_template_category_vertical_matrix';

// ─── Public types ──────────────────────────────────────────────────────

export type IndicatorCountBucket =
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'comprehensive';

export const ALL_INDICATOR_COUNT_BUCKETS: readonly IndicatorCountBucket[] = [
  'minimal',
  'low',
  'medium',
  'high',
  'comprehensive',
] as const;

export interface IndicatorCountBucketRow {
  bucket: IndicatorCountBucket;
  label: string;
  min: number;
  /** max bound; null for the open-ended `comprehensive` bucket. */
  max: number | null;
  max_inclusive: boolean;
  count: number;
  /** Per-category counts; every RuleTemplateCategory present at 0
   *  when absent (stable grid). */
  by_category: Record<RuleTemplateCategory, number>;
  /** Per-vertical counts; every RuleTemplateVertical present at 0
   *  when absent. */
  by_vertical: Record<RuleTemplateVertical, number>;
  /** Top 3 sample template_ids sorted asc (deterministic display). */
  sample_template_ids: string[];
}

export interface RuleTemplateIndicatorCountHistogram {
  generated_at: string;
  /** # templates that landed in a bucket (= templates with ≥ 1
   *  supporting_indicator). */
  total_templates: number;
  /** Templates with empty supporting_indicators[] — surfaced
   *  separately as a config-gap signal (excluded from buckets +
   *  envelope mean/min/max). */
  templates_with_zero_indicators: number;
  /** Total seed catalog size = total_templates + templates_with_zero_indicators. */
  total_catalog_size: number;
  buckets: IndicatorCountBucketRow[];
  /** Highest-count bucket; tie-broken by canonical bucket order via
   *  iteration; null on empty catalog. */
  peak_bucket: IndicatorCountBucket | null;
  peak_count: number;
  /** Mean # indicators per template (rounded to 2 decimals; null when
   *  total_templates=0). */
  mean_indicators: number | null;
  /** Min + max indicator counts across catalog; null on empty. */
  min_indicators: number | null;
  max_indicators: number | null;
  /** Zero-count buckets in canonical order (coverage gaps). */
  empty_buckets: IndicatorCountBucket[];
}

// ─── Bucket boundaries ─────────────────────────────────────────────────

const BUCKET_META: Record<
  IndicatorCountBucket,
  { label: string; min: number; max: number | null; max_inclusive: boolean }
> = {
  minimal: { label: '1 indicator', min: 1, max: 1, max_inclusive: true },
  low: { label: '2-3 indicators', min: 2, max: 3, max_inclusive: true },
  medium: { label: '4-6 indicators', min: 4, max: 6, max_inclusive: true },
  high: { label: '7-10 indicators', min: 7, max: 10, max_inclusive: true },
  comprehensive: {
    label: '11+ indicators',
    min: 11,
    max: null,
    max_inclusive: false,
  },
};

/** Pure helper — bucket a template by its supporting_indicators length.
 *  Returns null for 0-indicator templates (defensive — shouldn't happen
 *  per catalog but caller is free to filter). */
export function bucketForIndicatorCount(n: number): IndicatorCountBucket | null {
  if (!Number.isFinite(n) || n < 1) return null;
  if (n === 1) return 'minimal';
  if (n <= 3) return 'low';
  if (n <= 6) return 'medium';
  if (n <= 10) return 'high';
  return 'comprehensive';
}

// ─── Helpers ───────────────────────────────────────────────────────────

function emptyByCategory(): Record<RuleTemplateCategory, number> {
  const out = {} as Record<RuleTemplateCategory, number>;
  for (const c of listCategories()) out[c] = 0;
  return out;
}

function emptyByVertical(): Record<RuleTemplateVertical, number> {
  const out = {} as Record<RuleTemplateVertical, number>;
  for (const v of ALL_RULE_TEMPLATE_VERTICALS) out[v] = 0;
  return out;
}

// ─── Pure resolver ─────────────────────────────────────────────────────

export function buildRuleTemplateIndicatorCountHistogram(
  now: Date,
): RuleTemplateIndicatorCountHistogram {
  type BucketAgg = {
    templates: RuleTemplate[];
    by_category: Record<RuleTemplateCategory, number>;
    by_vertical: Record<RuleTemplateVertical, number>;
  };
  const buckets: Record<IndicatorCountBucket, BucketAgg> = {} as never;
  for (const b of ALL_INDICATOR_COUNT_BUCKETS) {
    buckets[b] = {
      templates: [],
      by_category: emptyByCategory(),
      by_vertical: emptyByVertical(),
    };
  }

  let total_templates = 0;
  let templates_with_zero_indicators = 0;
  let min_indicators: number | null = null;
  let max_indicators: number | null = null;
  let sum_indicators = 0;

  for (const t of RULE_TEMPLATES) {
    const n = t.supporting_indicators.length;
    const bucket = bucketForIndicatorCount(n);
    if (!bucket) {
      templates_with_zero_indicators++;
      continue;
    }
    total_templates++;
    sum_indicators += n;
    if (min_indicators === null || n < min_indicators) min_indicators = n;
    if (max_indicators === null || n > max_indicators) max_indicators = n;

    const b = buckets[bucket];
    b.templates.push(t);
    b.by_category[t.category]++;
    b.by_vertical[t.vertical]++;
  }

  const bucketRows: IndicatorCountBucketRow[] = ALL_INDICATOR_COUNT_BUCKETS.map(
    (b) => {
      const meta = BUCKET_META[b];
      const agg = buckets[b];
      const sample_template_ids = [...agg.templates]
        .map((t) => t.id)
        .sort((a, b) => a.localeCompare(b))
        .slice(0, 3);
      return {
        bucket: b,
        label: meta.label,
        min: meta.min,
        max: meta.max,
        max_inclusive: meta.max_inclusive,
        count: agg.templates.length,
        by_category: agg.by_category,
        by_vertical: agg.by_vertical,
        sample_template_ids,
      };
    },
  );

  // peak_bucket — highest count with canonical iteration tie-break.
  let peak_bucket: IndicatorCountBucket | null = null;
  let peak_count = 0;
  for (const row of bucketRows) {
    if (row.count > peak_count) {
      peak_count = row.count;
      peak_bucket = row.bucket;
    }
  }

  const empty_buckets = bucketRows
    .filter((r) => r.count === 0)
    .map((r) => r.bucket);

  const mean_indicators =
    total_templates > 0
      ? Math.round((sum_indicators / total_templates) * 100) / 100
      : null;

  return {
    generated_at: now.toISOString(),
    total_templates,
    templates_with_zero_indicators,
    total_catalog_size: total_templates + templates_with_zero_indicators,
    buckets: bucketRows,
    peak_bucket,
    peak_count,
    mean_indicators,
    min_indicators,
    max_indicators,
    empty_buckets,
  };
}
