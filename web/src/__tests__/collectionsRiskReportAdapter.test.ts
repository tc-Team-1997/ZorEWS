import { describe, test, expect } from 'vitest';
import { buildCollectionsRiskReportData } from '@/modules/banking/collectionsRiskReportAdapter';
import { DEFAULT_INCLUDE, type ExportConfig } from '@/lib/export/types';

const config: ExportConfig = { formats: ['pdf'], report_type: 'recovery', date_range: '30d', data_scope: 'complete', include: DEFAULT_INCLUDE };

describe('buildCollectionsRiskReportData', () => {
  test('maps the recovery work-queue into ReportData (recovery report)', () => {
    const data = buildCollectionsRiskReportData({
      summary: {
        total_accounts: 2,
        total_overdue_kes: 9_000_000,
        total_expected_recovery_kes: 5_400_000,
        recovery_rate_pct: 60,
        ptp_active_count: 1,
        high_risk_count: 1,
      },
      accounts: [
        { account_id: 'acc-1', customer_id: 'c-1', customer_name: 'Acme Mfg', sector: 'manufacturing', dpd: 95, overdue_kes: 6_000_000, recovery_probability: 0.35, expected_recovery_kes: 2_100_000, recovery_stage: 'legal_notice', ptp_status: 'broken', assigned_collector: 'op.one' },
        { account_id: 'acc-2', customer_id: 'c-2', customer_name: 'Beta Retail', sector: 'retail', dpd: 40, overdue_kes: 3_000_000, recovery_probability: 0.8, expected_recovery_kes: 2_400_000, recovery_stage: 'soft_reminder', ptp_status: 'active', assigned_collector: 'op.two' },
      ],
      meta: { tenant_id: 'BANK_DEMO', generated_by: 'alice.admin', role: 'admin' },
    }, config);
    expect(data.report_type).toBe('recovery');
    expect(data.module).toBe('collections_risk');
    expect(data.subject).toBeUndefined();
    expect(data.meta.report_id).toMatch(/^EXP-/);
    expect(data.sections.tables?.[0].rows).toHaveLength(2);
    expect(data.sections.kpis?.find((k) => k.label === 'Active PTPs')?.value).toBe('1');
    expect(data.record_count).toBe(2);
  });
});
