// web/src/modules/customers/financialRatiosReportAdapter.ts
//
// Export adapter for Module 2.3 Financial Ratios.
// Maps the screen's loaded ratio cohort (one row per borrower whose
// CustomerRatioBundle resolved) + its KPI strip into the standard
// ReportData contract. The ratio columns track whatever codes the ratio
// master returns, so the table stays in sync with the on-screen grid.
import type { ReportData, ExportConfig } from '@/lib/export/types';

export interface FinancialRatiosReportRow {
  customer_id: string;
  customer_name: string;
  sector: string;
  worst_band: string;
  /** ratio_code → numeric value (missing codes render as '—'). */
  values: Record<string, number | undefined>;
}

export interface FinancialRatiosReportSource {
  /** Ratio codes (column order) from the ratio master, e.g. ['DSCR','CR',...]. */
  ratioCodes: string[];
  rows: FinancialRatiosReportRow[];
  kpis: { total: number; red: number; amber: number; green: number };
  meta: { tenant_id: string; generated_by: string; role: string };
}

export function buildFinancialRatiosReportData(src: FinancialRatiosReportSource, _config: ExportConfig): ReportData {
  const now = new Date().toISOString();
  return {
    report_type: 'risk',
    module: 'financial_ratios',
    title: 'Financial Ratios Report',
    meta: {
      tenant_id: src.meta.tenant_id, generated_by: src.meta.generated_by, role: src.meta.role,
      generated_at: now, report_id: `EXP-${src.meta.tenant_id}-${Date.now()}`,
    },
    sections: {
      summary: [{ label: 'Cohort Size', value: String(src.kpis.total) }],
      kpis: [
        { label: 'Red (critical)', value: String(src.kpis.red) },
        { label: 'Amber (watch)', value: String(src.kpis.amber) },
        { label: 'Green (healthy)', value: String(src.kpis.green) },
      ],
      tables: [{
        name: 'Ratio Watchlist',
        columns: ['Borrower', 'Customer ID', 'Sector', 'Worst Band', ...src.ratioCodes],
        rows: src.rows.map((r) => [
          r.customer_name, r.customer_id, r.sector, r.worst_band,
          ...src.ratioCodes.map((code) => {
            const v = r.values[code];
            return v === undefined ? '—' : v;
          }),
        ]),
      }],
    },
    record_count: src.rows.length,
  };
}
