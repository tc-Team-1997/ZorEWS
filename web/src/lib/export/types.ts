// web/src/lib/export/types.ts
// Shared contract for the Enterprise Report Export Framework (P1).
// Each screen supplies a ReportAdapter; generators consume only ReportData.

export const ALL_EXPORT_FORMATS = ['pdf', 'xlsx', 'csv', 'docx'] as const;
export type ExportFormat = (typeof ALL_EXPORT_FORMATS)[number];

export const ALL_REPORT_TYPES = [
  'customer', 'risk', 'case', 'recovery',
  'compliance', 'portfolio', 'executive', 'ai_insight',
] as const;
export type ReportType = (typeof ALL_REPORT_TYPES)[number];

export type DateRangeKey = 'today' | '7d' | '30d' | 'quarter' | 'custom';
export type DataScope = 'current_page' | 'filtered' | 'selected' | 'complete';

export type ReportSectionKey =
  | 'summary' | 'kpis' | 'trends' | 'charts' | 'alerts'
  | 'ai_insights' | 'recommendations' | 'audit_trail' | 'workflow_history';

export interface ExportConfig {
  formats: ExportFormat[];
  report_type: ReportType;
  date_range: DateRangeKey;
  custom_range?: { from: string; to: string };
  data_scope: DataScope;
  include: Record<ReportSectionKey, boolean>;
}

export type TableRow = (string | number)[];
export interface ReportTable { name: string; columns: string[]; rows: TableRow[]; }

export interface ReportData {
  report_type: ReportType;
  module: string;
  title: string;
  subject?: { id: string; name: string };
  meta: {
    tenant_id: string;
    generated_by: string;
    role: string;
    generated_at: string; // ISO
    report_id: string;
  };
  sections: {
    summary?: { label: string; value: string }[];
    kpis?: { label: string; value: string; delta?: string }[];
    trends?: { label: string; points: { x: string; y: number }[] }[];
    tables?: ReportTable[];
    alerts?: Record<string, string | number>[];
    recommendations?: string[];
    ai_insights?: { narrative: string };
    audit_trail?: Record<string, string | number>[];
    workflow_history?: Record<string, string | number>[];
  };
  /** The row count that POST /v1/exports records (primary table size). */
  record_count: number;
}

export type ReportAdapter = (config: ExportConfig) => ReportData | Promise<ReportData>;

export const DEFAULT_INCLUDE: Record<ReportSectionKey, boolean> = {
  summary: true, kpis: true, trends: true, charts: true, alerts: true,
  ai_insights: false, recommendations: true, audit_trail: false, workflow_history: false,
};
