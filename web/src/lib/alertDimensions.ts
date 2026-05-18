// web/src/lib/alertDimensions.ts
//
// Pure functions that classify an Alert along the 7 analytics dimensions
// listed in the spec. Everything is derived from the existing `Alert`
// type (web/src/lib/api.ts) so the dashboard can render multi-dim
// drill-downs without ANY backend extension.
//
// Honest about heuristic-vs-real:
//   - severity  — direct field, real data
//   - status    — derived from `assignee` heuristic, NOT real data yet*
//   - risk_band — derived from `criticality_score` (lib/criticality.ts), real
//   - timeline  — derived from `created_at`, real
//   - category  — derived from rule.name prefix, HEURISTIC (flag for v2)
//   - module    — derived from rule.id prefix, HEURISTIC (flag for v2)
//   - source    — derived from rule.id pattern, HEURISTIC (flag for v2)
//
// * The Alert type has `assignee` (string|null) but no `acked_at`/`closed_at`.
//   When the BFF starts emitting these fields, statusOf() upgrades naturally.

import type { Alert, Severity } from './api';
import { bandFor } from './criticality';

// ─── Closed enums for stable rendering / chart axes ──────────────────────────

export const ALERT_DIMENSIONS = [
  'severity',
  'status',
  'risk_band',
  'category',
  'module',
  'source',
] as const;

export type AlertDimension = (typeof ALERT_DIMENSIONS)[number];

export const ALERT_SEVERITIES: readonly Severity[] = ['critical', 'high', 'medium', 'low'];

export const ALERT_STATUSES = ['open', 'in_progress', 'acked'] as const;
export type AlertStatus = (typeof ALERT_STATUSES)[number];

export const ALERT_RISK_BANDS = ['critical', 'high', 'medium', 'low'] as const;
export type AlertRiskBand = (typeof ALERT_RISK_BANDS)[number];

// Phase 1: these come back as 'unclassified' until rule metadata or
// alert.source is plumbed through the BFF. UI shows them as empty-state
// callouts (see AlertDeepDrilldown) rather than fake categories.
export const ALERT_CATEGORY_FALLBACK = 'unclassified' as const;
export const ALERT_MODULE_FALLBACK = 'unclassified' as const;
export const ALERT_SOURCE_FALLBACK = 'rule_engine' as const;

// ─── Per-dimension classifiers ───────────────────────────────────────────────

export function statusOf(a: Alert): AlertStatus {
  // Status proxy until BFF exposes app_alerts.alerts.status:
  //   assignee == null       → open       (just landed in queue)
  //   assignee && age < 240m → in_progress (someone's working on it)
  //   assignee && age >= 240 → acked       (acknowledged but not yet closed)
  // 240min == 4h cutoff matches the BIL §11 red-class SLA. When the
  // service grows a real `status` field this function becomes a passthrough.
  if (!a.assignee) return 'open';
  if (a.age_min < 240) return 'in_progress';
  return 'acked';
}

export function riskBandOf(a: Alert): AlertRiskBand {
  // bandFor() returns 'critical'|'high'|'medium'|'low' from criticality_score.
  return bandFor(a.criticality_score) as AlertRiskBand;
}

/**
 * Heuristic category extracted from the rule name's first significant word.
 * Returns `unclassified` for malformed inputs. When rules grow a `category`
 * field this routes through directly.
 */
export function categoryOf(a: Alert): string {
  const name = (a.rule?.name ?? '').trim();
  if (!name) return ALERT_CATEGORY_FALLBACK;
  // Take the first token, lowercase. Strip non-alphas so e.g. "DPD" stays
  // intact but "AML/CTF" becomes "amlctf".
  const first = name.split(/[\s,/\-]+/)[0]?.toLowerCase().replace(/[^a-z0-9]/g, '');
  return first && first.length >= 2 ? first : ALERT_CATEGORY_FALLBACK;
}

/**
 * Heuristic BIL T6 module from rule.id prefix.
 *   - 'r-fin-*' / 'rule-fin-*' → 'risk_indicators'
 *   - 'r-fraud-*'              → 'fraud_detection'
 *   - 'r-aml-*'                → 'compliance'
 *   - 'r-op-*'                 → 'operational'
 *   - 'r-uw-*'                 → 'underwriting'
 * Falls back to `unclassified`. Pure passthrough once rule.module is real.
 */
