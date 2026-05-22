// services/bff/src/rule_template_action_severity_matrix.ts
//
// T6 M5.19 — Rule template recommended_action × recommended_severity
// cross-tab matrix.
//
// 2D pivot over the M5.1 RULE_TEMPLATES library combining the M5.15
// action axis × M5.16 severity axis. Each template contributes 1 PER
// recommended_action to its (action, severity) cell — a template with
// 3 actions on severity=critical contributes 1 to each of 3 cells.
//
// Distinct from:
//   M5.15 — 1D action inventory (which templates use each action)
//   M5.16 — 1D severity distribution (templates per severity)
//   M5.17 — category × vertical matrix (different axes)
//   M5.18 — indicator-count histogram (single-axis distribution)
//
// Mirror of M4.16 / M14.28 / M12.14 / M3.14 / M15.14 / M8.14 matrix
// pattern: 6 actions × 4 severities = 24 cells with every-key-present
// + canonical iteration tie-break + peak_cell + empty_cells.
//
// Both axes CLOSED. Platform-static — same response across tenants
// since RULE_TEMPLATES is platform data.
//
// Drives the SPA "what severity tier does each recommended action
// belong to?" view — answers "do we ever recommend auto_decline at
// medium severity, or is it always critical/high?" governance
// questions in one round-trip.

import type {
  RecommendedAction,
  RecommendedSeverity,
} from './rule_templates';
import { RULE_TEMPLATES } from './rule_templates';

// ---------------------------------------------------------------------
// Closed-enum canonical orders
// ---------------------------------------------------------------------

/** 6 RecommendedAction values in canonical order. */
export const ALL_RECOMMENDED_ACTIONS: readonly RecommendedAction[] = [
  'open_case',
  'notify_supervisor',
  'pause_disbursement',
  'request_documents',
  'flag_for_review',
  'auto_decline',
] as const;

/** 4 RecommendedSeverity values in canonical order (worst-first). */
export const ALL_RECOMMENDED_SEVERITIES: readonly RecommendedSeverity[] = [
  'critical',
  'high',
  'medium',
  'low',
] as const;

// ---------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------

export interface ActionSeverityRow {
  action: RecommendedAction;
  total: number;
  /** Every RecommendedSeverity key present at 0 when absent — stable
   *  grid for SPA. */
  by_severity: Record<RecommendedSeverity, number>;
  /** Severities with by_severity[s]=0; canonical order. */
  severities_without: RecommendedSeverity[];
}

export interface ActionSeverityColumn {
  severity: RecommendedSeverity;
  total: number;
  /** Every RecommendedAction key present at 0 when absent. */
  by_action: Record<RecommendedAction, number>;
  /** Actions with by_action[a]=0; canonical order. */
  actions_without: RecommendedAction[];
}

export interface PeakCell {
  action: RecommendedAction;
  severity: RecommendedSeverity;
  count: number;
  /** Template ids contributing to this cell; sorted asc. */
  template_ids: string[];
}

export interface EmptyCell {
  action: RecommendedAction;
  severity: RecommendedSeverity;
}

export interface RuleTemplateActionSeverityMatrix {
  generated_at: string;
  total_templates: number;
  /** Total cell contributions = Σ |template.recommended_actions[]|
   *  across all templates. NOT equal to total_templates when
   *  templates carry multiple actions. */
  total_contributions: number;
  total_actions: number;
  total_severities: number;
  /** 6 rows in canonical ALL_RECOMMENDED_ACTIONS order. */
  rows: ActionSeverityRow[];
  /** 4 cols in canonical ALL_RECOMMENDED_SEVERITIES order. */
  columns: ActionSeverityColumn[];
  /** Highest-count cell. Iteration tie-break: actions in canonical
   *  order × severities in canonical order. null on empty library. */
  peak_cell: PeakCell | null;
  /** Empty cells (count=0) in canonical row-major action × severity
   *  order. Useful for "what severity tier never recommends this
   *  action?" gap surfacing. */
  empty_cells: EmptyCell[];
  /** Action with the most distinct non-zero severities (= used at
   *  most severity tiers; "versatile" action). Canonical action-order
   *  tie-break: open_case wins over notify_supervisor at tied span.
   *  null on empty library. */
  most_versatile_action: RecommendedAction | null;
  /** Severity with the most distinct non-zero actions (= triggers the
   *  widest action vocabulary). Canonical severity-order tie-break:
   *  critical wins over high at tied span. null on empty library. */
  most_distributed_severity: RecommendedSeverity | null;
}

// ---------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------

function zeroBySeverity(): Record<RecommendedSeverity, number> {
  return { critical: 0, high: 0, medium: 0, low: 0 };
}

function zeroByAction(): Record<RecommendedAction, number> {
  return {
    open_case: 0,
    notify_supervisor: 0,
    pause_disbursement: 0,
    request_documents: 0,
    flag_for_review: 0,
    auto_decline: 0,
  };
}

