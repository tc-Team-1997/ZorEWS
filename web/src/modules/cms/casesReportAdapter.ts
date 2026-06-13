// web/src/modules/cms/casesReportAdapter.ts
//
// Export adapter for §Action-Center Cases (CmsCaseListPage).
// Maps the CMS case list (the same `items` array the table renders, post
// status/priority/assignee filter + role-queue + ageBucket narrowing) + the
// CMS stat-card strip into the standard ReportData contract.
import type { ReportData, ExportConfig } from '@/lib/export/types';

export interface CasesReportRow {
  case_id: string;
  case_number: string;
  title: string;
  status: string;
  priority: string;
  assigned_to: string | null;
  sla_due_at: string;
  updated_at: string;
}

export interface CasesReportSource {
  stats: {
    total: number;
    sla_breached_count: number;
    sla_warning_count: number;
    open_investigating_count: number;
  };
  cases: CasesReportRow[];
  meta: { tenant_id: string; generated_by: string; role: string };
}

export function buildCasesReportData(src: CasesReportSource, _config: ExportConfig): ReportData {
  const now = new Date().toISOString();
  return {
    report_type: 'case',
    module: 'cases',
    title: 'Case Management Report',
    meta: {
      tenant_id: src.meta.tenant_id, generated_by: src.meta.generated_by, role: src.meta.role,
      generated_at: now, report_id: `EXP-${src.meta.tenant_id}-${Date.now()}`,
    },
    sections: {
      summary: [
        { label: 'Total cases', value: String(src.stats.total) },
        { label: 'SLA breached', value: String(src.stats.sla_breached_count) },
      ],
      kpis: [
        { label: 'Total cases', value: String(src.stats.total) },
        { label: 'SLA breached', value: String(src.stats.sla_breached_count) },
        { label: 'SLA warning', value: String(src.stats.sla_warning_count) },
        { label: 'Open + Investigating', value: String(src.stats.open_investigating_count) },
      ],
      tables: [{
        name: 'Cases',
        columns: ['Case #', 'Title', 'Status', 'Priority', 'Assigned', 'SLA Due', 'Updated'],
        rows: src.cases.map((c) => [
          c.case_number, c.title, c.status, c.priority, c.assigned_to ?? '—', c.sla_due_at, c.updated_at,
        ]),
      }],
    },
    record_count: src.cases.length,
  };
}
