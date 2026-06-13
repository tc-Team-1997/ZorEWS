// web/src/modules/banking/npaPredictionReportAdapter.ts
//
// Export adapter for the NPA Prediction screen.
// Maps the high-risk prediction rows (the same array the list renders) for the
// active horizon + the exposure KPI strip into the standard ReportData contract.
import type { ReportData, ExportConfig } from '@/lib/export/types';

export interface NpaPredictionReportRow {
  prediction_id: string;
  customer_id: string;
  customer_name: string;
  pd: number;
  band: 'high' | 'critical';
  predicted_at: string;
  horizon_days: number;
  outstanding_kes: number;
  sector: string;
  current_dpd: number;
}

export interface NpaPredictionReportSource {
  horizon: number;
  summary: { total_high_risk: number; total_critical: number; total_exposure_kes: number };
  rows: NpaPredictionReportRow[];
  meta: { tenant_id: string; generated_by: string; role: string };
}

export function buildNpaPredictionReportData(src: NpaPredictionReportSource, _config: ExportConfig): ReportData {
  const now = new Date().toISOString();
  return {
    report_type: 'risk',
    module: 'npa_prediction',
    title: 'NPA Prediction Report',
    meta: {
      tenant_id: src.meta.tenant_id, generated_by: src.meta.generated_by, role: src.meta.role,
      generated_at: now, report_id: `EXP-${src.meta.tenant_id}-${Date.now()}`,
    },
    sections: {
      summary: [
        { label: 'Horizon (days)', value: String(src.horizon) },
        { label: 'High-risk accounts', value: String(src.summary.total_high_risk) },
      ],
      kpis: [
        { label: 'Total high-risk accounts', value: String(src.summary.total_high_risk) },
        { label: 'Critical (PD ≥ 0.85)', value: String(src.summary.total_critical) },
        { label: 'Exposure at risk (KES)', value: String(src.summary.total_exposure_kes) },
      ],
      tables: [{
        name: 'High-Risk Accounts',
        columns: ['Customer ID', 'Customer', 'Sector', 'PD', 'Band', 'DPD', 'Outstanding (KES)', 'Horizon (days)'],
        rows: src.rows.map((r) => [
          r.customer_id, r.customer_name, r.sector, r.pd, r.band, r.current_dpd,
          r.outstanding_kes, r.horizon_days,
        ]),
      }],
    },
    record_count: src.rows.length,
  };
}
