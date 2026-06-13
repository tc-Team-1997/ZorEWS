// web/src/modules/customers/customerReportAdapter.ts
import type { ReportData, ExportConfig } from '@/lib/export/types';

export interface CustomerReportSource {
  customer: { id: string; name: string; risk_score: number; npa_status: string };
  alerts: { alert_id: string; severity: string; rule_name: string }[];
  cases: { case_id: string; state: string }[];
  meta: { tenant_id: string; generated_by: string; role: string };
}

export function buildCustomerReportData(src: CustomerReportSource, config: ExportConfig): ReportData {
  const now = new Date().toISOString();
  return {
    report_type: 'customer',
    module: 'customer_360',
    title: `Customer Report — ${src.customer.name} (${src.customer.id})`,
    subject: { id: src.customer.id, name: src.customer.name },
    meta: {
      tenant_id: src.meta.tenant_id, generated_by: src.meta.generated_by, role: src.meta.role,
      generated_at: now, report_id: `EXP-${src.meta.tenant_id}-${Date.now()}`,
    },
    sections: {
      summary: [
        { label: 'Customer ID', value: src.customer.id },
        { label: 'Risk Score', value: src.customer.risk_score.toFixed(2) },
        { label: 'NPA Status', value: src.customer.npa_status },
      ],
      kpis: [
        { label: 'Open Alerts', value: String(src.alerts.length) },
        { label: 'Open Cases', value: String(src.cases.length) },
      ],
      alerts: config.include.alerts ? src.alerts : undefined,
      tables: [{
        name: 'Case History', columns: ['Case', 'State'],
        rows: src.cases.map((c) => [c.case_id, c.state]),
      }],
      recommendations: config.include.recommendations
        ? ['Review highest-severity alert', 'Confirm NPA classification with credit team']
        : undefined,
    },
    record_count: src.cases.length,
  };
}
