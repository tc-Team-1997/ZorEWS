// services/bff/src/investigation_closure_by_decision.ts
// T6 M9.27 — Investigation closure time by decision.
// Groups closed investigations by decision and computes avg time-to-close.

import { type CaseInvestigationStore, type InvestigationDecision } from './case_investigation';

export interface ClosureByDecisionEntry {
  decision: string;
  count: number;
  avg_days_to_close: number;
  min_days: number;
  max_days: number;
}

export interface InvestigationClosureByDecisionResult {
  tenant_id: string;
  generated_at: string;
  total_closed_with_decision: number;
  by_decision: ClosureByDecisionEntry[];
  fastest_decision_type: string | null;
  slowest_decision_type: string | null;
  overall_avg_days: number;
}

export function buildInvestigationClosureByDecision(
  store: CaseInvestigationStore,
  tenant_id: string,
  now: Date,
): InvestigationClosureByDecisionResult {
  if (!tenant_id) throw new Error('tenant_id required');

  const page = store.list(tenant_id, {});
  const investigations = page.items;

  // Filter to closed with a non-null decision
  const closed = investigations.filter(
    (inv) => inv.status === 'closed' && inv.decision != null && inv.opened_at != null && inv.closed_at != null,
  );

  const groups = new Map<string, number[]>();

  for (const inv of closed) {
    const decision = inv.decision as string;
    const openedMs = new Date(inv.opened_at as string).getTime();
    const closedMs = new Date(inv.closed_at as string).getTime();
    const days = Math.max(0, (closedMs - openedMs) / 86_400_000);

    if (!groups.has(decision)) groups.set(decision, []);
    groups.get(decision)!.push(days);
  }

  const by_decision: ClosureByDecisionEntry[] = [];
  for (const [decision, daysList] of groups) {
    const avg_days_to_close = Math.round((daysList.reduce((s, d) => s + d, 0) / daysList.length) * 100) / 100;
    const min_days = Math.round(Math.min(...daysList) * 100) / 100;
    const max_days = Math.round(Math.max(...daysList) * 100) / 100;
    by_decision.push({ decision, count: daysList.length, avg_days_to_close, min_days, max_days });
  }

  // Sort by avg_days_to_close desc
  by_decision.sort((a, b) => b.avg_days_to_close - a.avg_days_to_close || a.decision.localeCompare(b.decision));

  const fastest = by_decision.length > 0 ? by_decision[by_decision.length - 1].decision : null;
  const slowest = by_decision.length > 0 ? by_decision[0].decision : null;

  const total = closed.length;
  const overall_avg_days =
    total > 0
      ? Math.round(
          (closed.reduce((s, inv) => {
            const openedMs = new Date(inv.opened_at as string).getTime();
            const closedMs = new Date(inv.closed_at as string).getTime();
            return s + Math.max(0, (closedMs - openedMs) / 86_400_000);
          }, 0) / total) * 100,
        ) / 100
      : 0;

  return {
    tenant_id,
    generated_at: now.toISOString(),
    total_closed_with_decision: total,
    by_decision,
    fastest_decision_type: fastest,
    slowest_decision_type: slowest,
    overall_avg_days,
  };
}
