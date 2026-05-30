// web/src/lib/authAuditExport.ts
//
// Phase 9 T7-extension — Auth audit-log export (CSV + PDF + Excel).
// Third sibling to auditExport.ts (M15.1 BFF audit chain) +
// adminActivityExport.ts (cross-source admin trail). Targets the
// auth-svc AuthAuditEvent row shape (login_*/lockout/password_reset/etc.).
// Same RFC 4180 / jspdf-autotable / write-excel-file pattern keeps the
// project's export pipeline consistent across every admin-audit surface.

import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import writeXlsxFile from 'write-excel-file/browser';
import type { AuthAuditEvent } from '@/store/auth';

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export const AUTH_AUDIT_CSV_HEADERS = [
  'id',
  'ts',
  'type',
  'target_username',
  'actor_username',
  'actor_role',
  'ip',
  'metadata',
] as const;

export function authAuditToCsv(rows: readonly AuthAuditEvent[]): string {
  const header = AUTH_AUDIT_CSV_HEADERS.join(',');
  const body = rows.map((r) =>
    AUTH_AUDIT_CSV_HEADERS.map((col) => {
      if (col === 'metadata') {
        return r.metadata && Object.keys(r.metadata).length
          ? csvCell(JSON.stringify(r.metadata))
          : '';
      }
      return csvCell((r as unknown as Record<string, unknown>)[col]);
    }).join(','),
  );
  return [header, ...body].join('\r\n') + '\r\n';
}

export function downloadAuthAuditCsv(
  rows: readonly AuthAuditEvent[],
  filenameStem = 'auth-audit',
): void {
  const csv = authAuditToCsv(rows);
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

const PDF_HEADER_FILL: [number, number, number] = [99, 102, 241];

function fmtTsForPdf(iso: string): string {
  try {
    return new Date(iso).toISOString().replace('T', ' ').slice(0, 19) + 'Z';
  } catch {
    return iso;
  }
}

export function buildAuthAuditPdf(rows: readonly AuthAuditEvent[]): jsPDF {
  const doc = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'a4' });

  doc.setFontSize(16);
  doc.setFont('helvetica', 'bold');
  doc.text('ZorEWS — Auth Audit Log', 40, 40);

  doc.setFontSize(9);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(80);
  doc.text(
    `Generated ${fmtTsForPdf(new Date().toISOString())} · ${rows.length} event${rows.length === 1 ? '' : 's'}`,
    40,
    56,
  );
  doc.text(
    'Authentication-related events captured by auth-svc · admin + supervisor only',
    40,
    70,
  );
  doc.setTextColor(0);

  autoTable(doc, {
    startY: 88,
    head: [['Timestamp', 'Type', 'Target', 'Actor', 'Role', 'IP']],
    body: rows.map((r) => [
      fmtTsForPdf(r.ts),
      r.type,
      r.target_username ?? '',
      r.actor_username ?? '',
      r.actor_role ?? '',
      r.ip ?? '',
    ]),
    headStyles: { fillColor: PDF_HEADER_FILL, textColor: 255, fontSize: 9, fontStyle: 'bold' },
    bodyStyles: { fontSize: 8 },
    alternateRowStyles: { fillColor: [248, 250, 252] },
    theme: 'grid',
    margin: { left: 40, right: 40 },
    columnStyles: {
      0: { cellWidth: 130 },
      1: { cellWidth: 170 },
    },
  });

  return doc;
}

export function downloadAuthAuditPdf(
  rows: readonly AuthAuditEvent[],
  filenameStem = 'auth-audit',
): void {
  const doc = buildAuthAuditPdf(rows);
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

function buildEventsSheet(rows: readonly AuthAuditEvent[]): XlsxCell[][] {
  const header: XlsxCell[] = AUTH_AUDIT_CSV_HEADERS.map((h) => ({
    value: h,
    fontWeight: 'bold',
    backgroundColor: XLSX_HEADER_FILL,
    color: XLSX_HEADER_COLOR,
  }));
  const body: XlsxCell[][] = rows.map((r) =>
    AUTH_AUDIT_CSV_HEADERS.map<XlsxCell>((col) => {
      if (col === 'metadata') {
        const v = r.metadata && Object.keys(r.metadata).length ? JSON.stringify(r.metadata) : '';
        return { value: v, type: String };
      }
      const raw = (r as unknown as Record<string, unknown>)[col];
      return { value: raw == null ? '' : String(raw), type: String };
    }),
  );
  return [header, ...body];
}

function buildMetadataSheet(rows: readonly AuthAuditEvent[]): XlsxCell[][] {
  const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19) + 'Z';
  return [
    [{ value: 'ZorEWS — Auth Audit Log', fontWeight: 'bold' }],
    [{ value: 'Generated at', fontWeight: 'bold' }, { value: stamp, type: String }],
    [{ value: 'Total events', fontWeight: 'bold' }, { value: rows.length, type: Number }],
    [{ value: 'Schema', fontWeight: 'bold' }, { value: 'auth-svc AuthAuditEvent', type: String }],
    [{ value: 'Scope', fontWeight: 'bold' }, { value: 'login / lockout / password reset / 2FA events', type: String }],
  ];
}

export async function downloadAuthAuditXlsx(
  rows: readonly AuthAuditEvent[],
  filenameStem = 'auth-audit',
): Promise<void> {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  await (writeXlsxFile as unknown as (
    sheets: { data: XlsxCell[][]; sheet: string }[],
  ) => { toFile: (name: string) => Promise<void> })([
    { data: buildMetadataSheet(rows), sheet: 'Metadata' },
    { data: buildEventsSheet(rows), sheet: 'Events' },
  ]).toFile(`${filenameStem}-${stamp}.xlsx`);
}
