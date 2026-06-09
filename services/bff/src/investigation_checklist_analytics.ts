// services/bff/src/investigation_checklist_analytics.ts
//
// T6 M9.21 — Investigation checklist completion analytics.
//
// M9.1 ships the BIL §17 8-step claim-fraud checklist embedded in
// every investigation. M9.21 aggregates step completion patterns
// across all investigations so BIL compliance can answer:
//   - "which steps are consistently skipped?"
//   - "what's the overall checklist completion rate across open cases?"
//
// Distinct from M9.9 (per-investigation step progress card) — M9.21
// is the fleet-wide cross-investigation pattern view.

import type { CaseInvestigation } from './case_investigation';

// ─── Public types ──────────────────────────────────────────────────────

export interface ChecklistStepAnalytics {
  step_id: string;
  /** Total investigations that include this step. */
  total_investigations_with_step: number;
  /** Investigations where the step is marked completed. */
  completed_count: number;
  completion_rate: number;
  /** Investigations where the step is never completed. */
  never_completed_count: number;
}

export interface InvestigationChecklistAnalyticsResult {
  tenant_id: string;
  generated_at: string;
  total_investigations: number;
  /** Per-step analytics sorted by completion_rate desc, then step_id asc. */
  steps: ChecklistStepAnalytics[];
  /** Step with the highest completion_rate; null on empty. */
  best_completed_step: string | null;
  /** Step with the lowest completion_rate; null on empty. */
  worst_completed_step: string | null;
  /** Mean completion_rate across all distinct steps (0..1). null when no steps. */
  overall_checklist_completion_rate: number | null;
}

// ─── Pure function ─────────────────────────────────────────────────────

export function buildInvestigationChecklistAnalytics(
  tenant_id: string,
  investigations: CaseInvestigation[],
  now: Date,
): InvestigationChecklistAnalyticsResult {
  if (!tenant_id || typeof tenant_id !== 'string') {
    throw new Error('tenant_id is required');
  }

  const total_investigations = investigations.length;

  if (total_investigations === 0) {
    return {
      tenant_id,
      generated_at: now.toISOString(),
      total_investigations: 0,
      steps: [],
      best_completed_step: null,
      worst_completed_step: null,
      overall_checklist_completion_rate: null,
    };
  }

  // Aggregate per step_id across all investigations
  const stepMap = new Map<string, { total: number; completed: number }>();

  for (const inv of investigations) {
    for (const step of inv.steps) {
      if (!stepMap.has(step.step_id)) {
        stepMap.set(step.step_id, { total: 0, completed: 0 });
      }
      const agg = stepMap.get(step.step_id)!;
      agg.total++;
      if (step.completed) {
        agg.completed++;
      }
    }
  }

  const steps: ChecklistStepAnalytics[] = [...stepMap.entries()]
    .map(([step_id, data]) => {
      const completion_rate = data.total > 0 ? data.completed / data.total : 0;
      return {
        step_id,
        total_investigations_with_step: data.total,
        completed_count: data.completed,
        completion_rate,
        never_completed_count: data.total - data.completed,
      };
    })
    .sort((a, b) => {
      if (b.completion_rate !== a.completion_rate)
        return b.completion_rate - a.completion_rate;
      return a.step_id.localeCompare(b.step_id);
    });

  const best_completed_step = steps.length > 0 ? steps[0].step_id : null;
  const worst_completed_step =
    steps.length > 0 ? steps[steps.length - 1].step_id : null;

  const overall_checklist_completion_rate =
    steps.length > 0
      ? steps.reduce((s, r) => s + r.completion_rate, 0) / steps.length
      : null;

  return {
    tenant_id,
    generated_at: now.toISOString(),
    total_investigations,
    steps,
    best_completed_step,
    worst_completed_step,
    overall_checklist_completion_rate,
  };
}
