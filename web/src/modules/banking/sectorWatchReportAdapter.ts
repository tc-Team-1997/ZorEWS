// web/src/modules/banking/sectorWatchReportAdapter.ts
//
// Export adapter for Module 2.7 Sector Watch.
// Maps the sector heatmap cells (the same array the heatmap tiles render) +
// the heat-level KPI strip into the standard ReportData contract.
import type { ReportData, ExportConfig } from '@/lib/export/types';

export interface SectorWatchReportCell {
  sector: string;
  npa_ratio_pct: number;
  total_customers: number;
  total_outstanding_kes: number;
  delta_30d_pct: number;
  heat_level: string;
  is_watchlisted: boolean;
}

export interface SectorWatchReportSource {
  summary: { total_sectors: number; by_heat_level: Record<string, number> };
  cells: SectorWatchReportCell[];
  meta: { tenant_id: string; generated_by: string; role: string };
}

export function buildSectorWatchReportData(src: SectorWatchReportSource, _config: ExportConfig): ReportData {
  const now = new Date().toISOString();
  return {
    report_type: 'portfolio',
    module: 'sector_watch',
    title: 'Sector Watch Report',
    meta: {
      tenant_id: src.meta.tenant_id, generated_by: src.meta.generated_by, role: src.meta.role,
      generated_at: now, report_id: `EXP-${src.meta.tenant_id}-${Date.now()}`,
    },
    sections: {
      summary: [
        { label: 'Total sectors', value: String(src.summary.total_sectors) },
      ],
      kpis: [
        { label: 'Total sectors', value: String(src.summary.total_sectors) },
        { label: 'Critical heat', value: String(src.summary.by_heat_level.critical ?? 0) },
        { label: 'High heat', value: String(src.summary.by_heat_level.high ?? 0) },
        { label: 'Low heat', value: String(src.summary.by_heat_level.low ?? 0) },
      ],
      tables: [{
        name: 'Sector Heatmap',
        columns: ['Sector', 'Heat Level', 'NPA Ratio (%)', '30d Δ (%)', 'Customers', 'Outstanding (KES)', 'Watchlisted'],
        rows: src.cells.map((c) => [
          c.sector, c.heat_level, c.npa_ratio_pct, c.delta_30d_pct, c.total_customers,
          c.total_outstanding_kes, c.is_watchlisted ? 'yes' : 'no',
        ]),
      }],
    },
    record_count: src.cells.length,
  };
}
