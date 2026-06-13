// web/src/modules/banking/borrowerTimelineReportAdapter.ts
//
// Export adapter for §2.1.9 Borrower Timeline — a SINGLE-borrower report.
// Maps the borrower's risk-event stream (the same array the timeline renders,
// post event-type filter) + the journey summary into the standard ReportData
// contract, stamping the borrower as the report `subject`.
import type { ReportData, ExportConfig } from '@/lib/export/types';

export interface BorrowerTimelineReportEvent {
  event_id: string;
  occurred_at: string;
  event_type: string;
  severity: string;
  title: string;
  description: string;
  linked_ref: string | null;
}

export interface BorrowerTimelineReportSource {
  customer_id: string;
  customer_name: string;
  summary: {
    current_risk_band: string;
    trajectory: string;
    peak_dpd: number;
    total_events: number;
    critical_events: number;
  };
  events: BorrowerTimelineReportEvent[];
  meta: { tenant_id: string; generated_by: string; role: string };
}

export function buildBorrowerTimelineReportData(src: BorrowerTimelineReportSource, _config: ExportConfig): ReportData {
  const now = new Date().toISOString();
  return {
    report_type: 'customer',
    module: 'borrower_timeline',
    title: 'Borrower Timeline Report',
    subject: { id: src.customer_id, name: src.customer_name },
    meta: {
      tenant_id: src.meta.tenant_id, generated_by: src.meta.generated_by, role: src.meta.role,
      generated_at: now, report_id: `EXP-${src.meta.tenant_id}-${Date.now()}`,
    },
    sections: {
      summary: [
        { label: 'Current risk band', value: src.summary.current_risk_band },
        { label: 'Trajectory', value: src.summary.trajectory },
      ],
      kpis: [
        { label: 'Current risk band', value: src.summary.current_risk_band },
        { label: 'Trajectory', value: src.summary.trajectory },
        { label: 'Peak DPD', value: String(src.summary.peak_dpd) },
        { label: 'Total events', value: String(src.summary.total_events) },
        { label: 'Critical events', value: String(src.summary.critical_events) },
      ],
      tables: [{
        name: 'Risk Journey',
        columns: ['Occurred At', 'Event Type', 'Severity', 'Title', 'Description', 'Linked Ref'],
        rows: src.events.map((e) => [
          e.occurred_at, e.event_type, e.severity, e.title, e.description, e.linked_ref ?? '—',
        ]),
      }],
    },
    record_count: src.events.length,
  };
}
