import { describe, test, expect } from 'vitest';
import { buildFraudSignalsReportData } from '@/modules/banking/fraudSignalsReportAdapter';
import { DEFAULT_INCLUDE, type ExportConfig } from '@/lib/export/types';

const config: ExportConfig = { formats: ['pdf'], report_type: 'risk', date_range: '30d', data_scope: 'complete', include: DEFAULT_INCLUDE };

describe('buildFraudSignalsReportData', () => {
  test('maps the active fraud-case list into ReportData (risk report)', () => {
    const data = buildFraudSignalsReportData({
      summary: { total: 2, open: 1, investigating: 0, reported: 1, exposure: 4_500_000 },
      cases: [
        { case_id: 'fc-1', customer_id: 'c-1', account_id: 'a-1', category: 'cheque_fraud', priority: 'critical', status: 'open', amount_kes: 3_000_000, assignee: 'op.one', sar_id: null, vigilance_ref: null },
        { case_id: 'fc-2', customer_id: 'c-2', account_id: null, category: 'card_fraud', priority: 'high', status: 'reported', amount_kes: 1_500_000, assignee: null, sar_id: 'SAR-9', vigilance_ref: null },
      ],
      meta: { tenant_id: 'BANK_DEMO', generated_by: 'alice.admin', role: 'admin' },
    }, config);
    expect(data.report_type).toBe('risk');
    expect(data.module).toBe('fraud_signals');
    expect(data.subject).toBeUndefined();
    expect(data.meta.report_id).toMatch(/^EXP-/);
    expect(data.sections.tables?.[0].rows).toHaveLength(2);
    expect(data.sections.kpis?.find((k) => k.label === 'SAR filed')?.value).toBe('1');
    expect(data.record_count).toBe(2);
  });
});
