// Phase 4 — Alert Center: severity → SLA / escalation system.
//
// The Phase 4 brief's "ALERT SEVERITY SYSTEM" + "SLA TRACKING" ask for a
// severity → SLA-window + escalation mapping with breach indicators.
// Alerts carry `severity` + `age_min` but no SLA target, so this derives
// the SLA posture client-side from a canonical config — no backend
// change. Mirrors the BFF M8.2 routing matrix shape (sla_hours +
// escalate_after_hours per class); the hour values use the Phase 4
// brief's stated windows. Pure logic — no React, no network.

import type { Severity } from '@/lib/api';

export interface SeveritySla {
  /** Hours from alert creation to SLA breach. */
  sla_hours: number;
  /** Hours after which an unactioned alert should escalate. Always
   *  < sla_hours (escalate before you breach). */
  escalate_after_hours: number;
}

// Phase 4 brief — SLA TRACKING: Critical → 2 hrs, High → 8 hrs,
// Medium → 24 hrs. Low isn't given an explicit window in the brief;
// 72 hrs keeps it bounded without being noise. Escalation fires at
// ~75% of the SLA window so a supervisor sees it before the breach.
export const ALERT_SLA_BY_SEVERITY: Readonly<Record<Severity, SeveritySla>> = {
  critical: { sla_hours: 2, escalate_after_hours: 1.5 },
  high: { sla_hours: 8, escalate_after_hours: 6 },
  medium: { sla_hours: 24, escalate_after_hours: 18 },
  low: { sla_hours: 72, escalate_after_hours: 54 },
};

export type AlertSlaStatus = 'on_time' | 'warning' | 'breached';

export interface AlertSlaPosture {
  severity: Severity;
  sla_minutes: number;
  escalate_after_minutes: number;
  elapsed_minutes: number;
  /** elapsed ÷ sla, 0..1+ (can exceed 1 when breached). Rounded 4dp. */
  progress: number;
  status: AlertSlaStatus;
  breached: boolean;
  /** True once elapsed ≥ escalate_after (and not yet breached → the
   *  "escalate now" window). Stays true through breach too. */
  escalate_due: boolean;
  /** Minutes until SLA breach; negative once breached. */
  remaining_minutes: number;
}

/**
 * Compute an alert's SLA posture from its severity + age. The warning
 * band opens at the escalation threshold (escalate_after_minutes):
 *   elapsed ≥ sla            → breached
 *   elapsed ≥ escalate_after → warning
 *   else                     → on_time
 * Negative / non-finite ageMin is clamped to 0 (clock-skew guard).
 */
export function computeAlertSla(severity: Severity, ageMin: number): AlertSlaPosture {
  const cfg = ALERT_SLA_BY_SEVERITY[severity];
  const sla_minutes = cfg.sla_hours * 60;
  const escalate_after_minutes = cfg.escalate_after_hours * 60;
  const elapsed = Number.isFinite(ageMin) && ageMin > 0 ? ageMin : 0;

  const breached = elapsed >= sla_minutes;
  const escalate_due = elapsed >= escalate_after_minutes;
  const status: AlertSlaStatus = breached ? 'breached' : escalate_due ? 'warning' : 'on_time';

  return {
    severity,
    sla_minutes,
    escalate_after_minutes,
    elapsed_minutes: elapsed,
    progress: Math.round((elapsed / sla_minutes) * 10_000) / 10_000,
    status,
    breached,
    escalate_due,
    remaining_minutes: sla_minutes - elapsed,
  };
}

/** Human label for an SLA window, e.g. 2h / 24h. */
export function slaWindowLabel(severity: Severity): string {
  return `${ALERT_SLA_BY_SEVERITY[severity].sla_hours}h`;
}
