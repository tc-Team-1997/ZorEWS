import { describe, test, expect } from 'vitest';
import { buildSectorWatchReportData } from '@/modules/banking/sectorWatchReportAdapter';
import { DEFAULT_INCLUDE, type ExportConfig } from '@/lib/export/types';

const config: ExportConfig = { formats: ['pdf'], report_type: 'portfolio', date_range: '30d', data_scope: 'complete', include: DEFAULT_INCLUDE };

describe('buildSectorWatchReportData', () => {
  test('maps the sector heatmap into ReportData (portfolio report)', () => {
    const data = buildSectorWatchReportData({
      summary: { total_sectors: 2, by_heat_level: { critical: 1, high: 1, medium: 0, low: 0 } },
      cells: [
        { sector: 'manufacturing', npa_ratio_pct: 8.4, total_customers: 320, total_outstanding_kes: 120_000_000, delta_30d_pct: 1.2, heat_level: 'critical', is_watchlisted: true },
        { sector: 'retail', npa_ratio_pct: 3.1, total_customers: 510, total_outstanding_kes: 60_000_000, delta_30d_pct: -0.5, heat_level: 'high', is_watchlisted: false },
      ],
      meta: { tenant_id: 'BANK_DEMO', generated_by: 'alice.admin', role: 'admin' },
    }, config);
    expect(data.report_type).toBe('portfolio');
    expect(data.module).toBe('sector_watch');
    expect(data.subject).toBeUndefined();
    expect(data.meta.report_id).toMatch(/^EXP-/);
    expect(data.sections.tables?.[0].rows).toHaveLength(2);
    expect(data.sections.kpis?.find((k) => k.label === 'Critical heat')?.value).toBe('1');
    expect(data.record_count).toBe(2);
  });
});
