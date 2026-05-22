// services/bff/src/tenant_onboarding_skip_reason_analytics.ts
//
// T6 M2.18 — Onboarding step skip-reason fleet analytics.
//
// Cross-tenant rollup over M2.5's skip_reason capture. Distinct from:
//  - M2.7 (single-tenant skip-history)  → per-tenant view
//  - M2.13 (per-step completion ranking) → pivots by step, doesn't
//    decompose skipped vs completed or surface skip reasons
//  - M2.10 (per-tenant actor summary)    → actor pivot per tenant, no
//    fleet skip aggregation
//
// M2.18 answers compliance-side questions:
//   - "Are operators consistently skipping the same step? — which one?"
//   - "What reasons are they providing? — should we improve the wizard
//     UX for that step?"
//   - "How many skips lack the M2.5 audit-trail reason (legacy
//     `markStep('skipped')` path)? — which steps are we still on the
//     legacy path for?"
//   - "Which actors are most prolific skippers? — RBI compliance flag"
//
// Pattern: mirror of M2.13 / M2.14 / M2.17 fleet-aggregation resolvers.

import {
  ONBOARDING_STEPS,
  type OnboardingState,
  type OnboardingStepId,
} from './tenant_onboarding';
import type { Tenant } from './tenant';

// ---------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------

export interface SkipReasonSample {
  tenant_id: string;
  actor: string | null;
  reason: string | null;
  completed_at: string | null;
}

export interface OnboardingStepSkipRow {
  step_id: OnboardingStepId;
  name: string;
  /** 1-based wizard order from ONBOARDING_STEPS catalog. */
  order: number;
  /** Whether this step is required (skipped required = blocker). */
  required: boolean;
  /** Total tenants where this step is in status='skipped'. */
  total_skips: number;
  /** Subset of total_skips that carry an M2.5 explicit skip_reason. */
  total_with_reason: number;
  /** Subset of total_skips on the legacy markStep('skipped') path
   *  (skip_reason=null) — these lack the M2.5 audit-trail reason
   *  and are migration candidates. */
  total_legacy: number;
  /** Distinct actor usernames across skipping tenants for this step. */
  distinct_actors: number;
  /** Distinct tenants that have skipped this step. */
  distinct_tenants: number;
  /**
   * Cap 5 samples sorted by completed_at desc with tenant_id asc
   * tie-break. **Note**: the underlying M2.2 store stores
   * `completed_at=null` for skipped status (only 'completed' status
   * sets it), so in practice the primary sort ties uniformly and
   * the tenant_id asc tie-break dominates. The resolver still
   * applies the primary sort defensively in case the schema
   * evolves to capture skipped_at on a future M2.5+ tweak.
   */
  sample_skips: SkipReasonSample[];
}

export interface OnboardingSkipReasonAnalytics {
  generated_at: string;
  total_tenants_scanned: number;
  total_skips_observed: number;
  total_steps_with_skips: number;
  /** Per-step rows in canonical ONBOARDING_STEPS.order asc — every
   *  step always present even at 0 skips (stable SPA grid). */
  steps: OnboardingStepSkipRow[];
  /**
   * Step with highest total_skips. Canonical step.order asc tie-break.
   * null when no tenant has skipped any step.
   */
  most_skipped_step: OnboardingStepId | null;
  /**
   * Required-only variant — surfaces compliance-relevant bottlenecks
   * where operators are deferring required setup work. null when no
   * required step has been skipped.
   */
  most_skipped_required_step: OnboardingStepId | null;
  /**
   * Total legacy-path skips across all steps (no M2.5 reason).
   * Surfaces the migration backlog for the M2.5 audit-trail rollout.
   */
  total_legacy_skips: number;
  /**
   * Total M2.5-path skips across all steps (with reason).
   * Σ total_with_reason + total_legacy = total_skips_observed
   * partition invariant.
   */
  total_with_reason_skips: number;
}

// ---------------------------------------------------------------------
// Pure resolver
// ---------------------------------------------------------------------

