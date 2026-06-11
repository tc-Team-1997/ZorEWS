// services/bff/src/dashboard_adoption_funnel.ts
// T6 M11.28 — Dashboard adoption funnel analysis

import { type CustomDashboardStore } from './custom_dashboards';

export type AdoptionTier = 'power_user' | 'engaged' | 'onboarding' | 'inactive';

export interface FunnelStage {
  stage: string;
  count: number;
  pct: number;
  label: string;
}

export interface DashboardAdoptionFunnel {
  tenant_id: string;
  generated_at: string;
  total_dashboards: number;
  funnel_stages: FunnelStage[];
  funnel_score: number;
  adoption_tier: AdoptionTier;
  recommendations: string[];
}

export function buildDashboardAdoptionFunnel(
  store: CustomDashboardStore,
  tenant_id: string,
  now: Date
): DashboardAdoptionFunnel {
  const generated_at = now.toISOString();
  const dashboards = store.list(tenant_id);
  const total = dashboards.length;

  const nowMs = now.getTime();
  const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;

  // Stage 1: has any dashboard (always 1 if we have dashboards)
  const stage1Count = total > 0 ? 1 : 0;
  const stage1Pct = total > 0 ? 100 : 0;

  // Stage 2: dashboards with 3+ widgets
  const stage2Count = dashboards.filter((d) => d.widgets.length >= 3).length;
  const stage2Pct = total > 0 ? Math.round((stage2Count / total) * 100) : 0;

  // Stage 3: dashboards updated within 30 days
  const stage3Count = dashboards.filter((d) => {
    const updatedMs = nowMs - new Date(d.updated_at).getTime();
    return updatedMs < thirtyDaysMs;
  }).length;
  const stage3Pct = total > 0 ? Math.round((stage3Count / total) * 100) : 0;

  // Stage 4: dashboards version >= 2 (been edited at least once)
  const stage4Count = dashboards.filter((d) => d.version >= 2).length;
  const stage4Pct = total > 0 ? Math.round((stage4Count / total) * 100) : 0;

  const funnel_stages: FunnelStage[] = [
    { stage: 'any_dashboard', count: stage1Count, pct: stage1Pct, label: 'Has at least one dashboard' },
    { stage: 'content_rich', count: stage2Count, pct: stage2Pct, label: 'Dashboards with 3+ widgets' },
    { stage: 'recently_active', count: stage3Count, pct: stage3Pct, label: 'Updated within 30 days' },
    { stage: 'iterated', count: stage4Count, pct: stage4Pct, label: 'Dashboards edited (v2+)' },
  ];

  const funnel_score = Math.round((stage1Pct + stage2Pct + stage3Pct + stage4Pct) / 4);

  let adoption_tier: AdoptionTier;
  if (funnel_score >= 80) adoption_tier = 'power_user';
  else if (funnel_score >= 50) adoption_tier = 'engaged';
  else if (funnel_score >= 20) adoption_tier = 'onboarding';
  else adoption_tier = 'inactive';

  const recommendations: string[] = [];
  if (total === 0) recommendations.push('Create your first custom dashboard.');
  if (stage2Pct < 50) recommendations.push('Add more widgets to your dashboards (aim for 3+).');
  if (stage3Pct < 50) recommendations.push('Keep dashboards fresh by updating them regularly.');
  if (stage4Pct < 50) recommendations.push('Iterate on existing dashboards to match evolving needs.');

  return {
    tenant_id,
    generated_at,
    total_dashboards: total,
    funnel_stages,
    funnel_score,
    adoption_tier,
    recommendations,
  };
}
