import { describe, test, expect } from 'vitest';
import { buildRecoveryReportData } from '@/modules/admin/recovery/recoveryReportAdapter';
import { DEFAULT_INCLUDE, type ExportConfig } from '@/lib/export/types';

const config: ExportConfig = { formats: ['pdf'], report_type: 'recovery', date_range: '30d', data_scope: 'complete', include: DEFAULT_INCLUDE };

describe('buildRecoveryReportData', () => {
  test('maps the recovery-center sections catalog + KPI strip into ReportData (recovery report)', () => {
    const data = buildRecoveryReportData({
      kpis: [
        { label: 'Active deletions', value: '—' },
        { label: 'Pending approvals', value: '—' },
        { label: 'Restored today', value: '—' },
        { label: 'Purges pending', value: '—' },
        { label: 'High-risk requests', value: '—' },
        { label: 'Audit chain', value: '✓' },
      ],
      sections: [
        { id: 'deleted', label: 'Deleted Records', description: 'Every soft-deleted row across the platform.', to: '/recovery-center/deleted', reuses: 'RecycleBinPage (default tab)' },
        { id: 'workflow', label: 'Recovery Workflow', description: 'Maker-checker approval queue for restore + purge requests.', to: '/recovery-center/workflow', reuses: 'Mirrors M9.3 case_maker_checker' },
      ],
      meta: { tenant_id: 'BANK_DEMO', generated_by: 'alice.admin', role: 'admin' },
    }, config);
    expect(data.report_type).toBe('recovery');
    expect(data.module).toBe('recovery');
    expect(data.subject).toBeUndefined();
    expect(data.meta.report_id).toMatch(/^EXP-/);
    expect(data.sections.tables?.[0].rows).toHaveLength(2);
    expect(data.sections.kpis?.find((k) => k.label === 'Audit chain')?.value).toBe('✓');
    expect(data.record_count).toBe(2);
  });
});
