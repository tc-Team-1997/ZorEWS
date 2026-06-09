// services/bff/src/tenant_step_timing_analytics.ts
//
// T6 M2.21 — Tenant onboarding step timing analytics.
//
// Cross-tenant view that surfaces WHEN (hour-of-day) and HOW FAST
// tenants complete each onboarding step. Drives the SaaS admin
// "at what time of day do tenants complete provisioning?" + "which
// steps take the longest?" analytics.
//
// Distinct from:
//   M2.12 — fleet completion status (WHERE tenants are)
//   M2.13 — per-step completion ranking (HOW MANY completed)
//   M2.16 — daily volume timeline (trend)
//   M2.19 — velocity rollup (bucket distribution)
//   M2.20 — velocity histogram
//
// Route: GET /v1/tenants/onboarding/step-timing
//   RBAC: audit:read (admin-only), async
//   Mounted BEFORE /:tenant_id catch-all.

import {
  ONBOARDING_STEPS,
  type OnboardingStepDef,
  type StepProgress,
} from './tenant_onboarding';

// ─── Public types ──────────────────────────────────────────────────────

export interface StepTimingEntry {
  step_id: string;
  name: string;
  order: number;
  required: boolean;
  /** Number of tenants that have completed this step. */
  total_completed: number;
  /** Fraction of tenants that completed it (0..1). */
  completion_rate: number;
  /** Mean UTC hour-of-day (0-23) when this step was completed across tenants.
   *  null when no completed_at timestamps are available. */
  avg_completion_hour_of_day: number | null;
  /** Fastest completion in days (from tenant's first step completion to this step).
   *  null when < 2 completed steps across any tenant. */
  fastest_completion_days: number | null;
  /** Slowest completion in days. null when < 2 completed steps. */
  slowest_completion_days: number | null;
}

export interface TenantStepTimingAnalytics {
  generated_at: string;
  total_tenants: number;
  steps: StepTimingEntry[];
  /** UTC hour 0-23 with the most completions across ALL steps combined. null when no data. */
  busiest_hour: number | null;
  /** step_id with the highest completion_rate. null when all zero. */
  most_adopted_step: string | null;
}

// ─── Input type ───────────────────────────────────────────────────────

export interface TenantStepData {
  tenant_id: string;
  steps: StepProgress[];
}

// ─── Implementation ─────────────────────────────────────────────────────

export function buildTenantStepTimingAnalytics(
  states: TenantStepData[],
  now: Date,
): TenantStepTimingAnalytics {
  const generated_at = now.toISOString();
  const total_tenants = states.length;

  // Collect global hour counts (for busiest_hour)
  const hourCounts = new Array<number>(24).fill(0);

  // Per-step accumulators
  interface StepAccum {
    completed_count: number;
    hours: number[];
    // For relative timing: days from first completed step to this step per tenant
    relative_days: number[];
  }
  const stepMap = new Map<string, StepAccum>();
  for (const s of ONBOARDING_STEPS) {
    stepMap.set(s.id, { completed_count: 0, hours: [], relative_days: [] });
  }

  for (const state of states) {
    // Find the earliest completed_at across all steps for this tenant
    const completedDates: string[] = state.steps
      .filter(sp => sp.status === 'completed' && sp.completed_at)
      .map(sp => sp.completed_at!);

    const firstCompletedAt =
      completedDates.length > 0 ? completedDates.sort()[0]! : null;

    for (const sp of state.steps) {
      const accum = stepMap.get(sp.step_id);
      if (!accum) continue;

      if (sp.status === 'completed') {
        accum.completed_count++;

        if (sp.completed_at) {
          const d = new Date(sp.completed_at);
          if (!isNaN(d.getTime())) {
            const hour = d.getUTCHours();
            accum.hours.push(hour);
            hourCounts[hour] = (hourCounts[hour] ?? 0) + 1;

            // Relative timing: days from first step to this step
            if (firstCompletedAt) {
              const firstMs = new Date(firstCompletedAt).getTime();
              const thisMs = d.getTime();
              const diffDays = (thisMs - firstMs) / (24 * 60 * 60 * 1000);
              if (diffDays >= 0) {
                accum.relative_days.push(Math.round(diffDays * 100) / 100);
              }
            }
          }
        }
      }
    }
  }

  // Build step entries
  const steps: StepTimingEntry[] = [];
  for (const stepDef of ONBOARDING_STEPS) {
    const accum = stepMap.get(stepDef.id)!;
    const completion_rate =
      total_tenants > 0
        ? Math.round((accum.completed_count / total_tenants) * 10000) / 10000
        : 0;

    let avg_completion_hour_of_day: number | null = null;
    if (accum.hours.length > 0) {
      const sum = accum.hours.reduce((a, b) => a + b, 0);
      avg_completion_hour_of_day =
        Math.round((sum / accum.hours.length) * 10) / 10;
    }

    let fastest_completion_days: number | null = null;
    let slowest_completion_days: number | null = null;
    if (accum.relative_days.length > 0) {
      fastest_completion_days = Math.min(...accum.relative_days);
      slowest_completion_days = Math.max(...accum.relative_days);
    }

    steps.push({
      step_id: stepDef.id,
      name: stepDef.name,
      order: stepDef.order,
      required: stepDef.required,
      total_completed: accum.completed_count,
      completion_rate,
      avg_completion_hour_of_day,
      fastest_completion_days,
      slowest_completion_days,
    });
  }

  // Busiest hour: hour with most completions across all steps
  let busiest_hour: number | null = null;
  let maxCount = 0;
  for (let h = 0; h < 24; h++) {
    const c = hourCounts[h] ?? 0;
    if (c > maxCount) {
      maxCount = c;
      busiest_hour = h;
    }
  }
  if (maxCount === 0) busiest_hour = null;

  // Most adopted step: highest completion_rate, canonical order tie-break
  let most_adopted_step: string | null = null;
  let bestRate = 0;
  for (const step of steps) {
    if (step.completion_rate > bestRate) {
      bestRate = step.completion_rate;
      most_adopted_step = step.step_id;
    }
  }
  if (bestRate === 0) most_adopted_step = null;

  return {
    generated_at,
    total_tenants,
    steps,
    busiest_hour,
    most_adopted_step,
  };
}
