// web/src/lib/adminActivityExport.ts
//
// Phase 9 T1 (partial) / sibling of auditExport.ts — CSV + PDF + Excel
// export for the multi-source admin audit log (AdminAuditLogRow). Same
// RFC 4180 / jspdf-autotable / write-excel-file pattern as
// auditExport.ts / scenarioExport.ts so the export pipeline stays
// consistent across all admin surfaces (compliance ops can pull the same
// shape from any admin page that surfaces an audit-style row list).

import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import writeXlsxFile from 'write-excel-file/browser';
import type { AdminAuditLogRow } from '@/lib/api';

/** RFC 4180: only quote when the cell contains comma / quote / newline. */
function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/** Stable column order — matches the AdminAuditLogRow interface. */
export const ADMIN_AUDIT_CSV_HEADERS = [
  'audit_id',
  'created_at',
  'tenant_id',
  'entity_type',
  'entity_id',
  'action',
  'actor_id',
  'actor_role',
  'reason',
  'request_id',
  'ip_address',
  'user_agent',
  'before_state',
  'after_state',
] as const;

export function adminActivityToCsv(rows: readonly AdminAuditLogRow[]): string {
  const header = ADMIN_AUDIT_CSV_HEADERS.join(',');
  const body = rows.map((r) =>
    ADMIN_AUDIT_CSV_HEADERS.map((col) => {
      if (col === 'before_state' || col === 'after_state') {
        const v = r[col];
        return v == null ? '' : csvCell(JSON.stringify(v));
      }
      return csvCell((r as unknown as Record<string, unknown>)[col]);
    }).join(','),
  );
  return [header, ...body].join('\r\n') + '\r\n';
}

export function downloadAdminActivityCsv(
  rows: readonly AdminAuditLogRow[],
  filenameStem = 'admin-activity',
): void {
  const csv = adminActivityToCsv(rows);
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

export function buildAdminActivityPdf(rows: readonly AdminAuditLogRow[]): jsPDF {
  const doc = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'a4' });

  doc.setFontSize(16);
  doc.setFont('helvetica', 'bold');
  doc.text('ZorEWS — Admin Activity', 40, 40);

  doc.setFontSize(9);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(80);
  doc.text(
    `Generated ${fmtTsForPdf(new Date().toISOString())} · ${rows.length} entr${rows.length === 1 ? 'y' : 'ies'}`,
    40,
    56,
  );
  doc.text(
    'Cross-source admin audit: user-access overrides · report exports · EWS rule reverts',
    40,
    70,
  );
  doc.setTextColor(0);

  autoTable(doc, {
    startY: 88,
    head: [['Created', 'Tenant', 'Entity', 'Action', 'Actor', 'Role', 'Reason', 'IP']],
    body: rows.map((r) => [
      fmtTsForPdf(r.created_at),
      r.tenant_id,
      `${r.entity_type}/${r.entity_id}`,
      r.action,
      r.actor_id,
      r.actor_role,
      r.reason ?? '',
      r.ip_address ?? '',
    ]),
    headStyles: { fillColor: PDF_HEADER_FILL, textColor: 255, fontSize: 9, fontStyle: 'bold' },
    bodyStyles: { fontSize: 8 },
    alternateRowStyles: { fillColor: [248, 250, 252] },
    theme: 'grid',
    margin: { left: 40, right: 40 },
    columnStyles: {
      0: { cellWidth: 130 },
      2: { cellWidth: 'auto' },
    },
  });

  return doc;
}

export function downloadAdminActivityPdf(
  rows: readonly AdminAuditLogRow[],
  filenameStem = 'admin-activity',
): void {
  const doc = buildAdminActivityPdf(rows);
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

function buildEntriesSheet(rows: readonly AdminAuditLogRow[]): XlsxCell[][] {
  const header: XlsxCell[] = ADMIN_AUDIT_CSV_HEADERS.map((h) => ({
    value: h,
    fontWeight: 'bold',
    backgroundColor: XLSX_HEADER_FILL,
    color: XLSX_HEADER_COLOR,
  }));
  const body: XlsxCell[][] = rows.map((r) =>
    ADMIN_AUDIT_CSV_HEADERS.map<XlsxCell>((col) => {
      if (col === 'before_state' || col === 'after_state') {
        const v = r[col];
        return { value: v == null ? '' : JSON.stringify(v), type: String };
      }
      const raw = (r as unknown as Record<string, unknown>)[col];
      return { value: raw == null ? '' : String(raw), type: String };
    }),
  );
  return [header, ...body];
}

function buildMetadataSheet(rows: readonly AdminAuditLogRow[]): XlsxCell[][] {
  const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19) + 'Z';
  return [
    [{ value: 'ZorEWS — Admin Activity', fontWeight: 'bold' }],
    [{ value: 'Generated at', fontWeight: 'bold' }, { value: stamp, type: String }],
    [{ value: 'Total entries', fontWeight: 'bold' }, { value: rows.length, type: Number }],
    [{ value: 'Schema', fontWeight: 'bold' }, { value: 'AdminAuditLogRow (multi-source)', type: String }],
    [{ value: 'Sources', fontWeight: 'bold' }, { value: 'user_access_override · report_export · ews_rule_version', type: String }],
  ];
}

export async function downloadAdminActivityXlsx(
  rows: readonly AdminAuditLogRow[],
  filenameStem = 'admin-activity',
): Promise<void> {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  await (writeXlsxFile as unknown as (
    sheets: { data: XlsxCell[][]; sheet: string }[],
  ) => { toFile: (name: string) => Promise<void> })([
    { data: buildMetadataSheet(rows), sheet: 'Metadata' },
    { data: buildEntriesSheet(rows), sheet: 'Entries' },
  ]).toFile(`${filenameStem}-${stamp}.xlsx`);
}
