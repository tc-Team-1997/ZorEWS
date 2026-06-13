// web/src/modules/banking/fraudSignalsReportAdapter.ts
//
// Export adapter for Module 2.6 Fraud Signals.
// Maps the active fraud-case rows (the same array the cases table renders,
// post status/priority filter) + the case KPI strip into the standard
// ReportData contract.
import type { ReportData, ExportConfig } from '@/lib/export/types';

export interface FraudSignalsReportCase {
  case_id: string;
  customer_id: string | null;
  account_id: string | null;
  category: string;
  priority: string;
  status: string;
  amount_kes: number;
  assignee: string | null;
  sar_id: string | null;
  vigilance_ref: string | null;
}

export interface FraudSignalsReportSource {
  summary: { total: number; open: number; investigating: number; reported: number; exposure: number };
  cases: FraudSignalsReportCase[];
  meta: { tenant_id: string; generated_by: string; role: string };
}

export function buildFraudSignalsReportData(src: FraudSignalsReportSource, _config: ExportConfig): ReportData {
  const now = new Date().toISOString();
  return {
    report_type: 'risk',
    module: 'fraud_signals',
    title: 'Fraud Signals Report',
    meta: {
      tenant_id: src.meta.tenant_id, generated_by: src.meta.generated_by, role: src.meta.role,
      generated_at: now, report_id: `EXP-${src.meta.tenant_id}-${Date.now()}`,
    },
    sections: {
      summary: [
        { label: 'Active cases', value: String(src.summary.total) },
      ],
      kpis: [
        { label: 'Active cases', value: String(src.summary.total) },
        { label: 'Open', value: String(src.summary.open) },
        { label: 'Investigating', value: String(src.summary.investigating) },
        { label: 'SAR filed', value: String(src.summary.reported) },
        { label: 'Exposure at risk (KES)', value: String(src.summary.exposure) },
      ],
      tables: [{
        name: 'Active Fraud Cases',
        columns: ['Case ID', 'Customer', 'Account', 'Fraud Type', 'Priority', 'Status', 'Exposure (KES)', 'Assignee', 'SAR', 'Vigilance'],
        rows: src.cases.map((c) => [
          c.case_id, c.customer_id ?? '—', c.account_id ?? '—', c.category, c.priority, c.status,
          c.amount_kes, c.assignee ?? 'unassigned', c.sar_id ?? '—', c.vigilance_ref ?? '—',
        ]),
      }],
    },
    record_count: src.cases.length,
  };
}
