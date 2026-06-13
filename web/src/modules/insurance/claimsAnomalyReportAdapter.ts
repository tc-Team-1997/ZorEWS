// web/src/modules/insurance/claimsAnomalyReportAdapter.ts
//
// Export adapter for Insurance Module 2 — Claims Anomaly.
// Maps the suspicious-claims queue (the same array the dashboard renders) +
// the anomaly KPI totals strip into the standard ReportData contract.
import type { ReportData, ExportConfig } from '@/lib/export/types';

export interface ClaimsAnomalyReportRow {
  claim_id: string;
  customer_name: string;
  claim_type: string;
  claim_amount_kes: number;
  anomaly_score: number;
  fraud_probability: number;
  severity: string;
  anomaly_reasons: string[];
}

export interface ClaimsAnomalyReportSource {
  totals: {
    claims_scored: number;
    suspicious_claims: number;
    critical_count: number;
    siu_open_cases: number;
    suspicious_amount_kes: number;
    mean_anomaly_score: number;
  };
  suspicious_claims_queue: ClaimsAnomalyReportRow[];
  meta: { tenant_id: string; generated_by: string; role: string };
}

export function buildClaimsAnomalyReportData(src: ClaimsAnomalyReportSource, _config: ExportConfig): ReportData {
  const now = new Date().toISOString();
  return {
    report_type: 'risk',
    module: 'claims_anomaly',
    title: 'Claims Anomaly Report',
    meta: {
      tenant_id: src.meta.tenant_id, generated_by: src.meta.generated_by, role: src.meta.role,
      generated_at: now, report_id: `EXP-${src.meta.tenant_id}-${Date.now()}`,
    },
    sections: {
      summary: [
        { label: 'Suspicious claims', value: String(src.totals.suspicious_claims) },
        { label: 'Mean anomaly score', value: src.totals.mean_anomaly_score.toFixed(3) },
      ],
      kpis: [
        { label: 'Claims scored', value: String(src.totals.claims_scored) },
        { label: 'Suspicious claims', value: String(src.totals.suspicious_claims) },
        { label: 'Critical', value: String(src.totals.critical_count) },
        { label: 'SIU open cases', value: String(src.totals.siu_open_cases) },
        { label: 'Suspicious amount (KES)', value: String(src.totals.suspicious_amount_kes) },
        { label: 'Mean anomaly score', value: src.totals.mean_anomaly_score.toFixed(3) },
      ],
      tables: [{
        name: 'Suspicious Claims Queue',
        columns: ['Claim ID', 'Customer', 'Type', 'Amount (KES)', 'Anomaly Score', 'Fraud Prob.', 'Severity', 'Reasons'],
        rows: src.suspicious_claims_queue.map((c) => [
          c.claim_id, c.customer_name, c.claim_type, c.claim_amount_kes,
          c.anomaly_score, c.fraud_probability, c.severity,
          c.anomaly_reasons.map((r) => r.replace(/_/g, ' ')).join(', '),
        ]),
      }],
    },
    record_count: src.suspicious_claims_queue.length,
  };
}
