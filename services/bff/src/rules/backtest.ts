// services/bff/src/rules/backtest.ts
//
// Deterministic backtest engine. Given a rule + a time window, returns
// the alerts it WOULD have generated, broken into TP/FP buckets and a
// monthly volume series for the SPA chart.
//
// Real impl re-runs the rule against the historical mart (12 months
// of customer-day rows). For the prototype we synthesize a plausible
// outcome from the rule's complexity + outcome.severity — the shape of
// the response is what matters for the SPA wiring.

import type { BacktestResult, RuleV2 } from './types';

function complexity(rule: RuleV2): number {
  // Count leaves — single-condition rules fire more, deep AND-trees fire less.
  let leaves = 0;
  const walk = (n: typeof rule.conditions) => {
    if (n.kind === 'leaf') leaves++;
    else for (const c of n.children) walk(c);
  };
  walk(rule.conditions);
  return leaves;
}

function expectedFiringsPerMonth(rule: RuleV2): number {
  // Severity drives base rate: critical rules are tuned tight, low rules loose.
  const baseBySeverity: Record<string, number> = {
    critical: 8,
    high: 22,
    medium: 45,
    low: 80,
  };
  const base = baseBySeverity[rule.outcome.severity] ?? 30;
  // Each extra leaf condition halves the firing rate (AND tree narrows).
  const damping = Math.pow(0.55, Math.max(0, complexity(rule) - 1));
  const productScope = rule.applicable_products.length === 0 ? 1.0 : 0.6;
  return Math.round(base * damping * productScope);
}

/** Hash → [0,1) so two backtests of the same rule_id stay deterministic. */
function seededRand(seed: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 15), h | 1);
    h ^= h + Math.imul(h ^ (h >>> 7), h | 61);
    return ((h ^ (h >>> 14)) >>> 0) / 4294967296;
  };
}

export function backtest(rule: RuleV2, now: Date = new Date()): BacktestResult {
  const rnd = seededRand(rule.id);
  const monthly = expectedFiringsPerMonth(rule);

  // Build 12 monthly buckets ending at `now`.
  const monthly_volume: BacktestResult['monthly_volume'] = [];
  let total_alerts = 0;
  for (let i = 11; i >= 0; i--) {
    const d = new Date(now);
    d.setUTCMonth(d.getUTCMonth() - i);
    const month = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    // ±25% jitter around the expected firings.
    const variance = 0.75 + rnd() * 0.5;
    const count = Math.max(0, Math.round(monthly * variance));
    monthly_volume.push({ month, count });
    total_alerts += count;
  }

  // Precision band by severity — tight rules tend to be more precise.
  const precisionBySeverity: Record<string, number> = {
    critical: 0.78,
    high: 0.62,
    medium: 0.48,
    low: 0.32,
  };
  const basePrecision = precisionBySeverity[rule.outcome.severity] ?? 0.5;
  const precision = Math.min(0.95, Math.max(0.1, basePrecision + (rnd() - 0.5) * 0.1));
  const true_positives = Math.round(total_alerts * precision);
  const false_positives = total_alerts - true_positives;

  // Coverage = TPs caught ÷ total NPAs in book. Synthetic NPA universe ≈ 220.
  const coverage = Math.min(0.95, true_positives / 220);

  const window_end = now;
  const window_start = new Date(now);
  window_start.setUTCMonth(window_start.getUTCMonth() - 12);

  return {
    rule_id: rule.id,
    window_start: window_start.toISOString().slice(0, 10),
    window_end: window_end.toISOString().slice(0, 10),
    total_alerts,
    true_positives,
    false_positives,
    coverage_pct: Math.round(coverage * 1000) / 10,
    precision_pct: Math.round(precision * 1000) / 10,
    avg_days_to_default: Math.round(15 + rnd() * 35), // 15–50 days lead time
    monthly_volume,
  };
}
