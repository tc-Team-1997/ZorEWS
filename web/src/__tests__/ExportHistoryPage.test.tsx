import type React from 'react';
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { ExportHistoryPage } from '@/modules/admin/exports/ExportHistoryPage';

vi.mock('@/lib/api', () => ({
  api: {
    exportsHistory: vi.fn().mockResolvedValue({
      items: [
        { export_id: 'EXP-1', tenant_id: 'BANK_DEMO', generated_by: 'alice.admin', role: 'admin', module: 'customer_360', report_type: 'customer', format: 'pdf', record_count: 12, title: 'Customer Report', status: 'completed', generated_at: '2026-06-13T10:00:00Z', has_artifact: true },
        { export_id: 'EXP-2', tenant_id: 'BANK_DEMO', generated_by: 'bob', role: 'supervisor', module: 'alerts', report_type: 'risk', format: 'csv', record_count: 5, title: 'Alerts', status: 'completed', generated_at: '2026-06-13T09:00:00Z', has_artifact: false },
      ], total: 2, page: 1, page_size: 50,
    }),
  },
}));

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}><MemoryRouter>{ui}</MemoryRouter></QueryClientProvider>;
}
beforeEach(() => localStorage.setItem('apex.ews.user', JSON.stringify({ username: 'alice.admin', roles: ['admin'] })));

describe('ExportHistoryPage', () => {
  test('lists export records with module + format + generated-by', async () => {
    render(wrap(<ExportHistoryPage />));
    await waitFor(() => expect(screen.getByText('Customer Report')).toBeTruthy());
    expect(screen.getByText('customer_360')).toBeTruthy();
    expect(screen.getByText('alice.admin')).toBeTruthy();
  });
  test('shows a download action only for records with an artifact', async () => {
    render(wrap(<ExportHistoryPage />));
    await waitFor(() => expect(screen.getByText('Customer Report')).toBeTruthy());
    expect(screen.getAllByTestId('export-download').length).toBe(1); // only EXP-1 has_artifact
  });
});
