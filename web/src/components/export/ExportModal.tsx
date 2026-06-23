// web/src/components/export/ExportModal.tsx — format + config + generate.
import { useState } from 'react';
import { Modal, Button } from '@/components/ui';
import {
  ALL_EXPORT_FORMATS, DEFAULT_INCLUDE,
  type ExportFormat, type ReportType, type ReportAdapter,
  type ExportConfig, type DateRangeKey, type DataScope, type ReportSectionKey,
} from '@/lib/export/types';
import { buildReportCsv } from '@/lib/export/generators/csv';
import { reportPdfBlob } from '@/lib/export/generators/pdf';
import { buildReportXlsxBlob } from '@/lib/export/generators/xlsx';
import { buildReportDocxBlob } from '@/lib/export/generators/docx';
import { buildExecutiveNarrative } from '@/lib/export/narrative';
import { recordExport } from '@/lib/export/recordExport';

const DATE_RANGES: { key: DateRangeKey; label: string }[] = [
  { key: 'today', label: 'Today' }, { key: '7d', label: 'Last 7 Days' },
  { key: '30d', label: 'Last 30 Days' }, { key: 'quarter', label: 'Quarter' }, { key: 'custom', label: 'Custom' },
];
const SCOPES: { key: DataScope; label: string }[] = [
  { key: 'current_page', label: 'Current Page' }, { key: 'filtered', label: 'Filtered Records' },
  { key: 'selected', label: 'Selected Records' }, { key: 'complete', label: 'Complete Dataset' },
];
const SECTIONS: { key: ReportSectionKey; label: string }[] = [
  { key: 'summary', label: 'Summary' }, { key: 'kpis', label: 'KPIs' }, { key: 'trends', label: 'Trends' },
  { key: 'charts', label: 'Charts' }, { key: 'alerts', label: 'Alerts' }, { key: 'ai_insights', label: 'AI Insights' },
  { key: 'recommendations', label: 'Recommendations' }, { key: 'audit_trail', label: 'Audit Trail' },
  { key: 'workflow_history', label: 'Workflow History' },
];
const REPORT_TYPES: ReportType[] = ['customer', 'risk', 'case', 'recovery', 'compliance', 'portfolio', 'executive', 'ai_insight'];

function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; document.body.appendChild(a); a.click();
  document.body.removeChild(a); URL.revokeObjectURL(url);
}

async function blobToBase64(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer();
  let binary = ''; const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

const MIME: Record<ExportFormat, string> = {
  csv: 'text/csv', pdf: 'application/pdf',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

export interface ExportModalProps {
  open: boolean;
  onClose: () => void;
  adapter: ReportAdapter;
  module: string;
  defaultReportType: ReportType;
}

export function ExportModal({ open, onClose, adapter, module, defaultReportType }: ExportModalProps) {
  const [formats, setFormats] = useState<ExportFormat[]>(['pdf']);
  const [reportType, setReportType] = useState<ReportType>(defaultReportType);
  const [dateRange, setDateRange] = useState<DateRangeKey>('30d');
  const [scope, setScope] = useState<DataScope>('complete');
  const [include, setInclude] = useState<Record<ReportSectionKey, boolean>>(DEFAULT_INCLUDE);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggleFormat = (f: ExportFormat) =>
    setFormats((cur) => (cur.includes(f) ? cur.filter((x) => x !== f) : [...cur, f]));

  async function generate() {
    setError(null);
    if (formats.length === 0) { setError('Select at least one format'); return; }
    setBusy(true);
    const config: ExportConfig = { formats, report_type: reportType, date_range: dateRange, data_scope: scope, include };
    try {
      const data = await adapter(config);
      if (config.include.ai_insights && !data.sections.ai_insights) {
        data.sections.ai_insights = { narrative: buildExecutiveNarrative(data) };
      }
      const slug = (data.subject?.id ?? module).replace(/\W+/g, '_');
      const stamp = new Date().toISOString().slice(0, 10);
      for (const fmt of formats) {
        let blob: Blob;
        if (fmt === 'csv') blob = buildReportCsv(data, config);
        else if (fmt === 'pdf') blob = reportPdfBlob(data, config);
        else if (fmt === 'docx') blob = await buildReportDocxBlob(data, config);
        else blob = await buildReportXlsxBlob(data, config);
        download(blob, `${module}-${slug}-${stamp}.${fmt}`);
        let artifact_base64: string | undefined;
        try { artifact_base64 = await blobToBase64(blob); } catch { artifact_base64 = undefined; }
        await recordExport({
          module, report_type: reportType, format: fmt, record_count: data.record_count,
          title: data.title, status: 'completed',
          config: { formats, report_type: reportType, date_range: dateRange, data_scope: scope, include },
          artifact_base64, content_type: MIME[fmt],
        });
      }
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Export failed');
      await recordExport({
        module, report_type: reportType, format: formats[0], record_count: 0,
        title: `${module} export`, status: 'failed',
        config: { formats, report_type: reportType, date_range: dateRange, data_scope: scope, include },
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} ariaLabel="Generate Report" size="2xl" testId="export-modal">
      <div className="p-6 space-y-5">
        <h2 className="text-lg font-semibold text-aurora-ink">Generate Report</h2>

        <div>
          <div className="text-sm font-medium mb-2">Formats</div>
          <div className="flex gap-3">
            {ALL_EXPORT_FORMATS.map((f) => (
              <label key={f} className="flex items-center gap-2 text-sm">
                <input type="checkbox" data-testid={`export-format-${f}`} checked={formats.includes(f)} onChange={() => toggleFormat(f)} />
                {f === 'docx' ? 'WORD (.docx)' : f.toUpperCase()}
              </label>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          <label className="text-sm">Report Type
            <select className="input mt-1" value={reportType} onChange={(e) => setReportType(e.target.value as ReportType)} data-testid="export-report-type">
              {REPORT_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </label>
          <label className="text-sm">Date Range
            <select className="input mt-1" value={dateRange} onChange={(e) => setDateRange(e.target.value as DateRangeKey)} data-testid="export-date-range">
              {DATE_RANGES.map((d) => <option key={d.key} value={d.key}>{d.label}</option>)}
            </select>
          </label>
          <label className="text-sm">Data Scope
            <select className="input mt-1" value={scope} onChange={(e) => setScope(e.target.value as DataScope)} data-testid="export-scope">
              {SCOPES.map((sc) => <option key={sc.key} value={sc.key}>{sc.label}</option>)}
            </select>
          </label>
        </div>

        <div>
          <div className="text-sm font-medium mb-2">Include Sections</div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
            {SECTIONS.map((sec) => (
              <label key={sec.key} className="flex items-center gap-2 text-sm">
                <input type="checkbox" data-testid={`export-section-${sec.key}`} checked={include[sec.key]}
                  onChange={() => setInclude((cur) => ({ ...cur, [sec.key]: !cur[sec.key] }))} />
                {sec.label}
              </label>
            ))}
          </div>
        </div>

        {error && <div className="text-sm text-danger" data-testid="export-error">{error}</div>}

        <div className="flex justify-end gap-3">
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button onClick={generate} disabled={busy} data-testid="export-generate">{busy ? 'Generating…' : 'Generate'}</Button>
        </div>
      </div>
    </Modal>
  );
}
