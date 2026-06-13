import { describe, test, expect } from 'vitest';
import { buildRegulatoryReportData } from '@/modules/regulatory/regulatoryReportAdapter';
import { DEFAULT_INCLUDE, type ExportConfig } from '@/lib/export/types';

const config: ExportConfig = { formats: ['pdf'], report_type: 'compliance', date_range: '30d', data_scope: 'complete', include: DEFAULT_INCLUDE };

describe('buildRegulatoryReportData', () => {
  test('maps command KPIs + obligation rows into ReportData', () => {
    const data = buildRegulatoryReportData({
      command: {
        compliance_health_score: 88, total_obligations: 42, open_findings: 5,
        regulatory_breaches: 1, sla_violations: 2, high_risk_obligations: 4,
        pending_actions: 7, audit_readiness: 91,
      },
      obligations: [
        { obligation_id: 'OBL-1', regulation: 'RBI MD', framework: 'Cyber', category: 'IT', owner: 'CISO', priority: 'high', status: 'open', next_due_date: '2026-07-01' },
        { obligation_id: 'OBL-2', regulation: 'IRDAI', framework: 'Solvency', category: 'Finance', owner: 'CFO', priority: 'medium', status: 'in_progress', next_due_date: '2026-08-01' },
      ],
      meta: { tenant_id: 'BANK_DEMO', generated_by: 'a', role: 'admin' },
    }, config);
    expect(data.report_type).toBe('compliance');
    expect(data.meta.report_id).toMatch(/^EXP-/);
    expect(data.sections.tables?.[0].rows).toHaveLength(2);
    expect(data.sections.kpis?.find((k) => k.label === 'Total obligations')?.value).toBe('42');
    expect(data.record_count).toBe(2);
  });
});
