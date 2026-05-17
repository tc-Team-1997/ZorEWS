// services/bff/src/audit_severity_outcome_matrix.ts
//
// T6 M15.15 — Audit severity × outcome cross-tab matrix.
//
// M15.6 ships action verb catalog. M15.7 ships dow×hour activity
// heatmap. M15.8 ships per-actor activity. M15.9 ships severity
// distribution (1D). M15.10 ships correlation rollup. M15.11 ships
// daily volume. M15.12 ships resource_type distribution (1D). M15.13
// ships action prefix distribution. M15.14 ships resource_type ×
// severity cross-tab.
//
// M15.15 lands the SEVERITY × OUTCOME cross-tab matrix:
// 3 AuditSeverity rows (critical / warning / info — canonical worst-first
// order matching M15.9) × 3 AuditOutcome columns (success / failure /
// denied — canonical order matching M15.12) = 9 cells.
//
// Each event lives in EXACTLY one cell (its severity + outcome).
// Per-row {severity, total, by_outcome (3-key Record at 0 when absent),
//          outcomes_without[] in canonical order}.
// Per-col {outcome, total, by_severity (3-key Record at 0 when absent),
//          severities_without[] in canonical order}.
//
// Envelope adds peak_cell + empty_cells + most_failing_severity (severity
// with most {failure + denied} events — "are critical events failing
// disproportionately?") + most_critical_outcome (outcome with most
// critical-severity events — "are denied actions usually critical?").
//
// Distinct from M15.9 (severity 1D pivot with by_resource_type +
// by_outcome nested inside) by being the proper severity × outcome
// MATRIX rather than 1D + nested.
//
// Mirror of M14.28 / M8.14 / M3.14 / M5.17 / M13.15 / M7.14 / M12.14 /
// M15.14 matrix pattern for the audit surface.
//
// Drives BIL compliance: "are critical events actually completing
// successfully or do they fail at a higher rate than warnings/info?".
//
// Pure resolver — caller passes event list.

import type {
  AuditEvent,
  AuditOutcome,
  AuditSeverity,
} from './audit_trail';

// ─── Canonical enums (worst-first ordering) ──────────────────────────

const ALL_AUDIT_SEVERITIES: readonly AuditSeverity[] = [
  'critical',
  'warning',
  'info',
] as const;

const ALL_AUDIT_OUTCOMES: readonly AuditOutcome[] = [
  'success',
  'failure',
  'denied',
] as const;

// ─── Public types ──────────────────────────────────────────────────────

export interface AuditSeverityOutcomeRow {
  severity: AuditSeverity;
  total: number;
  /** Per-outcome counts; every key always present (0 when absent). */
  by_outcome: Record<AuditOutcome, number>;
  /** Outcomes with by_outcome[outcome]=0 for this severity, in
   *  canonical order — coverage-gap list per severity. */
  outcomes_without: AuditOutcome[];
}

export interface AuditSeverityOutcomeColumn {
  outcome: AuditOutcome;
  total: number;
  /** Per-severity counts; every key always present (0 when absent). */
  by_severity: Record<AuditSeverity, number>;
  /** Severities with by_severity[severity]=0 for this outcome, in
   *  canonical order — coverage-gap list per outcome. */
  severities_without: AuditSeverity[];
}

export interface AuditSeverityOutcomeCell {
  severity: AuditSeverity;
  outcome: AuditOutcome;
}

export interface AuditSeverityOutcomePeakCell extends AuditSeverityOutcomeCell {
  count: number;
}

export interface AuditSeverityOutcomeMatrix {
  tenant_id: string;
  generated_at: string;
  total_events: number;
  rows: AuditSeverityOutcomeRow[];
  columns: AuditSeverityOutcomeColumn[];
  /** Highest-count cell; canonical iteration tie-break (severity asc
   *  by ALL_AUDIT_SEVERITIES, then outcome asc by ALL_AUDIT_OUTCOMES);
   *  null when no events. */
  peak_cell: AuditSeverityOutcomePeakCell | null;
  /** Cells with count=0 in canonical row-major order (severity outer,
   *  outcome inner). */
  empty_cells: AuditSeverityOutcomeCell[];
  /** Severity with the most failure+denied combined (the "things going
   *  wrong" cross-cut); canonical-order tie-break: critical wins over
   *  warning at tied count; null on empty. */
  most_failing_severity: AuditSeverity | null;
  /** Outcome carrying the most critical-severity events;
   *  canonical-order tie-break: success wins over failure at tied;
   *  null on empty (no events at all). */
  most_critical_outcome: AuditOutcome | null;
}

