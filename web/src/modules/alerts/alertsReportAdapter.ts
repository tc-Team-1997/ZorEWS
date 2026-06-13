// web/src/modules/alerts/alertsReportAdapter.ts
import type { ReportData, ExportConfig } from '@/lib/export/types';

export interface AlertRow {
  id: string;
  customer: { id: string; name: string };
  severity: string;
  rule: { name: string };
  age_min: number;
}
export interface AlertsReportSource {
  alerts: AlertRow[];
  meta: { tenant_id: string; generated_by: string; role: string };
}

export function buildAlertsReportData(src: AlertsReportSource, _config: ExportConfig): ReportData {
  const now = new Date().toISOString();
  const bySeverity = (sev: string) => src.alerts.filter((a) => a.severity === sev).length;
  return {
    report_type: 'risk',
    module: 'alerts',
    title: 'Alert Activity Report',
    meta: {
      tenant_id: src.meta.tenant_id, generated_by: src.meta.generated_by, role: src.meta.role,
      generated_at: now, report_id: `EXP-${src.meta.tenant_id}-${Date.now()}`,
    },
    sections: {
      summary: [{ label: 'Total Alerts', value: String(src.alerts.length) }],
      kpis: [
        { label: 'Critical', value: String(bySeverity('critical')) },
        { label: 'High', value: String(bySeverity('high')) },
        { label: 'Medium', value: String(bySeverity('medium')) },
      ],
      tables: [{
        name: 'Alerts', columns: ['Alert', 'Customer', 'Severity', 'Rule', 'Age (min)'],
        rows: src.alerts.map((a) => [a.id, a.customer.name, a.severity, a.rule.name, a.age_min]),
      }],
    },
    record_count: src.alerts.length,
  };
}
