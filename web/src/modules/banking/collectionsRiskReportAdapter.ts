// web/src/modules/banking/collectionsRiskReportAdapter.ts
//
// Export adapter for §2.1.7 Collections Risk.
// Maps the recovery work-queue rows (the same array the queue table renders,
// post DPD-bucket / stage filter) + the recovery KPI strip into the standard
// ReportData contract.
import type { ReportData, ExportConfig } from '@/lib/export/types';

export interface CollectionsRiskReportAccount {
  account_id: string;
  customer_id: string;
  customer_name: string;
  sector: string;
  dpd: number;
  overdue_kes: number;
  recovery_probability: number;
  expected_recovery_kes: number;
  recovery_stage: string;
  ptp_status: string;
  assigned_collector: string;
}

export interface CollectionsRiskReportSource {
  summary: {
    total_accounts: number;
    total_overdue_kes: number;
    total_expected_recovery_kes: number;
    recovery_rate_pct: number;
    ptp_active_count: number;
    high_risk_count: number;
  };
  accounts: CollectionsRiskReportAccount[];
  meta: { tenant_id: string; generated_by: string; role: string };
}

export function buildCollectionsRiskReportData(src: CollectionsRiskReportSource, _config: ExportConfig): ReportData {
  const now = new Date().toISOString();
  return {
    report_type: 'recovery',
    module: 'collections_risk',
    title: 'Collections Risk Report',
    meta: {
      tenant_id: src.meta.tenant_id, generated_by: src.meta.generated_by, role: src.meta.role,
      generated_at: now, report_id: `EXP-${src.meta.tenant_id}-${Date.now()}`,
    },
    sections: {
      summary: [
        { label: 'Accounts in recovery', value: String(src.summary.total_accounts) },
        { label: 'Recovery rate (%)', value: String(src.summary.recovery_rate_pct) },
      ],
      kpis: [
        { label: 'Accounts in recovery', value: String(src.summary.total_accounts) },
        { label: 'Total overdue (KES)', value: String(src.summary.total_overdue_kes) },
        { label: 'Expected recovery (KES)', value: String(src.summary.total_expected_recovery_kes) },
        { label: 'Recovery rate (%)', value: String(src.summary.recovery_rate_pct) },
        { label: 'Active PTPs', value: String(src.summary.ptp_active_count) },
        { label: 'High-risk accounts', value: String(src.summary.high_risk_count) },
      ],
      tables: [{
        name: 'Recovery Work-Queue',
        columns: ['Account ID', 'Customer ID', 'Customer', 'Sector', 'DPD', 'Overdue (KES)', 'Recovery Prob.', 'Expected (KES)', 'Stage', 'PTP', 'Collector'],
        rows: src.accounts.map((a) => [
          a.account_id, a.customer_id, a.customer_name, a.sector, a.dpd, a.overdue_kes,
          a.recovery_probability, a.expected_recovery_kes, a.recovery_stage, a.ptp_status, a.assigned_collector,
        ]),
      }],
    },
    record_count: src.accounts.length,
  };
}
