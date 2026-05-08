// services/bff/src/ai_auto_promotion_gate.ts
//
// T5.1 — Auto-promotion gate.
//
// The maker-checker promotion flow in `ai_model_promotion.ts` always
// requires a human to approve. For low-risk transitions (experimental
// → staging, staging → shadow) banks usually want an automatic gate
// that decides PROMOTE or HOLD based on the latest performance metrics
// from `model_performance.ts`. Production transitions still need a
// human — the gate refuses to auto-promote into `production` even when
// metrics pass; it returns the decision so the SPA can prefill the
// approval form.
//
// Pure resolver — takes a ModelPerformanceSummary + target status +
// optional thresholds, returns a Decision. No IO, fully testable.

import type {
  ModelPerformanceSummary,
  PerformanceMetric,
} from './model_performance';
import type { ModelStatus } from './ai_model_registry';

// ── Public types ───────────────────────────────────────────────────────

export type GateDecision = 'promote' | 'hold' | 'requires_approval';

/**
 * One per-metric check that ran. `passed` reflects the metric-level
 * verdict; the overall `decision` is the AND of every check.
 */
export interface GateCheck {
  metric: PerformanceMetric | 'sample_size' | 'metric_present';
  /** What the resolver compared against. */
  threshold: number | string;
  /** Comparison operator — `>=`, `<=`, `present`. */
  operator: '>=' | '<=' | 'present';
  /** Observed value from the summary; null when the metric wasn't
   *  recorded yet. A null observed for a required metric → fail. */
  observed: number | null;
  /** Human-readable note if it failed (or 'ok' if passed). */
  reason: string;
  passed: boolean;
}

export interface GateThresholds {
  /** Minimum AUC. null = no requirement. */
  min_auc?: number | null;
  /** Minimum precision. */
  min_precision?: number | null;
  /** Minimum recall. */
  min_recall?: number | null;
  /** Maximum drift_score. */
  max_drift_score?: number | null;
  /** Maximum calibration_err. */
  max_calibration_err?: number | null;
  /** Minimum number of recorded performance observations across all
   *  metrics for this model. Anchors the gate to "we've actually been
   *  watching this model for a while" rather than just one good day. */
  min_sample_size?: number | null;
  /** Metrics that must have at least one observation (null `summary.metrics[m]`
   *  is a fail). Most commonly: ['auc'] for shadow, ['auc','drift_score']
   *  for production. */
  required_metrics?: PerformanceMetric[];
}

export interface GateInput {
  /** The latest summary for the candidate model. */
  summary: ModelPerformanceSummary;
  /** Where the candidate is trying to land. */
  target_status: ModelStatus;
  /** Optional override; otherwise `defaultThresholds(target_status)`. */
  thresholds?: GateThresholds;
}

export interface GateResult {
  model_id: string;
  tenant_id: string;
  target_status: ModelStatus;
  decision: GateDecision;
  /** Verbose: every check that ran, including passes. The SPA renders
   *  failures first; passes are surfaced as a "what's healthy" pill. */
  checks: GateCheck[];
  /** Concise summary: failed-check reasons. Empty array on `promote`. */
  failures: string[];
  /** Thresholds the gate evaluated against — echoed back so callers can
   *  audit which preset applied. */
  thresholds_applied: GateThresholds;
  evaluated_at: string;
}

// ── Default thresholds per target_status ───────────────────────────────
//
// Tuned to BAC §3.4 + DataNetworks-EWS-Ver1.pdf §13 expectations:
//
//   experimental → staging    : light gate (graduation from sandbox).
//   staging → shadow          : moderate gate (live traffic, no serving).
//   staging → production      : strict gate (going to live decisions).
//                                Also requires_approval — never auto.
//   shadow → production       : strict gate. requires_approval.
//   * → retired               : no gate; just lifecycle.
//
// AUC anchors are deliberately conservative — the prototype's champion
// XGBoost trained at AUC 0.88, so even modest drift still clears 0.78.

