// web/src/modules/customers/accountBehaviourReportAdapter.ts
//
// Export adapter for Module 2.2 Account Behaviour (AI).
// Maps the screen's post-filter account signals (the same array the table
// renders) + its KPI strip into the standard ReportData contract.
import type { ReportData, ExportConfig } from '@/lib/export/types';

export interface AccountBehaviourReportSignal {
  signal_id: string;
  account_id: string;
  customer_id: string;
  customer_name: string;
  signal_type: string;
  severity: string;
  score: number;
  observed_at: string;
  description: string;
  is_watchlisted: boolean;
  status: string;
}

export interface AccountBehaviourReportSource {
  signals: AccountBehaviourReportSignal[];
  kpis: { total: number; critical: number; high: number; watchlisted: number; newCount: number };
  meta: { tenant_id: string; generated_by: string; role: string };
}

export function buildAccountBehaviourReportData(src: AccountBehaviourReportSource, _config: ExportConfig): ReportData {
  const now = new Date().toISOString();
  return {
    report_type: 'risk',
    module: 'account_behaviour',
    title: 'Account Behaviour Report',
    meta: {
      tenant_id: src.meta.tenant_id, generated_by: src.meta.generated_by, role: src.meta.role,
      generated_at: now, report_id: `EXP-${src.meta.tenant_id}-${Date.now()}`,
    },
    sections: {
      summary: [{ label: 'Total Signals', value: String(src.kpis.total) }],
      kpis: [
        { label: 'Critical', value: String(src.kpis.critical) },
        { label: 'High', value: String(src.kpis.high) },
        { label: 'On Watchlist', value: String(src.kpis.watchlisted) },
        { label: 'New (awaiting review)', value: String(src.kpis.newCount) },
      ],
      tables: [{
        name: 'Account Signals',
        columns: ['Account', 'Borrower', 'Customer ID', 'Signal Type', 'AI Score', 'Severity', 'Status', 'Watchlist', 'Detected At'],
        rows: src.signals.map((s) => [
          s.account_id, s.customer_name, s.customer_id, s.signal_type,
          Math.round(s.score * 100), s.severity, s.status,
          s.is_watchlisted ? 'yes' : 'no', s.observed_at,
        ]),
      }],
    },
    record_count: src.signals.length,
  };
}
