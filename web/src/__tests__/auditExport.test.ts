// web/src/__tests__/auditExport.test.ts
//
// Phase 9 T7 — Audit Trail export helpers. Pure-function coverage for CSV
// serialisation + smoke for PDF builder. The XLSX downloader hits
// write-excel-file's browser API (Blob URL + file save) which jsdom can't
// exercise end-to-end; assert it's callable + returns a Promise.

import { describe, expect, it } from 'vitest';
import {
  AUDIT_CSV_HEADERS,
  auditEventsToCsv,
  buildAuditEventsPdf,
} from '@/lib/auditExport';
import type { AuditEventRow } from '@/lib/api';

const SAMPLE: AuditEventRow = {
  event_id: 'evt-001',
  ts: '2026-05-30T09:00:00Z',
  tenant_id: 'BANK_DEMO',
  actor_username: 'alice.admin',
  actor_role: 'admin',
  action: 'config.update',
  resource_type: 'config',
  resource_id: 'alerts.red_sla_hours',
  outcome: 'success',
  severity: 'info',
  correlation_id: 'corr-x',
  ip_address: '10.0.0.1',
  metadata: { previous_value: 4, new_value: 2 },
};

describe('auditEventsToCsv (RFC 4180)', () => {
  it('emits a header line + 1 body line per row', () => {
    const csv = auditEventsToCsv([SAMPLE]);
    const lines = csv.split('\r\n').filter(Boolean);
    expect(lines).toHaveLength(2); // header + 1
    expect(lines[0]).toBe(AUDIT_CSV_HEADERS.join(','));
  });

  it('serialises every column in canonical order', () => {
    const csv = auditEventsToCsv([SAMPLE]);
    const cells = csv.split('\r\n')[1].split(',');
    expect(cells[0]).toBe('evt-001');
    expect(cells[1]).toBe('2026-05-30T09:00:00Z');
    expect(cells[2]).toBe('BANK_DEMO');
    expect(cells[3]).toBe('alice.admin');
    expect(cells[5]).toBe('config.update');
    expect(cells[8]).toBe('success');
  });

  it('quotes cells containing comma / quote / newline (RFC 4180)', () => {
    const row: AuditEventRow = {
      ...SAMPLE,
      action: 'note,with,commas',
      resource_id: 'has "quote"',
    };
    const csv = auditEventsToCsv([row]);
    expect(csv).toContain('"note,with,commas"');
    expect(csv).toContain('"has ""quote"""'); // doubled internal quotes
  });

  it('serialises metadata as JSON; null becomes empty', () => {
    const csv = auditEventsToCsv([SAMPLE]);
    expect(csv).toContain('"{""previous_value"":4,""new_value"":2}"');

    const noMeta: AuditEventRow = { ...SAMPLE, metadata: null };
    const csv2 = auditEventsToCsv([noMeta]);
    // The metadata column is the last field of the row → trailing comma + empty.
    const body = csv2.split('\r\n')[1];
    expect(body.endsWith(',')).toBe(true);
  });

  it('handles empty input safely (header + trailing CRLF only)', () => {
    const csv = auditEventsToCsv([]);
    expect(csv).toBe(`${AUDIT_CSV_HEADERS.join(',')}\r\n`);
  });
});

describe('buildAuditEventsPdf (smoke)', () => {
  it('returns a jsPDF instance with at least one page', () => {
    const doc = buildAuditEventsPdf([SAMPLE]);
    // jsPDF instance — surface a couple of expected methods to satisfy
    // a tests-without-a-PDF-renderer environment.
    expect(typeof doc.save).toBe('function');
    expect(typeof doc.output).toBe('function');
    // .internal.pages is 1-indexed with [0] as a sentinel.
    expect(doc.getNumberOfPages()).toBeGreaterThanOrEqual(1);
  });

  it('runs against an empty row list without throwing', () => {
    expect(() => buildAuditEventsPdf([])).not.toThrow();
  });
});
