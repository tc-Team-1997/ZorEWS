// web/src/lib/auditExport.ts
//
// Phase 9 T7 — Audit Trail report export (CSV).
//
// Client-side serialisation of the M15.1 AuditEventRow list to RFC 4180
// CSV + a Blob/anchor downloader. Re-uses the same csvCell escaping shape
// as scenarioExport.ts so the project's CSV output stays consistent. PDF +
// Excel are scoped as a follow-up (re-using jspdf-autotable +
// write-excel-file/browser, already in deps from the scenario + reports
// export pipeline).

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
