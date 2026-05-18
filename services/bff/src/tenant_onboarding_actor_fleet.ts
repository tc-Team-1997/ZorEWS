// services/bff/src/tenant_onboarding_actor_fleet.ts
//
// T6 M2.15 — Fleet-wide onboarding contribution by actor.
//
// M2.10 ships per-tenant onboarding actor summary (single tenant, all
// actors). M2.12 ships fleet overview (all tenants, no actor pivot).
// M2.13 ships per-step cross-tenant completion ranking. M2.14 ships
// step × tenant-vertical matrix.
//
// M2.15 lands the FLEET-WIDE per-actor pivot: which operators have
// done the most onboarding work across ALL tenants? Drives ops
// recognition + cross-tenant access reviews ("alice has touched 8
// tenants — does that match her assigned scope?").
//
// Mirror of M15.8 (audit per-actor activity) + M9.14 (note authorship)
// + M11.15 (dashboard authorship) pattern for the onboarding surface.
//
// Pure resolver — caller passes tenant list + per-tenant OnboardingState.

import {
  type OnboardingStepId,
  type StepProgress,
  type StepStatus,
} from './tenant_onboarding';

// ─── Public types ──────────────────────────────────────────────────────

/** Per-actor row for the fleet-wide pivot. */
export interface OnboardingFleetActorRow {
  actor_username: string;
  /** Total step actions credited to this actor (completed + skipped). */
  total_actions: number;
  /** Distinct tenants where this actor took at least one action. */
  distinct_tenants: number;
  /** Sorted tenant_id list (cap 50 for SPA grid rendering). */
  tenant_ids: string[];
  /** Distinct step ids this actor touched. */
  distinct_steps: number;
  completed_count: number;
  skipped_count: number;
  /** Newest completed_at across this actor's actions (across all
   *  tenants). null when actor has 0 timestamped actions. */
  most_recent_at: string | null;
}

export interface OnboardingFleetActorSummary {
  generated_at: string;
  total_tenants_scanned: number;
  total_actions: number;
  total_actors: number;
  actors: OnboardingFleetActorRow[];
  /** Top row from actors[] (sorted total_actions desc); null on empty. */
  most_prolific_actor: string | null;
  /** Actor with highest distinct_tenants (independent of total_actions);
   *  canonical username asc tie-break; null on empty. */
  most_broad_actor: string | null;
}

// ─── Helpers ───────────────────────────────────────────────────────────

interface FleetEntry {
  tenant_id: string;
  steps: readonly StepProgress[];
}

function isCountedStatus(status: StepStatus): boolean {
  return status === 'completed' || status === 'skipped';
}

// ─── Pure resolver ─────────────────────────────────────────────────────

export function summarizeOnboardingFleetActors(
  fleet: readonly FleetEntry[],
  now: Date,
): OnboardingFleetActorSummary {
  type Bucket = {
    total_actions: number;
    completed_count: number;
    skipped_count: number;
    tenants: Set<string>;
    steps: Set<OnboardingStepId>;
    most_recent_at: string | null;
  };
  const buckets = new Map<string, Bucket>();

  let total_actions = 0;

  for (const entry of fleet) {
    for (const sp of entry.steps) {
      if (!isCountedStatus(sp.status)) continue;
      const actor = sp.completed_by;
      if (!actor) continue; // skip null actor entries defensively
      let b = buckets.get(actor);
      if (!b) {
        b = {
          total_actions: 0,
          completed_count: 0,
          skipped_count: 0,
          tenants: new Set<string>(),
          steps: new Set<OnboardingStepId>(),
          most_recent_at: null,
        };
        buckets.set(actor, b);
      }
      b.total_actions++;
      total_actions++;
      if (sp.status === 'completed') b.completed_count++;
      else b.skipped_count++;
      b.tenants.add(entry.tenant_id);
      b.steps.add(sp.step_id);
      const ts = sp.completed_at;
      if (ts && (!b.most_recent_at || ts > b.most_recent_at)) {
        b.most_recent_at = ts;
      }
    }
  }

  const actors: OnboardingFleetActorRow[] = [...buckets.entries()]
    .map(([actor, b]) => ({
      actor_username: actor,
      total_actions: b.total_actions,
      distinct_tenants: b.tenants.size,
      tenant_ids: [...b.tenants].sort().slice(0, 50),
      distinct_steps: b.steps.size,
      completed_count: b.completed_count,
      skipped_count: b.skipped_count,
      most_recent_at: b.most_recent_at,
    }))
    .sort((a, b) => {
      if (b.total_actions !== a.total_actions) {
        return b.total_actions - a.total_actions;
      }
      return a.actor_username.localeCompare(b.actor_username);
    });

  const most_prolific_actor = actors.length > 0 ? actors[0].actor_username : null;

  // most_broad_actor — highest distinct_tenants count; canonical username
  // asc tie-break.
  let most_broad_actor: string | null = null;
  let bestBroad = 0;
  const sortedByBreadth = [...actors].sort((a, b) => {
    if (b.distinct_tenants !== a.distinct_tenants) {
      return b.distinct_tenants - a.distinct_tenants;
    }
    return a.actor_username.localeCompare(b.actor_username);
  });
  if (sortedByBreadth.length > 0 && sortedByBreadth[0].distinct_tenants > 0) {
    most_broad_actor = sortedByBreadth[0].actor_username;
    bestBroad = sortedByBreadth[0].distinct_tenants;
  }
  void bestBroad;

  return {
    generated_at: now.toISOString(),
    total_tenants_scanned: fleet.length,
    total_actions,
    total_actors: actors.length,
    actors,
    most_prolific_actor,
    most_broad_actor,
  };
}
