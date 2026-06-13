// web/src/modules/insurance/solvencyReportAdapter.ts
//
// Export adapter for Insurance Module 4 — Solvency Watch (IRDAI).
// This is a multi-panel page (current solvency snapshot, forecast trend,
// capital stress simulation, compliance alerts) with no single primary list;
// following the recoveryReportAdapter / fraudDetectionReportAdapter precedent we
// export the most representative rendered tabular output for a COMPLIANCE report —
// the IRDAI compliance-alerts list — plus the solvency-position KPI strip.
import type { ReportData, ExportConfig } from '@/lib/export/types';

export interface SolvencyComplianceAlertRow {
  alert_id: string;
  regulator: string;
  rule_code: string;
  severity: string;
  message: string;
  metric_value: number;
  threshold_value: number;
  status: string;
  raised_at: string;
}

export interface SolvencyReportSource {
  current: {
    solvency_ratio: number;
    control_level: number;
    available_solvency_margin_kes: number;
    required_solvency_margin_kes: number;
    capital_adequacy_pct: number;
    status: string;
  };
  totals: {
    open_alerts: number;
    critical_alerts: number;
    min_forecast_ratio: number;
    breach_horizon_days: number | null;
  };
  compliance_alerts: SolvencyComplianceAlertRow[];
  meta: { tenant_id: string; generated_by: string; role: string };
}

export function buildSolvencyReportData(src: SolvencyReportSource, _config: ExportConfig): ReportData {
  const now = new Date().toISOString();
  return {
    report_type: 'compliance',
    module: 'solvency',
    title: 'Solvency Watch Report',
    meta: {
      tenant_id: src.meta.tenant_id, generated_by: src.meta.generated_by, role: src.meta.role,
      generated_at: now, report_id: `EXP-${src.meta.tenant_id}-${Date.now()}`,
    },
    sections: {
      summary: [
        { label: 'Solvency status', value: src.current.status },
        { label: 'Open compliance alerts', value: String(src.totals.open_alerts) },
        { label: 'Projected breach horizon (days)', value: src.totals.breach_horizon_days != null ? String(src.totals.breach_horizon_days) : 'none' },
      ],
      kpis: [
        { label: 'Solvency ratio', value: src.current.solvency_ratio.toFixed(2) },
        { label: 'Control level (IRDAI)', value: src.current.control_level.toFixed(2) },
        { label: 'Available margin (KES)', value: String(src.current.available_solvency_margin_kes) },
        { label: 'Required margin (KES)', value: String(src.current.required_solvency_margin_kes) },
        { label: 'Open alerts', value: String(src.totals.open_alerts) },
        { label: 'Critical alerts', value: String(src.totals.critical_alerts) },
        { label: 'Min forecast ratio', value: src.totals.min_forecast_ratio.toFixed(2) },
      ],
      tables: [{
        name: 'IRDAI Compliance Alerts',
        columns: ['Alert ID', 'Regulator', 'Rule', 'Severity', 'Message', 'Metric', 'Threshold', 'Status'],
        rows: src.compliance_alerts.map((a) => [
          a.alert_id, a.regulator, a.rule_code, a.severity, a.message,
          a.metric_value, a.threshold_value, a.status,
        ]),
      }],
    },
    record_count: src.compliance_alerts.length,
  };
}
