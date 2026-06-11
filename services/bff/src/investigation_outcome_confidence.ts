// services/bff/src/investigation_outcome_confidence.ts
//
// T6 M9.23 — Investigation outcome prediction confidence.
//
// For each checklist template observed across investigations, compute
// a prediction confidence score (0-100) based on:
//   - decision_rate: how often completed investigations had a non-null decision
//   - sample_size: number of completed investigations
//   - confidence_score = min(100, round(decision_rate * 60 + min(sample_size, 20) * 2))
//
// Sorted by confidence_score desc.

import { type CaseInvestigation, type InvestigationDecision } from './case_investigation';

export interface OutcomeConfidenceRow {
  template_id: string;
  decision_rate: number;
  sample_size: number;
  confidence_score: number;
  most_common_decision: InvestigationDecision | null;
}

export interface OutcomeConfidenceResult {
  tenant_id: string;
  generated_at: string;
  total_templates: number;
  results: OutcomeConfidenceRow[];
}

export function buildInvestigationOutcomeConfidence(
  tenant_id: string,
  investigations: CaseInvestigation[],
  now: Date,
): OutcomeConfidenceResult {
  if (!tenant_id) throw new Error('tenant_id required');

  // Group closed investigations by template_id
  const byTemplate = new Map<string, CaseInvestigation[]>();
  for (const inv of investigations) {
    if (inv.status !== 'closed') continue;
    const tpl = inv.checklist_template_id ?? 'BUILT_IN';
    if (!byTemplate.has(tpl)) byTemplate.set(tpl, []);
    byTemplate.get(tpl)!.push(inv);
  }

  const rows: OutcomeConfidenceRow[] = [];

  for (const [template_id, invs] of byTemplate) {
    const sample_size = invs.length;
    const with_decision = invs.filter((i) => i.decision !== null);
    const decision_rate = sample_size > 0 ? with_decision.length / sample_size : 0;

    // Compute most_common_decision
    const counts = new Map<string, number>();
    for (const inv of with_decision) {
      if (inv.decision) {
        counts.set(inv.decision, (counts.get(inv.decision) ?? 0) + 1);
      }
    }
    let most_common_decision: InvestigationDecision | null = null;
    let maxCount = 0;
    for (const [d, c] of counts) {
      if (c > maxCount) { maxCount = c; most_common_decision = d as InvestigationDecision; }
    }

    const confidence_score = Math.min(
      100,
      Math.round(decision_rate * 60 + Math.min(sample_size, 20) * 2),
    );

    rows.push({
      template_id,
      decision_rate: Math.round(decision_rate * 10000) / 10000,
      sample_size,
      confidence_score,
      most_common_decision,
    });
  }

  rows.sort((a, b) => b.confidence_score - a.confidence_score || a.template_id.localeCompare(b.template_id));

  return {
    tenant_id,
    generated_at: now.toISOString(),
    total_templates: rows.length,
    results: rows,
  };
}
