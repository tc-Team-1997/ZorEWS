import { describe, test, expect } from 'vitest';
import { buildInvestigationsReportData } from '@/modules/investigation/investigationsReportAdapter';
import { DEFAULT_INCLUDE, type ExportConfig } from '@/lib/export/types';

const config: ExportConfig = { formats: ['pdf'], report_type: 'case', date_range: '30d', data_scope: 'complete', include: DEFAULT_INCLUDE };

describe('buildInvestigationsReportData', () => {
  test('maps the investigation list into ReportData (case report)', () => {
    const data = buildInvestigationsReportData({
      command: {
        total_cases: 2,
        open_cases: 1,
        critical_cases: 1,
        high_risk_cases: 1,
        escalated_cases: 0,
        sla_breached_cases: 1,
        fraud_cases: 1,
        resolution_rate: 0.5,
      },
      investigations: [
        { investigation_id: 'INV-BANK_DEMO-00001', title: 'Borrower watch — BRW-03001', domain: 'banking', kind: 'borrower', status: 'open', severity: 'high', assignee_username: null, exposure_kes: 2_400_000, due_at: '2026-06-20T00:00:00Z', opened_at: '2026-06-10T00:00:00Z' },
        { investigation_id: 'INV-BANK_DEMO-00009', title: 'Claim fraud review — POL-05009', domain: 'insurance', kind: 'claim_fraud', status: 'escalated', severity: 'critical', assignee_username: 'carol.fraud', exposure_kes: 5_000_000, due_at: '2026-06-15T00:00:00Z', opened_at: '2026-06-08T00:00:00Z' },
      ],
      meta: { tenant_id: 'BANK_DEMO', generated_by: 'alice.admin', role: 'admin' },
    }, config);
    expect(data.report_type).toBe('case');
    expect(data.module).toBe('investigations');
    expect(data.subject).toBeUndefined();
    expect(data.meta.report_id).toMatch(/^EXP-/);
    expect(data.sections.tables?.[0].rows).toHaveLength(2);
    expect(data.sections.kpis?.find((k) => k.label === 'Fraud cases')?.value).toBe('1');
    expect(data.record_count).toBe(2);
  });
});
