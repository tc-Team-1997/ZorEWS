// services/bff/src/rule_engine_report.ts
//
// Phase 9 T10 — Rule Engine reporting aggregator.
//
// Pure fleet-wide rollup over the rule store. Each per-rule primitive
// (backtest + performance) already exists; this aggregator joins them
// with cohort counts so the SPA reports page can answer:
//
//   - How many rules do we have, in what states, in what families?
//   - What's the firing volume across the whole fleet, month by month?
//   - Which rules fire the most? Which are underperforming?
//   - What's the mean precision / coverage / FP rate across active rules?
//   - Which rules have never fired in the last 12 months?
//
// Deterministic per (rule_id, now-date) because both `backtest` + `performanceFor`
// are deterministic — the SPA can render this without a real metrics
// warehouse and tests can assert exact numbers.
//
// Cross-module integration:
//   - reads RuleV2[] from rules/store
//   - composes rules/backtest + rules/performance per row
//   - no new persistence — derived view over the live store
//
// Mirror of the M11.14 fleet-lint summary shape for rules.

import { backtest } from './rules/backtest';
import { performanceFor } from './rules/performance';
import type {
  BacktestResult,
  RulePerformance,
  RulePerformanceStatus,
  RuleState,
  RuleV2,
} from './rules/types';

// ── Closed enums re-exported for SPA consumption ──────────────────────

export const ALL_RULE_STATES: readonly RuleState[] = [
  'draft',
  'pending_review',
  'approved',
  'active',
  'rejected',
  'deprecated',
] as const;

export const ALL_RULE_FAMILIES = [
  'Financial',
  'Behavioural',
  'Transaction',
  'Credit',
  'Fraud',
] as const;
export type RuleFamily = (typeof ALL_RULE_FAMILIES)[number];

export const ALL_RULE_SEVERITIES = ['critical', 'high', 'medium', 'low'] as const;
export type RuleSeverity = (typeof ALL_RULE_SEVERITIES)[number];

export const ALL_RULE_PERFORMANCE_STATUSES: readonly RulePerformanceStatus[] = [
  'performing',
  'underperforming',
  'deprecated',
  'no_data',
] as const;

// ── Shapes ─────────────────────────────────────────────────────────────

/** Per-rule joined view used by the report table. Carries enough for the
 *  SPA to render a single row WITHOUT a second API call per rule. */
export interface RuleEngineReportRow {
  rule_id: string;
  name: string;
  family: RuleFamily;
  state: RuleState;
  severity: RuleSeverity;
  version: string;
  /** Empty array = applies to every product. Echoed from the rule. */
  applicable_products: RuleV2['applicable_products'];
  /** Synthetic per-rule monthly volume sum across the last 12 months. */
  total_alerts_12mo: number;
  /** Newest month's count (today's "month-to-date" proxy). */
  triggers_month: number;
  /** Synthetic per-rule daily / weekly snapshots from performanceFor. */
  triggers_today: number;
  triggers_week: number;
  /** % — true positives / total alerts. */
  precision_pct: number;
  /** % — share of NPAs caught by this rule. */
  coverage_pct: number;
  /** % — false positives / total alerts. */
  false_positive_rate: number;
  /** % — officer "useful" share. */
  officer_useful_pct: number;
  /** Average days from alert → actual NPA event. */
  avg_days_to_default: number;
  /** Rule's live performance status (performing / underperforming / etc.). */
  status: RulePerformanceStatus;
  /** Newest audit event's timestamp (created_at fallback). */
  last_modified_at: string;
}

/** A single point on the fleet-wide monthly volume series. */
export interface FleetMonthlyVolumePoint {
  month: string; // YYYY-MM
  total_alerts: number;
  /** Per-family breakdown so the SPA can render a stacked bar chart. */
  by_family: Record<RuleFamily, number>;
}

