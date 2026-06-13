// web/src/modules/banking/smaClassificationReportAdapter.ts
//
// Export adapter for Module 2.4 SMA Classification.
// Maps today's SMA movement rows (the same array the movements table renders)
// + the movement KPI strip into the standard ReportData contract.
import type { ReportData, ExportConfig } from '@/lib/export/types';

export interface SmaClassificationReportMovement {
  customer_id: string;
  customer_name: string;
  loan_id: string;
  from_category: string;
  to_category: string;
  dpd: number;
  outstanding_kes: number;
  sector: string;
}

export interface SmaClassificationReportSource {
  framework: string;
  date: string;
  summary: { total_movements: number; deteriorations: number; improvements: number; total_exposure_at_risk_kes: number };
  movements: SmaClassificationReportMovement[];
  meta: { tenant_id: string; generated_by: string; role: string };
}

export function buildSmaClassificationReportData(src: SmaClassificationReportSource, _config: ExportConfig): ReportData {
  const now = new Date().toISOString();
  return {
    report_type: 'risk',
    module: 'sma_classification',
    title: 'SMA Classification Report',
    meta: {
      tenant_id: src.meta.tenant_id, generated_by: src.meta.generated_by, role: src.meta.role,
      generated_at: now, report_id: `EXP-${src.meta.tenant_id}-${Date.now()}`,
    },
    sections: {
      summary: [
        { label: 'Framework', value: src.framework },
        { label: 'As of', value: src.date },
      ],
      kpis: [
        { label: 'Total movements', value: String(src.summary.total_movements) },
        { label: 'Deteriorations', value: String(src.summary.deteriorations) },
        { label: 'Improvements', value: String(src.summary.improvements) },
        { label: 'Exposure at risk (KES)', value: String(src.summary.total_exposure_at_risk_kes) },
      ],
      tables: [{
        name: 'SMA Movements',
        columns: ['Customer ID', 'Customer', 'Loan ID', 'From', 'To', 'DPD', 'Outstanding (KES)', 'Sector'],
        rows: src.movements.map((m) => [
          m.customer_id, m.customer_name, m.loan_id, m.from_category, m.to_category,
          m.dpd, m.outstanding_kes, m.sector,
        ]),
      }],
    },
    record_count: src.movements.length,
  };
}
