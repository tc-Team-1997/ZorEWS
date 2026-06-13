import { describe, test, expect } from 'vitest';
import { buildExecutiveCockpitReportData } from '@/modules/executive/executiveCockpitReportAdapter';
import { DEFAULT_INCLUDE, type ExportConfig } from '@/lib/export/types';

const config: ExportConfig = { formats: ['pdf'], report_type: 'executive', date_range: '30d', data_scope: 'complete', include: DEFAULT_INCLUDE };

describe('buildExecutiveCockpitReportData', () => {
  test('maps overview KPIs + top-exposures into ReportData', () => {
    const data = buildExecutiveCockpitReportData({
      overview: [
        { label: 'Enterprise Risk Score', value: '0.61', sub: 'composite' },
        { label: 'Portfolios at Risk', value: '4' },
      ],
      exposures: [
        { rank: 1, entity_name: 'Acme Ltd', exposure_kes: 5_000_000, risk_score: 0.82, band: 'High' },
        { rank: 2, entity_name: 'Beta Co', exposure_kes: 3_200_000, risk_score: 0.64, band: 'Medium' },
      ],
      meta: { tenant_id: 'BANK_DEMO', generated_by: 'a', role: 'admin' },
    }, config);
    expect(data.report_type).toBe('executive');
    expect(data.module).toBe('executive_cockpit');
    expect(data.meta.report_id).toMatch(/^EXP-/);
    expect(data.sections.tables?.[0].rows).toHaveLength(2);
    expect(data.sections.kpis).toHaveLength(2);
    expect(data.record_count).toBe(2);
  });
});
