// web/src/modules/reports/builder/builderExport.ts
//
// T4.6.6 — Self-service report builder client-side PDF + Excel export.
//
// Mirrors the pattern in `web/src/lib/reportsExport.ts` (T4.18 / 2026-
// 05-09) but works against the T4.6.4 ReportResult envelope. Both
// renderers run in the browser — no BFF round-trip needed since the
// result is already in memory after a /run.

import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import writeXlsxFile, { type Sheet } from 'write-excel-file/browser';

import type { ReportResult, SavedReport } from './api';

// ─── PDF ──────────────────────────────────────────────────────────────

function dateStamp(): string {
  return new Date().toISOString().slice(0, 10);
}

function formatCellPdf(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return v.toLocaleString();
  return String(v);
}

export function buildBuilderReportPdf(
  result: ReportResult,
  saved?: SavedReport | null,
): jsPDF {
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  const margin = 40;

  doc.setFontSize(16);
  doc.text('ZorEWS — Report Builder', margin, margin);

  doc.setFontSize(9);
  doc.setTextColor(110);
  doc.text(`Report: ${saved?.name ?? '(unsaved)'}`, margin, margin + 16);
  doc.text(`Source: ${result.source_id}`, margin, margin + 30);
  doc.text(`Generated: ${result.generated_at}`, margin, margin + 44);
  doc.text(
    `Rows: ${result.total_rows} of ${result.candidate_rows} candidates — ${result.duration_ms}ms`,
    margin,
    margin + 58,
  );
  doc.setTextColor(0);

  let cursor = margin + 80;

  // Aggregates as a header table when present.
  if (Object.keys(result.aggregates).length > 0) {
    autoTable(doc, {
      startY: cursor,
      head: [['Metric', 'Value']],
      body: Object.entries(result.aggregates).map(([k, v]) => [k, formatCellPdf(v)]),
      theme: 'grid',
      styles: { fontSize: 8 },
      headStyles: { fillColor: [37, 99, 235] },
      margin: { left: margin, right: margin },
    });
    // @ts-expect-error — autoTable mutates the doc with lastAutoTable.
    cursor = (doc.lastAutoTable.finalY ?? cursor) + 20;
  }

  // Main result table — cap rows for PDF readability (CSV/Excel carry
  // the full set).
  const cap = 200;
  const rowsForPdf = result.rows.slice(0, cap);
  autoTable(doc, {
    startY: cursor,
    head: [result.projection],
    body: rowsForPdf.map((row) => result.projection.map((col) => formatCellPdf(row[col]))),
    theme: 'striped',
    styles: { fontSize: 7, cellPadding: 3 },
    headStyles: { fillColor: [37, 99, 235], fontSize: 8 },
    margin: { left: margin, right: margin },
  });
  if (result.rows.length > cap) {
    // @ts-expect-error — autoTable mutates the doc with lastAutoTable.
    const finalY = (doc.lastAutoTable?.finalY ?? cursor) + 12;
    doc.setFontSize(8);
    doc.setTextColor(110);
    doc.text(
      `(Showing first ${cap} of ${result.rows.length} rows — export Excel for full set.)`,
      margin,
      finalY,
    );
    doc.setTextColor(0);
  }

  return doc;
}

export function downloadBuilderReportPdf(
  result: ReportResult,
  saved?: SavedReport | null,
): void {
  const doc = buildBuilderReportPdf(result, saved);
  const slug = result.source_id.replace(/\W+/g, '_');
  doc.save(`report-${slug}-${dateStamp()}.pdf`);
}

// ─── Excel ────────────────────────────────────────────────────────────

interface XlsxCell {
  value?: string | number | boolean | Date | null;
  fontWeight?: 'bold';
  backgroundColor?: string;
  color?: string;
  type?: typeof String | typeof Number | typeof Boolean | typeof Date;
  align?: 'left' | 'center' | 'right';
}

function xlsxCellValue(v: unknown): XlsxCell {
  if (v === null || v === undefined) return { value: null };
  if (typeof v === 'boolean') return { type: Boolean, value: v };
  if (typeof v === 'number') {
    return { type: Number, value: Number.isFinite(v) ? v : null, align: 'right' };
  }
  // dates ISO-8601 → leave as string for Excel-friendly display
  return { type: String, value: String(v) };
}

function headerCell(label: string): XlsxCell {
  return {
    value: label,
    fontWeight: 'bold',
    backgroundColor: '#2563EB',
    color: '#FFFFFF',
  };
}

export async function downloadBuilderReportXlsx(
  result: ReportResult,
  saved?: SavedReport | null,
): Promise<void> {
  // Sheet 1 — metadata.
  const metadataSheet: XlsxCell[][] = [
    [headerCell('Field'), headerCell('Value')],
    [{ value: 'Report' }, { value: saved?.name ?? '(unsaved)' }],
    [{ value: 'Source' }, { value: result.source_id }],
    [{ value: 'Tenant' }, { value: result.tenant_id }],
    [{ value: 'Generated at' }, { value: result.generated_at }],
    [{ value: 'Total rows' }, { type: Number, value: result.total_rows }],
    [{ value: 'Candidate rows' }, { type: Number, value: result.candidate_rows }],
    [{ value: 'Duration ms' }, { type: Number, value: result.duration_ms }],
    [{ value: 'Aggregate report?' }, { type: Boolean, value: result.is_aggregate }],
  ];

  // Sheet 2 — aggregates (only when present).
  const aggKeys = Object.keys(result.aggregates);
  const aggregatesSheet: XlsxCell[][] | null = aggKeys.length > 0
    ? [
        [headerCell('Metric'), headerCell('Value')],
        ...aggKeys.map((k) => [
          { value: k } satisfies XlsxCell,
          xlsxCellValue(result.aggregates[k]),
        ]),
      ]
    : null;

  // Sheet 3 — rows.
  const rowsSheet: XlsxCell[][] = [
    result.projection.map(headerCell),
    ...result.rows.map((row) => result.projection.map((col) => xlsxCellValue(row[col]))),
  ];

  const sheets: Array<{ sheet: string; data: XlsxCell[][] }> = [
    { sheet: 'Metadata', data: metadataSheet },
  ];
  if (aggregatesSheet) sheets.push({ sheet: 'Aggregates', data: aggregatesSheet });
  sheets.push({ sheet: 'Rows', data: rowsSheet });

  const slug = result.source_id.replace(/\W+/g, '_');
  // The library's strict CellType<Value> constructor narrowing rejects our
  // permissive XlsxCell — cast through unknown since the shape is valid at
  // runtime (sheet + data are the only required keys).
  await writeXlsxFile(sheets as unknown as Sheet<Blob>[]).toFile(`report-${slug}-${dateStamp()}.xlsx`);
}
