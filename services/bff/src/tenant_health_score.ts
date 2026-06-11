// services/bff/src/tenant_health_score.ts
//
// T6 M2.26 — Tenant health composite score.
//
// Computes a composite health score (0-100) for the caller's tenant
// based on 5 dimensions using deterministic PRNG seeded by (tenant_id, day):
//   - config_score
//   - onboarding_score
//   - alert_score
//   - integration_score
//   - security_score
//
// composite_score = mean of 5 (rounded)
// health_grade: A(>=85) / B(70-84) / C(55-69) / D(<55)
//
// Route: GET /v1/tenants/health-score
//   RBAC: audit:read (admin)

import { defaultOnboardingStore, type OnboardingStore } from './tenant_onboarding';

// ─── FNV-1a + mulberry32 ──────────────────────────────────────────────

function fnv1a(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = ((h ^ s.charCodeAt(i)) * 16777619) >>> 0;
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let t = seed;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = t;
    r = ((r ^ (r >>> 15)) * (r | 1)) >>> 0;
    r = (r ^ (r + ((r ^ (r >>> 7)) * (r | 61)))) >>> 0;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

// ─── Public types ─────────────────────────────────────────────────────

export type HealthGrade = 'A' | 'B' | 'C' | 'D';

export interface TenantHealthDimensions {
  config_score: number;
  onboarding_score: number;
  alert_score: number;
  integration_score: number;
  security_score: number;
}

export interface TenantHealthScore {
  tenant_id: string;
  generated_at: string;
  composite_score: number;
  health_grade: HealthGrade;
  dimensions: TenantHealthDimensions;
  recommendations: string[];
}

function gradeFor(score: number): HealthGrade {
  if (score >= 85) return 'A';
  if (score >= 70) return 'B';
  if (score >= 55) return 'C';
  return 'D';
}

// ─── Pure resolver ────────────────────────────────────────────────────

export function computeTenantHealthScore(
  tenant_id: string,
  onboardingStore: OnboardingStore,
  now: Date,
): TenantHealthScore {
  if (!tenant_id) throw new Error('tenant_id is required');

  const day = now.toISOString().slice(0, 10);
  const rng = mulberry32(fnv1a(`${tenant_id}::${day}::health`));

  // onboarding_score from the actual onboarding state
  const state = onboardingStore.get(tenant_id);
  let onboarding_score: number;
  if (state.is_complete) {
    onboarding_score = 100;
  } else {
    // completeness_score is 0-100 already
    const readiness = state.steps.filter((s) => s.status === 'completed').length;
    onboarding_score = Math.round((readiness / state.total_steps) * 100);
  }

  // PRNG-based dimensions
  const config_score = Math.round(50 + rng() * 50);
  const alert_score = Math.round(60 + rng() * 40);
  const integration_score = Math.round(70 + rng() * 30);
  const security_score = Math.round(75 + rng() * 25);

  const composite_score = Math.round(
    (config_score + onboarding_score + alert_score + integration_score + security_score) / 5,
  );

  const grade = gradeFor(composite_score);

  const recommendations: string[] = [];
  if (onboarding_score < 70) recommendations.push('Complete tenant onboarding wizard steps');
  if (config_score < 70) recommendations.push('Review and override platform config defaults');
  if (security_score < 80) recommendations.push('Enable 2FA and review API key hygiene');
  if (integration_score < 80) recommendations.push('Check adapter health status');
  if (alert_score < 75) recommendations.push('Improve alert acknowledgement rate');

  return {
    tenant_id,
    generated_at: now.toISOString(),
    composite_score,
    health_grade: grade,
    dimensions: {
      config_score,
      onboarding_score,
      alert_score,
      integration_score,
      security_score,
    },
    recommendations,
  };
}
