// web/src/modules/customers/borrowerWatchReportAdapter.ts
//
// Export adapter for Module 2.1 Borrower Watch.
// Maps the screen's post-filter borrower rows (the same array the table
// renders) + its KPI strip totals into the standard ReportData contract.
import type { ReportData, ExportConfig } from '@/lib/export/types';

export interface BorrowerWatchReportRow {
  borrower_id: string;
  name: string;
  sector: string;
  segment: string;
  region: string;
  exposure_inr: number;
  pd: number;
  ews_score: number;
  severity: string;
  top_signal: string;
  last_alert_at: string | null;
  watchlist_tag: string | null;
  dpd: number;
}

export interface BorrowerWatchReportSource {
  rows: BorrowerWatchReportRow[];
  summary: { total: number; total_unfiltered: number; by_severity: { S1: number; S2: number; S3: number } };
  meta: { tenant_id: string; generated_by: string; role: string };
}

export function buildBorrowerWatchReportData(src: BorrowerWatchReportSource, _config: ExportConfig): ReportData {
  const now = new Date().toISOString();
  return {
    report_type: 'risk',
    module: 'borrower_watch',
    title: 'Borrower Watch Report',
    meta: {
      tenant_id: src.meta.tenant_id, generated_by: src.meta.generated_by, role: src.meta.role,
      generated_at: now, report_id: `EXP-${src.meta.tenant_id}-${Date.now()}`,
    },
    sections: {
      summary: [
        { label: 'Borrowers (filtered)', value: String(src.summary.total) },
        { label: 'Total (unfiltered)', value: String(src.summary.total_unfiltered) },
      ],
      kpis: [
        { label: 'S1 (critical)', value: String(src.summary.by_severity.S1) },
        { label: 'S2 (warning)', value: String(src.summary.by_severity.S2) },
        { label: 'S3 (monitor)', value: String(src.summary.by_severity.S3) },
      ],
      tables: [{
        name: 'Stressed Borrowers',
        columns: ['Borrower ID', 'Name', 'Sector', 'Segment', 'Region', 'Exposure (INR)', 'EWS', 'Severity', 'DPD', 'Top Signal', 'Watchlist'],
        rows: src.rows.map((r) => [
          r.borrower_id, r.name, r.sector, r.segment, r.region, r.exposure_inr,
          r.ews_score, r.severity, r.dpd, r.top_signal, r.watchlist_tag ?? '—',
        ]),
      }],
    },
    record_count: src.rows.length,
  };
}
