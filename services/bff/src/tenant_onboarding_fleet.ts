// services/bff/src/tenant_onboarding_fleet.ts
//
// T6 M2.12 — Cross-tenant onboarding fleet overview.
//
// M2.1 ships per-tenant readiness. M2.6 ships per-tenant completeness
// score. M2.11 ships per-tenant milestone-stage classification.
// M2.12 lands the platform-admin view: a single GET that returns
// the onboarding posture for EVERY configured tenant in one
// round-trip, so the SaaS admin can answer "where do my tenants
// stand?" without N round-trips.
//
// Per-row carries the same shape M2.11 emits per tenant, plus
// vertical / active / last_updated_at for the SPA's fleet grid.
// Envelope adds by_stage rollup, mean_completeness, tenants_needing_
// attention (completeness < 70), most_advanced_tenant.
//
// Pure resolver — caller passes the tenant list + a function that
// resolves OnboardingState per tenant_id (matches OnboardingStore.get's
// signature). Async because tenantLookup.all() may be async.

import type { Tenant } from './tenant';
import type { OnboardingState } from './tenant_onboarding';
import { computeOnboardingReadiness } from './tenant_onboarding_readiness';
import { computeOnboardingMilestone, type OnboardingStage } from './tenant_onboarding_milestone';

// ─── Constants ────────────────────────────────────────────────────────

/** Tenants below this completeness score surface in
 *  `tenants_needing_attention` for the SPA's "needs follow-up" panel. */
export const ATTENTION_THRESHOLD = 70;

const ALL_STAGES: readonly OnboardingStage[] = [
  'starting',
  'in_progress',
  'near_done',
  'final_review',
  'complete',
] as const;

// ─── Public types ─────────────────────────────────────────────────────

export interface FleetTenantRow {
  tenant_id: string;
  tenant_name: string;
  vertical: 'banking' | 'insurance';
  active: boolean;
  completeness_score: number;
  current_stage: OnboardingStage;
  current_label: string;
  is_complete: boolean;
  total_blockers: number;
  /** Required steps currently in 'pending' status. Excludes skipped
   *  required steps (which need an unblock decision, not more work). */
  remaining_required_blockers: number;
  last_updated_at: string | null;
}

export interface FleetOnboardingSummary {
  generated_at: string;
  total_tenants: number;
  total_active_tenants: number;
  total_inactive_tenants: number;
  /** Per OnboardingStage; every key present at 0 when absent. */
  by_stage: Record<OnboardingStage, number>;
  /** Round(mean completeness across all tenants); 0 when no tenants. */
  mean_completeness_score: number;
  /** Tenants sorted by completeness_score desc with tenant_id asc
   *  tie-break — most-progressed first. */
  tenants: FleetTenantRow[];
  /** Subset of tenants with completeness_score < ATTENTION_THRESHOLD.
   *  Sorted by completeness_score ASC (least-progressed first — needs
   *  attention soonest). */
  tenants_needing_attention: Array<{
    tenant_id: string;
    tenant_name: string;
    completeness_score: number;
  }>;
  /** Top row in `tenants` (highest completeness_score with tenant_id
   *  asc tie-break). null when no tenants. */
  most_advanced_tenant: {
    tenant_id: string;
    tenant_name: string;
    completeness_score: number;
  } | null;
}

// ─── Helpers ──────────────────────────────────────────────────────────

function emptyByStage(): Record<OnboardingStage, number> {
  return {
    starting: 0,
    in_progress: 0,
    near_done: 0,
    final_review: 0,
    complete: 0,
  };
}

// ─── Pure resolver ────────────────────────────────────────────────────

export type OnboardingStateGetter = (tenant_id: string) => OnboardingState;

export function summarizeOnboardingFleet(
  tenants: readonly Tenant[],
  getState: OnboardingStateGetter,
  now: Date,
): FleetOnboardingSummary {
  const by_stage = emptyByStage();
  const rows: FleetTenantRow[] = [];
  let total_active_tenants = 0;
  let total_inactive_tenants = 0;
  let sumCompleteness = 0;

  for (const t of tenants) {
    const state = getState(t.tenant_id);
    const readiness = computeOnboardingReadiness(state);
    const milestone = computeOnboardingMilestone(state, now);

    rows.push({
      tenant_id: t.tenant_id,
      tenant_name: t.name,
      vertical: t.vertical,
      active: t.active,
      completeness_score: readiness.completeness_score,
      current_stage: milestone.current_stage,
      current_label: milestone.current_label,
      is_complete: readiness.is_complete,
      total_blockers: readiness.blockers.length,
      remaining_required_blockers: milestone.remaining_required_blockers,
      last_updated_at: state.updated_at,
    });

    if (ALL_STAGES.includes(milestone.current_stage)) {
      by_stage[milestone.current_stage]++;
    }
    if (t.active) total_active_tenants++;
    else total_inactive_tenants++;
    sumCompleteness += readiness.completeness_score;
  }

  // tenants[] sorted by completeness_score desc + tenant_id asc tie-break.
  rows.sort((a, b) => {
    if (b.completeness_score !== a.completeness_score) {
      return b.completeness_score - a.completeness_score;
    }
    return a.tenant_id.localeCompare(b.tenant_id);
  });

  const mean_completeness_score = tenants.length > 0
    ? Math.round(sumCompleteness / tenants.length)
    : 0;

  const tenants_needing_attention = rows
    .filter((r) => r.completeness_score < ATTENTION_THRESHOLD)
    .map((r) => ({
      tenant_id: r.tenant_id,
      tenant_name: r.tenant_name,
      completeness_score: r.completeness_score,
    }))
    .sort((a, b) => {
      if (a.completeness_score !== b.completeness_score) {
        return a.completeness_score - b.completeness_score;
      }
      return a.tenant_id.localeCompare(b.tenant_id);
    });

  const most_advanced_tenant = rows.length > 0
    ? {
        tenant_id: rows[0]!.tenant_id,
        tenant_name: rows[0]!.tenant_name,
        completeness_score: rows[0]!.completeness_score,
      }
    : null;

  return {
    generated_at: now.toISOString(),
    total_tenants: tenants.length,
    total_active_tenants,
    total_inactive_tenants,
    by_stage,
    mean_completeness_score,
    tenants: rows,
    tenants_needing_attention,
    most_advanced_tenant,
  };
}
