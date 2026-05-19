// services/bff/src/tenant_onboarding_stage_vertical_matrix.ts
//
// T6 M2.17 — Onboarding milestone stage × tenant vertical cross-tab matrix.
//
// M2.11 ships per-tenant milestone (5 canonical stages). M2.12 ships
// fleet overview. M2.13 ships per-step cross-tenant completion. M2.14
// ships step × tenant-vertical matrix. M2.15 ships fleet-wide
// actor pivot. M2.16 ships completion daily timeline.
//
// M2.17 ships the orthogonal STAGE × vertical cross-tab. For each
// tenant in the registry, compute its M2.11 milestone stage; combine
// with `tenant.vertical`. Rows = 5 OnboardingStage (canonical starting
// → in_progress → near_done → final_review → complete) × cols = 2
// TenantVertical (banking → insurance). Each tenant lives in exactly
// one (stage, vertical) cell.
//
// Per-row {stage, label, total, by_vertical (every vertical at 0 when
// absent — stable grid), verticals_without[] canonical}. Per-col
// {vertical, total, by_stage (every stage at 0 when absent),
// stages_without[] canonical, mean_completeness_score (across tenants
// in this vertical), tenant_ids[] sorted asc}. Envelope: peak_cell +
// fastest_vertical (highest mean_completeness) + slowest_vertical
// (lowest mean) + empty_cells[] canonical row-major.
//
// Distinct from M2.14 (step × vertical — granular per-step coverage)
// by aggregating into the higher-level milestone stage. Useful SaaS
// admin "where do banking tenants stall vs insurance?" governance view.

import {
  computeOnboardingMilestone,
  type OnboardingStage,
} from './tenant_onboarding_milestone';
import { ALL_TENANT_VERTICALS } from './tenant_onboarding_step_vertical_matrix';
import type { TenantVertical } from './tenant_onboarding_step_vertical_matrix';
import type { OnboardingState } from './tenant_onboarding';
import type { Tenant } from './tenant';

// ─── Public types ──────────────────────────────────────────────────────

export const ALL_ONBOARDING_STAGES: readonly OnboardingStage[] = [
  'starting',
  'in_progress',
  'near_done',
  'final_review',
  'complete',
] as const;

const STAGE_LABELS: Record<OnboardingStage, string> = {
  starting: 'Starting',
  in_progress: 'In progress',
  near_done: 'Near done',
  final_review: 'Final review',
  complete: 'Complete',
};

export interface StageRow {
  stage: OnboardingStage;
  label: string;
  total: number;
  by_vertical: Record<TenantVertical, number>;
  verticals_without: TenantVertical[];
}

export interface VerticalColumn {
  vertical: TenantVertical;
  total: number;
  by_stage: Record<OnboardingStage, number>;
  stages_without: OnboardingStage[];
  /** Mean of completeness_score across tenants in this vertical
   *  (rounded; null when no tenants). */
  mean_completeness_score: number | null;
  /** Tenant IDs in this vertical, sorted asc. */
  tenant_ids: string[];
}

export interface OnboardingStageVerticalMatrix {
  generated_at: string;
  total_tenants: number;
  total_stages: number; // = 5
  total_verticals: number; // = 2
  rows: StageRow[];
  columns: VerticalColumn[];
  /** Highest count cell; canonical iteration tie-break — stages in
   *  ALL_ONBOARDING_STAGES order × verticals in ALL_TENANT_VERTICALS
   *  order; null when zero tenants. */
  peak_cell: {
    stage: OnboardingStage;
    vertical: TenantVertical;
    count: number;
  } | null;
  /** Vertical with highest mean_completeness_score; canonical-order
   *  tie-break (banking first); null when zero tenants in either
   *  vertical. */
  fastest_vertical: TenantVertical | null;
  /** Vertical with lowest mean_completeness_score; canonical-order
   *  tie-break; null on empty. */
  slowest_vertical: TenantVertical | null;
  /** (stage, vertical) cells with count=0 — canonical row-major order. */
  empty_cells: Array<{ stage: OnboardingStage; vertical: TenantVertical }>;
}

// ─── Helpers ───────────────────────────────────────────────────────────

function emptyByVertical(): Record<TenantVertical, number> {
  const out = {} as Record<TenantVertical, number>;
  for (const v of ALL_TENANT_VERTICALS) out[v] = 0;
  return out;
}

function emptyByStage(): Record<OnboardingStage, number> {
  const out = {} as Record<OnboardingStage, number>;
  for (const s of ALL_ONBOARDING_STAGES) out[s] = 0;
  return out;
}

// ─── Pure resolver ─────────────────────────────────────────────────────

