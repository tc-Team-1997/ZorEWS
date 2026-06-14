// web/src/lib/export/recordExport.ts — best-effort audit/history record.
import { http } from '@/lib/http';
import type { ExportFormat, ReportType } from './types';

export interface RecordExportInput {
  module: string;
  report_type: ReportType;
  format: ExportFormat;
  record_count: number;
  title: string;
  status: 'completed' | 'failed';
  config: {
    formats: ExportFormat[]; report_type: ReportType;
    date_range: string; data_scope: string; include: Record<string, boolean>;
    custom_range?: { from: string; to: string };
  };
  /** Base64-encoded generated artifact, stored server-side for re-download (P4). */
  artifact_base64?: string;
  /** MIME type of the artifact (e.g. text/csv, application/pdf). */
  content_type?: string;
}

/** Fire-and-forget — the client download already succeeded; never block on this. */
export async function recordExport(input: RecordExportInput): Promise<void> {
  try {
    await http.post('/v1/exports', input);
  } catch (e) {
    // Best-effort: the export already downloaded. Log + move on.
    // eslint-disable-next-line no-console
    console.warn('[export] failed to record export history:', e instanceof Error ? e.message : e);
  }
}
