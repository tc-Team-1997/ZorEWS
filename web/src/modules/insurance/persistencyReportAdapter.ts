// web/src/modules/insurance/persistencyReportAdapter.ts
//
// Export adapter for Insurance Module 5 — Persistency Watch.
// This is a multi-panel page (by-milestone persistency trend, product /
// channel / region retention) with no single primary table; following the
// recoveryReportAdapter / fraudDetectionReportAdapter precedent we export the
// most representative rendered output — the by-milestone persistency trend
// (13/25/37/49/61-month retention) as a PORTFOLIO report — plus the headline
// persistency KPI strip.
import type { ReportData, ExportConfig } from '@/lib/export/types';

export interface PersistencyTrendReportRow {
  period_month: number;
  persistency_pct: number;
  target_pct: number;
  shortfall: number;
  band: string;
}

export interface PersistencyReportSource {
  totals: {
    headline_13m_pct: number;
    headline_61m_pct: number;
    cohorts_below_target: number;
    open_alerts: number;
    worst_dimension: string | null;
  };
  persistency_trend: PersistencyTrendReportRow[];
  meta: { tenant_id: string; generated_by: string; role: string };
}

export function buildPersistencyReportData(src: PersistencyReportSource, _config: ExportConfig): ReportData {
  const now = new Date().toISOString();
  return {
    report_type: 'portfolio',
    module: 'persistency',
    title: 'Persistency Watch Report',
    meta: {
      tenant_id: src.meta.tenant_id, generated_by: src.meta.generated_by, role: src.meta.role,
      generated_at: now, report_id: `EXP-${src.meta.tenant_id}-${Date.now()}`,
    },
    sections: {
      summary: [
        { label: '13-month persistency', value: (src.totals.headline_13m_pct * 100).toFixed(1) + '%' },
        { label: 'Cohorts below target', value: String(src.totals.cohorts_below_target) },
        { label: 'Worst dimension', value: src.totals.worst_dimension ?? 'none' },
      ],
      kpis: [
        { label: '13-month persistency', value: (src.totals.headline_13m_pct * 100).toFixed(1) + '%' },
        { label: '61-month persistency', value: (src.totals.headline_61m_pct * 100).toFixed(1) + '%' },
        { label: 'Cohorts below target', value: String(src.totals.cohorts_below_target) },
        { label: 'Open alerts', value: String(src.totals.open_alerts) },
      ],
      tables: [{
        name: 'Persistency by Milestone',
        columns: ['Milestone (months)', 'Persistency', 'Target', 'Shortfall', 'Band'],
        rows: src.persistency_trend.map((t) => [
          `${t.period_month}m`,
          (t.persistency_pct * 100).toFixed(1) + '%',
          (t.target_pct * 100).toFixed(1) + '%',
          (t.shortfall * 100).toFixed(1) + '%',
          t.band,
        ]),
      }],
    },
    record_count: src.persistency_trend.length,
  };
}