// ─── Helpers ───────────────────────────────────────────────────────────

function emptyByOutcome(): Record<AuditOutcome, number> {
  return { success: 0, failure: 0, denied: 0 };
}

function emptyBySeverity(): Record<AuditSeverity, number> {
  return { critical: 0, warning: 0, info: 0 };
}

// ─── Pure resolver ─────────────────────────────────────────────────────

export function buildAuditSeverityOutcomeMatrix(
  tenant_id: string,
  events: readonly AuditEvent[],
  now: Date,
): AuditSeverityOutcomeMatrix {
  // 3×3 cell counts initialised to 0 by canonical iteration order.
  const cellCounts: Record<AuditSeverity, Record<AuditOutcome, number>> = {
    critical: emptyByOutcome(),
    warning: emptyByOutcome(),
    info: emptyByOutcome(),
  };

  let total_events = 0;

  for (const e of events) {
    if (!ALL_AUDIT_SEVERITIES.includes(e.severity)) continue;
    if (!ALL_AUDIT_OUTCOMES.includes(e.outcome)) continue;
    cellCounts[e.severity][e.outcome]++;
    total_events++;
  }

  // Build per-row + per-column projections.
  const rows: AuditSeverityOutcomeRow[] = ALL_AUDIT_SEVERITIES.map((sev) => {
    const by_outcome = cellCounts[sev];
    const total = ALL_AUDIT_OUTCOMES.reduce(
      (acc, oc) => acc + by_outcome[oc],
      0,
    );
    const outcomes_without = ALL_AUDIT_OUTCOMES.filter(
      (oc) => by_outcome[oc] === 0,
    );
    return { severity: sev, total, by_outcome: { ...by_outcome }, outcomes_without };
  });

  const columns: AuditSeverityOutcomeColumn[] = ALL_AUDIT_OUTCOMES.map((oc) => {
    const by_severity = emptyBySeverity();
    let total = 0;
    for (const sev of ALL_AUDIT_SEVERITIES) {
      by_severity[sev] = cellCounts[sev][oc];
      total += by_severity[sev];
    }
    const severities_without = ALL_AUDIT_SEVERITIES.filter(
      (sev) => by_severity[sev] === 0,
    );
    return { outcome: oc, total, by_severity, severities_without };
  });

  // peak_cell — highest count, canonical iteration tie-break
  // (severity major, outcome minor).
  let peak_cell: AuditSeverityOutcomePeakCell | null = null;
  let peakCount = 0;
  for (const sev of ALL_AUDIT_SEVERITIES) {
    for (const oc of ALL_AUDIT_OUTCOMES) {
      const c = cellCounts[sev][oc];
      if (c > peakCount) {
        peakCount = c;
        peak_cell = { severity: sev, outcome: oc, count: c };
      }
    }
  }
  if (peakCount === 0) peak_cell = null;

  // empty_cells — canonical row-major iteration order.
  const empty_cells: AuditSeverityOutcomeCell[] = [];
  for (const sev of ALL_AUDIT_SEVERITIES) {
    for (const oc of ALL_AUDIT_OUTCOMES) {
      if (cellCounts[sev][oc] === 0) {
        empty_cells.push({ severity: sev, outcome: oc });
      }
    }
  }

  // most_failing_severity — severity with most (failure + denied)
  // events; canonical-order tie-break via iteration.
  let most_failing_severity: AuditSeverity | null = null;
  let mostFailingCount = 0;
  for (const sev of ALL_AUDIT_SEVERITIES) {
    const f = cellCounts[sev].failure + cellCounts[sev].denied;
    if (f > mostFailingCount) {
      mostFailingCount = f;
      most_failing_severity = sev;
    }
  }
  if (mostFailingCount === 0) most_failing_severity = null;

  // most_critical_outcome — outcome with most critical-severity events;
  // canonical-order tie-break via iteration.
  let most_critical_outcome: AuditOutcome | null = null;
  let mostCriticalCount = 0;
  for (const oc of ALL_AUDIT_OUTCOMES) {
    const c = cellCounts.critical[oc];
    if (c > mostCriticalCount) {
      mostCriticalCount = c;
      most_critical_outcome = oc;
    }
  }
  if (mostCriticalCount === 0) most_critical_outcome = null;

  return {
    tenant_id,
    generated_at: now.toISOString(),
    total_events,
    rows,
    columns,
    peak_cell,
    empty_cells,
    most_failing_severity,
    most_critical_outcome,
  };
}
