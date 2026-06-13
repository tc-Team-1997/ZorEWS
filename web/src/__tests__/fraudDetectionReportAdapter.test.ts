import { describe, test, expect } from 'vitest';
import { buildFraudDetectionReportData } from '@/modules/insurance/fraudDetectionReportAdapter';
import { DEFAULT_INCLUDE, type ExportConfig } from '@/lib/export/types';

const config: ExportConfig = { formats: ['pdf'], report_type: 'risk', date_range: '30d', data_scope: 'complete', include: DEFAULT_INCLUDE };

describe('buildFraudDetectionReportData', () => {
  test('maps the fraud ring detection table into ReportData (risk report)', () => {
    const data = buildFraudDetectionReportData({
      totals: {
        entities_tracked: 8_400,
        flagged_entities: 210,
        fraud_rings: 6,
        open_fraud_cases: 4,
        estimated_exposure_kes: 54_000_000,
      },
      fraud_ring_detection: [
        { network_id: 'RING-1', label: 'Nairobi clinic cluster', entity_count: 12, edge_count: 22, ring_risk_score: 0.88, estimated_exposure_kes: 21_000_000, detection_method: 'shared_bank_account', status: 'confirmed' },
        { network_id: 'RING-2', label: 'Garage collusion', entity_count: 7, edge_count: 11, ring_risk_score: 0.64, estimated_exposure_kes: 9_500_000, detection_method: 'co_claim_overlap', status: 'investigating' },
        { network_id: 'RING-3', label: 'Identity recycling', entity_count: 5, edge_count: 6, ring_risk_score: 0.51, estimated_exposure_kes: 4_200_000, detection_method: 'identity_mismatch', status: 'detected' },
      ],
      meta: { tenant_id: 'BANK_DEMO', generated_by: 'alice.admin', role: 'admin' },
    }, config);
    expect(data.report_type).toBe('risk');
    expect(data.module).toBe('fraud_detection');
    expect(data.meta.report_id).toMatch(/^EXP-/);
    expect(data.sections.tables?.[0].rows).toHaveLength(3);
    expect(data.sections.kpis?.find((k) => k.label === 'Fraud rings')?.value).toBe('6');
    expect(data.record_count).toBe(3);
  });
});