export interface RuleEngineReport {
  /** Tenant scoping echo. */
  tenant_id: string;
  /** ISO of when this report was rendered. */
  generated_at: string;
  /** Total rule count across all states. */
  total_rules: number;
  /** Active rules only — the denominator for mean_precision_pct etc. */
  total_active_rules: number;
  /** Every RuleState present at 0 when absent — stable SPA grid. */
  by_state: Record<RuleState, number>;
  /** Every RuleFamily present at 0 when absent — stable SPA grid. */
  by_family: Record<RuleFamily, number>;
  /** Every RuleSeverity present at 0 when absent. */
  by_severity: Record<RuleSeverity, number>;
  /** Every RulePerformanceStatus present at 0 when absent. */
  by_performance_status: Record<RulePerformanceStatus, number>;
  /** Σ of every rule's total_alerts_12mo (active rules only — deprecated /
   *  draft rules don't fire). */
  total_alerts_12mo: number;
  /** Newest-month sum across active rules — "this month" headline. */
  triggers_month_total: number;
  /** Mean precision_pct across active rules; null when no active rules. */
  mean_precision_pct: number | null;
  /** Mean coverage_pct across active rules; null when no active rules. */
  mean_coverage_pct: number | null;
  /** Mean false_positive_rate across active rules; null when no active rules. */
  mean_false_positive_rate: number | null;
  /** Fleet monthly volume across the trailing 12 months; oldest-first.
   *  Each entry sums active rules' monthly_volume for that month + breaks
   *  the total down by family. */
  monthly_volume: FleetMonthlyVolumePoint[];
  /** Full per-rule row list, sorted by total_alerts_12mo desc + rule_id asc
   *  tie-break (loudest first). */
  rows: RuleEngineReportRow[];
  /** Top 10 rules by total_alerts_12mo. Subset of rows[] for SPA convenience. */
  top_firing: RuleEngineReportRow[];
  /** Rules whose performance status === 'underperforming' (active rules only).
   *  Sorted by false_positive_rate desc. */
  underperforming: RuleEngineReportRow[];
  /** Active rules with total_alerts_12mo === 0 — never fired in the window.
   *  Sorted by rule_id asc. */
  silent_rules: RuleEngineReportRow[];
}

// ── Pure aggregator ────────────────────────────────────────────────────

function emptyFamilyMap(): Record<RuleFamily, number> {
  return {
    Financial: 0,
    Behavioural: 0,
    Transaction: 0,
    Credit: 0,
    Fraud: 0,
  };
}

function emptyStateMap(): Record<RuleState, number> {
  return {
    draft: 0,
    pending_review: 0,
    approved: 0,
    active: 0,
    rejected: 0,
    deprecated: 0,
  };
}

function emptySeverityMap(): Record<RuleSeverity, number> {
  return { critical: 0, high: 0, medium: 0, low: 0 };
}

function emptyPerformanceMap(): Record<RulePerformanceStatus, number> {
  return { performing: 0, underperforming: 0, deprecated: 0, no_data: 0 };
}

function lastModifiedOf(rule: RuleV2): string {
  if (rule.audit.length === 0) return rule.created_at;
  const newest = rule.audit.reduce((acc, e) => (e.ts > acc.ts ? e : acc), rule.audit[0]!);
  return newest.ts;
}

function buildRow(rule: RuleV2, bt: BacktestResult, perf: RulePerformance): RuleEngineReportRow {
  return {
    rule_id: rule.id,
    name: rule.name,
    family: rule.family,
    state: rule.state,
    severity: rule.outcome.severity,
    version: rule.version,
    applicable_products: rule.applicable_products.slice(),
    total_alerts_12mo: bt.total_alerts,
    triggers_month: perf.triggers_month,
    triggers_today: perf.triggers_today,
    triggers_week: perf.triggers_week,
    precision_pct: bt.precision_pct,
    coverage_pct: bt.coverage_pct,
    false_positive_rate: perf.false_positive_rate,
    officer_useful_pct: perf.officer_useful_pct,
    avg_days_to_default: bt.avg_days_to_default,
    status: perf.status,
    last_modified_at: lastModifiedOf(rule),
  };
}

/**
 * Pure rollup over the rule store. Tenant scoping happens at the caller —
 * this function trusts every rule passed in belongs to `tenant_id`.
 *
 * @param tenant_id  — required, echoed in the envelope; throws on empty
 * @param rules      — full rule list (every state); the aggregator filters
 *                     active rules internally for the fleet metrics
 * @param now        — clock injection for deterministic testing
 */
