// web/src/modules/investigation/investigationsReportAdapter.ts
//
// Export adapter for §Action-Center Investigations (InvestigationCenterPage).
// The page is a multi-panel investigation command center; its PRIMARY list is
// the "Investigation list" panel (the post-status/domain/severity-filter
// `filtered` array). This adapter maps that list + the Case Command Center KPI
// strip into the standard ReportData contract.
import type { ReportData, ExportConfig } from '@/lib/export/types';

export interface InvestigationsReportRow {
  investigation_id: string;
  title: string;
  domain: string;
  kind: string;
  status: string;
  severity: string;
  assignee_username: string | null;
  exposure_kes: number;
  due_at: string;
  opened_at: string;
}

export interface InvestigationsReportSource {
  command: {
    total_cases: number;
    open_cases: number;
    critical_cases: number;
    high_risk_cases: number;
    escalated_cases: number;
    sla_breached_cases: number;
    fraud_cases: number;
    resolution_rate: number;
  };
  investigations: InvestigationsReportRow[];
  meta: { tenant_id: string; generated_by: string; role: string };
}

export function buildInvestigationsReportData(src: InvestigationsReportSource, _config: ExportConfig): ReportData {
  const now = new Date().toISOString();
  return {
    report_type: 'case',
    module: 'investigations',
    title: 'Investigation Center Report',
    meta: {
      tenant_id: src.meta.tenant_id, generated_by: src.meta.generated_by, role: src.meta.role,
      generated_at: now, report_id: `EXP-${src.meta.tenant_id}-${Date.now()}`,
    },
    sections: {
      summary: [
        { label: 'Total cases', value: String(src.command.total_cases) },
        { label: 'Resolution rate (%)', value: String(Math.round(src.command.resolution_rate * 100)) },
      ],
      kpis: [
        { label: 'Total cases', value: String(src.command.total_cases) },
        { label: 'Open', value: String(src.command.open_cases) },
        { label: 'Critical', value: String(src.command.critical_cases) },
        { label: 'High risk', value: String(src.command.high_risk_cases) },
        { label: 'Escalated', value: String(src.command.escalated_cases) },
        { label: 'SLA breached', value: String(src.command.sla_breached_cases) },
        { label: 'Fraud cases', value: String(src.command.fraud_cases) },
        { label: 'Resolution rate (%)', value: String(Math.round(src.command.resolution_rate * 100)) },
      ],
      tables: [{
        name: 'Investigations',
        columns: ['ID', 'Title', 'Domain', 'Kind', 'Status', 'Severity', 'Assignee', 'Exposure (KES)', 'Due'],
        rows: src.investigations.map((i) => [
          i.investigation_id, i.title, i.domain, i.kind, i.status, i.severity,
          i.assignee_username ?? '—', i.exposure_kes, i.due_at,
        ]),
      }],
    },
    record_count: src.investigations.length,
  };
}
