import { describe, test, expect } from 'vitest';
import { buildAccountBehaviourReportData } from '@/modules/customers/accountBehaviourReportAdapter';
import { DEFAULT_INCLUDE, type ExportConfig } from '@/lib/export/types';

const config: ExportConfig = { formats: ['csv'], report_type: 'risk', date_range: '30d', data_scope: 'filtered', include: DEFAULT_INCLUDE };

describe('buildAccountBehaviourReportData', () => {
  test('maps filtered account signals into ReportData (risk report)', () => {
    const data = buildAccountBehaviourReportData({
      signals: [
        { signal_id: 's-1', account_id: 'ac-1', customer_id: 'c-1', customer_name: 'Acme', signal_type: 'salary_credit_stopped', severity: 'critical', score: 0.92, observed_at: '2026-06-10T00:00:00Z', description: 'Salary stopped', is_watchlisted: true, status: 'new' },
        { signal_id: 's-2', account_id: 'ac-2', customer_id: 'c-2', customer_name: 'Beta', signal_type: 'od_frequency', severity: 'medium', score: 0.45, observed_at: '2026-06-09T00:00:00Z', description: 'OD usage up', is_watchlisted: false, status: 'reviewed' },
      ],
      kpis: { total: 2, critical: 1, high: 0, watchlisted: 1, newCount: 1 },
      meta: { tenant_id: 'BANK_DEMO', generated_by: 'alice.admin', role: 'admin' },
    }, config);
    expect(data.report_type).toBe('risk');
    expect(data.module).toBe('account_behaviour');
    expect(data.subject).toBeUndefined();
    expect(data.meta.report_id).toMatch(/^EXP-/);
    expect(data.sections.tables?.[0].rows).toHaveLength(2);
    expect(data.sections.kpis?.find((k) => k.label === 'Critical')?.value).toBe('1');
    expect(data.record_count).toBe(2);
  });
});
