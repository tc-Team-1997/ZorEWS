// services/bff/src/tenant_onboarding_readiness.ts
//
// T6 M2.6 — Tenant onboarding readiness score.
//
// M2.2 ships the wizard state (8 platform steps, per-tenant
// progress, is_complete bool). What ops have asked for next: a
// single-number readiness gauge for the admin dashboard — "this
// tenant is 73% ready" — plus a structured blocker list pointing
// at WHICH required steps are still pending/skipped. M2.6 ships
// the pure derived view on top of OnboardingState.
//
// Design:
//  - Pure function over `OnboardingState`. No I/O.
//  - `completeness_score` is a weighted blend: 70% required-pct +
//    30% overall-pct. Weights matter — a tenant with 7/7 required
//    done but the 1 optional step pending should still read as
//    "ready" (≈ 92.5%), not "missing one step".
//  - `blockers[]` enumerates required steps NOT in `completed`
//    status (pending OR skipped — a skipped required step is a
//    deferred decision, not an accomplishment), sorted by step
//    order so the SPA can render "next required step" naturally.
//  - `next_action` is the first PENDING required step (skipped
//    required steps are blockers but aren't a "next action" —
//    they need an unblock decision, not a status flip).

import {
  ONBOARDING_STEPS,
  type OnboardingState,
  type OnboardingStepDef,
  type StepProgress,
} from './tenant_onboarding';

// ─── Public types ─────────────────────────────────────────────────────

export interface ReadinessBlocker {
  step_id: OnboardingStepDef['id'];
  name: string;
  order: number;
  /** 'pending' or 'skipped' — both block required-completeness. */
  status: 'pending' | 'skipped';
  /** Captured M2.5 skip reason when status='skipped'. null when pending. */
  skip_reason: string | null;
}

export interface NextRequiredAction {
  step_id: OnboardingStepDef['id'];
  name: string;
  order: number;
  description: string;
}

export interface OnboardingReadiness {
  tenant_id: string;
  /** 0..100, rounded to integer. Weighted: 0.7 × required_pct +
   *  0.3 × overall_pct. */
  completeness_score: number;
  /** Fraction of REQUIRED steps in `completed` status. 0..100 rounded. */
  required_pct: number;
  /** Fraction of ALL steps in `completed` status. 0..100 rounded. */
  overall_pct: number;
  /** Count of required steps in `completed` status. */
  completed_required_count: number;
  /** Total required steps. */
  required_steps: number;
  /** True iff every required step is in `completed` status. Matches
   *  OnboardingState.is_complete; surfaced here for self-containedness. */
  is_complete: boolean;
  /** Required steps NOT completed (pending OR skipped), oldest-order first. */
  blockers: ReadinessBlocker[];
  /** First PENDING required step (the one ops should work on next).
   *  null when all required steps are either completed or skipped. */
  next_action: NextRequiredAction | null;
}

// ─── Helpers ──────────────────────────────────────────────────────────

const REQUIRED_WEIGHT = 0.7;
const OVERALL_WEIGHT = 0.3;

// ─── Pure resolver ────────────────────────────────────────────────────

/**
 * Pure resolver — derives `OnboardingReadiness` from the supplied
 * `OnboardingState`. State assumed valid per the M2.2 contract.
 */
export function computeOnboardingReadiness(
  state: OnboardingState,
): OnboardingReadiness {
  const requiredDefs = ONBOARDING_STEPS.filter((s) => s.required);
  const required_steps = requiredDefs.length;
  const total_steps = ONBOARDING_STEPS.length;

  // Index progress by step_id for fast lookup.
  const progressById = new Map<string, StepProgress>(
    state.steps.map((s) => [s.step_id, s]),
  );

  let completed_required_count = 0;
  let completed_total_count = 0;
  const blockers: ReadinessBlocker[] = [];
  let next_action: NextRequiredAction | null = null;

  for (const def of ONBOARDING_STEPS) {
    const prog = progressById.get(def.id);
    const status = prog?.status ?? 'pending';
    if (status === 'completed') {
      completed_total_count += 1;
      if (def.required) completed_required_count += 1;
      continue;
    }
    if (def.required) {
      blockers.push({
        step_id: def.id,
        name: def.name,
        order: def.order,
        status: status === 'skipped' ? 'skipped' : 'pending',
        skip_reason: status === 'skipped' ? prog?.skip_reason ?? null : null,
      });
      if (next_action === null && status === 'pending') {
        next_action = {
          step_id: def.id,
          name: def.name,
          order: def.order,
          description: def.description,
        };
      }
    }
  }

  blockers.sort((a, b) => a.order - b.order);

  const required_pct =
    required_steps === 0
      ? 100
      : Math.round((completed_required_count / required_steps) * 100);
  const overall_pct =
    total_steps === 0
      ? 100
      : Math.round((completed_total_count / total_steps) * 100);
  const completeness_score = Math.round(
    REQUIRED_WEIGHT * required_pct + OVERALL_WEIGHT * overall_pct,
  );

  return {
    tenant_id: state.tenant_id,
    completeness_score,
    required_pct,
    overall_pct,
    completed_required_count,
    required_steps,
    is_complete: state.is_complete,
    blockers,
    next_action,
  };
}
