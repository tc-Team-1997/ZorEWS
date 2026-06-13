import { describe, test, expect } from 'vitest';
import { buildDashboardReportData } from '@/modules/dashboard/dashboardReportAdapter';
import { DEFAULT_INCLUDE, type ExportConfig } from '@/lib/export/types';

const config: ExportConfig = { formats: ['pdf'], report_type: 'executive', date_range: '30d', data_scope: 'complete', include: DEFAULT_INCLUDE };

describe('buildDashboardReportData', () => {
  test('maps dashboard KPIs + alerts-by-severity into ReportData', () => {
    const data = buildDashboardReportData({
      summary: {
        customers_monitored: 10000, high_risk_customers: 412, active_alerts: 87, cases_open: 33,
        alerts_by_severity: [{ severity: 'critical', count: 12 }, { severity: 'high', count: 30 }, { severity: 'medium', count: 45 }],
      },
      meta: { tenant_id: 'BANK_DEMO', generated_by: 'a', role: 'admin' },
    }, config);
    expect(data.report_type).toBe('executive');
    expect(data.module).toBe('executive_dashboard');
    expect(data.meta.report_id).toMatch(/^EXP-/);
    expect(data.sections.kpis?.find((k) => k.label === 'Active alerts')?.value).toBe('87');
    expect(data.sections.tables?.[0].rows).toHaveLength(3);
    expect(data.record_count).toBe(3);
  });
});
