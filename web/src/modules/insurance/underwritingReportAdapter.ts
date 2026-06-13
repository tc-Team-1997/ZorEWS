// web/src/modules/insurance/underwritingReportAdapter.ts
//
// Export adapter for Insurance Module 6 — Underwriting Deviation.
// Maps the rule-violation alerts table (the same array the dashboard renders)
// + the deviation KPI totals strip into the standard ReportData contract.
import type { ReportData, ExportConfig } from '@/lib/export/types';

export interface UnderwritingReportRow {
  deviation_id: string;
  policy_id: string;
  underwriter_name: string;
  deviation_type: string;
  rule_code: string;
  deviation_pct: number;
  severity: string;
}

export interface UnderwritingReportSource {
  totals: {
    proposals_reviewed: number;
    total_deviations: number;
    open_deviations: number;
    critical_deviations: number;
    medical_waivers: number;
    high_risk_underwriters: number;
  };
  rule_violation_alerts: UnderwritingReportRow[];
  meta: { tenant_id: string; generated_by: string; role: string };
}

export function buildUnderwritingReportData(src: UnderwritingReportSource, _config: ExportConfig): ReportData {
  const now = new Date().toISOString();
  return {
    report_type: 'risk',
    module: 'underwriting',
    title: 'Underwriting Deviation Report',
    meta: {
      tenant_id: src.meta.tenant_id, generated_by: src.meta.generated_by, role: src.meta.role,
      generated_at: now, report_id: `EXP-${src.meta.tenant_id}-${Date.now()}`,
    },
    sections: {
      summary: [
        { label: 'Total deviations', value: String(src.totals.total_deviations) },
        { label: 'Open deviations', value: String(src.totals.open_deviations) },
      ],
      kpis: [
        { label: 'Proposals reviewed', value: String(src.totals.proposals_reviewed) },
        { label: 'Total deviations', value: String(src.totals.total_deviations) },
        { label: 'Open deviations', value: String(src.totals.open_deviations) },
        { label: 'Critical deviations', value: String(src.totals.critical_deviations) },
        { label: 'Medical waivers', value: String(src.totals.medical_waivers) },
        { label: 'High-risk underwriters', value: String(src.totals.high_risk_underwriters) },
      ],
      tables: [{
        name: 'Rule Violation Alerts',
        columns: ['Deviation ID', 'Policy ID', 'Underwriter', 'Type', 'Rule', 'Deviation %', 'Severity'],
        rows: src.rule_violation_alerts.map((d) => [
          d.deviation_id, d.policy_id, d.underwriter_name, d.deviation_type.replace(/_/g, ' '),
          d.rule_code, d.deviation_pct, d.severity,
        ]),
      }],
    },
    record_count: src.rule_violation_alerts.length,
  };
}
