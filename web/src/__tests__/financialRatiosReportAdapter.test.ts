import { describe, test, expect } from 'vitest';
import { buildFinancialRatiosReportData } from '@/modules/customers/financialRatiosReportAdapter';
import { DEFAULT_INCLUDE, type ExportConfig } from '@/lib/export/types';

const config: ExportConfig = { formats: ['csv'], report_type: 'risk', date_range: '30d', data_scope: 'filtered', include: DEFAULT_INCLUDE };

describe('buildFinancialRatiosReportData', () => {
  test('maps the loaded ratio cohort into ReportData (risk report)', () => {
    const data = buildFinancialRatiosReportData({
      ratioCodes: ['DSCR', 'CR', 'DER'],
      rows: [
        { customer_id: 'c-101', customer_name: 'Acme Mfg', sector: 'manufacturing', worst_band: 'red', values: { DSCR: 0.8, CR: 1.1, DER: 3.2 } },
        { customer_id: 'c-106', customer_name: 'Beta Retail', sector: 'retail', worst_band: 'amber', values: { DSCR: 1.5, CR: 1.8, DER: 1.4 } },
      ],
      kpis: { total: 2, red: 1, amber: 1, green: 0 },
      meta: { tenant_id: 'BANK_DEMO', generated_by: 'alice.admin', role: 'admin' },
    }, config);
    expect(data.report_type).toBe('risk');
    expect(data.module).toBe('financial_ratios');
    expect(data.subject).toBeUndefined();
    expect(data.meta.report_id).toMatch(/^EXP-/);
    expect(data.sections.tables?.[0].rows).toHaveLength(2);
    // columns: Borrower, Customer ID, Sector, Worst Band, + one per ratio code
    expect(data.sections.tables?.[0].columns).toHaveLength(4 + 3);
    expect(data.sections.kpis?.find((k) => k.label === 'Red (critical)')?.value).toBe('1');
    expect(data.record_count).toBe(2);
  });
});
