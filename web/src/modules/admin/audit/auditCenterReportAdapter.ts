// web/src/modules/admin/audit/auditCenterReportAdapter.ts
//
// Export adapter for the Audit Center. The page is a navigation hub (no
// fetched data list — it collapses 4 audit modules into one surface), so the
// report exports the audit-section catalog the page renders + a compliance
// note, following the RecoveryCenter nav-page precedent (no fabricated data).
import type { ReportData, ExportConfig } from '@/lib/export/types';

export interface AuditCenterReportCard {
  id: string;
  label: string;
  description: string;
  to: string;
}

export interface AuditCenterReportSource {
  cards: AuditCenterReportCard[];
  meta: { tenant_id: string; generated_by: string; role: string };
}

export function buildAuditCenterReportData(src: AuditCenterReportSource, _config: ExportConfig): ReportData {
  const now = new Date().toISOString();
  return {
    report_type: 'compliance',
    module: 'audit_center',
    title: 'Audit Center Report',
    meta: {
      tenant_id: src.meta.tenant_id, generated_by: src.meta.generated_by, role: src.meta.role,
      generated_at: now, report_id: `EXP-${src.meta.tenant_id}-${Date.now()}`,
    },
    sections: {
      summary: [
        { label: 'Audit sections', value: String(src.cards.length) },
        { label: 'Scope', value: 'Hash-chained regulatory ledger + activity + sessions + compliance reports' },
      ],
      kpis: [
        { label: 'Audit sections', value: String(src.cards.length) },
      ],
      tables: [{
        name: 'Audit Sections',
        columns: ['Section ID', 'Section', 'Description', 'Route'],
        rows: src.cards.map((c) => [c.id, c.label, c.description, c.to]),
      }],
    },
    record_count: src.cards.length,
  };
}
