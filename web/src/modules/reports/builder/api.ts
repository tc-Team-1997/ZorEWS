// web/src/modules/reports/builder/api.ts
//
// T4.6.5 — SPA report builder: typed API wrappers for the BFF
// `/v1/reports/builder/*` surface (T4.6.1 / T4.6.2 / T4.6.3 / T4.6.4).
//
// The BFF envelope-wraps every response — we unwrap once via the http
// response interceptor pattern, so callers see the body directly.

import { http } from '@/lib/http';

// ─── T4.6.1 catalog types ─────────────────────────────────────────────

export type ReportFieldType =
  | 'string'
  | 'integer'
  | 'number'
  | 'boolean'
  | 'date'
  | 'datetime'
  | 'enum';

export interface ReportField {
  name: string;
  display_name: string;
  type: ReportFieldType;
  enum_values?: readonly string[];
  filterable: boolean;
  groupable: boolean;
  aggregatable: boolean;
  pii: boolean;
  description?: string;
}

export interface DrillTarget {
  to_source_id: string;
  via_field: string;
  display_name: string;
}

export interface ReportDataSource {
  source_id: string;
  display_name: string;
  description: string;
  schema: 'mart' | 'app_alerts' | 'app_cases' | 'app_audit' | 'audit';
  table: string;
  fields: ReportField[];
  default_filter_fields: string[];
  drill_targets: DrillTarget[];
  tenant_scoped: boolean;
  required_role: string;
}

export interface SourceCatalogResponse {
  tenant_id: string;
  generated_at: string;
  total_sources: number;
  sources: ReportDataSource[];
}

// ─── T4.6.2 filter compiler types ─────────────────────────────────────

export type FilterOp =
  | 'eq'
  | 'ne'
  | 'lt'
  | 'le'
  | 'gt'
  | 'ge'
  | 'in'
  | 'not_in'
  | 'between'
  | 'is_null'
  | 'is_not_null';

export type FilterNode =
  | { op: 'AND'; children: FilterNode[] }
  | { op: 'OR'; children: FilterNode[] }
  | { op: 'NOT'; child: FilterNode }
  | { op: FilterOp; field: string; value?: unknown };

export type MetricAgg =
  | 'COUNT'
  | 'SUM'
  | 'AVG'
  | 'MIN'
  | 'MAX'
  | 'DISTINCT_COUNT';

export interface ReportMetric {
  field: string;
  agg: MetricAgg;
  alias?: string;
}

export interface SortClause {
  field: string;
  direction: 'ASC' | 'DESC';
}

export type ReportSectionType = 'chart' | 'table' | 'grid' | 'kpi';

export interface ReportSection {
  section_id: string;
  type: ReportSectionType;
  config: Record<string, unknown>;
}

export interface ReportDefinition {
  source_id: string;
  filters?: FilterNode;
  group_by?: string[];
  metrics?: ReportMetric[];
  sort?: SortClause[];
  limit?: number;
  sections?: ReportSection[];
}

export interface PreviewResponse {
  source_id: string;
  sql: string;
  params: Record<string, unknown>;
  projection: string[];
  param_count: number;
  is_aggregate: boolean;
}

// ─── T4.6.3 saved-report types ────────────────────────────────────────

export type ReportVisibility = 'private' | 'role' | 'tenant';

export interface SavedReport {
  report_id: string;
  tenant_id: string;
  name: string;
  description: string;
  definition: ReportDefinition;
  created_by: string;
  created_at: string;
  updated_at: string;
  visibility: ReportVisibility;
  visible_to_roles: string[];
  tags: string[];
}

export interface SavedReportListResponse {
  tenant_id: string;
  total: number;
  reports: SavedReport[];
}

export interface CreateSavedReportInput {
  name: string;
  description?: string;
  definition: ReportDefinition;
  visibility?: ReportVisibility;
  visible_to_roles?: string[];
  tags?: string[];
}

export interface UpdateSavedReportInput {
  name?: string;
  description?: string;
  definition?: ReportDefinition;
  visibility?: ReportVisibility;
  visible_to_roles?: string[];
  tags?: string[];
}

// ─── T4.6.4 execution types ───────────────────────────────────────────

export type ReportRow = Record<string, unknown>;

export interface ReportResult {
  tenant_id: string;
  generated_at: string;
  source_id: string;
  is_aggregate: boolean;
  rows: ReportRow[];
  aggregates: Record<string, number>;
  total_rows: number;
  candidate_rows: number;
  projection: string[];
  /** Only present for admin callers (BFF info-leak guard). */
  sql?: string;
  /** Only present for admin callers. */
  params?: Record<string, unknown>;
  duration_ms: number;
}

// ─── API client ───────────────────────────────────────────────────────

export const reportsBuilderApi = {
  listSources: () =>
    http
      .get<SourceCatalogResponse>('/v1/reports/builder/sources')
      .then((r) => r.data),

  getSource: (source_id: string) =>
    http
      .get<ReportDataSource>(`/v1/reports/builder/sources/${source_id}`)
      .then((r) => r.data),

  preview: (def: ReportDefinition) =>
    http
      .post<PreviewResponse>('/v1/reports/builder/preview', def)
      .then((r) => r.data),

  run: (def: ReportDefinition) =>
    http
      .post<ReportResult>('/v1/reports/builder/run', def)
      .then((r) => r.data),

  exportCsv: async (def: ReportDefinition): Promise<Blob> => {
    const r = await http.post('/v1/reports/builder/export.csv', def, {
      responseType: 'blob',
      // The BFF returns text/csv — the response interceptor's envelope
      // unwrap doesn't apply to non-JSON. Cast through to Blob.
      transformResponse: [(d) => d],
    });
    return r.data as Blob;
  },

  // Saved reports.
  listSaved: (params: {
    visibility?: ReportVisibility;
    source_id?: string;
    created_by?: string;
    tag?: string;
  } = {}) =>
    http
      .get<SavedReportListResponse>('/v1/reports/builder/saved', { params })
      .then((r) => r.data),

  getSaved: (report_id: string) =>
    http
      .get<SavedReport>(`/v1/reports/builder/saved/${report_id}`)
      .then((r) => r.data),

  createSaved: (input: CreateSavedReportInput) =>
    http
      .post<SavedReport>('/v1/reports/builder/saved', input)
      .then((r) => r.data),

  updateSaved: (report_id: string, patch: UpdateSavedReportInput) =>
    http
      .patch<SavedReport>(`/v1/reports/builder/saved/${report_id}`, patch)
      .then((r) => r.data),

  deleteSaved: (report_id: string) =>
    http
      .delete(`/v1/reports/builder/saved/${report_id}`)
      .then(() => undefined),

  runSaved: (report_id: string) =>
    http
      .post<ReportResult>(`/v1/reports/builder/saved/${report_id}/run`)
      .then((r) => r.data),
};
