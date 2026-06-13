import { describe, test, expect } from 'vitest';
import { buildCustomerReportData } from '@/modules/customers/customerReportAdapter';
import { DEFAULT_INCLUDE, type ExportConfig } from '@/lib/export/types';

const config: ExportConfig = { formats: ['pdf'], report_type: 'customer', date_range: '30d', data_scope: 'complete', include: DEFAULT_INCLUDE };

describe('buildCustomerReportData', () => {
  test('maps a customer profile into ReportData', () => {
    const data = buildCustomerReportData({
      customer: { id: 'c-101', name: 'Acme Ltd', risk_score: 0.82, npa_status: 'SUBSTANDARD' },
      alerts: [{ alert_id: 'a-1', severity: 'high', rule_name: 'DPD 30+' }],
      cases: [{ case_id: 'case-1', state: 'open' }],
      meta: { tenant_id: 'BANK_DEMO', generated_by: 'alice.admin', role: 'admin' },
    }, config);
    expect(data.report_type).toBe('customer');
    expect(data.subject).toEqual({ id: 'c-101', name: 'Acme Ltd' });
    expect(data.meta.report_id).toMatch(/^EXP-/);
    expect(data.sections.summary?.some((s) => s.label === 'Risk Score')).toBe(true);
    expect(data.sections.tables?.[0].rows).toHaveLength(1); // 1 case
    expect(data.record_count).toBe(1);
  });
});
