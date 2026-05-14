// services/bff/src/tenant_onboarding_eta.ts
//
// T6 M2.8 — Tenant onboarding ETA projection.
//
// M2.6 ships the readiness score; M2.7 the skip-reason history.
// M2.8 adds the operational time projection: per-step minute
// estimates + remaining time + projected completion timestamp.
// Lets the SPA show ops "this tenant has ~85 minutes of setup
// work left" and "projected completion at 14:00 today".
//
// Pure — no I/O. Caller passes the loaded OnboardingState.

import type {
  OnboardingStepId,
  OnboardingState,
} from './tenant_onboarding';
import { ONBOARDING_STEPS } from './tenant_onboarding';

// ─── Effort table ────────────────────────────────────────────────────
//
// Hand-calibrated estimates per step. Reflects "how long does this
// step typically take a competent BIL ops engineer?". Skipped steps
// burn zero additional minutes (caller already decided not to do them).

const MINUTES_BY_STEP: Readonly<Record<OnboardingStepId, number>> = {
  tenant_provisioned: 5,        // automated; just provision DB row
  channels_configured: 10,      // pick channels + accept defaults
  vertical_set: 5,              // dropdown selection
  config_baseline: 30,          // walk the 13 M13 defaults + override
  email_channel: 15,            // SES creds + sender verification
  alert_routing: 20,            // tweak the 4 M8 default rules
  audit_active: 10,             // confirm WORM bucket + chain start
  operator_invited: 15,         // optional — invite + verify first login
};

const TOTAL_PLATFORM_MINUTES = Object.values(MINUTES_BY_STEP).reduce(
  (s, v) => s + v,
  0,
);

// ─── Public types ─────────────────────────────────────────────────────

export interface OnboardingEtaProjection {
  tenant_id: string;
  generated_at: string;
  total_platform_minutes: number;
  completed_minutes: number;
  skipped_minutes: number;
  pending_minutes: number;
  /** Sum of pending step minutes — the SPA's "time remaining" badge. */
  remaining_minutes: number;
  /** completed_minutes / total_platform_minutes (0..1). */
  percent_done_by_effort: number;
  /** Projected completion timestamp = now + remaining_minutes if
   *  remaining_minutes > 0, else null. */
  projected_completion_at: string | null;
  /** Required steps still pending — these MUST complete for the
   *  onboarding to be `is_complete=true`. */
  remaining_required_minutes: number;
}

// ─── Pure projector ───────────────────────────────────────────────────

export function projectOnboardingEta(
  state: OnboardingState,
  now: Date,
): OnboardingEtaProjection {
  let completed = 0;
  let skipped = 0;
  let pending = 0;
  let pending_required = 0;
  // Map step ids to required flags for cross-reference.
  const stepDefs = new Map<OnboardingStepId, { required: boolean }>();
  for (const def of ONBOARDING_STEPS) stepDefs.set(def.id, { required: def.required });
  for (const sp of state.steps) {
    const minutes = MINUTES_BY_STEP[sp.step_id] ?? 0;
    if (sp.status === 'completed') completed += minutes;
    else if (sp.status === 'skipped') skipped += minutes;
    else {
      pending += minutes;
      if (stepDefs.get(sp.step_id)?.required) pending_required += minutes;
    }
  }
  const projected =
    pending > 0
      ? new Date(now.getTime() + pending * 60_000).toISOString()
      : null;
  return {
    tenant_id: state.tenant_id,
    generated_at: now.toISOString(),
    total_platform_minutes: TOTAL_PLATFORM_MINUTES,
    completed_minutes: completed,
    skipped_minutes: skipped,
    pending_minutes: pending,
    remaining_minutes: pending,
    percent_done_by_effort:
      TOTAL_PLATFORM_MINUTES > 0 ? completed / TOTAL_PLATFORM_MINUTES : 0,
    projected_completion_at: projected,
    remaining_required_minutes: pending_required,
  };
}
