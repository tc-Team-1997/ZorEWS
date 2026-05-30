// web/src/lib/auditExport.ts
//
// Phase 9 T7 — Audit Trail report export (CSV + PDF + Excel).
//
// Client-side serialisation of the M15.1 AuditEventRow list. Re-uses the
// same csvCell / jspdf-autotable / write-excel-file patterns as
// scenarioExport.ts + reportsExport.ts so the project's export pipeline
// stays consistent. All three formats respect the currently-filtered events
// page (the caller passes whatever `events.data?.items ?? []` resolves to).

import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import writeXlsxFile from 'write-excel-file/browser';
import type { AuditEventRow } from '@/lib/api';

/** RFC 4180: only quote when the cell contains comma / quote / newline. */
function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/** Stable column order — matches the AuditEventRow interface. */
export const AUDIT_CSV_HEADERS = [
  'event_id',
  'ts',
  'tenant_id',
  'actor_username',
  'actor_role',
  'action',
  'resource_type',
  'resource_id',
  'outcome',
  'severity',
  'correlation_id',
  'ip_address',
  'metadata',
] as const;

export function auditEventsToCsv(rows: readonly AuditEventRow[]): string {
  const header = AUDIT_CSV_HEADERS.join(',');
  const body = rows.map((r) =>
    AUDIT_CSV_HEADERS.map((col) => {
      if (col === 'metadata') {
        return r.metadata ? csvCell(JSON.stringify(r.metadata)) : '';
      }
      return csvCell((r as unknown as Record<string, unknown>)[col]);
    }).join(','),
  );
  // Trailing CRLF per RFC 4180 §2.1 — keeps Content-Length stable on empty body.
  return [header, ...body].join('\r\n') + '\r\n';
}

export function downloadAuditEventsCsv(
  rows: readonly AuditEventRow[],
  filenameStem = 'audit-trail',
): void {
  const csv = auditEventsToCsv(rows);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${filenameStem}-${stamp}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ─── PDF ──────────────────────────────────────────────────────────────

/** Aurora indigo (#6366F1) for table headers — matches the SPA accent. */
const PDF_HEADER_FILL: [number, number, number] = [99, 102, 241];

function fmtTsForPdf(iso: string): string {
  try {
    return new Date(iso).toISOString().replace('T', ' ').slice(0, 19) + 'Z';
  } catch {
    return iso;
  }
}

/** A4-landscape PDF: header block + filter summary + main events table. */
export function buildAuditEventsPdf(rows: readonly AuditEventRow[]): jsPDF {
  const doc = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'a4' });

  doc.setFontSize(16);
  doc.setFont('helvetica', 'bold');
  doc.text('ZorEWS — Audit Trail', 40, 40);

  doc.setFontSize(9);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(80);
  doc.text(
    `Generated ${fmtTsForPdf(new Date().toISOString())} · ${rows.length} event${rows.length === 1 ? '' : 's'}`,
    40,
    56,
  );
  doc.text(
    'Immutable cryptographic ledger — SHA-256 hash-chained (RBI Cyber Resilience §4.3)',
    40,
    70,
  );
  doc.setTextColor(0);

  autoTable(doc, {
    startY: 88,
    head: [['Timestamp', 'Actor', 'Role', 'Action', 'Resource', 'Outcome', 'Sev', 'Tenant']],
    body: rows.map((r) => [
      fmtTsForPdf(r.ts),
      r.actor_username,
      r.actor_role,
      r.action,
      `${r.resource_type}/${r.resource_id}`,
      r.outcome,
      r.severity,
      r.tenant_id,
    ]),
    headStyles: { fillColor: PDF_HEADER_FILL, textColor: 255, fontSize: 9, fontStyle: 'bold' },
    bodyStyles: { fontSize: 8 },
    alternateRowStyles: { fillColor: [248, 250, 252] },
    theme: 'grid',
    margin: { left: 40, right: 40 },
    columnStyles: {
      0: { cellWidth: 130 },
      4: { cellWidth: 'auto' },
    },
  });

  return doc;
}

export function downloadAuditEventsPdf(
  rows: readonly AuditEventRow[],
  filenameStem = 'audit-trail',
): void {
  const doc = buildAuditEventsPdf(rows);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  doc.save(`${filenameStem}-${stamp}.pdf`);
}

// ─── XLSX ─────────────────────────────────────────────────────────────

type XlsxCell = {
  value?: string | number;
  type?: typeof String | typeof Number;
  fontWeight?: 'bold';
  backgroundColor?: string;
  color?: string;
  align?: 'left' | 'right';
};

const XLSX_HEADER_FILL = '#6366F1';
const XLSX_HEADER_COLOR = '#FFFFFF';

/** Build the single Events sheet (header row in aurora indigo). */
function buildEventsSheet(rows: readonly AuditEventRow[]): XlsxCell[][] {
  const header: XlsxCell[] = AUDIT_CSV_HEADERS.map((h) => ({
    value: h,
    fontWeight: 'bold',
    backgroundColor: XLSX_HEADER_FILL,
    color: XLSX_HEADER_COLOR,
  }));
  const body: XlsxCell[][] = rows.map((r) =>
    AUDIT_CSV_HEADERS.map<XlsxCell>((col) => {
      if (col === 'metadata') {
        return { value: r.metadata ? JSON.stringify(r.metadata) : '', type: String };
      }
      const raw = (r as unknown as Record<string, unknown>)[col];
      return { value: raw == null ? '' : String(raw), type: String };
    }),
  );
  return [header, ...body];
}

/** Optional metadata sheet — file context + counts (per scenarioExport convention). */
function buildMetadataSheet(rows: readonly AuditEventRow[]): XlsxCell[][] {
  const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19) + 'Z';
  return [
    [{ value: 'ZorEWS — Audit Trail', fontWeight: 'bold' }],
    [{ value: 'Generated at', fontWeight: 'bold' }, { value: stamp, type: String }],
    [{ value: 'Total events', fontWeight: 'bold' }, { value: rows.length, type: Number }],
    [{ value: 'Schema', fontWeight: 'bold' }, { value: 'M15.1 AuditEventRow', type: String }],
    [{ value: 'Compliance', fontWeight: 'bold' }, { value: 'RBI Cyber Resilience §4.3', type: String }],
  ];
}

export async function downloadAuditEventsXlsx(
  rows: readonly AuditEventRow[],
  filenameStem = 'audit-trail',
): Promise<void> {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  // write-excel-file/browser's strict generic narrowing rejects the union-typed
  // cells when typed through Sheet<unknown>[] — cast via unknown like
  // builderExport.ts does for the same reason (T4.6.6 precedent).
  await (writeXlsxFile as unknown as (
    sheets: { data: XlsxCell[][]; sheet: string }[],
  ) => { toFile: (name: string) => Promise<void> })([
    { data: buildMetadataSheet(rows), sheet: 'Metadata' },
    { data: buildEventsSheet(rows), sheet: 'Events' },
  ]).toFile(`${filenameStem}-${stamp}.xlsx`);
}
