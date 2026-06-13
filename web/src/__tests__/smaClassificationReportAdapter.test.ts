import { describe, test, expect } from 'vitest';
import { buildSmaClassificationReportData } from '@/modules/banking/smaClassificationReportAdapter';
import { DEFAULT_INCLUDE, type ExportConfig } from '@/lib/export/types';

const config: ExportConfig = { formats: ['pdf'], report_type: 'risk', date_range: '30d', data_scope: 'complete', include: DEFAULT_INCLUDE };

describe('buildSmaClassificationReportData', () => {
  test('maps SMA movements into ReportData (risk report)', () => {
    const data = buildSmaClassificationReportData({
      framework: 'RBI',
      date: '2026-06-13',
      summary: { total_movements: 2, deteriorations: 1, improvements: 1, total_exposure_at_risk_kes: 12_500_000 },
      movements: [
        { customer_id: 'c-1', customer_name: 'Acme Mfg', loan_id: 'l-1', from_category: 'CURRENT', to_category: 'SMA-1', dpd: 45, outstanding_kes: 5_000_000, sector: 'manufacturing' },
        { customer_id: 'c-2', customer_name: 'Beta Retail', loan_id: 'l-2', from_category: 'SMA-2', to_category: 'SMA-1', dpd: 40, outstanding_kes: 7_500_000, sector: 'retail' },
      ],
      meta: { tenant_id: 'BANK_DEMO', generated_by: 'alice.admin', role: 'admin' },
    }, config);
    expect(data.report_type).toBe('risk');
    expect(data.module).toBe('sma_classification');
    expect(data.subject).toBeUndefined();
    expect(data.meta.report_id).toMatch(/^EXP-/);
    expect(data.sections.tables?.[0].rows).toHaveLength(2);
    expect(data.sections.kpis?.find((k) => k.label === 'Deteriorations')?.value).toBe('1');
    expect(data.record_count).toBe(2);
  });
});