export function buildRuleEngineReport(
  tenant_id: string,
  rules: readonly RuleV2[],
  now: Date,
): RuleEngineReport {
  if (!tenant_id || typeof tenant_id !== 'string') {
    throw new Error('tenant_id required');
  }

  const by_state = emptyStateMap();
  const by_family = emptyFamilyMap();
  const by_severity = emptySeverityMap();
  const by_performance_status = emptyPerformanceMap();

  // Pre-compute backtest + performance for every rule once (deterministic
  // per rule_id so order doesn't matter).
  const enriched = rules.map((rule) => {
    const bt = backtest(rule, now);
    const perf = performanceFor(rule, now);
    return { rule, bt, perf, row: buildRow(rule, bt, perf) };
  });

  for (const { rule, perf } of enriched) {
    by_state[rule.state]++;
    by_family[rule.family]++;
    by_severity[rule.outcome.severity]++;
    by_performance_status[perf.status]++;
  }

  // Fleet metrics — derived from ACTIVE rules only. Draft / pending /
  // rejected / deprecated rules don't fire so their backtest series
  // would inflate the fleet view with stale numbers.
  const activeRows = enriched.filter(({ rule }) => rule.state === 'active');
  const total_active_rules = activeRows.length;

  let total_alerts_12mo = 0;
  let triggers_month_total = 0;
  const monthlyAccum = new Map<string, FleetMonthlyVolumePoint>();

  for (const { bt, perf, rule } of activeRows) {
    total_alerts_12mo += bt.total_alerts;
    triggers_month_total += perf.triggers_month;
    for (const point of bt.monthly_volume) {
      let acc = monthlyAccum.get(point.month);
      if (!acc) {
        acc = { month: point.month, total_alerts: 0, by_family: emptyFamilyMap() };
        monthlyAccum.set(point.month, acc);
      }
      acc.total_alerts += point.count;
      acc.by_family[rule.family] += point.count;
    }
  }

  const monthly_volume = Array.from(monthlyAccum.values()).sort((a, b) =>
    a.month < b.month ? -1 : a.month > b.month ? 1 : 0,
  );

  // Means over active rules — null when zero active rules.
  const mean_precision_pct =
    total_active_rules === 0
      ? null
      : round1(
          activeRows.reduce((acc, { bt }) => acc + bt.precision_pct, 0) / total_active_rules,
        );
  const mean_coverage_pct =
    total_active_rules === 0
      ? null
      : round1(
          activeRows.reduce((acc, { bt }) => acc + bt.coverage_pct, 0) / total_active_rules,
        );
  const mean_false_positive_rate =
    total_active_rules === 0
      ? null
      : round1(
          activeRows.reduce((acc, { perf }) => acc + perf.false_positive_rate, 0) /
            total_active_rules,
        );

  // Sorted row list — loudest first; rule_id asc tie-break.
  const rows = enriched
    .map((e) => e.row)
    .sort((a, b) => {
      if (b.total_alerts_12mo !== a.total_alerts_12mo) {
        return b.total_alerts_12mo - a.total_alerts_12mo;
      }
      return a.rule_id < b.rule_id ? -1 : a.rule_id > b.rule_id ? 1 : 0;
    });

  const top_firing = rows.slice(0, 10);

  const underperforming = enriched
    .filter(({ perf, rule }) => rule.state === 'active' && perf.status === 'underperforming')
    .map((e) => e.row)
    .sort((a, b) => b.false_positive_rate - a.false_positive_rate);

  const silent_rules = enriched
    .filter(({ rule, bt }) => rule.state === 'active' && bt.total_alerts === 0)
    .map((e) => e.row)
    .sort((a, b) => (a.rule_id < b.rule_id ? -1 : a.rule_id > b.rule_id ? 1 : 0));

  return {
    tenant_id,
    generated_at: now.toISOString(),
    total_rules: rules.length,
    total_active_rules,
    by_state,
    by_family,
    by_severity,
    by_performance_status,
    total_alerts_12mo,
    triggers_month_total,
    mean_precision_pct,
    mean_coverage_pct,
    mean_false_positive_rate,
    monthly_volume,
    rows,
    top_firing,
    underperforming,
    silent_rules,
  };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
