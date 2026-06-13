// web/src/modules/insurance/policyLapseReportAdapter.ts
//
// Export adapter for Insurance Module 1 — Policy Lapse Risk.
// Maps the high-risk policies table (the same array the dashboard renders) +
// the lapse KPI totals strip into the standard ReportData contract.
import type { ReportData, ExportConfig } from '@/lib/export/types';

export interface PolicyLapseReportRow {
  policy_id: string;
  customer_name: string;
  product_code: string;
  channel: string;
  gwp_kes: number;
  lapse_probability: number;
  retention_risk_band: string;
  recommended_action: string;
}

export interface PolicyLapseReportSource {
  totals: {
    in_force_policies: number;
    at_risk_policies: number;
    critical_count: number;
    gwp_at_risk_kes: number;
    mean_lapse_probability: number;
  };
  high_risk_policies: PolicyLapseReportRow[];
  meta: { tenant_id: string; generated_by: string; role: string };
}

export function buildPolicyLapseReportData(src: PolicyLapseReportSource, _config: ExportConfig): ReportData {
  const now = new Date().toISOString();
  return {
    report_type: 'risk',
    module: 'policy_lapse',
    title: 'Policy Lapse Risk Report',
    meta: {
      tenant_id: src.meta.tenant_id, generated_by: src.meta.generated_by, role: src.meta.role,
      generated_at: now, report_id: `EXP-${src.meta.tenant_id}-${Date.now()}`,
    },
    sections: {
      summary: [
        { label: 'At-risk policies (30–90d)', value: String(src.totals.at_risk_policies) },
        { label: 'Mean lapse probability', value: src.totals.mean_lapse_probability.toFixed(3) },
      ],
      kpis: [
        { label: 'In-force policies', value: String(src.totals.in_force_policies) },
        { label: 'At risk (30–90d)', value: String(src.totals.at_risk_policies) },
        { label: 'Critical', value: String(src.totals.critical_count) },
        { label: 'GWP at risk (KES)', value: String(src.totals.gwp_at_risk_kes) },
        { label: 'Mean lapse prob.', value: src.totals.mean_lapse_probability.toFixed(3) },
      ],
      tables: [{
        name: 'High-Risk Policies',
        columns: ['Policy ID', 'Customer', 'Product', 'Channel', 'GWP (KES)', 'Lapse Prob.', 'Band', 'Recommended Action'],
        rows: src.high_risk_policies.map((p) => [
          p.policy_id, p.customer_name, p.product_code, p.channel, p.gwp_kes,
          p.lapse_probability, p.retention_risk_band, p.recommended_action,
        ]),
      }],
    },
    record_count: src.high_risk_policies.length,
  };
}
