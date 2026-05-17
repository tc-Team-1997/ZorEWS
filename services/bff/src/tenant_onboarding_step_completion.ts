// services/bff/src/tenant_onboarding_step_completion.ts
//
// T6 M2.13 — Per-onboarding-step cross-tenant completion ranking.
//
// M2.12 ships the per-TENANT fleet overview (what's each tenant's
// score?). M2.13 ships the orthogonal per-STEP view (which step
// gets stuck for the most tenants?).
//
// Mirror of M13.14 cross-tenant feature-flag adoption for the
// onboarding-steps surface. For each ONBOARDING_STEP, count how many
// tenants have it completed / skipped / pending.
//
// Drives the SaaS admin "where do tenants get stuck?" view — if
// `email_channel` shows pending=80% across 100 tenants, that's a
// product / onboarding-UX problem. If `audit_active` shows skipped=
// 50%, ops is allowing compliance steps to be deferred too
// aggressively.
//
// Pure resolver — caller passes tenant list + state-lookup callback
// (matches OnboardingStore.get's signature).

import type { Tenant } from './tenant';
import {
  ONBOARDING_STEPS,
  type OnboardingState,
  type OnboardingStepDef,
  type OnboardingStepId,
  type StepStatus,
} from './tenant_onboarding';

// ─── Public types ─────────────────────────────────────────────────────

export interface StepCompletionRow {
  step_id: OnboardingStepId;
  name: string;
  order: number;
  required: boolean;
  total_tenants: number;
  completed_count: number;
  skipped_count: number;
  pending_count: number;
  /** completed / total_tenants in [0, 1]; 0 when total_tenants=0. */
  completion_rate: number;
  /** Subset of tenant_ids whose step is in 'pending' status. Sorted
   *  asc. Useful for the SPA to drill into "who hasn't done this?". */
  pending_tenant_ids: string[];
}

export interface OnboardingStepCompletionSummary {
  generated_at: string;
  total_tenants: number;
  total_steps: number;
  /** Per-step rows in canonical step.order ASC for stable rendering. */
  steps: StepCompletionRow[];
  /** Step with the highest pending_count among REQUIRED steps —
   *  surfaces "the bottleneck". Canonical step.order asc tie-break.
   *  null when no required steps or all completed. */
  biggest_required_bottleneck: {
    step_id: OnboardingStepId;
    name: string;
    pending_count: number;
  } | null;
  /** Steps with completion_rate < 0.5 (less than half of tenants
   *  done). Sorted by completion_rate asc — most-stuck first. */
  steps_needing_attention: StepCompletionRow[];
  /** Steps every tenant has completed (completion_rate === 1.0 AND
   *  total_tenants > 0). Sorted by step.order asc. */
  fully_adopted_steps: StepCompletionRow[];
}

// ─── Pure resolver ────────────────────────────────────────────────────

export function summarizeOnboardingStepCompletion(
  tenants: readonly Tenant[],
  getState: (tenant_id: string) => OnboardingState,
  now: Date,
): OnboardingStepCompletionSummary {
  const total_tenants = tenants.length;

  // Per-step builders keyed by step_id.
  const builders = new Map<OnboardingStepId, {
    def: OnboardingStepDef;
    completed: number;
    skipped: number;
    pending: number;
    pending_tenants: string[];
  }>();
  for (const def of ONBOARDING_STEPS) {
    builders.set(def.id, {
      def,
      completed: 0,
      skipped: 0,
      pending: 0,
      pending_tenants: [],
    });
  }

  // For each tenant, fetch their state and bucket per step.
  for (const tenant of tenants) {
    const state = getState(tenant.tenant_id);
    // Build a quick lookup of this tenant's step states.
    const byStep = new Map<OnboardingStepId, StepStatus>();
    for (const sp of state.steps) {
      byStep.set(sp.step_id, sp.status);
    }
    for (const def of ONBOARDING_STEPS) {
      const status = byStep.get(def.id) ?? 'pending';
      const b = builders.get(def.id)!;
      if (status === 'completed') b.completed++;
      else if (status === 'skipped') b.skipped++;
      else {
        b.pending++;
        b.pending_tenants.push(tenant.tenant_id);
      }
    }
  }

  const steps: StepCompletionRow[] = [];
  for (const def of ONBOARDING_STEPS) {
    const b = builders.get(def.id)!;
    steps.push({
      step_id: def.id,
      name: def.name,
      order: def.order,
      required: def.required,
      total_tenants,
      completed_count: b.completed,
      skipped_count: b.skipped,
      pending_count: b.pending,
      completion_rate: total_tenants > 0 ? b.completed / total_tenants : 0,
      pending_tenant_ids: b.pending_tenants.sort((a, z) => a.localeCompare(z)),
    });
  }

  // Sort: canonical step.order asc.
  steps.sort((a, z) => a.order - z.order);

  // biggest_required_bottleneck — highest pending_count among
  // required steps; canonical step.order asc tie-break via stable
  // iteration. Strict `>` keeps earlier-order tied row.
  let bottleneck: StepCompletionRow | null = null;
  for (const row of steps) {
    if (!row.required) continue;
    if (row.pending_count === 0) continue;
    if (!bottleneck || row.pending_count > bottleneck.pending_count) {
      bottleneck = row;
    }
  }
  const biggest_required_bottleneck = bottleneck
    ? { step_id: bottleneck.step_id, name: bottleneck.name, pending_count: bottleneck.pending_count }
    : null;

  // steps_needing_attention — completion_rate < 0.5 (strict). Empty
  // when total_tenants=0 to avoid noise.
  const steps_needing_attention = total_tenants > 0
    ? steps
        .filter((r) => r.completion_rate < 0.5)
        .sort((a, z) => a.completion_rate - z.completion_rate)
    : [];

  // fully_adopted_steps — completion_rate === 1.0 AND total_tenants > 0.
  const fully_adopted_steps = total_tenants > 0
    ? steps.filter((r) => r.completion_rate === 1.0)
    : [];

  return {
    generated_at: now.toISOString(),
    total_tenants,
    total_steps: ONBOARDING_STEPS.length,
    steps,
    biggest_required_bottleneck,
    steps_needing_attention,
    fully_adopted_steps,
  };
}
