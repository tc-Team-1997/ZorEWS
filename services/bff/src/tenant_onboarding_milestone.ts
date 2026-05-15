// services/bff/src/tenant_onboarding_milestone.ts
//
// T6 M2.11 — Tenant onboarding milestone tracker.
//
// M2.6 ships the completeness_score (0..100) + blockers[]. M2.11
// shipping is the SPA-friendly 5-stage milestone classification:
// where in the onboarding journey is this tenant, and how far
// through the current stage?
//
// Stages keyed off the M2.6 completeness_score:
//   0   .. <25  → starting       ("Just getting going")
//   25  .. <50  → in_progress    ("Halfway there")
//   50  .. <75  → near_done      ("Most work behind us")
//   75  .. <100 → final_review   ("Wrap-up stage")
//   100         → complete       ("All required steps done")
//
// Drives the SPA's onboarding header progress bar — answers
// "what milestone is this tenant in?" at a glance, alongside
// the precise M2.6 numeric score.
//
// Pure rollup. Composes M2.6 readiness; no I/O.

import type { OnboardingState } from './tenant_onboarding';
import { computeOnboardingReadiness } from './tenant_onboarding_readiness';

// ─── Public types ─────────────────────────────────────────────────────

export type OnboardingStage =
  | 'starting'
  | 'in_progress'
  | 'near_done'
  | 'final_review'
  | 'complete';

interface StageDef {
  stage: OnboardingStage;
  label: string;
  description: string;
  /** Inclusive lower bound (0..100). */
  min_score: number;
  /** Exclusive upper bound for stages 0-3; for 'complete' it's
   *  exclusive 101 (i.e. covers only score=100). */
  max_score_exclusive: number;
}

const STAGES: readonly StageDef[] = [
  {
    stage: 'starting',
    label: 'Starting',
    description: 'Just getting going — required-step momentum still building.',
    min_score: 0,
    max_score_exclusive: 25,
  },
  {
    stage: 'in_progress',
    label: 'In progress',
    description: 'Quarter through the required-step backlog.',
    min_score: 25,
    max_score_exclusive: 50,
  },
  {
    stage: 'near_done',
    label: 'Near done',
    description: 'Most required steps behind us.',
    min_score: 50,
    max_score_exclusive: 75,
  },
  {
    stage: 'final_review',
    label: 'Final review',
    description: 'Wrap-up stage — verify, sign off, invite the operator.',
    min_score: 75,
    max_score_exclusive: 100,
  },
  {
    stage: 'complete',
    label: 'Complete',
    description: 'Every required onboarding step is completed.',
    min_score: 100,
    max_score_exclusive: 101,
  },
];

export interface MilestoneRow {
  stage: OnboardingStage;
  label: string;
  description: string;
  min_score: number;
  max_score_exclusive: number;
  /** True iff the tenant's current completeness_score is at or above
   *  this stage's min_score. */
  reached: boolean;
}

export interface OnboardingMilestoneSummary {
  tenant_id: string;
  generated_at: string;
  completeness_score: number;
  /** Current stage based on completeness_score. */
  current_stage: OnboardingStage;
  current_label: string;
  current_description: string;
  /** Score at which the NEXT stage begins. null when current_stage is
   *  'complete'. */
  next_stage_threshold: number | null;
  /** Progress within the current stage as a [0, 1] fraction —
   *  (score - min_score) / (max_score_exclusive - min_score). For
   *  the 'complete' stage this is always 1. */
  progress_within_stage: number;
  /** Required steps still to complete to reach the next milestone.
   *  Sourced from M2.6 blockers — always reflects PENDING (not skipped)
   *  required steps. */
  remaining_required_blockers: number;
  /** All 5 stages with reached flag. */
  all_stages: MilestoneRow[];
}

// ─── Pure resolver ────────────────────────────────────────────────────

function findStageDef(score: number): StageDef {
  // Clamp defensively in case score is out of band.
  const clamped = Math.max(0, Math.min(100, score));
  if (clamped >= 100) return STAGES[STAGES.length - 1]!;
  for (const st of STAGES) {
    if (clamped >= st.min_score && clamped < st.max_score_exclusive) return st;
  }
  return STAGES[0]!;
}

export function computeOnboardingMilestone(
  state: OnboardingState,
  now: Date,
): OnboardingMilestoneSummary {
  const readiness = computeOnboardingReadiness(state);
  const score = readiness.completeness_score;
  const current = findStageDef(score);

  // next_stage_threshold = min_score of the NEXT stage; null for
  // 'complete' since there's no next.
  let next_stage_threshold: number | null = null;
  if (current.stage !== 'complete') {
    const idx = STAGES.findIndex((s) => s.stage === current.stage);
    next_stage_threshold = STAGES[idx + 1]?.min_score ?? null;
  }

  // progress_within_stage: (score - min_score) / span. Use the span
  // (max_score_exclusive - min_score). For 'complete' the span is 1
  // (100 to 101) so progress is always 1.
  const span = current.max_score_exclusive - current.min_score;
  const progress_within_stage = current.stage === 'complete'
    ? 1
    : Math.max(0, Math.min(1, (score - current.min_score) / span));

  // Remaining required blockers = M2.6 blockers filtered to
  // status='pending' (skipped required steps surface as blockers but
  // they're operationally distinct — they need an unblock decision
  // rather than additional work).
  const remaining_required_blockers = readiness.blockers
    .filter((b) => b.status === 'pending')
    .length;

  const all_stages: MilestoneRow[] = STAGES.map((s) => ({
    stage: s.stage,
    label: s.label,
    description: s.description,
    min_score: s.min_score,
    max_score_exclusive: s.max_score_exclusive,
    reached: score >= s.min_score,
  }));

  return {
    tenant_id: state.tenant_id,
    generated_at: now.toISOString(),
    completeness_score: score,
    current_stage: current.stage,
    current_label: current.label,
    current_description: current.description,
    next_stage_threshold,
    progress_within_stage,
    remaining_required_blockers,
    all_stages,
  };
}
