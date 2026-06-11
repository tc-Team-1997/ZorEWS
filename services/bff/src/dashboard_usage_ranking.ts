/**
 * M11.23 — Dashboard usage score ranking
 * Ranks custom dashboards by a usage score based on widget count, freshness, version.
 */

import { defaultCustomDashboardStore } from './custom_dashboards';

export type UsageTier = 'active' | 'moderate' | 'inactive';

export interface DashboardUsageRanking {
  rank: number;
  dashboard_id: string;
  name: string;
  usage_score: number;
  usage_tier: UsageTier;
  last_updated_days_ago: number;
  widget_count: number;
  version: number;
}

export interface DashboardUsageRankingReport {
  tenant_id: string;
  generated_at: string;
  total_dashboards: number;
  rankings: DashboardUsageRanking[];
  active_count: number;
  inactive_count: number;
}

function tierFor(score: number): UsageTier {
  if (score >= 30) return 'active';
  if (score >= 15) return 'moderate';
  return 'inactive';
}

export function buildDashboardUsageRanking(
  tenant_id: string,
  now: Date = new Date(),
): DashboardUsageRankingReport {
  if (!tenant_id) throw new Error('tenant_id required');

  const dashboards = defaultCustomDashboardStore.list(tenant_id);

  const scored = dashboards.map((d) => {
    const last_updated_days_ago = Math.floor(
      (now.getTime() - new Date(d.updated_at).getTime()) / 86_400_000,
    );
    const freshness_bonus =
      last_updated_days_ago < 30 ? 20 : last_updated_days_ago < 90 ? 10 : 0;
    const version_bonus = d.version > 1 ? 15 : 0;
    const usage_score = d.widgets.length * 5 + freshness_bonus + version_bonus;

    return {
      dashboard_id: d.dashboard_id,
      name: d.name,
      usage_score,
      last_updated_days_ago,
      widget_count: d.widgets.length,
      version: d.version,
    };
  });

  // Sort by usage_score desc
  scored.sort((a, b) => b.usage_score - a.usage_score);

  const rankings: DashboardUsageRanking[] = scored.map((s, i) => ({
    rank: i + 1,
    ...s,
    usage_tier: tierFor(s.usage_score),
  }));

  const active_count = rankings.filter((r) => r.usage_tier === 'active').length;
  const inactive_count = rankings.filter((r) => r.usage_tier === 'inactive').length;

  return {
    tenant_id,
    generated_at: now.toISOString(),
    total_dashboards: dashboards.length,
    rankings,
    active_count,
    inactive_count,
  };
}
