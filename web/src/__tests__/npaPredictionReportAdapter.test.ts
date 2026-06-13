import { describe, test, expect } from 'vitest';
import { buildNpaPredictionReportData } from '@/modules/banking/npaPredictionReportAdapter';
import { DEFAULT_INCLUDE, type ExportConfig } from '@/lib/export/types';

const config: ExportConfig = { formats: ['pdf'], report_type: 'risk', date_range: '30d', data_scope: 'complete', include: DEFAULT_INCLUDE };

describe('buildNpaPredictionReportData', () => {
  test('maps high-risk NPA predictions into ReportData (risk report)', () => {
    const data = buildNpaPredictionReportData({
      horizon: 90,
      summary: { total_high_risk: 2, total_critical: 1, total_exposure_kes: 18_000_000 },
      rows: [
        { prediction_id: 'p-1', customer_id: 'c-1', customer_name: 'Acme Mfg', pd: 0.91, band: 'critical', predicted_at: '2026-06-10T00:00:00Z', horizon_days: 90, outstanding_kes: 10_000_000, sector: 'manufacturing', current_dpd: 75 },
        { prediction_id: 'p-2', customer_id: 'c-2', customer_name: 'Beta Retail', pd: 0.72, band: 'high', predicted_at: '2026-06-10T00:00:00Z', horizon_days: 90, outstanding_kes: 8_000_000, sector: 'retail', current_dpd: 40 },
      ],
      meta: { tenant_id: 'BANK_DEMO', generated_by: 'alice.admin', role: 'admin' },
    }, config);
    expect(data.report_type).toBe('risk');
    expect(data.module).toBe('npa_prediction');
    expect(data.subject).toBeUndefined();
    expect(data.meta.report_id).toMatch(/^EXP-/);
    expect(data.sections.tables?.[0].rows).toHaveLength(2);
    expect(data.sections.kpis?.find((k) => k.label === 'Critical (PD ≥ 0.85)')?.value).toBe('1');
    expect(data.record_count).toBe(2);
  });
});
