// web/src/modules/dashboard/dashboardReportAdapter.ts
//
// Export adapter for the executive EWS Dashboard. The dashboard is a composed
// multi-panel shell; the report exports its headline KPI cards + the
// alerts-by-severity breakdown (the page's primary tabular data) into the
// standard ReportData contract.
import type { ReportData, ExportConfig } from '@/lib/export/types';

export interface DashboardReportSource {
  summary: {
    customers_monitored: number;
    high_risk_customers: number;
    active_alerts: number;
    cases_open: number;
    alerts_by_severity: { severity: string; count: number }[];
  };
  meta: { tenant_id: string; generated_by: string; role: string };
}

export function buildDashboardReportData(src: DashboardReportSource, _config: ExportConfig): ReportData {
  const now = new Date().toISOString();
  const s = src.summary;
  return {
    report_type: 'executive',
    module: 'executive_dashboard',
    title: 'Executive EWS Dashboard Report',
    meta: {
      tenant_id: src.meta.tenant_id, generated_by: src.meta.generated_by, role: src.meta.role,
      generated_at: now, report_id: `EXP-${src.meta.tenant_id}-${Date.now()}`,
    },
    sections: {
      summary: [
        { label: 'Customers monitored', value: String(s.customers_monitored) },
        { label: 'High-risk accounts', value: String(s.high_risk_customers) },
        { label: 'Active alerts', value: String(s.active_alerts) },
        { label: 'Open cases', value: String(s.cases_open) },
      ],
      kpis: [
        { label: 'Customers monitored', value: String(s.customers_monitored) },
        { label: 'High-risk accounts', value: String(s.high_risk_customers) },
        { label: 'Active alerts', value: String(s.active_alerts) },
        { label: 'Open cases', value: String(s.cases_open) },
      ],
      tables: [{
        name: 'Alerts by Severity',
        columns: ['Severity', 'Count'],
        rows: s.alerts_by_severity.map((r) => [r.severity, r.count]),
      }],
    },
    record_count: s.alerts_by_severity.length,
  };
}
