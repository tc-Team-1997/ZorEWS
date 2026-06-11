// services/bff/src/investigation_sla_compliance.ts
//
// T6 M9.26 — Investigation SLA compliance tracker.
//
// For each open (non-closed) investigation, check against SLA tiers:
//   - triage: <= 4h
//   - gathering_evidence: <= 24h
//   - awaiting_response: <= 72h
//   - review: <= 48h
//   - decision: <= 24h
//   - default: <= 72h
//
// sla_met = age_hours <= sla_hours
// sla_remaining_hours = sla_hours - age_hours (negative = breached)
//
// Route: GET /v1/investigations/sla-compliance
//   RBAC: audit:read (admin)

import {
  defaultCaseInvestigationStore,
  type CaseInvestigationStore,
  type InvestigationStatus,
} from './case_investigation';

// ─── SLA configuration ────────────────────────────────────────────────

export const SLA_BY_STATUS: Record<InvestigationStatus, number> = {
  triage: 4,
  gathering_evidence: 24,
  awaiting_response: 72,
  review: 48,
  decision: 24,
  closed: 0, // closed → not evaluated
};

const DEFAULT_SLA_HOURS = 72;

// ─── Public types ─────────────────────────────────────────────────────

export interface InvestigationSlaRow {
  investigation_id: string;
  case_id: string;
  status: string;
  opened_at: string;
  age_hours: number;
  sla_hours: number;
  sla_met: boolean;
  sla_remaining_hours: number;
}

export interface InvestigationSlaComplianceReport {
  tenant_id: string;
  generated_at: string;
  total_open: number;
  compliant_count: number;
  breached_count: number;
  overall_compliance_rate: number;
  investigations: InvestigationSlaRow[];
}

// ─── Pure resolver ────────────────────────────────────────────────────

export function buildInvestigationSlaCompliance(
  store: CaseInvestigationStore,
  tenant_id: string,
  now: Date,
): InvestigationSlaComplianceReport {
  if (!tenant_id) throw new Error('tenant_id is required');

  const page = store.list(tenant_id, { page_size: 10000 });
  const open = page.items.filter((inv) => inv.status !== 'closed');

  const nowMs = now.getTime();
  const rows: InvestigationSlaRow[] = [];

  for (const inv of open) {
    const age_ms = nowMs - new Date(inv.opened_at).getTime();
    const age_hours = Math.round((age_ms / 3600000) * 100) / 100;
    const sla_hours =
      inv.status in SLA_BY_STATUS
        ? (SLA_BY_STATUS as Record<string, number>)[inv.status]
        : DEFAULT_SLA_HOURS;
    const sla_met = age_hours <= sla_hours;
    const sla_remaining_hours = Math.round((sla_hours - age_hours) * 100) / 100;

    rows.push({
      investigation_id: inv.investigation_id,
      case_id: inv.case_id,
      status: inv.status,
      opened_at: inv.opened_at,
      age_hours,
      sla_hours,
      sla_met,
      sla_remaining_hours,
    });
  }

  // Sort: breached first (most-negative remaining hours first)
  rows.sort((a, b) => a.sla_remaining_hours - b.sla_remaining_hours);

  const compliant_count = rows.filter((r) => r.sla_met).length;
  const breached_count = rows.filter((r) => !r.sla_met).length;
  const total_open = rows.length;
  const overall_compliance_rate =
    total_open === 0
      ? 1
      : Math.round((compliant_count / total_open) * 10000) / 10000;

  return {
    tenant_id,
    generated_at: now.toISOString(),
    total_open,
    compliant_count,
    breached_count,
    overall_compliance_rate,
    investigations: rows,
  };
}