export async function buildOnboardingStageVerticalMatrix(
  tenants: readonly Tenant[],
  getState: (tenant_id: string) => OnboardingState | Promise<OnboardingState>,
  now: Date,
): Promise<OnboardingStageVerticalMatrix> {
  // cellCounts[stage][vertical] = count
  const cellCounts: Record<OnboardingStage, Record<TenantVertical, number>> =
    {} as never;
  for (const s of ALL_ONBOARDING_STAGES) cellCounts[s] = emptyByVertical();

  const tenantsByVertical: Record<TenantVertical, string[]> = {} as never;
  const scoreSumByVertical: Record<TenantVertical, number> = {} as never;
  const scoreCountByVertical: Record<TenantVertical, number> = {} as never;
  for (const v of ALL_TENANT_VERTICALS) {
    tenantsByVertical[v] = [];
    scoreSumByVertical[v] = 0;
    scoreCountByVertical[v] = 0;
  }

  let total_tenants = 0;

  for (const tenant of tenants) {
    if (!ALL_TENANT_VERTICALS.includes(tenant.vertical)) continue;
    const state = await getState(tenant.tenant_id);
    const milestone = computeOnboardingMilestone(state, now);
    if (!ALL_ONBOARDING_STAGES.includes(milestone.current_stage)) continue;
    total_tenants++;
    cellCounts[milestone.current_stage][tenant.vertical]++;
    tenantsByVertical[tenant.vertical].push(tenant.tenant_id);
    scoreSumByVertical[tenant.vertical] += milestone.completeness_score;
    scoreCountByVertical[tenant.vertical]++;
  }

  // Build rows in canonical stage order.
  const rows: StageRow[] = ALL_ONBOARDING_STAGES.map((stage) => {
    const by_vertical = { ...cellCounts[stage] };
    const total = ALL_TENANT_VERTICALS.reduce(
      (a, v) => a + by_vertical[v],
      0,
    );
    const verticals_without = ALL_TENANT_VERTICALS.filter(
      (v) => by_vertical[v] === 0,
    );
    return {
      stage,
      label: STAGE_LABELS[stage],
      total,
      by_vertical,
      verticals_without,
    };
  });

  // Build columns in canonical vertical order.
  const columns: VerticalColumn[] = ALL_TENANT_VERTICALS.map((vertical) => {
    const by_stage = emptyByStage();
    let total = 0;
    for (const stage of ALL_ONBOARDING_STAGES) {
      const c = cellCounts[stage][vertical];
      by_stage[stage] = c;
      total += c;
    }
    const stages_without = ALL_ONBOARDING_STAGES.filter(
      (s) => by_stage[s] === 0,
    );
    const tenant_ids = [...tenantsByVertical[vertical]].sort((a, b) =>
      a.localeCompare(b),
    );
    const mean_completeness_score =
      scoreCountByVertical[vertical] > 0
        ? Math.round(
            scoreSumByVertical[vertical] / scoreCountByVertical[vertical],
          )
        : null;
    return {
      vertical,
      total,
      by_stage,
      stages_without,
      mean_completeness_score,
      tenant_ids,
    };
  });

  // peak_cell — canonical iteration tie-break.
  let peak_cell:
    | { stage: OnboardingStage; vertical: TenantVertical; count: number }
    | null = null;
  let peakCount = 0;
  for (const stage of ALL_ONBOARDING_STAGES) {
    for (const vertical of ALL_TENANT_VERTICALS) {
      const c = cellCounts[stage][vertical];
      if (c > peakCount) {
        peakCount = c;
        peak_cell = { stage, vertical, count: c };
      }
    }
  }

  // fastest_vertical + slowest_vertical — both based on mean_completeness_score
  // across tenants in that vertical. null when zero tenants in EITHER vertical
  // (need both to compare meaningfully).
  let fastest_vertical: TenantVertical | null = null;
  let slowest_vertical: TenantVertical | null = null;
  const verticalsWithData = ALL_TENANT_VERTICALS.filter(
    (v) => columns.find((c) => c.vertical === v)!.mean_completeness_score !== null,
  );
  if (verticalsWithData.length > 0) {
    // Highest mean first; canonical-order tie-break.
    const sortedDesc = [...verticalsWithData].sort((a, b) => {
      const ma = columns.find((c) => c.vertical === a)!.mean_completeness_score!;
      const mb = columns.find((c) => c.vertical === b)!.mean_completeness_score!;
      if (mb !== ma) return mb - ma;
      // canonical order tie-break
      return (
        ALL_TENANT_VERTICALS.indexOf(a) - ALL_TENANT_VERTICALS.indexOf(b)
      );
    });
    fastest_vertical = sortedDesc[0];
    // slowest = lowest mean; canonical-order tie-break
    const sortedAsc = [...verticalsWithData].sort((a, b) => {
      const ma = columns.find((c) => c.vertical === a)!.mean_completeness_score!;
      const mb = columns.find((c) => c.vertical === b)!.mean_completeness_score!;
      if (ma !== mb) return ma - mb;
      return (
        ALL_TENANT_VERTICALS.indexOf(a) - ALL_TENANT_VERTICALS.indexOf(b)
      );
    });
    slowest_vertical = sortedAsc[0];
  }

  // empty_cells — canonical stage × vertical row-major order.
  const empty_cells: Array<{
    stage: OnboardingStage;
    vertical: TenantVertical;
  }> = [];
  for (const stage of ALL_ONBOARDING_STAGES) {
    for (const vertical of ALL_TENANT_VERTICALS) {
      if (cellCounts[stage][vertical] === 0) {
        empty_cells.push({ stage, vertical });
      }
    }
  }

  return {
    generated_at: now.toISOString(),
    total_tenants,
    total_stages: ALL_ONBOARDING_STAGES.length,
    total_verticals: ALL_TENANT_VERTICALS.length,
    rows,
    columns,
    peak_cell,
    fastest_vertical,
    slowest_vertical,
    empty_cells,
  };
}
