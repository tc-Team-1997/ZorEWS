// services/bff/src/tenant_onboarding_overview.ts
//
// T6 M2.9 — Tenant onboarding overview (composite).
//
// M2.6 ships the readiness score; M2.7 the skip-reason history; M2.8
// the ETA projection. Each is a separate route today, forcing the
// SPA's onboarding dashboard to make 3 round-trips on every refresh.
// M2.9 ships the composite payload — one route, one network call,
// all three sub-views in a single envelope.
//
// Pure — composes the three existing pure functions. No I/O.

import type { OnboardingState } from './tenant_onboarding';
import {
  computeOnboardingReadiness,
  type OnboardingReadiness,
} from './tenant_onboarding_readiness';
import {
  listOnboardingSkips,
  type OnboardingSkipHistory,
} from './onboarding_skip_history';
import {
  projectOnboardingEta,
  type OnboardingEtaProjection,
} from './tenant_onboarding_eta';

// ─── Public types ─────────────────────────────────────────────────────

export interface OnboardingOverview {
  tenant_id: string;
  generated_at: string;
  readiness: OnboardingReadiness;
  skip_history: OnboardingSkipHistory;
  eta: OnboardingEtaProjection;
}

// ─── Pure composer ───────────────────────────────────────────────────

export function composeOnboardingOverview(
  state: OnboardingState,
  now: Date,
): OnboardingOverview {
  const readiness = computeOnboardingReadiness(state);
  const skip_history = listOnboardingSkips(state);
  const eta = projectOnboardingEta(state, now);
  return {
    tenant_id: state.tenant_id,
    generated_at: now.toISOString(),
    readiness,
    skip_history,
    eta,
  };
}
