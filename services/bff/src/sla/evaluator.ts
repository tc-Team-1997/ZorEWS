// services/bff/src/sla/evaluator.ts
//
// Pure SLA evaluator. Given a case snapshot + the current time, returns
// the next-active deadline + status (on-track / approaching / breached).
//
// Stage selection rule:
//   - state == 'open'                → check the ack deadline
//   - state == 'assigned'            → check the action deadline
//   - state == 'in_action' / 'monitored' → check the close deadline
//   - state == 'closed'              → no SLA active (status='closed')

import { APPROACHING_FRACTION, SLA_POLICY, type Severity, type SlaStage } from './policy';

export type CaseState = 'open' | 'assigned' | 'in_action' | 'monitored' | 'closed';

export interface SlaCase {
  case_id: string;
  severity: Severity;
  state: CaseState;
  /** ISO timestamp when the case was opened. */
  created_at: string;
  /** ISO timestamp when first acked (assignee was set). Null if not yet. */
  acked_at?: string | null;
  /** ISO timestamp when first action was logged. Null if not yet. */
  first_action_at?: string | null;
  /** ISO timestamp when closed. Null if still open. */
  closed_at?: string | null;
}

export type SlaStatus = 'on_track' | 'approaching' | 'breached' | 'closed';

export interface SlaEvaluation {
  case_id: string;
  severity: Severity;
  /** Active stage being measured — or null if the case is closed. */
  stage: SlaStage | null;
  /** Stage deadline (ISO). Null if closed. */
  deadline_at: string | null;
  /**
   * Minutes remaining until the active deadline. Negative when breached.
   * Null if the case is closed.
   */
  minutes_remaining: number | null;
  status: SlaStatus;
}

function ageMinutes(fromISO: string, now: Date): number {
  const t = new Date(fromISO).getTime();
  return Math.max(0, (now.getTime() - t) / 60_000);
}

function pickStage(c: SlaCase): SlaStage | null {
  if (c.state === 'closed') return null;
  if (c.state === 'open') return 'ack';
  if (c.state === 'assigned') return 'action';
  // in_action + monitored both race the close deadline
  return 'close';
}

export function evaluateCase(c: SlaCase, now: Date = new Date()): SlaEvaluation {
  const stage = pickStage(c);
  if (stage === null) {
    return {
      case_id: c.case_id,
      severity: c.severity,
      stage: null,
      deadline_at: null,
      minutes_remaining: null,
      status: 'closed',
    };
  }

  const policy = SLA_POLICY[c.severity];
  const allowed =
    stage === 'ack' ? policy.ack_minutes
      : stage === 'action' ? policy.action_minutes
      : policy.close_minutes;
  const elapsed = ageMinutes(c.created_at, now);
  const remaining = allowed - elapsed;
  const deadline_at = new Date(
    new Date(c.created_at).getTime() + allowed * 60_000,
  ).toISOString();

  let status: SlaStatus;
  if (remaining < 0) status = 'breached';
  else if (remaining <= allowed * (1 - APPROACHING_FRACTION)) status = 'approaching';
  else status = 'on_track';

  return {
    case_id: c.case_id,
    severity: c.severity,
    stage,
    deadline_at,
    minutes_remaining: Math.round(remaining * 10) / 10,
    status,
  };
}

export interface SlaSummaryRow {
  severity: Severity;
  on_track: number;
  approaching: number;
  breached: number;
  closed: number;
  total: number;
}

export interface SlaSummary {
  generated_at: string;
  /** Per-severity breakdown — one row per severity (always 4 rows). */
  by_severity: SlaSummaryRow[];
  /** Portfolio-wide totals across the four severities. */
  totals: { on_track: number; approaching: number; breached: number; closed: number; total: number };
  /** Cases currently in breached state (open ones — closed cases excluded). */
  breached_cases: SlaEvaluation[];
}

const ALL_SEVERITIES: Severity[] = ['critical', 'high', 'medium', 'low'];

export function summarise(cases: SlaCase[], now: Date = new Date()): SlaSummary {
  const evals = cases.map((c) => evaluateCase(c, now));

  const by_severity: SlaSummaryRow[] = ALL_SEVERITIES.map((sev) => {
    const subset = evals.filter((e) => e.severity === sev);
    return {
      severity: sev,
      on_track: subset.filter((e) => e.status === 'on_track').length,
      approaching: subset.filter((e) => e.status === 'approaching').length,
      breached: subset.filter((e) => e.status === 'breached').length,
      closed: subset.filter((e) => e.status === 'closed').length,
      total: subset.length,
    };
  });

  const totals = by_severity.reduce(
    (acc, r) => ({
      on_track: acc.on_track + r.on_track,
      approaching: acc.approaching + r.approaching,
      breached: acc.breached + r.breached,
      closed: acc.closed + r.closed,
      total: acc.total + r.total,
    }),
    { on_track: 0, approaching: 0, breached: 0, closed: 0, total: 0 },
  );

  const breached_cases = evals
    .filter((e) => e.status === 'breached')
    // Most-overdue first.
    .sort((a, b) => (a.minutes_remaining ?? 0) - (b.minutes_remaining ?? 0));

  return {
    generated_at: now.toISOString(),
    by_severity,
    totals,
    breached_cases,
  };
}
