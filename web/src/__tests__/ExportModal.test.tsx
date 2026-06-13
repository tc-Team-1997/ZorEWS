import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ExportModal } from '@/components/export/ExportModal';
import type { ReportData } from '@/lib/export/types';

vi.mock('@/lib/export/recordExport', () => ({ recordExport: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/lib/export/generators/csv', () => ({ buildReportCsv: () => new Blob(['Case,State\r\nc-1,open']) }));
vi.mock('@/lib/export/generators/pdf', () => ({ reportPdfBlob: () => new Blob(['%PDF']) }));
vi.mock('@/lib/export/generators/xlsx', () => ({ buildReportXlsxBlob: async () => new Blob(['xlsx']) }));

// jsdom has no URL.createObjectURL / anchor download — stub it.
// (This jsdom defines createObjectURL/revokeObjectURL as non-writable but
// configurable, so a plain assignment throws — define the property instead.)
beforeEach(() => {
  Object.defineProperty(URL, 'createObjectURL', { value: vi.fn(() => 'blob:x'), writable: true, configurable: true });
  Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), writable: true, configurable: true });
});

const data: ReportData = {
  report_type: 'customer', module: 'customer_360', title: 'Customer Report — c-101',
  meta: { tenant_id: 'BANK_DEMO', generated_by: 'alice.admin', role: 'admin', generated_at: '2026-06-13T10:00:00Z', report_id: 'EXP-1' },
  sections: { tables: [{ name: 'Cases', columns: ['Case', 'State'], rows: [['c-1', 'open']] }] },
  record_count: 1,
};

describe('ExportModal', () => {
  test('renders format + scope + section controls when open', () => {
    render(<ExportModal open onClose={() => {}} adapter={() => data} module="customer_360" defaultReportType="customer" />);
    expect(screen.getByTestId('export-format-pdf')).toBeTruthy();
    expect(screen.getByTestId('export-format-csv')).toBeTruthy();
    expect(screen.getByTestId('export-scope')).toBeTruthy();
    expect(screen.getByTestId('export-generate')).toBeTruthy();
  });

  test('Generate runs the adapter + records the export', async () => {
    const { recordExport } = await import('@/lib/export/recordExport');
    render(<ExportModal open onClose={() => {}} adapter={() => data} module="customer_360" defaultReportType="customer" />);
    fireEvent.click(screen.getByTestId('export-generate'));
    await waitFor(() => expect(recordExport).toHaveBeenCalled());
  });
});
