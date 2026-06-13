import { describe, test, expect, vi, beforeEach } from 'vitest';
import { useState } from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ExportModal } from '@/components/export/ExportModal';
import type { ReportData } from '@/lib/export/types';

vi.mock('@/lib/export/recordExport', () => ({ recordExport: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/lib/export/generators/csv', () => ({ buildReportCsv: () => new Blob(['Case,State\r\nc-1,open']) }));
vi.mock('@/lib/export/generators/pdf', () => ({ reportPdfBlob: () => new Blob(['%PDF']) }));
vi.mock('@/lib/export/generators/xlsx', () => ({ buildReportXlsxBlob: async () => new Blob(['xlsx']) }));
vi.mock('@/lib/export/generators/docx', () => ({ buildReportDocxBlob: async () => new Blob(['docx']) }));

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

  test('Word format is selectable + generates + records', async () => {
    const { recordExport } = await import('@/lib/export/recordExport');
    render(<ExportModal open onClose={() => {}} adapter={() => data} module="customer_360" defaultReportType="customer" />);
    // Word checkbox is enabled now.
    const word = screen.getByTestId('export-format-docx') as HTMLInputElement;
    expect(word.disabled).toBe(false);
    fireEvent.click(screen.getByTestId('export-format-pdf')); // turn pdf OFF (default on)
    fireEvent.click(word); // turn docx ON
    fireEvent.click(screen.getByTestId('export-generate'));
    await waitFor(() => expect(recordExport).toHaveBeenCalledWith(expect.objectContaining({ format: 'docx' })));
  });

  test('AI Insights toggle injects narrative before generating', async () => {
    // include.ai_insights defaults false; turn it on and assert generation
    // succeeds (modal closes). The modal renders only while `open` is true, so
    // a state-controlled harness lets `onClose` actually unmount it on success.
    function Harness() {
      const [open, setOpen] = useState(true);
      return <ExportModal open={open} onClose={() => setOpen(false)} adapter={() => data} module="customer_360" defaultReportType="customer" />;
    }
    render(<Harness />);
    fireEvent.click(screen.getByTestId('export-section-ai_insights'));
    fireEvent.click(screen.getByTestId('export-generate'));
    await waitFor(() => expect(screen.queryByTestId('export-modal')).toBeNull()); // closed on success
  });
});
