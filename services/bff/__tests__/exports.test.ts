import {
  InMemoryExportHistoryStore,
  ExportRecordError,
  type ExportRecordInput,
} from '../src/exports/store';

const NOW = new Date('2026-06-13T10:00:00.000Z');
function input(over: Partial<ExportRecordInput> = {}): ExportRecordInput {
  return {
    generated_by: 'alice.admin',
    role: 'admin',
    module: 'customer_360',
    report_type: 'customer',
    format: 'pdf',
    record_count: 12,
    title: 'Customer Report — c-101',
    status: 'completed',
    config: { formats: ['pdf'], report_type: 'customer', date_range: '30d', data_scope: 'complete', include: {} },
    ...over,
  };
}

describe('InMemoryExportHistoryStore', () => {
  test('add() returns a record with EXP- id, tenant, and echoed fields', () => {
    const s = new InMemoryExportHistoryStore();
    const rec = s.add('BANK_DEMO', input(), NOW, 1);
    expect(rec.export_id).toBe('EXP-BANK_DEMO-1781344800000-1');
    expect(rec.tenant_id).toBe('BANK_DEMO');
    expect(rec.format).toBe('pdf');
    expect(rec.record_count).toBe(12);
    expect(rec.status).toBe('completed');
    expect(rec.generated_at).toBe('2026-06-13T10:00:00.000Z');
  });

  test('list() is newest-first and tenant-scoped', () => {
    const s = new InMemoryExportHistoryStore();
    s.add('BANK_DEMO', input({ format: 'csv' }), new Date('2026-06-13T10:00:00Z'), 1);
    s.add('BANK_DEMO', input({ format: 'pdf' }), new Date('2026-06-13T11:00:00Z'), 2);
    s.add('BIL', input(), new Date('2026-06-13T12:00:00Z'), 3);
    const page = s.list('BANK_DEMO', {});
    expect(page.total).toBe(2);
    expect(page.items[0].format).toBe('pdf'); // newest first
    expect(page.items.every((r) => r.tenant_id === 'BANK_DEMO')).toBe(true);
  });

  test('list() filters by module + format', () => {
    const s = new InMemoryExportHistoryStore();
    s.add('BANK_DEMO', input({ module: 'alerts', format: 'csv' }), NOW, 1);
    s.add('BANK_DEMO', input({ module: 'customer_360', format: 'pdf' }), NOW, 2);
    expect(s.list('BANK_DEMO', { module: 'alerts' }).total).toBe(1);
    expect(s.list('BANK_DEMO', { format: 'pdf' }).total).toBe(1);
  });

  test('get() returns the record incl. config_snapshot, null cross-tenant', () => {
    const s = new InMemoryExportHistoryStore();
    const rec = s.add('BANK_DEMO', input(), NOW, 1);
    expect(s.get('BANK_DEMO', rec.export_id)?.config.report_type).toBe('customer');
    expect(s.get('BIL', rec.export_id)).toBeNull();
  });

  test('add() rejects invalid format / missing module', () => {
    const s = new InMemoryExportHistoryStore();
    expect(() => s.add('BANK_DEMO', input({ format: 'docx' as never }), NOW, 1)).toThrow(ExportRecordError);
    expect(() => s.add('BANK_DEMO', input({ module: '' }), NOW, 1)).toThrow(ExportRecordError);
  });

  test('per-tenant FIFO cap evicts oldest', () => {
    const s = new InMemoryExportHistoryStore(2);
    s.add('BANK_DEMO', input({ title: 'a' }), new Date('2026-06-13T10:00:00Z'), 1);
    s.add('BANK_DEMO', input({ title: 'b' }), new Date('2026-06-13T11:00:00Z'), 2);
    s.add('BANK_DEMO', input({ title: 'c' }), new Date('2026-06-13T12:00:00Z'), 3);
    const titles = s.list('BANK_DEMO', {}).items.map((r) => r.title);
    expect(titles).toEqual(['c', 'b']); // 'a' evicted, newest-first
  });
});
