// services/bff/src/tenant_onboarding_roi.ts
// T6 M2.28 — Tenant onboarding ROI estimate.

import { defaultOnboardingStore, type OnboardingStore } from './tenant_onboarding';
import { computeOnboardingReadiness } from './tenant_onboarding_readiness';

export type RoiGrade = 'high' | 'medium' | 'low';

export interface TenantOnboardingRoi {
  tenant_id: string;
  generated_at: string;
  completeness_score: number;
  projected_alert_reduction_pct: number;
  projected_fp_reduction_pct: number;
  estimated_monthly_savings_usd: number;
  time_to_value_days: number;
  roi_grade: RoiGrade;
}

export function buildTenantOnboardingRoi(
  tenant_id: string,
  store: OnboardingStore,
  now: Date,
): TenantOnboardingRoi {
  const state = store.get(tenant_id);
  const readiness = computeOnboardingReadiness(state);
  const completeness_score = readiness.completeness_score;

  const projected_alert_reduction_pct = Math.round(completeness_score * 0.3 * 100) / 100;
  const projected_fp_reduction_pct = Math.round(completeness_score * 0.2 * 100) / 100;
  const estimated_monthly_savings_usd = Math.round((projected_alert_reduction_pct / 100) * 5000 * 100) / 100;
  const time_to_value_days = Math.round(30 - completeness_score * 0.28);

  let roi_grade: RoiGrade;
  if (estimated_monthly_savings_usd > 2000) {
    roi_grade = 'high';
  } else if (estimated_monthly_savings_usd >= 500) {
    roi_grade = 'medium';
  } else {
    roi_grade = 'low';
  }

  return {
    tenant_id,
    generated_at: now.toISOString(),
    completeness_score,
    projected_alert_reduction_pct,
    projected_fp_reduction_pct,
    estimated_monthly_savings_usd,
    time_to_value_days,
    roi_grade,
  };
}

export { defaultOnboardingStore };
