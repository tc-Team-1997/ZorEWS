// web/src/lib/export/generators/csv.ts — primary-table-only CSV (RFC 4180).
import type { ReportData, ExportConfig } from '../types';

function esc(v: string | number): string {
  const s = String(v ?? '');
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function buildReportCsv(data: ReportData, _config: ExportConfig): Blob {
  const table = data.sections.tables?.[0];
  let text: string;
  if (!table || table.rows.length === 0) {
    text = `# ${data.title}\r\nNo tabular records for this scope\r\n`;
  } else {
    const header = table.columns.map(esc).join(',');
    const rows = table.rows.map((r) => r.map(esc).join(','));
    text = [header, ...rows].join('\r\n') + '\r\n';
  }
  return new Blob([text], { type: 'text/csv;charset=utf-8' });
}
