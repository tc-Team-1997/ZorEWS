import { describe, test, expect } from 'vitest';
import { buildAlertsReportData } from '@/modules/alerts/alertsReportAdapter';
import { DEFAULT_INCLUDE, type ExportConfig } from '@/lib/export/types';

const config: ExportConfig = { formats: ['csv'], report_type: 'risk', date_range: '30d', data_scope: 'filtered', include: DEFAULT_INCLUDE };

describe('buildAlertsReportData', () => {
  test('maps a filtered alert list into ReportData (risk report)', () => {
    const data = buildAlertsReportData({
      alerts: [
        { id: 'a-1', customer: { id: 'c-1', name: 'X' }, severity: 'critical', rule: { name: 'R1' }, age_min: 10 },
        { id: 'a-2', customer: { id: 'c-2', name: 'Y' }, severity: 'high', rule: { name: 'R2' }, age_min: 50 },
      ],
      meta: { tenant_id: 'BANK_DEMO', generated_by: 'alice.admin', role: 'admin' },
    }, config);
    expect(data.report_type).toBe('risk');
    expect(data.subject).toBeUndefined();
    expect(data.sections.tables?.[0].rows).toHaveLength(2);
    expect(data.sections.kpis?.find((k) => k.label === 'Critical')?.value).toBe('1');
    expect(data.record_count).toBe(2);
  });
});
