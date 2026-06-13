// web/src/modules/admin/recovery/recoveryReportAdapter.ts
//
// Export adapter for §Action-Center Recovery (RecoveryCenterPage).
// RecoveryCenterPage is a navigation landing page — it renders no fetched
// data list, only a KPI strip (placeholder values: the page deliberately
// shows "—"/"✓" rather than fabricated numbers) and a 10-section navigation
// catalog (RECOVERY_CENTER_CARDS). The catalog is the page's primary
// rendered list, so it is the export's main table; the KPI strip surfaces
// as summary/kpis exactly as the page renders it.
import type { ReportData, ExportConfig } from '@/lib/export/types';

export interface RecoveryReportKpi {
  label: string;
  value: string;
}

export interface RecoveryReportSection {
  id: string;
  label: string;
  description: string;
  to: string;
  reuses: string;
}

export interface RecoveryReportSource {
  kpis: RecoveryReportKpi[];
  sections: RecoveryReportSection[];
  meta: { tenant_id: string; generated_by: string; role: string };
}

export function buildRecoveryReportData(src: RecoveryReportSource, _config: ExportConfig): ReportData {
  const now = new Date().toISOString();
  return {
    report_type: 'recovery',
    module: 'recovery',
    title: 'Recovery Center Report',
    meta: {
      tenant_id: src.meta.tenant_id, generated_by: src.meta.generated_by, role: src.meta.role,
      generated_at: now, report_id: `EXP-${src.meta.tenant_id}-${Date.now()}`,
    },
    sections: {
      summary: [
        { label: 'Recovery sections', value: String(src.sections.length) },
      ],
      kpis: src.kpis.map((k) => ({ label: k.label, value: k.value })),
      tables: [{
        name: 'Recovery Center Sections',
        columns: ['Section', 'Description', 'Route', 'Reuses'],
        rows: src.sections.map((s) => [s.label, s.description, s.to, s.reuses]),
      }],
    },
    record_count: src.sections.length,
  };
}
