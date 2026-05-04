// Severity bucketing.
//
// We use the catalog's `severity_weight` (0..1) as the upper bound on severity
// when an indicator breaches:
//
//   weight ≥ 0.85 → 'critical'
//   weight ≥ 0.65 → 'high'
//   weight ≥ 0.45 → 'medium'
//   weight <  0.45 → 'low'
//
// agent-alert performs the final severity merge across rule severity + score
// band. This is just the per-indicator "if breached, how serious is it on
// its own" hint.

import { Severity } from './types';

export function severityForWeight(weight: number): Severity {
  if (weight >= 0.85) return 'critical';
  if (weight >= 0.65) return 'high';
  if (weight >= 0.45) return 'medium';
  return 'low';
}

export function severityIfBreached(breached: boolean, weight: number): Severity {
  return breached ? severityForWeight(weight) : 'low';
}
