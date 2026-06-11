// services/bff/src/investigation_resolution_by_template.ts
//
// T6 M9.22 — Investigation resolution time by checklist template.
//
// Groups CLOSED investigations by their checklist_template_id and
// surfaces average/median resolution time + fraud detection rate
// per template. Answers "which checklist template leads to faster
// resolution? which has the highest fraud confirmation rate?"

import type { CaseInvestigation } from './case_investigation';

// ─── Public types ──────────────────────────────────────────────────────

export interface ResolutionByTemplateRow {
  template_id: string;
  total_investigations: number;
  closed_count: number;
  /** Mean days from opened_at to closed_at. null when no closed investigations. */
  avg_resolution_days: number | null;
  /** Median days. null when no closed. */
  median_resolution_days: number | null;
  /**
   * (fraud_confirmed + partial_fraud) / closed_investigations_with_decision.
   * null when no closed investigations with a non-null decision.
   */
  fraud_rate: number | null;
}

export interface InvestigationResolutionByTemplate {
  tenant_id: string;
  generated_at: string;
  /** sorted avg_resolution_days asc (null last) */
  templates: ResolutionByTemplateRow[];
  fastest_template: { template_id: string; avg_resolution_days: number } | null;
  highest_fraud_rate_template: { template_id: string; fraud_rate: number } | null;
}

// ─── Pure function ─────────────────────────────────────────────────────

/**
 * buildResolutionByTemplate
 *
 * @param tenant_id     caller's tenant
 * @param investigations  all CaseInvestigation[] for the tenant
 * @param now           current Date
 */
export function buildResolutionByTemplate(
  tenant_id: string,
  investigations: readonly CaseInvestigation[],
  now: Date,
): InvestigationResolutionByTemplate {
  // Group by checklist_template_id
  const groups = new Map<string, CaseInvestigation[]>();
  for (const inv of investigations) {
    if (inv.tenant_id !== tenant_id) continue;
    const tid = inv.checklist_template_id ?? 'BUILT_IN';
    const arr = groups.get(tid) ?? [];
    arr.push(inv);
    groups.set(tid, arr);
  }

  const rows: ResolutionByTemplateRow[] = [];

  for (const [template_id, invs] of groups.entries()) {
    const total_investigations = invs.length;
    const closed = invs.filter((i) => i.status === 'closed' && i.closed_at != null);
    const closed_count = closed.length;

    // Resolution days per closed investigation
    const resolutionDays: number[] = [];
    for (const inv of closed) {
      const openedMs = Date.parse(inv.opened_at);
      const closedMs = Date.parse(inv.closed_at!);
      if (!Number.isFinite(openedMs) || !Number.isFinite(closedMs)) continue;
      const days = (closedMs - openedMs) / (1000 * 60 * 60 * 24);
      if (days >= 0) resolutionDays.push(days);
    }

    let avg_resolution_days: number | null = null;
    let median_resolution_days: number | null = null;
    if (resolutionDays.length > 0) {
      avg_resolution_days = Math.round(
        (resolutionDays.reduce((s, d) => s + d, 0) / resolutionDays.length) * 100,
      ) / 100;
      // Median
      const sorted = [...resolutionDays].sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      if (sorted.length % 2 === 0) {
        median_resolution_days = Math.round(((sorted[mid - 1] + sorted[mid]) / 2) * 100) / 100;
      } else {
        median_resolution_days = Math.round(sorted[mid] * 100) / 100;
      }
    }

    // Fraud rate: among closed with non-null decision
    const closedWithDecision = closed.filter((i) => i.decision !== null);
    let fraud_rate: number | null = null;
    if (closedWithDecision.length > 0) {
      const fraudCount = closedWithDecision.filter(
        (i) => i.decision === 'fraud_confirmed' || i.decision === 'partial_fraud',
      ).length;
      fraud_rate = Math.round((fraudCount / closedWithDecision.length) * 10000) / 10000;
    }

    rows.push({
      template_id,
      total_investigations,
      closed_count,
      avg_resolution_days,
      median_resolution_days,
      fraud_rate,
    });
  }

  // Sort: avg_resolution_days asc, nulls last, then template_id asc tie-break
  rows.sort((a, b) => {
    if (a.avg_resolution_days === null && b.avg_resolution_days === null) {
      return a.template_id < b.template_id ? -1 : 1;
    }
    if (a.avg_resolution_days === null) return 1;
    if (b.avg_resolution_days === null) return -1;
    if (a.avg_resolution_days !== b.avg_resolution_days) {
      return a.avg_resolution_days - b.avg_resolution_days;
    }
    return a.template_id < b.template_id ? -1 : 1;
  });

  // fastest template — first non-null avg_resolution_days
  const fastestRow = rows.find((r) => r.avg_resolution_days !== null);
  const fastest_template = fastestRow
    ? { template_id: fastestRow.template_id, avg_resolution_days: fastestRow.avg_resolution_days! }
    : null;

  // highest fraud rate — filter rows with fraud_rate not null, pick max
  const fraudRateRows = rows.filter((r) => r.fraud_rate !== null);
  let highest_fraud_rate_template: { template_id: string; fraud_rate: number } | null = null;
  if (fraudRateRows.length > 0) {
    // Sort by fraud_rate desc, then sample_size desc (closed_count), then template_id asc
    const sorted = [...fraudRateRows].sort((a, b) => {
      if (b.fraud_rate! !== a.fraud_rate!) return b.fraud_rate! - a.fraud_rate!;
      if (b.closed_count !== a.closed_count) return b.closed_count - a.closed_count;
      return a.template_id < b.template_id ? -1 : 1;
    });
    highest_fraud_rate_template = {
      template_id: sorted[0].template_id,
      fraud_rate: sorted[0].fraud_rate!,
    };
  }

  return {
    tenant_id,
    generated_at: now.toISOString(),
    templates: rows,
    fastest_template,
    highest_fraud_rate_template,
  };
}
