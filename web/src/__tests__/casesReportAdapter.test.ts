import { describe, test, expect } from 'vitest';
import { buildCasesReportData } from '@/modules/cms/casesReportAdapter';
import { DEFAULT_INCLUDE, type ExportConfig } from '@/lib/export/types';

const config: ExportConfig = { formats: ['pdf'], report_type: 'case', date_range: '30d', data_scope: 'complete', include: DEFAULT_INCLUDE };

describe('buildCasesReportData', () => {
  test('maps the CMS case list into ReportData (case report)', () => {
    const data = buildCasesReportData({
      stats: {
        total: 2,
        sla_breached_count: 1,
        sla_warning_count: 0,
        open_investigating_count: 1,
      },
      cases: [
        { case_id: 'cs-1', case_number: 'CASE-0001', title: 'DPD spike — Acme Mfg', status: 'OPEN', priority: 'P1', assigned_to: 'op.one', sla_due_at: '2026-06-20T00:00:00Z', updated_at: '2026-06-12T10:00:00Z' },
        { case_id: 'cs-2', case_number: 'CASE-0002', title: 'Repeat claim review', status: 'INVESTIGATING', priority: 'P3', assigned_to: null, sla_due_at: '2026-06-25T00:00:00Z', updated_at: '2026-06-11T09:00:00Z' },
      ],
      meta: { tenant_id: 'BANK_DEMO', generated_by: 'alice.admin', role: 'admin' },
    }, config);
    expect(data.report_type).toBe('case');
    expect(data.module).toBe('cases');
    expect(data.subject).toBeUndefined();
    expect(data.meta.report_id).toMatch(/^EXP-/);
    expect(data.sections.tables?.[0].rows).toHaveLength(2);
    expect(data.sections.kpis?.find((k) => k.label === 'SLA breached')?.value).toBe('1');
    expect(data.record_count).toBe(2);
  });
});
