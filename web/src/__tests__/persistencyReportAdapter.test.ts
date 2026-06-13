import { describe, test, expect } from 'vitest';
import { buildPersistencyReportData } from '@/modules/insurance/persistencyReportAdapter';
import { DEFAULT_INCLUDE, type ExportConfig } from '@/lib/export/types';

const config: ExportConfig = { formats: ['pdf'], report_type: 'portfolio', date_range: '30d', data_scope: 'complete', include: DEFAULT_INCLUDE };

describe('buildPersistencyReportData', () => {
  test('maps the by-milestone persistency trend into ReportData (portfolio report)', () => {
    const data = buildPersistencyReportData({
      totals: {
        headline_13m_pct: 0.78,
        headline_61m_pct: 0.52,
        cohorts_below_target: 3,
        open_alerts: 2,
        worst_dimension: 'online',
      },
      persistency_trend: [
        { period_month: 13, persistency_pct: 0.78, target_pct: 0.85, shortfall: 0.07, band: 'watch' },
        { period_month: 25, persistency_pct: 0.69, target_pct: 0.80, shortfall: 0.11, band: 'concern' },
        { period_month: 37, persistency_pct: 0.61, target_pct: 0.75, shortfall: 0.14, band: 'concern' },
        { period_month: 49, persistency_pct: 0.56, target_pct: 0.70, shortfall: 0.14, band: 'critical' },
        { period_month: 61, persistency_pct: 0.52, target_pct: 0.65, shortfall: 0.13, band: 'critical' },
      ],
      meta: { tenant_id: 'BANK_DEMO', generated_by: 'alice.admin', role: 'admin' },
    }, config);
    expect(data.report_type).toBe('portfolio');
    expect(data.module).toBe('persistency');
    expect(data.meta.report_id).toMatch(/^EXP-/);
    expect(data.sections.tables?.[0].rows).toHaveLength(5);
    expect(data.sections.kpis?.find((k) => k.label === 'Cohorts below target')?.value).toBe('3');
    expect(data.record_count).toBe(5);
  });
});
