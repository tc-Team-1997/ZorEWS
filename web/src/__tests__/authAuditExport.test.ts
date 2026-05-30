// web/src/__tests__/authAuditExport.test.ts
//
// Phase 9 T7-extension — AuthAuditEvent export helpers. Third sibling of
// auditExport.test.ts + adminActivityExport.test.ts.

import { describe, expect, it } from 'vitest';
import {
  AUTH_AUDIT_CSV_HEADERS,
  authAuditToCsv,
  buildAuthAuditPdf,
} from '@/lib/authAuditExport';
import type { AuthAuditEvent } from '@/store/auth';

const SAMPLE: AuthAuditEvent = {
  id: 'ae-001',
  ts: '2026-05-30T09:00:00Z',
  type: 'login_success',
  target_username: 'alice.admin',
  actor_username: 'alice.admin',
  actor_role: 'admin',
  ip: '10.0.0.1',
  metadata: { tenant_id: 'BANK_DEMO', channel: 'web' },
};

describe('authAuditToCsv (RFC 4180)', () => {
  it('emits header + 1 body line in canonical column order', () => {
    const csv = authAuditToCsv([SAMPLE]);
    const lines = csv.split('\r\n').filter(Boolean);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe(AUTH_AUDIT_CSV_HEADERS.join(','));
    const cells = lines[1].split(',');
    expect(cells[0]).toBe('ae-001');
    expect(cells[2]).toBe('login_success');
    expect(cells[6]).toBe('10.0.0.1');
  });

  it('JSON-serialises non-empty metadata; empty/null → empty cell', () => {
    expect(authAuditToCsv([SAMPLE])).toContain('"{""tenant_id"":""BANK_DEMO"",""channel"":""web""}"');

    const noMeta: AuthAuditEvent = { ...SAMPLE, metadata: {} };
    const csv = authAuditToCsv([noMeta]);
    const body = csv.split('\r\n')[1];
    expect(body.endsWith(',')).toBe(true); // metadata column is the last field
  });

  it('null target_username / actor_username / actor_role / ip become empty', () => {
    const sparse: AuthAuditEvent = {
      ...SAMPLE,
      target_username: null,
      actor_username: null,
      actor_role: null,
      ip: null,
    };
    const csv = authAuditToCsv([sparse]);
    const cells = csv.split('\r\n')[1].split(',');
    expect(cells[3]).toBe('');
    expect(cells[4]).toBe('');
    expect(cells[5]).toBe('');
    expect(cells[6]).toBe('');
  });

  it('quotes commas + quotes per RFC 4180', () => {
    const row: AuthAuditEvent = {
      ...SAMPLE,
      target_username: 'a,b,c',
      ip: 'has "quote"',
    };
    const csv = authAuditToCsv([row]);
    expect(csv).toContain('"a,b,c"');
    expect(csv).toContain('"has ""quote"""');
  });

  it('empty rows → header + CRLF only', () => {
    expect(authAuditToCsv([])).toBe(`${AUTH_AUDIT_CSV_HEADERS.join(',')}\r\n`);
  });
});

describe('buildAuthAuditPdf (smoke)', () => {
  it('returns a jsPDF instance with ≥1 page', () => {
    const doc = buildAuthAuditPdf([SAMPLE]);
    expect(typeof doc.save).toBe('function');
    expect(doc.getNumberOfPages()).toBeGreaterThanOrEqual(1);
  });

  it('runs against empty rows without throwing', () => {
    expect(() => buildAuthAuditPdf([])).not.toThrow();
  });
});
