import { describe, test, expect } from 'vitest';
import { buildUnderwritingReportData } from '@/modules/insurance/underwritingReportAdapter';
import { DEFAULT_INCLUDE, type ExportConfig } from '@/lib/export/types';

const config: ExportConfig = { formats: ['pdf'], report_type: 'risk', date_range: '30d', data_scope: 'complete', include: DEFAULT_INCLUDE };

describe('buildUnderwritingReportData', () => {
  test('maps the rule-violation alerts into ReportData (risk report)', () => {
    const data = buildUnderwritingReportData({
      totals: {
        proposals_reviewed: 1_900,
        total_deviations: 142,
        open_deviations: 38,
        critical_deviations: 9,
        medical_waivers: 27,
        high_risk_underwriters: 4,
      },
      rule_violation_alerts: [
        { deviation_id: 'DEV-1', policy_id: 'POL-1', underwriter_name: 'Asha N', deviation_type: 'premium', rule_code: 'UW-PREM-01', deviation_pct: -0.18, severity: 'critical' },
        { deviation_id: 'DEV-2', policy_id: 'POL-2', underwriter_name: 'Brian K', deviation_type: 'rule_violation', rule_code: 'UW-RULE-07', deviation_pct: 0, severity: 'high' },
      ],
      meta: { tenant_id: 'BANK_DEMO', generated_by: 'alice.admin', role: 'admin' },
    }, config);
    expect(data.report_type).toBe('risk');
    expect(data.module).toBe('underwriting');
    expect(data.meta.report_id).toMatch(/^EXP-/);
    expect(data.sections.tables?.[0].rows).toHaveLength(2);
    expect(data.sections.kpis?.find((k) => k.label === 'Critical deviations')?.value).toBe('9');
    expect(data.record_count).toBe(2);
  });
});
