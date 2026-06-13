import { describe, test, expect } from 'vitest';
import { buildBorrowerWatchReportData } from '@/modules/customers/borrowerWatchReportAdapter';
import { DEFAULT_INCLUDE, type ExportConfig } from '@/lib/export/types';

const config: ExportConfig = { formats: ['csv'], report_type: 'risk', date_range: '30d', data_scope: 'filtered', include: DEFAULT_INCLUDE };

describe('buildBorrowerWatchReportData', () => {
  test('maps a filtered borrower list into ReportData (risk report)', () => {
    const data = buildBorrowerWatchReportData({
      rows: [
        { borrower_id: 'b-1', name: 'Acme Mfg', sector: 'manufacturing', segment: 'corporate', region: 'north', exposure_inr: 50_000_000, pd: 0.12, ews_score: 82, severity: 'S1', top_signal: 'DPD spike', last_alert_at: '2026-06-10T00:00:00Z', watchlist_tag: 'Manual', dpd: 95 },
        { borrower_id: 'b-2', name: 'Beta Retail', sector: 'retail', segment: 'sme', region: 'south', exposure_inr: 1_000_000, pd: 0.04, ews_score: 40, severity: 'S3', top_signal: 'OK', last_alert_at: null, watchlist_tag: null, dpd: 10 },
      ],
      summary: { total: 2, total_unfiltered: 120, by_severity: { S1: 1, S2: 0, S3: 1 } },
      meta: { tenant_id: 'BANK_DEMO', generated_by: 'alice.admin', role: 'admin' },
    }, config);
    expect(data.report_type).toBe('risk');
    expect(data.module).toBe('borrower_watch');
    expect(data.subject).toBeUndefined();
    expect(data.meta.report_id).toMatch(/^EXP-/);
    expect(data.sections.tables?.[0].rows).toHaveLength(2);
    expect(data.sections.kpis?.find((k) => k.label === 'S1 (critical)')?.value).toBe('1');
    expect(data.record_count).toBe(2);
  });
});
