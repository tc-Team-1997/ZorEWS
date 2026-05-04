// services/regulatory-svc/alerts/src/severity.ts
//
// Severity merge per FR-ALERT-2:
//   final_severity = max(rule.severity, score-band severity)
//
// Score-band severity mapping (per agent-alert spec):
//   Low    → low
//   Medium → medium
//   High   → high
//
// `critical` is only ever produced by a rule (no score level maps to critical).
// If `rule.severity === 'critical'`, it always wins.

import { RiskLevel, Severity, WireSeverity, Bucket } from './types';

/** Strict total order: low < medium < high < critical. */
const SEVERITY_RANK: Record<Severity, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

const SEVERITY_BY_RANK: Severity[] = ['low', 'medium', 'high', 'critical'];

/** Map a PD-level (`Low|Medium|High`) to the equivalent rule severity. */
export function severityFromLevel(level: RiskLevel | null | undefined): Severity {
  switch (level) {
    case 'High':
      return 'high';
    case 'Medium':
      return 'medium';
    case 'Low':
      return 'low';
    default:
      // Unknown / null score → contributes the lowest severity (rule wins).
      return 'low';
  }
}

/**
 * Merge rule severity with score-band severity, taking the maximum.
 * critical always wins; otherwise it's the higher rank of the two.
 */
export function mergeSeverity(
  ruleSeverity: Severity,
  scoreLevel: RiskLevel | null | undefined,
): Severity {
  const fromScore = severityFromLevel(scoreLevel);
  const max = Math.max(SEVERITY_RANK[ruleSeverity], SEVERITY_RANK[fromScore]);
  return SEVERITY_BY_RANK[max];
}

/** Smart-queue bucket mapping (T2.7): critical/high → Critical, medium → Medium, low → Low. */
export function bucketFor(severity: Severity): Bucket {
  if (severity === 'critical' || severity === 'high') return 'critical';
  if (severity === 'medium') return 'medium';
  return 'low';
}

export function toWireSeverity(s: Severity): WireSeverity {
  return s.toUpperCase() as WireSeverity;
}

export function fromWireSeverity(s: WireSeverity): Severity {
  return s.toLowerCase() as Severity;
}
