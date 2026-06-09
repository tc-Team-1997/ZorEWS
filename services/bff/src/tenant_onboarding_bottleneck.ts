// services/bff/src/tenant_onboarding_bottleneck.ts
//
// T6 M2.22 — Tenant onboarding bottleneck predictor.
//
// Identifies which required onboarding steps are most commonly
// blocking completion across the tenant fleet. For each required
// step that has pending tenants, surfaces the count + percentage
// blocked + a risk_tier classification.
//
// Distinct from M2.13 (per-step completion ranking — counts
// completed/skipped/pending without risk classification),
// M2.15 (per-actor fleet contribution), M2.16 (daily timeline).
//
// Pure resolver. Async-compatible (caller supplies pre-loaded fleet).

import {
  ONBOARDING_STEPS,
  type OnboardingState,
  type OnboardingStepDef,
} from './tenant_onboarding';

// ─── Public types ─────────────────────────────────────────────────────

export type BottleneckRiskTier = 'critical' | 'high' | 'medium';

export interface BottleneckEntry {
  step_id: string;
  name: string;
  order: number;
  total_tenants_pending: number;
  pct_blocked: number;
  estimated_hours_blocked: number;
  risk_tier: BottleneckRiskTier;
}

export interface OnboardingBottleneckSummary {
  generated_at: string;
  total_tenants: number;
  bottlenecks: BottleneckEntry[];
  critical_bottleneck: { step_id: string; name: string; total_tenants_pending: number } | null;
  fleet_completion_probability: number;
}

// ─── Helpers ──────────────────────────────────────────────────────────

function riskTier(pct: number): BottleneckRiskTier {
  if (pct > 0.5) return 'critical';
  if (pct > 0.25) return 'high';
  return 'medium';
}

// ─── Main pure function ───────────────────────────────────────────────

export function predictOnboardingBottlenecks(
  fleet: Array<{ tenant_id: string; state: OnboardingState }>,
  now: Date,
): OnboardingBottleneckSummary {
  const total_tenants = fleet.length;
  const requiredSteps = ONBOARDING_STEPS.filter((s) => s.required);

  // Completed tenants count.
  const completed_tenants = fleet.filter((f) => f.state.is_complete).length;

  const bottlenecks: BottleneckEntry[] = [];

  for (const stepDef of requiredSteps) {
    let pendingCount = 0;
    let totalHoursBlocked = 0;

    for (const { state } of fleet) {
      const stepProgress = state.steps.find((s) => s.step_id === stepDef.id);
      if (!stepProgress || stepProgress.status !== 'pending') continue;

      pendingCount++;

      // Estimate hours stuck: find how long since the previous step was completed.
      // If no previous step data available, fall back to 0.
      const stepIdx = ONBOARDING_STEPS.findIndex((s) => s.id === stepDef.id);
      if (stepIdx > 0) {
        const prevStep = ONBOARDING_STEPS[stepIdx - 1];
        const prevProgress = state.steps.find((s) => s.step_id === prevStep.id);
        if (prevProgress && prevProgress.completed_at) {
          const sinceMs = now.getTime() - new Date(prevProgress.completed_at).getTime();
          totalHoursBlocked += Math.max(0, sinceMs / (1000 * 3600));
        }
      }
    }

    if (pendingCount === 0) continue;

    const pct_blocked = total_tenants > 0 ? pendingCount / total_tenants : 0;

    bottlenecks.push({
      step_id: stepDef.id,
      name: stepDef.name,
      order: stepDef.order,
      total_tenants_pending: pendingCount,
      pct_blocked: Math.round(pct_blocked * 10000) / 10000,
      estimated_hours_blocked: Math.round(totalHoursBlocked * 100) / 100,
      risk_tier: riskTier(pct_blocked),
    });
  }

  // Sort by pct_blocked desc, then step.order asc.
  bottlenecks.sort((a, b) => {
    if (b.pct_blocked !== a.pct_blocked) return b.pct_blocked - a.pct_blocked;
    return a.order - b.order;
  });

  const critical_bottleneck = bottlenecks.find((b) => b.risk_tier === 'critical') ?? null;
  const fleet_completion_probability = total_tenants > 0
    ? Math.round((completed_tenants / total_tenants) * 10000) / 10000
    : 0;

  return {
    generated_at: now.toISOString(),
    total_tenants,
    bottlenecks,
    critical_bottleneck: critical_bottleneck
      ? {
          step_id: critical_bottleneck.step_id,
          name: critical_bottleneck.name,
          total_tenants_pending: critical_bottleneck.total_tenants_pending,
        }
      : null,
    fleet_completion_probability,
  };
}
