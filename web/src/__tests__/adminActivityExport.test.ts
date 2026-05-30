// web/src/__tests__/adminActivityExport.test.ts
//
// Phase 9 T1-adjacent — AdminAuditLogRow export helpers. Mirror of
// auditExport.test.ts for the multi-source admin audit row shape.

import { describe, expect, it } from 'vitest';
import {
  ADMIN_AUDIT_CSV_HEADERS,
  adminActivityToCsv,
  buildAdminActivityPdf,
} from '@/lib/adminActivityExport';
import type { AdminAuditLogRow } from '@/lib/api';

const SAMPLE: AdminAuditLogRow = {
  audit_id: 'aa-001',
  tenant_id: 'BANK_DEMO',
  entity_type: 'user_access_override',
  entity_id: 'u-042',
  action: 'approve',
  actor_id: 'alice.admin',
  actor_role: 'admin',
  before_state: { scope: 'cases:read' },
  after_state: { scope: 'cases:write' },
  reason: 'Emergency triage',
  request_id: 'req-x',
  ip_address: '10.0.0.1',
  user_agent: 'Mozilla/5.0',
  created_at: '2026-05-30T09:00:00Z',
};

describe('adminActivityToCsv (RFC 4180)', () => {
  it('emits header + 1 body line per row in canonical column order', () => {
    const csv = adminActivityToCsv([SAMPLE]);
    const lines = csv.split('\r\n').filter(Boolean);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe(ADMIN_AUDIT_CSV_HEADERS.join(','));
    const cells = lines[1].split(',');
    expect(cells[0]).toBe('aa-001');
    expect(cells[1]).toBe('2026-05-30T09:00:00Z');
    expect(cells[2]).toBe('BANK_DEMO');
    expect(cells[3]).toBe('user_access_override');
  });

  it('serialises before_state / after_state as JSON', () => {
    const csv = adminActivityToCsv([SAMPLE]);
    expect(csv).toContain('"{""scope"":""cases:read""}"');
    expect(csv).toContain('"{""scope"":""cases:write""}"');
  });

  it('null reason / null nested state become empty cells', () => {
    const sparse: AdminAuditLogRow = {
      ...SAMPLE,
      reason: null,
      before_state: null,
      after_state: null,
      request_id: null,
      ip_address: null,
      user_agent: null,
    };
    const csv = adminActivityToCsv([sparse]);
    const cells = csv.split('\r\n')[1].split(',');
    // reason index = 8 per canonical column order
    expect(cells[8]).toBe('');
    expect(cells[10]).toBe(''); // ip_address
  });

  it('quotes commas + quotes + newlines per RFC 4180', () => {
    const row: AdminAuditLogRow = {
      ...SAMPLE,
      reason: 'override, escalated, comma test',
      user_agent: 'Has "quote" inside',
    };
    const csv = adminActivityToCsv([row]);
    expect(csv).toContain('"override, escalated, comma test"');
    expect(csv).toContain('"Has ""quote"" inside"');
  });

  it('empty rows → header + CRLF only', () => {
    expect(adminActivityToCsv([])).toBe(`${ADMIN_AUDIT_CSV_HEADERS.join(',')}\r\n`);
  });
});

describe('buildAdminActivityPdf (smoke)', () => {
  it('returns a jsPDF instance with at least one page', () => {
    const doc = buildAdminActivityPdf([SAMPLE]);
    expect(typeof doc.save).toBe('function');
    expect(typeof doc.output).toBe('function');
    expect(doc.getNumberOfPages()).toBeGreaterThanOrEqual(1);
  });

  it('runs against empty rows without throwing', () => {
    expect(() => buildAdminActivityPdf([])).not.toThrow();
  });
});
