// services/bff/src/investigation_bottleneck_predictor.ts
// T6 M9.30 — Investigation bottleneck predictor

import { type CaseInvestigationStore, type CaseInvestigation } from './case_investigation';

export type RiskTier = 'critical' | 'high' | 'medium' | 'low';

const SLA_HOURS_BY_STATUS: Record<string, number> = {
  triage: 4,
  gathering_evidence: 24,
  awaiting_response: 72,
  review: 24,
  decision: 12,
  closed: 0,
};

export interface InvestigationPrediction {
  investigation_id: string;
  risk_score: number;
  risk_tier: RiskTier;
  top_risk_factor: string;
}

export interface InvestigationBottleneckPredictor {
  tenant_id: string;
  generated_at: string;
  total_open: number;
  at_risk_count: number;
  predictions: InvestigationPrediction[];
  systemic_bottleneck_step: string | null;
  avg_risk_score: number;
}

function getRiskTier(score: number): RiskTier {
  if (score >= 80) return 'critical';
  if (score >= 60) return 'high';
  if (score >= 40) return 'medium';
  return 'low';
}

export function buildInvestigationBottleneckPredictor(
  store: CaseInvestigationStore,
  tenant_id: string,
  now: Date
): InvestigationBottleneckPredictor {
  const generated_at = now.toISOString();
  const page = store.list(tenant_id, {});
  const allInvestigations: CaseInvestigation[] = page.items;

  const open = allInvestigations.filter((inv) => inv.status !== 'closed');
  const nowMs = now.getTime();

  const stepPendingCounts: Record<string, number> = {};

  const scored = open.map((inv) => {
    const sla_hours = SLA_HOURS_BY_STATUS[inv.status] ?? 24;
    const age_hours = (nowMs - new Date(inv.opened_at).getTime()) / (1000 * 60 * 60);
    const total_steps = inv.steps.length;
    const pending_steps = inv.steps.filter((s) => !s.completed).length;
    const hasNotes = inv.notes_count > 0;

    // Count pending steps for systemic bottleneck
    for (const step of inv.steps) {
      if (!step.completed) {
        stepPendingCounts[step.step_id] = (stepPendingCounts[step.step_id] ?? 0) + 1;
      }
    }

    const ageFactor = sla_hours > 0 ? Math.min(100, (age_hours / sla_hours) * 50) : 0;
    const stepFactor = total_steps > 0 ? (pending_steps / total_steps) * 30 : 0;
    const notesFactor = hasNotes ? 0 : 20;

    const risk_score = Math.min(100, Math.round(ageFactor + stepFactor + notesFactor));
    const risk_tier = getRiskTier(risk_score);

    let top_risk_factor: string;
    if (ageFactor >= stepFactor && ageFactor >= notesFactor) {
      top_risk_factor = `Age (${Math.round(age_hours)}h vs ${sla_hours}h SLA)`;
    } else if (stepFactor >= notesFactor) {
      top_risk_factor = `${pending_steps}/${total_steps} steps pending`;
    } else {
      top_risk_factor = 'No notes documented';
    }

    return { investigation_id: inv.investigation_id, risk_score, risk_tier, top_risk_factor };
  });

  // Top 5 most at-risk
  const sorted = scored.slice().sort((a, b) => b.risk_score - a.risk_score);
  const predictions = sorted.slice(0, 5);

  const at_risk_count = scored.filter((s) => s.risk_tier === 'critical' || s.risk_tier === 'high').length;

  // Systemic bottleneck: most often pending step
  let systemic_bottleneck_step: string | null = null;
  let maxPending = 0;
  for (const [stepId, count] of Object.entries(stepPendingCounts)) {
    if (count > maxPending) {
      maxPending = count;
      systemic_bottleneck_step = stepId;
    }
  }

  const avg_risk_score = scored.length > 0
    ? Math.round(scored.reduce((s, r) => s + r.risk_score, 0) / scored.length)
    : 0;

  return {
    tenant_id,
    generated_at,
    total_open: open.length,
    at_risk_count,
    predictions,
    systemic_bottleneck_step,
    avg_risk_score,
  };
}
