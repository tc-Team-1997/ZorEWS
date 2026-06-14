// services/bff/src/exports/store.ts
//
// P1 — Enterprise Report Export Framework history + audit-record store.
// In-memory, per-tenant, FIFO-capped. pg-swap-ready: a PgExportHistoryStore
// satisfying ExportHistoryStore is a future drop-in (matches the T4.13–T4.18
// pattern). Records are written by POST /v1/exports on every export.

export const ALL_EXPORT_FORMATS = ['pdf', 'xlsx', 'csv'] as const;
export type ExportFormat = (typeof ALL_EXPORT_FORMATS)[number];

export const ALL_REPORT_TYPES = [
  'customer', 'risk', 'case', 'recovery',
  'compliance', 'portfolio', 'executive', 'ai_insight',
] as const;
export type ReportType = (typeof ALL_REPORT_TYPES)[number];

export function isExportFormat(v: unknown): v is ExportFormat {
  return typeof v === 'string' && (ALL_EXPORT_FORMATS as readonly string[]).includes(v);
}
export function isReportType(v: unknown): v is ReportType {
  return typeof v === 'string' && (ALL_REPORT_TYPES as readonly string[]).includes(v);
}

/** The modal's config, snapshotted so P1 can "re-run with same config". */
export interface ExportConfigSnapshot {
  formats: ExportFormat[];
  report_type: ReportType;
  date_range: string;
  data_scope: string;
  include: Record<string, boolean>;
  custom_range?: { from: string; to: string };
}

export interface ExportRecordInput {
  generated_by: string;
  role: string;
  module: string;
  report_type: ReportType;
  format: ExportFormat;
  record_count: number;
  title: string;
  status: 'completed' | 'failed';
  config: ExportConfigSnapshot;
  /** Optional base64 of the generated file, for byte-identical re-download.
   *  Stored separately + size/count-capped; never inlined into list/get views. */
  artifact_base64?: string;
  content_type?: string;
}

export interface ExportRecord extends Omit<ExportRecordInput, 'artifact_base64' | 'content_type'> {
  export_id: string;
  tenant_id: string;
  generated_at: string; // ISO
  has_artifact: boolean;
}

export interface ExportArtifact { base64: string; content_type: string; }

export interface ExportListFilters {
  module?: string;
  format?: ExportFormat;
  report_type?: ReportType;
  page?: number;
  page_size?: number;
}

export interface ExportListPage {
  items: ExportRecord[];
  total: number;
  page: number;
  page_size: number;
}

export interface ExportHistoryStore {
  add(tenant_id: string, input: ExportRecordInput, now: Date, seq: number): ExportRecord;
  list(tenant_id: string, filters: ExportListFilters): ExportListPage;
  get(tenant_id: string, export_id: string): ExportRecord | null;
  getArtifact(tenant_id: string, export_id: string): ExportArtifact | null;
}

export class ExportRecordError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'ExportRecordError';
  }
}

const DEFAULT_CAP = 500;
const MAX_ARTIFACT_B64 = 4 * 1024 * 1024; // ~4MB base64 ceiling per artifact

export class InMemoryExportHistoryStore implements ExportHistoryStore {
  private byTenant = new Map<string, ExportRecord[]>();
  /** per-tenant artifact store; Map insertion order = eviction order */
  private artifacts = new Map<string, Map<string, ExportArtifact>>();
  constructor(private readonly cap = DEFAULT_CAP, private readonly artifactCap = 50) {}

  add(tenant_id: string, input: ExportRecordInput, now: Date, seq: number): ExportRecord {
    if (!tenant_id) throw new ExportRecordError('invalid_input', 'tenant_id required');
    if (!input.module || typeof input.module !== 'string') {
      throw new ExportRecordError('invalid_input', 'module required');
    }
    if (!isExportFormat(input.format)) {
      throw new ExportRecordError('invalid_format', `invalid format: ${String(input.format)}`);
    }
    if (!isReportType(input.report_type)) {
      throw new ExportRecordError('invalid_report_type', `invalid report_type: ${String(input.report_type)}`);
    }
    // Strip artifact bytes out of the metadata record — never inline the blob.
    const { artifact_base64, content_type, ...meta } = input;
    const rec: ExportRecord = {
      ...meta,
      export_id: `EXP-${tenant_id}-${now.getTime()}-${seq}`,
      tenant_id,
      generated_at: now.toISOString(),
      has_artifact: false,
    };
    if (artifact_base64 && content_type && artifact_base64.length <= MAX_ARTIFACT_B64) {
      const am = this.artifacts.get(tenant_id) ?? new Map<string, ExportArtifact>();
      am.set(rec.export_id, { base64: artifact_base64, content_type });
      // evict oldest artifact(s) beyond the cap (insertion order = Map order)
      while (am.size > this.artifactCap) {
        const oldest = am.keys().next().value as string;
        am.delete(oldest);
        const stale = (this.byTenant.get(tenant_id) ?? []).find((r) => r.export_id === oldest);
        if (stale) stale.has_artifact = false;
      }
      this.artifacts.set(tenant_id, am);
      rec.has_artifact = true;
    }
    const list = this.byTenant.get(tenant_id) ?? [];
    list.push(rec);
    while (list.length > this.cap) list.shift();
    this.byTenant.set(tenant_id, list);
    return { ...rec };
  }

  getArtifact(tenant_id: string, export_id: string): ExportArtifact | null {
    const a = this.artifacts.get(tenant_id)?.get(export_id);
    return a ? { ...a } : null;
  }

  list(tenant_id: string, filters: ExportListFilters): ExportListPage {
    let rows = (this.byTenant.get(tenant_id) ?? []).slice();
    if (filters.module) rows = rows.filter((r) => r.module === filters.module);
    if (filters.format) rows = rows.filter((r) => r.format === filters.format);
    if (filters.report_type) rows = rows.filter((r) => r.report_type === filters.report_type);
    // newest-first
    rows.sort((a, b) => (a.generated_at < b.generated_at ? 1 : a.generated_at > b.generated_at ? -1 : 0));
    const total = rows.length;
    const page = Math.max(1, filters.page ?? 1);
    const page_size = Math.max(1, Math.min(200, filters.page_size ?? 50));
    const start = (page - 1) * page_size;
    return { items: rows.slice(start, start + page_size).map((r) => ({ ...r })), total, page, page_size };
  }

  get(tenant_id: string, export_id: string): ExportRecord | null {
    const rec = (this.byTenant.get(tenant_id) ?? []).find((r) => r.export_id === export_id);
    return rec ? { ...rec } : null;
  }
}

let _default: InMemoryExportHistoryStore | null = null;
export function defaultExportHistoryStore(): InMemoryExportHistoryStore {
  if (!_default) _default = new InMemoryExportHistoryStore();
  return _default;
}
export function _resetDefaultExportHistoryStore(): void {
  _default = null;
}
