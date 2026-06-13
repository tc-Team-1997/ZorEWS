import { describe, test, expect } from 'vitest';
import { buildBorrowerTimelineReportData } from '@/modules/banking/borrowerTimelineReportAdapter';
import { DEFAULT_INCLUDE, type ExportConfig } from '@/lib/export/types';

const config: ExportConfig = { formats: ['pdf'], report_type: 'customer', date_range: '30d', data_scope: 'complete', include: DEFAULT_INCLUDE };

describe('buildBorrowerTimelineReportData', () => {
  test('maps a single borrower risk journey into ReportData (customer report w/ subject)', () => {
    const data = buildBorrowerTimelineReportData({
      customer_id: 'c-200000',
      customer_name: 'Acme Mfg',
      summary: { current_risk_band: 'high', trajectory: 'deteriorating', peak_dpd: 95, total_events: 2, critical_events: 1 },
      events: [
        { event_id: 'e-1', occurred_at: '2026-06-01T00:00:00Z', event_type: 'dpd_change', severity: 'critical', title: 'DPD breached 90', description: 'Account crossed into NPA territory', linked_ref: 'l-1' },
        { event_id: 'e-2', occurred_at: '2026-05-01T00:00:00Z', event_type: 'repayment', severity: 'info', title: 'EMI received', description: 'On-time repayment', linked_ref: null },
      ],
      meta: { tenant_id: 'BANK_DEMO', generated_by: 'alice.admin', role: 'admin' },
    }, config);
    expect(data.report_type).toBe('customer');
    expect(data.module).toBe('borrower_timeline');
    expect(data.subject).toEqual({ id: 'c-200000', name: 'Acme Mfg' });
    expect(data.meta.report_id).toMatch(/^EXP-/);
    expect(data.sections.tables?.[0].rows).toHaveLength(2);
    expect(data.sections.kpis?.find((k) => k.label === 'Critical events')?.value).toBe('1');
    expect(data.record_count).toBe(2);
  });
});
