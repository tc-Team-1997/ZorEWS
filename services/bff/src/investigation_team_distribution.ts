// services/bff/src/investigation_team_distribution.ts
// T6 M9.28 — Investigation team workload distribution.

import { defaultCaseInvestigationStore, type CaseInvestigationStore } from './case_investigation';

export type DistributionTier = 'balanced' | 'moderate' | 'unequal';

export interface InvestigatorWorkload {
  investigator: string;
  count: number;
  pct_of_total: number;
}

export interface InvestigationTeamDistribution {
  tenant_id: string;
  generated_at: string;
  total_investigators: number;
  total_investigations: number;
  avg_per_investigator: number;
  workload_balance_score: number;
  gini_coefficient: number;
  distribution_tier: DistributionTier;
  by_investigator: InvestigatorWorkload[];
}

function computeGini(values: number[]): number {
  if (values.length === 0) return 0;
  const n = values.length;
  const mean = values.reduce((s, v) => s + v, 0) / n;
  if (mean === 0) return 0;
  let sumDiffs = 0;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      sumDiffs += Math.abs(values[i] - values[j]);
    }
  }
  return Math.round((sumDiffs / (2 * n * n * mean)) * 10000) / 10000;
}

function stdDev(values: number[]): number {
  if (values.length === 0) return 0;
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

export function buildInvestigationTeamDistribution(
  tenant_id: string,
  store: CaseInvestigationStore,
  now: Date,
): InvestigationTeamDistribution {
  const page = store.list(tenant_id, { page_size: 100000 });
  const all = page.items;
  const countByInvestigator = new Map<string, number>();
  for (const inv of all) {
    if (!inv.opened_by) continue;
    countByInvestigator.set(inv.opened_by, (countByInvestigator.get(inv.opened_by) ?? 0) + 1);
  }

  const total_investigators = countByInvestigator.size;
  const total_investigations = all.length;
  const avg_per_investigator = total_investigators > 0
    ? Math.round((total_investigations / total_investigators) * 100) / 100
    : 0;

  const counts = Array.from(countByInvestigator.values());
  const sd = stdDev(counts);
  const workload_balance_score = Math.min(100, Math.round(Math.max(0, 100 - sd * 10) * 100) / 100);
  const gini_coefficient = computeGini(counts);

  let distribution_tier: DistributionTier;
  if (gini_coefficient < 0.3) distribution_tier = 'balanced';
  else if (gini_coefficient <= 0.6) distribution_tier = 'moderate';
  else distribution_tier = 'unequal';

  const by_investigator: InvestigatorWorkload[] = Array.from(countByInvestigator.entries())
    .map(([investigator, count]) => ({
      investigator,
      count,
      pct_of_total: total_investigations > 0 ? Math.round((count / total_investigations) * 10000) / 10000 : 0,
    }))
    .sort((a, b) => b.count - a.count);

  return { tenant_id, generated_at: now.toISOString(), total_investigators, total_investigations, avg_per_investigator, workload_balance_score, gini_coefficient, distribution_tier, by_investigator };
}

export { defaultCaseInvestigationStore };
