import { describe, test, expect } from 'vitest';
import { buildPolicyLapseReportData } from '@/modules/insurance/policyLapseReportAdapter';
import { DEFAULT_INCLUDE, type ExportConfig } from '@/lib/export/types';

const config: ExportConfig = { formats: ['pdf'], report_type: 'risk', date_range: '30d', data_scope: 'complete', include: DEFAULT_INCLUDE };

describe('buildPolicyLapseReportData', () => {
  test('maps the high-risk policies into ReportData (risk report)', () => {
    const data = buildPolicyLapseReportData({
      totals: {
        in_force_policies: 12_000,
        at_risk_policies: 340,
        critical_count: 22,
        gwp_at_risk_kes: 88_000_000,
        mean_lapse_probability: 0.41,
      },
      high_risk_policies: [
        { policy_id: 'POL-1', customer_name: 'Asha N', product_code: 'TERM-20', channel: 'agent', gwp_kes: 240_000, lapse_probability: 0.82, retention_risk_band: 'critical', recommended_action: 'Call within 24h' },
        { policy_id: 'POL-2', customer_name: 'Brian K', product_code: 'ENDOW-15', channel: 'broker', gwp_kes: 180_000, lapse_probability: 0.61, retention_risk_band: 'high', recommended_action: 'Send retention offer' },
        { policy_id: 'POL-3', customer_name: 'Cynthia M', product_code: 'ULIP-10', channel: 'bancassurance', gwp_kes: 95_000, lapse_probability: 0.48, retention_risk_band: 'medium', recommended_action: 'Schedule renewal reminder' },
      ],
      meta: { tenant_id: 'BANK_DEMO', generated_by: 'alice.admin', role: 'admin' },
    }, config);
    expect(data.report_type).toBe('risk');
    expect(data.module).toBe('policy_lapse');
    expect(data.meta.report_id).toMatch(/^EXP-/);
    expect(data.sections.tables?.[0].rows).toHaveLength(3);
    expect(data.sections.kpis?.find((k) => k.label === 'Critical')?.value).toBe('22');
    expect(data.record_count).toBe(3);
  });
});