export function defaultThresholds(target: ModelStatus): GateThresholds {
  switch (target) {
    case 'staging':
      return {
        min_auc: 0.65,
        min_sample_size: 1, // any observation is enough for sandbox graduation
        max_drift_score: 0.4,
        required_metrics: ['auc'],
      };
    case 'shadow':
      return {
        min_auc: 0.7,
        min_precision: 0.5,
        min_recall: 0.5,
        min_sample_size: 2, // ≥ 2 observations — at least one re-confirmation
        max_drift_score: 0.3,
        max_calibration_err: 0.1,
        required_metrics: ['auc', 'drift_score'],
      };
    case 'production':
      return {
        min_auc: 0.78,
        min_precision: 0.65,
        min_recall: 0.6,
        min_sample_size: 5, // ≥ 5 observations — sustained healthy run
        max_drift_score: 0.2,
        max_calibration_err: 0.05,
        required_metrics: ['auc', 'drift_score', 'calibration_err'],
      };
    default:
      return {};
  }
}

// ── Pure resolver ──────────────────────────────────────────────────────

export function evaluatePromotionGate(
  input: GateInput,
  asOf: Date = new Date(),
): GateResult {
  const thresholds = input.thresholds ?? defaultThresholds(input.target_status);
  const summary = input.summary;
  const checks: GateCheck[] = [];

  // 1. Required-metrics presence
  for (const m of thresholds.required_metrics ?? []) {
    const present = summary.metrics[m] !== null;
    checks.push({
      metric: 'metric_present',
      threshold: m,
      operator: 'present',
      observed: present ? 1 : 0,
      reason: present ? 'ok' : `metric ${m} has no observations yet`,
      passed: present,
    });
  }

  // 2. Sample-size threshold (aggregate)
  if (thresholds.min_sample_size != null) {
    const obs = summary.sample_size;
    const passed = obs >= thresholds.min_sample_size;
    checks.push({
      metric: 'sample_size',
      threshold: thresholds.min_sample_size,
      operator: '>=',
      observed: obs,
      reason: passed ? 'ok' : `sample_size ${obs} < ${thresholds.min_sample_size}`,
      passed,
    });
  }

  // 3. Per-metric latest_value thresholds.
  const metricChecks: Array<{
    metric: PerformanceMetric;
    op: '>=' | '<=';
    threshold: number | null | undefined;
  }> = [
    { metric: 'auc',             op: '>=', threshold: thresholds.min_auc },
    { metric: 'precision',       op: '>=', threshold: thresholds.min_precision },
    { metric: 'recall',          op: '>=', threshold: thresholds.min_recall },
    { metric: 'drift_score',     op: '<=', threshold: thresholds.max_drift_score },
    { metric: 'calibration_err', op: '<=', threshold: thresholds.max_calibration_err },
  ];

  for (const c of metricChecks) {
    if (c.threshold == null) continue;
    const m = summary.metrics[c.metric];
    if (m === null) {
      // No observation. If the metric was already required-and-missing
      // in step 1 we don't double-fail. Otherwise treat absence as pass
      // for an optional metric.
      const wasRequired = (thresholds.required_metrics ?? []).includes(c.metric);
      if (wasRequired) continue; // already covered by required-metrics check
      checks.push({
        metric: c.metric,
        threshold: c.threshold,
        operator: c.op,
        observed: null,
        reason: 'optional metric not observed — skipped',
        passed: true,
      });
      continue;
    }
    const observed = m.latest_value;
    const passed = c.op === '>=' ? observed >= c.threshold : observed <= c.threshold;
    checks.push({
      metric: c.metric,
      threshold: c.threshold,
      operator: c.op,
      observed,
      reason: passed
        ? 'ok'
        : `${c.metric}=${observed} fails ${c.op} ${c.threshold}`,
      passed,
    });
  }

  const allPassed = checks.every((c) => c.passed);
  const failures = checks.filter((c) => !c.passed).map((c) => c.reason);

  // Production transitions never auto-promote even when metrics pass —
  // requires the human approval flow per maker-checker invariant.
  let decision: GateDecision;
  if (!allPassed) {
    decision = 'hold';
  } else if (input.target_status === 'production') {
    decision = 'requires_approval';
  } else {
    decision = 'promote';
  }

  return {
    model_id: summary.model_id,
    tenant_id: summary.tenant_id,
    target_status: input.target_status,
    decision,
    checks,
    failures,
    thresholds_applied: thresholds,
    evaluated_at: asOf.toISOString(),
  };
}
