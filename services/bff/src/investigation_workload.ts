/**
 * M9.25 — Investigation workload balance
 * Computes per-investigator workload from the investigation store.
 */

import { defaultCaseInvestigationStore } from './case_investigation';

export interface InvestigatorWorkload {
  investigator: string;
  total_investigations: number;
  open_count: number;
  closed_count: number;
  avg_age_hours: number;
  workload_score: number;
}

export interface InvestigationWorkloadReport {
  tenant_id: string;
  generated_at: string;
  total_investigators: number;
  investigators: InvestigatorWorkload[];
  most_loaded: string | null;
  least_loaded: string | null;
  balanced: boolean;
}

export function buildInvestigationWorkload(
  tenant_id: string,
  now: Date = new Date(),
): InvestigationWorkloadReport {
  if (!tenant_id) throw new Error('tenant_id required');

  const page = defaultCaseInvestigationStore.list(tenant_id, {});
  const investigations = page.items;

  const byInvestigator = new Map<
    string,
    { total: number; open: number; closed: number; ages: number[] }
  >();

  for (const inv of investigations) {
    const actor = inv.opened_by || 'unknown';
    if (!byInvestigator.has(actor)) {
      byInvestigator.set(actor, { total: 0, open: 0, closed: 0, ages: [] });
    }
    const entry = byInvestigator.get(actor)!;
    entry.total++;

    const opened = new Date(inv.opened_at).getTime();
    const end = inv.closed_at ? new Date(inv.closed_at).getTime() : now.getTime();
    const age_hours = (end - opened) / 3_600_000;
    entry.ages.push(age_hours);

    if (inv.status === 'closed') {
      entry.closed++;
    } else {
      entry.open++;
    }
  }

  const workloads: InvestigatorWorkload[] = [];

  for (const [investigator, data] of byInvestigator) {
    const avg_age_hours =
      data.ages.length > 0 ? data.ages.reduce((s, v) => s + v, 0) / data.ages.length : 0;
    const workload_score = data.open * 10 + avg_age_hours * 0.1;

    workloads.push({
      investigator,
      total_investigations: data.total,
      open_count: data.open,
      closed_count: data.closed,
      avg_age_hours,
      workload_score,
    });
  }

  // Sort by workload_score desc
  workloads.sort((a, b) => b.workload_score - a.workload_score);

  const most_loaded = workloads.length > 0 ? workloads[0].investigator : null;
  const least_loaded = workloads.length > 0 ? workloads[workloads.length - 1].investigator : null;

  const max_score = workloads.length > 0 ? workloads[0].workload_score : 0;
  const min_score = workloads.length > 0 ? workloads[workloads.length - 1].workload_score : 0;
  const balanced = max_score - min_score < 20;

  return {
    tenant_id,
    generated_at: now.toISOString(),
    total_investigators: workloads.length,
    investigators: workloads,
    most_loaded,
    least_loaded,
    balanced,
  };
}
