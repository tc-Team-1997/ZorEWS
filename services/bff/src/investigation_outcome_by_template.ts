// services/bff/src/investigation_outcome_by_template.ts
//
// T6 M9.12 — Investigation outcome breakdown by checklist template.
//
// Each investigation carries `checklist_template_id` (M9.2) — the
// template that seeded its steps. Each closed investigation carries
// a `decision` (M9.1): fraud_confirmed / fraud_unsubstantiated /
// partial_fraud / data_quality. M9.12 pivots: for every distinct
// template id observed, count the per-decision split + a
// `confirmation_rate` = (fraud_confirmed + partial_fraud) / closed.
//
// Answers the BIL ops question: "which checklist template gives
// the highest fraud confirmation rate?" — surfaces whether the
// per-tenant custom checklists (M9.2) actually move the needle vs
// the built-in BIL §17 default. If a custom checklist confirms 80%
// of investigations but the default only confirms 30%, ops should
// migrate to the custom one.
//
// Pure rollup — single pass over the investigation list. Open
// investigations contribute to `open_count` but not to the
// confirmation_rate denominator (they have no decision yet).

import type { CaseInvestigation, InvestigationDecision } from './case_investigation';

// ─── Public types ─────────────────────────────────────────────────────

export interface OutcomeByTemplateRow {
  checklist_template_id: string;
  /** Total investigations using this template (open + closed). */
  total_count: number;
  open_count: number;
  closed_count: number;
  fraud_confirmed_count: number;
  fraud_unsubstantiated_count: number;
  partial_fraud_count: number;
  data_quality_count: number;
  /** Closed but with decision=null (legacy / pre-M9.1 closures). */
  closed_without_decision_count: number;
  /** (fraud_confirmed + partial_fraud) / closed_with_decision; null when
   *  no closed-with-decision investigations exist (avoids 0/0). */
  confirmation_rate: number | null;
}

export interface OutcomeByTemplateSummary {
  tenant_id: string;
  generated_at: string;
  total_investigations: number;
  /** Total templates observed across investigations. */
  total_templates: number;
  /** Templates sorted by total_count desc with checklist_template_id asc
   *  tie-break — the most-used checklists float to the top. */
  rows: OutcomeByTemplateRow[];
  /** Template with the highest confirmation_rate (among templates with
   *  ≥ 1 closed-with-decision investigation). null when no such template
   *  exists. Ties broken by total_count desc then template_id asc. */
  most_effective_template: {
    checklist_template_id: string;
    confirmation_rate: number;
    closed_count: number;
  } | null;
}

// ─── Pure resolver ────────────────────────────────────────────────────

function newRow(template_id: string): OutcomeByTemplateRow {
  return {
    checklist_template_id: template_id,
    total_count: 0,
    open_count: 0,
    closed_count: 0,
    fraud_confirmed_count: 0,
    fraud_unsubstantiated_count: 0,
    partial_fraud_count: 0,
    data_quality_count: 0,
    closed_without_decision_count: 0,
    confirmation_rate: null,
  };
}

function bumpDecision(row: OutcomeByTemplateRow, decision: InvestigationDecision): void {
  if (decision === 'fraud_confirmed') row.fraud_confirmed_count++;
  else if (decision === 'fraud_unsubstantiated') row.fraud_unsubstantiated_count++;
  else if (decision === 'partial_fraud') row.partial_fraud_count++;
  else if (decision === 'data_quality') row.data_quality_count++;
  else row.closed_without_decision_count++;
}

export function summarizeOutcomeByTemplate(
  tenant_id: string,
  investigations: readonly CaseInvestigation[],
  now: Date,
): OutcomeByTemplateSummary {
  const byTemplate = new Map<string, OutcomeByTemplateRow>();

  for (const inv of investigations) {
    let row = byTemplate.get(inv.checklist_template_id);
    if (!row) {
      row = newRow(inv.checklist_template_id);
      byTemplate.set(inv.checklist_template_id, row);
    }
    row.total_count++;
    if (inv.status === 'closed') {
      row.closed_count++;
      bumpDecision(row, inv.decision);
    } else {
      row.open_count++;
    }
  }

  for (const row of byTemplate.values()) {
    const closed_with_decision =
      row.fraud_confirmed_count
      + row.fraud_unsubstantiated_count
      + row.partial_fraud_count
      + row.data_quality_count;
    if (closed_with_decision > 0) {
      row.confirmation_rate =
        (row.fraud_confirmed_count + row.partial_fraud_count) / closed_with_decision;
    }
  }

  const rows = [...byTemplate.values()].sort((a, b) => {
    if (b.total_count !== a.total_count) return b.total_count - a.total_count;
    return a.checklist_template_id.localeCompare(b.checklist_template_id);
  });

  // most_effective_template: highest confirmation_rate among templates
  // with ≥ 1 closed-with-decision investigation. Tie-break (a) total_count
  // desc (more samples = more trust), (b) template_id asc (alphabetical).
  let best: OutcomeByTemplateSummary['most_effective_template'] = null;
  for (const r of rows) {
    if (r.confirmation_rate === null) continue;
    const closed_with_decision =
      r.fraud_confirmed_count
      + r.fraud_unsubstantiated_count
      + r.partial_fraud_count
      + r.data_quality_count;
    if (!best) {
      best = {
        checklist_template_id: r.checklist_template_id,
        confirmation_rate: r.confirmation_rate,
        closed_count: closed_with_decision,
      };
      continue;
    }
    if (r.confirmation_rate > best.confirmation_rate) {
      best = {
        checklist_template_id: r.checklist_template_id,
        confirmation_rate: r.confirmation_rate,
        closed_count: closed_with_decision,
      };
    } else if (r.confirmation_rate === best.confirmation_rate) {
      if (closed_with_decision > best.closed_count) {
        best = {
          checklist_template_id: r.checklist_template_id,
          confirmation_rate: r.confirmation_rate,
          closed_count: closed_with_decision,
        };
      } else if (
        closed_with_decision === best.closed_count
        && r.checklist_template_id.localeCompare(best.checklist_template_id) < 0
      ) {
        best = {
          checklist_template_id: r.checklist_template_id,
          confirmation_rate: r.confirmation_rate,
          closed_count: closed_with_decision,
        };
      }
    }
  }

  return {
    tenant_id,
    generated_at: now.toISOString(),
    total_investigations: investigations.length,
    total_templates: rows.length,
    rows,
    most_effective_template: best,
  };
}