const STEP_BY_ID: Map<OnboardingStepId, (typeof ONBOARDING_STEPS)[number]> = new Map(
  ONBOARDING_STEPS.map((s) => [s.id, s]),
);

export function summarizeOnboardingSkipReasons(
  tenants: readonly Tenant[],
  getState: (tenant_id: string) => OnboardingState,
  now: Date,
): OnboardingSkipReasonAnalytics {
  // Per-step accumulators
  type Acc = {
    skips: SkipReasonSample[];
    actors: Set<string>;
    tenants: Set<string>;
    with_reason: number;
    legacy: number;
  };
  const perStep = new Map<OnboardingStepId, Acc>();
  for (const step of ONBOARDING_STEPS) {
    perStep.set(step.id, {
      skips: [],
      actors: new Set(),
      tenants: new Set(),
      with_reason: 0,
      legacy: 0,
    });
  }

  let total_skips_observed = 0;
  let total_with_reason_skips = 0;
  let total_legacy_skips = 0;

  for (const tenant of tenants) {
    const state = getState(tenant.tenant_id);
    for (const step of state.steps) {
      if (step.status !== 'skipped') continue;
      const acc = perStep.get(step.step_id);
      if (!acc) continue; // defensive — step_id not in canonical list
      acc.skips.push({
        tenant_id: tenant.tenant_id,
        actor: step.completed_by,
        reason: step.skip_reason,
        completed_at: step.completed_at,
      });
      acc.tenants.add(tenant.tenant_id);
      if (step.completed_by) acc.actors.add(step.completed_by);
      if (step.skip_reason !== null) {
        acc.with_reason += 1;
        total_with_reason_skips += 1;
      } else {
        acc.legacy += 1;
        total_legacy_skips += 1;
      }
      total_skips_observed += 1;
    }
  }

  // Build per-step rows in canonical order
  const steps: OnboardingStepSkipRow[] = ONBOARDING_STEPS.map((stepDef) => {
    const acc = perStep.get(stepDef.id)!;
    // Sort samples newest-first by completed_at (nulls last), tie-break
    // by tenant_id asc.
    const sortedSamples = [...acc.skips].sort((a, b) => {
      const at = a.completed_at ? Date.parse(a.completed_at) : -Infinity;
      const bt = b.completed_at ? Date.parse(b.completed_at) : -Infinity;
      if (at !== bt) return bt - at;
      return a.tenant_id < b.tenant_id ? -1 : 1;
    });
    return {
      step_id: stepDef.id,
      name: stepDef.name,
      order: stepDef.order,
      required: stepDef.required,
      total_skips: acc.skips.length,
      total_with_reason: acc.with_reason,
      total_legacy: acc.legacy,
      distinct_actors: acc.actors.size,
      distinct_tenants: acc.tenants.size,
      sample_skips: sortedSamples.slice(0, 5),
    };
  });

  // Leaderboards
  let most_skipped_step: OnboardingStepId | null = null;
  let most_skipped_required_step: OnboardingStepId | null = null;
  let max_total = 0;
  let max_required_total = 0;
  for (const row of steps) {
    // Canonical step.order asc tie-break: strict > so earlier-order wins
    if (row.total_skips > max_total) {
      max_total = row.total_skips;
      most_skipped_step = row.step_id;
    }
    if (row.required && row.total_skips > max_required_total) {
      max_required_total = row.total_skips;
      most_skipped_required_step = row.step_id;
    }
  }

  const total_steps_with_skips = steps.filter((s) => s.total_skips > 0).length;

  return {
    generated_at: now.toISOString(),
    total_tenants_scanned: tenants.length,
    total_skips_observed,
    total_steps_with_skips,
    steps,
    most_skipped_step,
    most_skipped_required_step,
    total_legacy_skips,
    total_with_reason_skips,
  };
}

// Re-export the helper map for tests/consumers that need step metadata.
export { STEP_BY_ID };
