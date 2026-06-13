// web/src/modules/regulatory/regulatoryReportAdapter.ts
//
// Export adapter for the Regulatory Compliance Center.
// Maps the compliance command-center KPIs + the obligation registry rows
// (the same post-filter array the registry table renders) into the standard
// ReportData contract.
import type { ReportData, ExportConfig } from '@/lib/export/types';

export interface RegulatoryReportObligation {
  obligation_id: string;
  regulation: string;
  framework: string;
  category: string;
  owner: string;
  priority: string;
  status: string;
  next_due_date: string;
}

export interface RegulatoryReportSource {
  // Command-center scalars are stringified into KPI values, so each accepts
  // number OR string (e.g. audit_readiness is a 'ready'|'needs_attention'
  // enum on the page, while the counts are numbers).
  command: {
    compliance_health_score: number | string;
    total_obligations: number | string;
    open_findings: number | string;
    regulatory_breaches: number | string;
    sla_violations: number | string;
    high_risk_obligations: number | string;
    pending_actions: number | string;
    audit_readiness: number | string;
  };
  obligations: RegulatoryReportObligation[];
  meta: { tenant_id: string; generated_by: string; role: string };
}

export function buildRegulatoryReportData(src: RegulatoryReportSource, _config: ExportConfig): ReportData {
  const now = new Date().toISOString();
  return {
    report_type: 'compliance',
    module: 'regulatory_center',
    title: 'Regulatory Compliance Report',
    meta: {
      tenant_id: src.meta.tenant_id, generated_by: src.meta.generated_by, role: src.meta.role,
      generated_at: now, report_id: `EXP-${src.meta.tenant_id}-${Date.now()}`,
    },
    sections: {
      summary: [
        { label: 'Compliance health score', value: String(src.command.compliance_health_score) },
        { label: 'Audit readiness', value: String(src.command.audit_readiness) },
      ],
      kpis: [
        { label: 'Total obligations', value: String(src.command.total_obligations) },
        { label: 'Open findings', value: String(src.command.open_findings) },
        { label: 'Regulatory breaches', value: String(src.command.regulatory_breaches) },
        { label: 'SLA violations', value: String(src.command.sla_violations) },
        { label: 'High-risk obligations', value: String(src.command.high_risk_obligations) },
        { label: 'Pending actions', value: String(src.command.pending_actions) },
      ],
      tables: [{
        name: 'Obligation Registry',
        columns: ['Obligation ID', 'Regulation', 'Framework', 'Category', 'Owner', 'Priority', 'Status', 'Next Due'],
        rows: src.obligations.map((o) => [
          o.obligation_id, o.regulation, o.framework, o.category, o.owner, o.priority, o.status, o.next_due_date,
        ]),
      }],
    },
    record_count: src.obligations.length,
  };
}