function isRecommendedAction(s: unknown): s is RecommendedAction {
  return (
    typeof s === 'string' &&
    (ALL_RECOMMENDED_ACTIONS as readonly string[]).includes(s)
  );
}

function isRecommendedSeverity(s: unknown): s is RecommendedSeverity {
  return (
    typeof s === 'string' &&
    (ALL_RECOMMENDED_SEVERITIES as readonly string[]).includes(s)
  );
}

// ---------------------------------------------------------------------
// Main resolver
// ---------------------------------------------------------------------

export function buildRuleTemplateActionSeverityMatrix(
  now: Date,
): RuleTemplateActionSeverityMatrix {
  // Cell counts + per-cell template_ids (collected so peak_cell can
  // surface the contributing templates without a second pass).
  // Keyed by `${action}::${severity}`.
  const cellTemplateIds = new Map<string, string[]>();
  const cellCounts = new Map<string, number>();

  let total_contributions = 0;

  for (const template of RULE_TEMPLATES) {
    if (!isRecommendedSeverity(template.recommended_severity)) continue;
    // Defensive intra-template action dedup — a template listing the
    // same action twice counts once.
    const seenActions = new Set<RecommendedAction>();
    for (const action of template.recommended_actions) {
      if (!isRecommendedAction(action)) continue;
      if (seenActions.has(action)) continue;
      seenActions.add(action);
      const key = `${action}::${template.recommended_severity}`;
      const prev = cellCounts.get(key) ?? 0;
      cellCounts.set(key, prev + 1);
      const ids = cellTemplateIds.get(key);
      if (ids) {
        ids.push(template.id);
      } else {
        cellTemplateIds.set(key, [template.id]);
      }
      total_contributions += 1;
    }
  }

  // Build rows in canonical action order
  const rows: ActionSeverityRow[] = ALL_RECOMMENDED_ACTIONS.map((action) => {
    const by_severity = zeroBySeverity();
    let total = 0;
    for (const sev of ALL_RECOMMENDED_SEVERITIES) {
      const count = cellCounts.get(`${action}::${sev}`) ?? 0;
      by_severity[sev] = count;
      total += count;
    }
    const severities_without = ALL_RECOMMENDED_SEVERITIES.filter(
      (s) => by_severity[s] === 0,
    );
    return { action, total, by_severity, severities_without };
  });

  // Build columns in canonical severity order
  const columns: ActionSeverityColumn[] = ALL_RECOMMENDED_SEVERITIES.map(
    (severity) => {
      const by_action = zeroByAction();
      let total = 0;
      for (const action of ALL_RECOMMENDED_ACTIONS) {
        const count = cellCounts.get(`${action}::${severity}`) ?? 0;
        by_action[action] = count;
        total += count;
      }
      const actions_without = ALL_RECOMMENDED_ACTIONS.filter(
        (a) => by_action[a] === 0,
      );
      return { severity, total, by_action, actions_without };
    },
  );

  // peak_cell + empty_cells via canonical row-major iteration
  let peak_cell: PeakCell | null = null;
  const empty_cells: EmptyCell[] = [];
  for (const action of ALL_RECOMMENDED_ACTIONS) {
    for (const severity of ALL_RECOMMENDED_SEVERITIES) {
      const key = `${action}::${severity}`;
      const count = cellCounts.get(key) ?? 0;
      if (count === 0) {
        empty_cells.push({ action, severity });
        continue;
      }
      if (!peak_cell || count > peak_cell.count) {
        peak_cell = {
          action,
          severity,
          count,
          template_ids: [...(cellTemplateIds.get(key) ?? [])].sort((a, b) =>
            a.localeCompare(b),
          ),
        };
      }
    }
  }

  // most_versatile_action — action with most distinct non-zero by_severity
  let most_versatile_action: RecommendedAction | null = null;
  let bestActionSpan = -1;
  for (const row of rows) {
    if (row.total === 0) continue;
    const span = ALL_RECOMMENDED_SEVERITIES.length - row.severities_without.length;
    // strict > to honour canonical-iteration tie-break (first row scanned wins on ties)
    if (span > bestActionSpan) {
      bestActionSpan = span;
      most_versatile_action = row.action;
    }
  }

  // most_distributed_severity — severity with most distinct non-zero by_action
  let most_distributed_severity: RecommendedSeverity | null = null;
  let bestSeveritySpan = -1;
  for (const col of columns) {
    if (col.total === 0) continue;
    const span = ALL_RECOMMENDED_ACTIONS.length - col.actions_without.length;
    if (span > bestSeveritySpan) {
      bestSeveritySpan = span;
      most_distributed_severity = col.severity;
    }
  }

  return {
    generated_at: now.toISOString(),
    total_templates: RULE_TEMPLATES.length,
    total_contributions,
    total_actions: ALL_RECOMMENDED_ACTIONS.length,
    total_severities: ALL_RECOMMENDED_SEVERITIES.length,
    rows,
    columns,
    peak_cell,
    empty_cells,
    most_versatile_action,
    most_distributed_severity,
  };
}
