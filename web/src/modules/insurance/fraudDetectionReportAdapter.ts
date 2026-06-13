// web/src/modules/insurance/fraudDetectionReportAdapter.ts
//
// Export adapter for Insurance Module 3 — Fraud Detection (network / ring).
// This is a multi-panel page (network graph, ring table, high-risk providers,
// identity risk) with no single primary list; following the recoveryReportAdapter
// precedent we export the most representative rendered tabular output — the
// fraud-ring-detection table — plus the fraud-network KPI totals strip.
import type { ReportData, ExportConfig } from '@/lib/export/types';

export interface FraudRingReportRow {
  network_id: string;
  label: string;
  entity_count: number;
  edge_count: number;
  ring_risk_score: number;
  estimated_exposure_kes: number;
  detection_method: string;
  status: string;
}

export interface FraudDetectionReportSource {
  totals: {
    entities_tracked: number;
    flagged_entities: number;
    fraud_rings: number;
    open_fraud_cases: number;
    estimated_exposure_kes: number;
  };
  fraud_ring_detection: FraudRingReportRow[];
  meta: { tenant_id: string; generated_by: string; role: string };
}

export function buildFraudDetectionReportData(src: FraudDetectionReportSource, _config: ExportConfig): ReportData {
  const now = new Date().toISOString();
  return {
    report_type: 'risk',
    module: 'fraud_detection',
    title: 'Fraud Detection Report',
    meta: {
      tenant_id: src.meta.tenant_id, generated_by: src.meta.generated_by, role: src.meta.role,
      generated_at: now, report_id: `EXP-${src.meta.tenant_id}-${Date.now()}`,
    },
    sections: {
      summary: [
        { label: 'Fraud rings detected', value: String(src.totals.fraud_rings) },
        { label: 'Estimated exposure (KES)', value: String(src.totals.estimated_exposure_kes) },
      ],
      kpis: [
        { label: 'Entities tracked', value: String(src.totals.entities_tracked) },
        { label: 'Flagged entities', value: String(src.totals.flagged_entities) },
        { label: 'Fraud rings', value: String(src.totals.fraud_rings) },
        { label: 'Open fraud cases', value: String(src.totals.open_fraud_cases) },
        { label: 'Estimated exposure (KES)', value: String(src.totals.estimated_exposure_kes) },
      ],
      tables: [{
        name: 'Fraud Ring Detection',
        columns: ['Ring ID', 'Label', 'Entities', 'Edges', 'Ring Risk', 'Exposure (KES)', 'Detection Method', 'Status'],
        rows: src.fraud_ring_detection.map((r) => [
          r.network_id, r.label, r.entity_count, r.edge_count, r.ring_risk_score,
          r.estimated_exposure_kes, r.detection_method.replace(/_/g, ' '), r.status,
        ]),
      }],
    },
    record_count: src.fraud_ring_detection.length,
  };
}