export function moduleOf(a: Alert): string {
  const id = (a.rule?.id ?? '').toLowerCase();
  if (!id) return ALERT_MODULE_FALLBACK;
  if (/(^|[-_])(fin|fraud|risk)/.test(id)) {
    return /fraud/.test(id) ? 'fraud_detection' : 'risk_indicators';
  }
  if (/aml|kyc|compliance/.test(id)) return 'compliance';
  if (/op|operational|sla/.test(id)) return 'operational';
  if (/uw|underwriting/.test(id)) return 'underwriting';
  return ALERT_MODULE_FALLBACK;
}

/**
 * Heuristic source/channel — for now, every alert is 'rule_engine'.
 * When the BFF emits alerts from the AI model or manual operator paths
 * this branches accordingly (the AlertRow shape would gain a `source`).
 */
export function sourceOf(_a: Alert): string {
  return ALERT_SOURCE_FALLBACK;
}

/**
 * Universal dimension dispatcher. Used by chart components that switch
 * axis at runtime (`<AlertBarChart dimension="severity"|"status"|...>`).
 */
export function valueFor(a: Alert, dim: AlertDimension): string {
  switch (dim) {
    case 'severity':
      return a.severity;
    case 'status':
      return statusOf(a);
    case 'risk_band':
      return riskBandOf(a);
    case 'category':
      return categoryOf(a);
    case 'module':
      return moduleOf(a);
    case 'source':
      return sourceOf(a);
  }
}

// ─── Aggregation helpers ─────────────────────────────────────────────────────

export interface DimensionBucket {
  value: string;
  count: number;
}

/**
 * Group alerts by the chosen dimension, sorted highest-count first.
 * When an `order` is supplied (e.g. for severities) buckets are returned
 * in that canonical order instead — guarantees a stable x-axis.
 */
export function aggregate(
  alerts: readonly Alert[],
  dim: AlertDimension,
  options: { order?: readonly string[] } = {},
): DimensionBucket[] {
  const counts = new Map<string, number>();
  for (const a of alerts) {
    const v = valueFor(a, dim);
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  if (options.order) {
    // Stable canonical order — always render every key, zero-fill missing.
    return options.order.map((value) => ({ value, count: counts.get(value) ?? 0 }));
  }
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
}

/**
 * Time-bucket alerts by ISO date (YYYY-MM-DD). Returns oldest-first so
 * a recharts XAxis renders left-to-right naturally. Buckets with zero
 * alerts in the window aren't filled (chart consumer can interpolate).
 */
export interface TimelineBucket {
  date: string;
  count: number;
}

export function aggregateTimeline(alerts: readonly Alert[]): TimelineBucket[] {
  const counts = new Map<string, number>();
  for (const a of alerts) {
    const day = (a.created_at || '').slice(0, 10);
    if (!day) continue;
    counts.set(day, (counts.get(day) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([date, count]) => ({ date, count }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
}

/**
 * Filter alerts to a single (dimension, value) pair.
 * Used by the drill-down panel to compute distributions on the subset.
 */
export function filterByDimension(
  alerts: readonly Alert[],
  dim: AlertDimension,
  value: string,
): Alert[] {
  return alerts.filter((a) => valueFor(a, dim) === value);
}

/**
 * Top-N customers by alert count within a subset. Used in drill-down lists.
 */
export interface TopCustomer {
  customer_id: string;
  customer_name: string;
  count: number;
  total_exposure_kes: number;
}

export function topCustomers(alerts: readonly Alert[], n: number): TopCustomer[] {
  const map = new Map<string, TopCustomer>();
  for (const a of alerts) {
    const id = a.customer?.id ?? '?';
    const existing = map.get(id);
    if (existing) {
      existing.count += 1;
      existing.total_exposure_kes += a.customer_exposure_kes ?? 0;
    } else {
      map.set(id, {
        customer_id: id,
        customer_name: a.customer?.name ?? id,
        count: 1,
        total_exposure_kes: a.customer_exposure_kes ?? 0,
      });
    }
  }
  return [...map.values()]
    .sort((a, b) => b.count - a.count || a.customer_name.localeCompare(b.customer_name))
    .slice(0, n);
}
