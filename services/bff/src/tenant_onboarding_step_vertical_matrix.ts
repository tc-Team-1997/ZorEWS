// services/bff/src/tenant_onboarding_step_vertical_matrix.ts
//
// T6 M2.14 — Onboarding step × tenant-vertical cross-tab matrix.
//
// M2.13 ships per-step completion ranking (rows = steps, with
// completed/skipped/pending counts inside each row). M2.14 elevates
// to a 2D matrix split by tenant VERTICAL: rows = 8 ONBOARDING_STEPS ×
// cols = 2 verticals (banking, insurance) = 16 cells. Cells count
// tenants who have COMPLETED that step.
//
// Mirror of M3.14 / M14.28 / M14.29 / M8.14 matrix pattern for the
// cross-tenant onboarding surface. Drives "is banking onboarding
// faster than insurance? where are the gaps per vertical?".
//
// Pure resolver — caller supplies (tenants, getState).

import type { Tenant } from './tenant';
import {
  ONBOARDING_STEPS,
  type OnboardingState,
  type OnboardingStepDef,
  type OnboardingStepId,
} from './tenant_onboarding';

// ─── Canonical vertical order ─────────────────────────────────────────

export type TenantVertical = 'banking' | 'insurance';

export const ALL_TENANT_VERTICALS: readonly TenantVertical[] = [
  'banking',
  'insurance',
] as const;

// ─── Public types ─────────────────────────────────────────────────────

export interface StepVerticalCell {
  step_id: OnboardingStepId;
  vertical: TenantVertical;
  completed_count: number;
  /** completed / vertical_total in [0, 1]; 0 when vertical has zero
   *  tenants. */
  completion_rate: number;
}

export interface StepRow {
  step_id: OnboardingStepId;
  name: string;
  order: number;
  required: boolean;
  total_completed: number;
  by_vertical: Record<TenantVertical, number>;
  /** Verticals without ANY completed tenant for this step. Canonical
   *  order. */
  verticals_without: TenantVertical[];
}

export interface VerticalColumn {
  vertical: TenantVertical;
  /** Total tenants in this vertical across the fleet. */
  total_tenants: number;
  /** Completed-step dispatches (sum across all steps). A tenant who
   *  completes 3 steps contributes 3. */
  total_completed: number;
  by_step: Record<OnboardingStepId, number>;
  /** Steps every tenant in this vertical has completed
   *  (completed_count === total_tenants AND total_tenants > 0). */
  steps_universally_completed: OnboardingStepId[];
}

export interface OnboardingStepVerticalMatrix {
  generated_at: string;
  total_tenants: number;
  total_steps: number;
  total_verticals: number;
  rows: StepRow[];
  columns: VerticalColumn[];
  /** Peak (step, vertical) cell by completed_count. Canonical
   *  iteration tie-break (steps in step.order asc × verticals in
   *  canonical order). null when no completed steps anywhere. */
  peak_cell: StepVerticalCell | null;
  /** (step, vertical) cells with completed_count=0 in canonical
   *  step.order × vertical row-major order. */
  empty_cells: Array<{ step_id: OnboardingStepId; vertical: TenantVertical }>;
  /** Vertical with the highest fleet-wide completion_rate (averaged
   *  over steps). Canonical-order tie-break. null when no tenants. */
  fastest_vertical: { vertical: TenantVertical; mean_completion_rate: number } | null;
  /** Vertical with the lowest mean completion_rate. Canonical
   *  tie-break. null when no tenants. */
  slowest_vertical: { vertical: TenantVertical; mean_completion_rate: number } | null;
}

// ─── Helpers ──────────────────────────────────────────────────────────

function emptyByVertical(): Record<TenantVertical, number> {
  return { banking: 0, insurance: 0 };
}

function emptyByStep(): Record<OnboardingStepId, number> {
  const out: Partial<Record<OnboardingStepId, number>> = {};
  for (const step of ONBOARDING_STEPS) out[step.id] = 0;
  return out as Record<OnboardingStepId, number>;
}

// ─── Pure resolver ────────────────────────────────────────────────────

