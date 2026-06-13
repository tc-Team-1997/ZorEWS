import { describe, test, expect } from 'vitest';
import { buildAuditCenterReportData } from '@/modules/admin/audit/auditCenterReportAdapter';
import { DEFAULT_INCLUDE, type ExportConfig } from '@/lib/export/types';

const config: ExportConfig = { formats: ['pdf'], report_type: 'compliance', date_range: '30d', data_scope: 'complete', include: DEFAULT_INCLUDE };

describe('buildAuditCenterReportData', () => {
  test('maps the audit-section catalog into ReportData', () => {
    const data = buildAuditCenterReportData({
      cards: [
        { id: 'trail', label: 'Audit Trail', description: 'hash-chained ledger', to: '/admin/audit/trail' },
        { id: 'export', label: 'Export', description: 'evidence packaging', to: '/admin/audit/export' },
      ],
      meta: { tenant_id: 'BANK_DEMO', generated_by: 'a', role: 'admin' },
    }, config);
    expect(data.report_type).toBe('compliance');
    expect(data.module).toBe('audit_center');
    expect(data.meta.report_id).toMatch(/^EXP-/);
    expect(data.sections.tables?.[0].rows).toHaveLength(2);
    expect(data.record_count).toBe(2);
  });
});
