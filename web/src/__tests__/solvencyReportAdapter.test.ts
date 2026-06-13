import { describe, test, expect } from 'vitest';
import { buildSolvencyReportData } from '@/modules/insurance/solvencyReportAdapter';
import { DEFAULT_INCLUDE, type ExportConfig } from '@/lib/export/types';

const config: ExportConfig = { formats: ['pdf'], report_type: 'compliance', date_range: '30d', data_scope: 'complete', include: DEFAULT_INCLUDE };

describe('buildSolvencyReportData', () => {
  test('maps the IRDAI compliance alerts into ReportData (compliance report)', () => {
    const data = buildSolvencyReportData({
      current: {
        solvency_ratio: 1.62,
        control_level: 1.5,
        available_solvency_margin_kes: 4_200_000_000,
        required_solvency_margin_kes: 2_600_000_000,
        capital_adequacy_pct: 0.162,
        status: 'watch',
      },
      totals: {
        open_alerts: 2,
        critical_alerts: 1,
        min_forecast_ratio: 1.43,
        breach_horizon_days: 47,
      },
      compliance_alerts: [
        { alert_id: 'CA-1', regulator: 'IRDAI', rule_code: 'SOLV-1.5', severity: 'critical', message: 'Forecast breach within 90 days', metric_value: 1.43, threshold_value: 1.5, status: 'open', raised_at: '2026-06-01T00:00:00Z' },
        { alert_id: 'CA-2', regulator: 'IRDAI', rule_code: 'CAP-ADQ', severity: 'warning', message: 'Capital adequacy trending down', metric_value: 0.162, threshold_value: 0.18, status: 'open', raised_at: '2026-06-02T00:00:00Z' },
      ],
      meta: { tenant_id: 'BANK_DEMO', generated_by: 'alice.admin', role: 'admin' },
    }, config);
    expect(data.report_type).toBe('compliance');
    expect(data.module).toBe('solvency');
    expect(data.meta.report_id).toMatch(/^EXP-/);
    expect(data.sections.tables?.[0].rows).toHaveLength(2);
    expect(data.sections.kpis?.find((k) => k.label === 'Solvency ratio')?.value).toBe('1.62');
    expect(data.record_count).toBe(2);
  });
});