export function buildOnboardingStepVerticalMatrix(
  tenants: readonly Tenant[],
  getState: (tenant_id: string) => OnboardingState,
  now: Date,
): OnboardingStepVerticalMatrix {
  // Per (step, vertical) → completed_count.
  const cell = new Map<OnboardingStepId, Record<TenantVertical, number>>();
  for (const step of ONBOARDING_STEPS) cell.set(step.id, emptyByVertical());

  // Per-vertical tenant totals.
  const verticalTotals: Record<TenantVertical, number> = emptyByVertical();

  for (const tenant of tenants) {
    if (!ALL_TENANT_VERTICALS.includes(tenant.vertical as TenantVertical)) continue;
    const vertical = tenant.vertical as TenantVertical;
    verticalTotals[vertical]++;
    const state = getState(tenant.tenant_id);
    for (const sp of state.steps) {
      if (sp.status !== 'completed') continue;
      const inner = cell.get(sp.step_id);
      if (!inner) continue;
      inner[vertical]++;
    }
  }

  const total_tenants = verticalTotals.banking + verticalTotals.insurance;

  // Rows (steps × all verticals).
  const rows: StepRow[] = ONBOARDING_STEPS.map((step: OnboardingStepDef) => {
    const inner = cell.get(step.id)!;
    const by_vertical: Record<TenantVertical, number> = {
      banking: inner.banking,
      insurance: inner.insurance,
    };
    const total_completed = inner.banking + inner.insurance;
    const verticals_without = ALL_TENANT_VERTICALS.filter((v) => by_vertical[v] === 0);
    return {
      step_id: step.id,
      name: step.name,
      order: step.order,
      required: step.required,
      total_completed,
      by_vertical,
      verticals_without,
    };
  });

  // Columns (verticals × all steps).
  const columns: VerticalColumn[] = ALL_TENANT_VERTICALS.map((vertical) => {
    const by_step = emptyByStep();
    let total_completed = 0;
    for (const step of ONBOARDING_STEPS) {
      const c = cell.get(step.id)![vertical];
      by_step[step.id] = c;
      total_completed += c;
    }
    const vtotal = verticalTotals[vertical];
    const steps_universally_completed =
      vtotal > 0
        ? ONBOARDING_STEPS.filter((step) => by_step[step.id] === vtotal).map((step) => step.id)
        : [];
    return {
      vertical,
      total_tenants: vtotal,
      total_completed,
      by_step,
      steps_universally_completed,
    };
  });

  // peak_cell — canonical iteration tie-break (step.order asc × vertical asc).
  let peak_cell: StepVerticalCell | null = null;
  const sortedSteps = [...ONBOARDING_STEPS].sort((a, z) => a.order - z.order);
  for (const step of sortedSteps) {
    for (const v of ALL_TENANT_VERTICALS) {
      const count = cell.get(step.id)![v];
      if (count > 0 && (!peak_cell || count > peak_cell.completed_count)) {
        const vtotal = verticalTotals[v];
        peak_cell = {
          step_id: step.id,
          vertical: v,
          completed_count: count,
          completion_rate: vtotal > 0 ? +(count / vtotal).toFixed(4) : 0,
        };
      }
    }
  }

  // empty_cells canonical row-major (step.order asc × vertical).
  const empty_cells: Array<{ step_id: OnboardingStepId; vertical: TenantVertical }> = [];
  for (const step of sortedSteps) {
    for (const v of ALL_TENANT_VERTICALS) {
      const count = cell.get(step.id)![v];
      if (count === 0) empty_cells.push({ step_id: step.id, vertical: v });
    }
  }

  // fastest_vertical / slowest_vertical — by mean completion_rate
  // across steps.
  function meanCompletionRate(v: TenantVertical): number {
    const vtotal = verticalTotals[v];
    if (vtotal === 0) return 0;
    let sum = 0;
    for (const step of ONBOARDING_STEPS) {
      sum += cell.get(step.id)![v] / vtotal;
    }
    return +(sum / ONBOARDING_STEPS.length).toFixed(4);
  }

  if (total_tenants === 0) {
    return {
      generated_at: now.toISOString(),
      total_tenants,
      total_steps: ONBOARDING_STEPS.length,
      total_verticals: ALL_TENANT_VERTICALS.length,
      rows,
      columns,
      peak_cell,
      empty_cells,
      fastest_vertical: null,
      slowest_vertical: null,
    };
  }

  let fastest: { vertical: TenantVertical; mean_completion_rate: number } | null = null;
  let slowest: { vertical: TenantVertical; mean_completion_rate: number } | null = null;
  for (const v of ALL_TENANT_VERTICALS) {
    if (verticalTotals[v] === 0) continue;
    const rate = meanCompletionRate(v);
    if (!fastest || rate > fastest.mean_completion_rate) {
      fastest = { vertical: v, mean_completion_rate: rate };
    }
    if (!slowest || rate < slowest.mean_completion_rate) {
      slowest = { vertical: v, mean_completion_rate: rate };
    }
  }

  return {
    generated_at: now.toISOString(),
    total_tenants,
    total_steps: ONBOARDING_STEPS.length,
    total_verticals: ALL_TENANT_VERTICALS.length,
    rows,
    columns,
    peak_cell,
    empty_cells,
    fastest_vertical: fastest,
    slowest_vertical: slowest,
  };
}
