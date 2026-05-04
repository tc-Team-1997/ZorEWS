// services/bff/src/rules/performance.ts
//
// Live performance metrics — what the rule has actually done in
// production today / this week / this month, and whether it's holding
// up. Computed deterministically per rule_id so the SPA can render it
// without a real metrics warehouse.

import { backtest } from './backtest';
import type { RulePerformance, RulePerformanceStatus, RuleV2 } from './types';

function statusFor(
  state: RuleV2['state'],
  truePositiveRate: number,
  falsePositiveRate: number,
  triggersMonth: number,
): RulePerformanceStatus {
  if (state === 'deprecated') return 'deprecated';
  if (state !== 'active') return 'no_data';
  // Underperforming = high FP rate or low precision. Tuned for the seed
  // distribution — easy to swing one way or another by changing the rule.
  if (falsePositiveRate > 0.5 && truePositiveRate < 0.5) return 'underperforming';
  if (triggersMonth === 0) return 'underperforming';
  return 'performing';
}

export function performanceFor(rule: RuleV2, now: Date = new Date()): RulePerformance {
  // Reuse the backtest's deterministic compute as the basis — same rule,
  // same numbers. Then split the monthly total into today/week/month.
  const bt = backtest(rule, now);
  const monthlyTotal = bt.monthly_volume[bt.monthly_volume.length - 1]?.count ?? 0;
  const triggers_today = Math.round(monthlyTotal / 30);
  const triggers_week = Math.round(monthlyTotal / 4);

  const tp = bt.precision_pct / 100;
  const fp = 1 - tp;

  const status = statusFor(rule.state, tp, fp, monthlyTotal);

  return {
    rule_id: rule.id,
    triggers_today,
    triggers_week,
    triggers_month: monthlyTotal,
    true_positive_rate: Math.round(tp * 1000) / 10,
    false_positive_rate: Math.round(fp * 1000) / 10,
    avg_days_to_default: bt.avg_days_to_default,
    officer_useful_pct: Math.round((tp * 100 + (1 - fp) * 30) / 1.3) / 1, // synthetic blend
    status,
  };
}
