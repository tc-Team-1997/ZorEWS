// web/src/modules/executive/executiveCockpitReportAdapter.ts
//
// Export adapter for the Executive Risk Cockpit. The cockpit is a composed
// 8-section executive shell; the report exports its enterprise-risk overview
// KPIs + the top-exposures list (the cockpit's primary ranked table) into the
// standard ReportData contract.
import type { ReportData, ExportConfig } from '@/lib/export/types';

export interface ExecutiveCockpitReportKpi {
  label: string;
  value: string;
  sub?: string;
}
export interface ExecutiveCockpitReportExposure {
  rank: number;
  entity_name: string;
  exposure_kes: number;
  risk_score: number;
  band: string;
}

export interface ExecutiveCockpitReportSource {
  overview: ExecutiveCockpitReportKpi[];
  exposures: ExecutiveCockpitReportExposure[];
  meta: { tenant_id: string; generated_by: string; role: string };
}

export function buildExecutiveCockpitReportData(src: ExecutiveCockpitReportSource, _config: ExportConfig): ReportData {
  const now = new Date().toISOString();
  return {
    report_type: 'executive',
    module: 'executive_cockpit',
    title: 'Executive Risk Cockpit Report',
    meta: {
      tenant_id: src.meta.tenant_id, generated_by: src.meta.generated_by, role: src.meta.role,
      generated_at: now, report_id: `EXP-${src.meta.tenant_id}-${Date.now()}`,
    },
    sections: {
      summary: src.overview.slice(0, 4).map((k) => ({ label: k.label, value: k.value })),
      kpis: src.overview.map((k) => ({ label: k.label, value: k.value })),
      tables: [{
        name: 'Top Exposures',
        columns: ['Rank', 'Entity', 'Exposure (KES)', 'Risk Score', 'Band'],
        rows: src.exposures.map((e) => [e.rank, e.entity_name, e.exposure_kes, e.risk_score, e.band]),
      }],
    },
    record_count: src.exposures.length,
  };
}
