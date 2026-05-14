// services/bff/src/tenant_onboarding_actors.ts
//
// T6 M2.10 — Tenant onboarding actor summary.
//
// M2.2 tracks step status + actor on every change. M2.6 returns a
// score, M2.7 a skip audit, M2.8 an ETA, M2.9 the composite. None
// of them answer "WHO did what" — the actor-perspective view that
// the BIL ops lead needs when distributed onboarding teams share
// the work (RM does verticals, IT does config, compliance reviews
// alerts routing + audit).
//
// This rollup groups the M2.2 StepProgress entries by `completed_by`
// (the actor for completed AND skipped statuses) and emits one row
// per distinct actor with their completion / skip counts plus the
// step ids they touched. Pure — single pass over state.steps.

import { ONBOARDING_STEPS, type OnboardingState, type OnboardingStepId } from './tenant_onboarding';

// ─── Public types ─────────────────────────────────────────────────────

export interface OnboardingActorRow {
  actor_username: string;
  total_actions: number;
  completed_count: number;
  skipped_count: number;
  /** Step ids the actor completed, sorted by step.order asc. */
  completed_steps: OnboardingStepId[];
  /** Step ids the actor skipped, sorted by step.order asc. */
  skipped_steps: OnboardingStepId[];
}

export interface OnboardingActorSummary {
  tenant_id: string;
  total_actors: number;
  total_completed: number;
  total_skipped: number;
  /** Actors sorted by total_actions desc, ties by username asc. */
  actors: OnboardingActorRow[];
}

// ─── Pure resolver ────────────────────────────────────────────────────

const STEP_ORDER = new Map<OnboardingStepId, number>(
  ONBOARDING_STEPS.map((s) => [s.id, s.order]),
);

function orderOf(id: OnboardingStepId): number {
  return STEP_ORDER.get(id) ?? Number.MAX_SAFE_INTEGER;
}

export function summarizeOnboardingActors(
  state: OnboardingState,
): OnboardingActorSummary {
  const byActor = new Map<string, OnboardingActorRow>();
  let total_completed = 0;
  let total_skipped = 0;

  for (const s of state.steps) {
    if (s.status === 'pending') continue;
    if (!s.completed_by) continue;
    const actor = s.completed_by;
    let row = byActor.get(actor);
    if (!row) {
      row = {
        actor_username: actor,
        total_actions: 0,
        completed_count: 0,
        skipped_count: 0,
        completed_steps: [],
        skipped_steps: [],
      };
      byActor.set(actor, row);
    }
    row.total_actions++;
    if (s.status === 'completed') {
      row.completed_count++;
      row.completed_steps.push(s.step_id);
      total_completed++;
    } else if (s.status === 'skipped') {
      row.skipped_count++;
      row.skipped_steps.push(s.step_id);
      total_skipped++;
    }
  }

  for (const row of byActor.values()) {
    row.completed_steps.sort((a, b) => orderOf(a) - orderOf(b));
    row.skipped_steps.sort((a, b) => orderOf(a) - orderOf(b));
  }

  const actors = [...byActor.values()].sort((a, b) => {
    if (b.total_actions !== a.total_actions) return b.total_actions - a.total_actions;
    return a.actor_username.localeCompare(b.actor_username);
  });

  return {
    tenant_id: state.tenant_id,
    total_actors: actors.length,
    total_completed,
    total_skipped,
    actors,
  };
}
