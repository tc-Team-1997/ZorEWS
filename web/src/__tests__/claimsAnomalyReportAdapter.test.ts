import { describe, test, expect } from 'vitest';
import { buildClaimsAnomalyReportData } from '@/modules/insurance/claimsAnomalyReportAdapter';
import { DEFAULT_INCLUDE, type ExportConfig } from '@/lib/export/types';

const config: ExportConfig = { formats: ['pdf'], report_type: 'risk', date_range: '30d', data_scope: 'complete', include: DEFAULT_INCLUDE };

describe('buildClaimsAnomalyReportData', () => {
  test('maps the suspicious-claims queue into ReportData (risk report)', () => {
    const data = buildClaimsAnomalyReportData({
      totals: {
        claims_scored: 4_200,
        suspicious_claims: 96,
        critical_count: 14,
        siu_open_cases: 8,
        suspicious_amount_kes: 31_000_000,
        mean_anomaly_score: 0.27,
      },
      suspicious_claims_queue: [
        { claim_id: 'CLM-1', customer_name: 'Asha N', claim_type: 'health', claim_amount_kes: 1_200_000, anomaly_score: 0.91, fraud_probability: 0.78, severity: 'critical', anomaly_reasons: ['amount_spike', 'rapid_refile'] },
        { claim_id: 'CLM-2', customer_name: 'Brian K', claim_type: 'motor', claim_amount_kes: 540_000, anomaly_score: 0.62, fraud_probability: 0.5, severity: 'high', anomaly_reasons: ['duplicate_claim'] },
      ],
      meta: { tenant_id: 'BANK_DEMO', generated_by: 'alice.admin', role: 'admin' },
    }, config);
    expect(data.report_type).toBe('risk');
    expect(data.module).toBe('claims_anomaly');
    expect(data.meta.report_id).toMatch(/^EXP-/);
    expect(data.sections.tables?.[0].rows).toHaveLength(2);
    expect(data.sections.kpis?.find((k) => k.label === 'SIU open cases')?.value).toBe('8');
    expect(data.record_count).toBe(2);
  });
});
