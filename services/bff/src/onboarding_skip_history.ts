// services/bff/src/onboarding_skip_history.ts
//
// T6 M2.7 — Tenant onboarding skip-reason history.
//
// M2.5 captures a `skip_reason` on every step explicitly skipped via
// `skipStepWithReason`. M2.6 rolls that into the readiness score
// (skipped required steps surface as blockers). M2.7 is the focused
// view: just the skipped steps, with their captured reasons, sorted
// by step order — for the compliance team's auditable "why was this
// skipped?" report.
//
// Note: a step can also be `skipped` via the legacy `markStep(...,
// 'skipped', ...)` path which doesn't capture a reason (skip_reason
// stays null). That's surfaced separately as `total_skipped_legacy`
// so compliance knows how many skips lack the new audit trail.

import {
  ONBOARDING_STEPS,
  type OnboardingState,
} from './tenant_onboarding';

// ─── Public types ─────────────────────────────────────────────────────

export interface OnboardingSkipRecord {
  step_id: string;
  name: string;
  required: boolean;
  order: number;
  /** Captured reason from M2.5. null when the step was skipped via the
   *  legacy markStep path. */
  skip_reason: string | null;
  /** Actor who performed the skip — preserved by both
   *  skipStepWithReason and markStep('skipped', ...). null if absent. */
  actor: string | null;
}

export interface OnboardingSkipHistory {
  tenant_id: string;
  total_skipped: number;
  /** Skipped via M2.5 explicit skip_reason path. */
  total_skipped_with_reason: number;
  /** Skipped via the legacy markStep(..., 'skipped', ...) path. */
  total_skipped_legacy: number;
  /** ISO timestamp of the last `markStep`/`skipStepWithReason` call,
   *  mirroring `OnboardingState.updated_at`. null on an untouched tenant. */
  state_last_updated_at: string | null;
  /** Sorted by step.order asc. */
  skipped_steps: OnboardingSkipRecord[];
}

// ─── Pure introspector ────────────────────────────────────────────────

const STEPS_BY_ID = new Map(ONBOARDING_STEPS.map((s) => [s.id, s]));

/**
 * Pure pull from the onboarding state — emits only the steps in
 * `skipped` status with their captured reasons + actor + order.
 */
export function listOnboardingSkips(state: OnboardingState): OnboardingSkipHistory {
  const skipped: OnboardingSkipRecord[] = [];
  for (const step of state.steps) {
    if (step.status !== 'skipped') continue;
    const def = STEPS_BY_ID.get(step.step_id);
    if (!def) continue; // defensive — step_id missing from catalog
    skipped.push({
      step_id: step.step_id,
      name: def.name,
      required: def.required,
      order: def.order,
      skip_reason: step.skip_reason,
      actor: step.completed_by,
    });
  }
  skipped.sort((a, b) => a.order - b.order);

  const with_reason = skipped.filter((s) => s.skip_reason !== null).length;
  return {
    tenant_id: state.tenant_id,
    total_skipped: skipped.length,
    total_skipped_with_reason: with_reason,
    total_skipped_legacy: skipped.length - with_reason,
    state_last_updated_at: state.updated_at,
    skipped_steps: skipped,
  };
}
