// services/bff/src/ews_rules_executor.ts
//
// EWS rules engine — pure executor (EWS-2).
//
// Evaluates a flat conditions[] rule against an entity's indicator
// values. Runs ALL active rules supplied by the caller in a single
// pass over a precomputed values map — O(rules × conditions) with
// no I/O. The brief's perf budget (1000+ rules / entity / 500 ms)
// is verified by tests in EWS-3.

import {
  AGGREGATE_SEVERITY_THRESHOLDS,
  type AlertSeverity,
  type EwsCondition,
  type EwsRule,
  type EwsOperator,
} from './ews_rules';

// ─── Types ────────────────────────────────────────────────────────────

export type EntityType = 'customer' | 'policy' | 'claim';

/** Map of indicator name → numeric or string value. The executor
 *  treats `undefined`/`null`/`NaN` as "no data" — comparators
 *  return false against them, never throw. */
export type IndicatorValues = Record<string, number | string | null | undefined>;

export interface EvaluationInput {
  tenant_id: string;
  entity_type: EntityType;
  entity_id: string;
  values: IndicatorValues;
  /** Rules to evaluate. Caller filters to the active set BEFORE
   *  passing in — keeps the executor pure + the perf budget tight. */
  rules: readonly EwsRule[];
  now: Date;
}

export interface RuleMatch {
  rule_id: string;
  name: string;
  category: EwsRule['category'];
  alert_severity: AlertSeverity;
  weight: number;
  recommended_action: string | null;
  /** Indicator names whose comparator returned true. */
  matched_indicators: string[];
}

export interface EvaluationResult {
  tenant_id: string;
  entity_type: EntityType;
  entity_id: string;
  evaluated_at: string;
  /** Number of rules evaluated. */
  rule_count: number;
  /** Number of rules that matched. */
  matched_count: number;
  /** Cumulative weight across matched rules, capped at 100. */
  cumulative_score: number;
  /** Aggregate severity derived from cumulative_score. */
  aggregate_severity: AlertSeverity;
  matches: RuleMatch[];
  /** Wall-clock evaluation time. Exposed for SRE perf dashboards. */
  duration_us: number;
}

// ─── Comparator + condition eval (pure) ──────────────────────────────

function asNumber(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  return null;
}

function evalCondition(c: EwsCondition, values: IndicatorValues): boolean {
  const raw = values[c.field];
  if (raw === undefined || raw === null) return false;
  const op: EwsOperator = c.operator;

  // Equality / inequality / inclusion: string-or-number.
  if (op === '==') return raw === c.value;
  if (op === '!=') return raw !== c.value;
  if (op === 'in') {
    return Array.isArray(c.value) && c.value.includes(raw as never);
  }
  if (op === 'not_in') {
    return Array.isArray(c.value) && !c.value.includes(raw as never);
  }

  // Numeric ordering operators — coerce both sides.
  const num = asNumber(raw);
  if (num === null) return false;

  if (op === 'between') {
    if (!c.range) return false;
    const [lo, hi] = c.range;
    return num >= lo && num <= hi;
  }

  const cv = typeof c.value === 'number' ? c.value : null;
  if (cv === null) return false;

  switch (op) {
    case '>':
      return num > cv;
    case '>=':
      return num >= cv;
    case '<':
      return num < cv;
    case '<=':
      return num <= cv;
    default:
      return false;
  }
}

// ─── Rule eval ────────────────────────────────────────────────────────

/** Returns the indicator names that contributed to a match. AND-rules
 *  must all match — otherwise we return []. OR-rules return only the
 *  conditions that fired. Single-condition rules degrade gracefully. */
function firingIndicators(rule: EwsRule, values: IndicatorValues): string[] {
  if (rule.logic === 'AND') {
    const fired: string[] = [];
    for (const c of rule.conditions) {
      if (!evalCondition(c, values)) return [];
      fired.push(c.field);
    }
    return Array.from(new Set(fired));
  }
  // OR
  const fired: string[] = [];
  for (const c of rule.conditions) {
    if (evalCondition(c, values)) fired.push(c.field);
  }
  return Array.from(new Set(fired));
}

function ruleMatches(rule: EwsRule, values: IndicatorValues): boolean {
  return firingIndicators(rule, values).length > 0;
}

// ─── Aggregate severity ──────────────────────────────────────────────

export function deriveAggregateSeverity(score: number): AlertSeverity {
  if (score >= AGGREGATE_SEVERITY_THRESHOLDS.RED) return 'RED';
  if (score >= AGGREGATE_SEVERITY_THRESHOLDS.ORANGE) return 'ORANGE';
  if (score >= AGGREGATE_SEVERITY_THRESHOLDS.YELLOW) return 'YELLOW';
  return 'GREEN';
}

// ─── Main entry — pure ────────────────────────────────────────────────

/**
 * Evaluate every supplied rule against the entity's indicator values.
 * Pure function — no I/O. Returns the full result envelope including
 * matched rules + cumulative score + aggregate severity.
 *
 * Caller must pre-filter `rules` to those that should evaluate (typically
 * `is_active && state === 'active'`). Keeping that out of here keeps the
 * executor a pure function.
 */
export function evaluateRules(input: EvaluationInput): EvaluationResult {
  const startNs = (typeof process !== 'undefined' && typeof process.hrtime?.bigint === 'function'
    ? process.hrtime.bigint()
    : null) as bigint | null;
  const startMs = Date.now();

  const matches: RuleMatch[] = [];
  let cumulative = 0;

  for (const rule of input.rules) {
    const fired = firingIndicators(rule, input.values);
    if (fired.length === 0) continue;
    matches.push({
      rule_id: rule.rule_id,
      name: rule.name,
      category: rule.category,
      alert_severity: rule.action.alert_severity,
      weight: rule.action.weight,
      recommended_action: rule.action.recommended_action ?? null,
      matched_indicators: fired,
    });
    cumulative += rule.action.weight;
  }

  const cumulative_score = Math.min(100, cumulative);
  const aggregate_severity = deriveAggregateSeverity(cumulative_score);

  const duration_us = startNs
    ? Number((process.hrtime.bigint() - startNs) / BigInt(1000))
    : Math.max(0, (Date.now() - startMs) * 1000);

  return {
    tenant_id: input.tenant_id,
    entity_type: input.entity_type,
    entity_id: input.entity_id,
    evaluated_at: input.now.toISOString(),
    rule_count: input.rules.length,
    matched_count: matches.length,
    cumulative_score,
    aggregate_severity,
    matches,
    duration_us,
  };
}

/** Re-exported for callers that need to test a single rule against
 *  a synthetic entity (used by /v1/ews/rules/:id/test). */
export { ruleMatches, firingIndicators };
