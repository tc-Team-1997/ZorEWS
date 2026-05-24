// web/src/__tests__/AuditTrailPage.test.tsx
//
// G2 — Compliance Audit Trail page (Monday Playbook H9).

import { describe, it, expect } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuditTrailPage } from '@/modules/admin/AuditTrailPage';

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <AuditTrailPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('AuditTrailPage', () => {
  it('renders header + 4 KPI tiles', async () => {
    renderPage();
    expect(screen.getByText('Audit Trail')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByTestId('audit-kpi-total')).toBeInTheDocument();
      expect(screen.getByTestId('audit-kpi-critical')).toBeInTheDocument();
      expect(screen.getByTestId('audit-kpi-denied')).toBeInTheDocument();
      expect(screen.getByTestId('audit-kpi-integrity')).toBeInTheDocument();
    });
  });

  it('shows filter controls + events table', async () => {
    renderPage();
    expect(screen.getByTestId('audit-filters')).toBeInTheDocument();
    expect(screen.getByTestId('audit-filter-actor')).toBeInTheDocument();
    expect(screen.getByTestId('audit-filter-resource')).toBeInTheDocument();
    expect(screen.getByTestId('audit-filter-outcome')).toBeInTheDocument();
    expect(screen.getByTestId('audit-filter-severity')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByTestId('audit-events-table')).toBeInTheDocument();
    });
  });

  it('row click opens detail modal with payload + hash chain', async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => screen.getByTestId('audit-events-table'));
    const firstRow = await screen.findByTestId('audit-row-aud-msw-001');
    await user.click(firstRow);
    await waitFor(() => {
      expect(screen.getByTestId('audit-detail-modal')).toBeInTheDocument();
      expect(screen.getByTestId('audit-payload-json')).toBeInTheDocument();
      expect(screen.getByTestId('audit-prev-hash')).toBeInTheDocument();
      expect(screen.getByTestId('audit-this-hash')).toBeInTheDocument();
    });
  });

  it('correlation-bearing event surfaces drill button', async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => screen.getByTestId('audit-events-table'));
    // event 004 has correlation_id='corr-c-115'
    await user.click(await screen.findByTestId('audit-row-aud-msw-004'));
    await waitFor(() => {
      expect(screen.getByTestId('audit-drill-correlation')).toBeInTheDocument();
    });
  });

  it('filter input narrows events table', async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => screen.getByTestId('audit-events-table'));
    await user.type(screen.getByTestId('audit-filter-actor'), 'alice');
    await waitFor(() => {
      // alice.admin actor → 2 rows (config.update + report.run) — both should be present
      expect(screen.getByTestId('audit-row-aud-msw-004')).toBeInTheDocument();
      expect(screen.getByTestId('audit-row-aud-msw-007')).toBeInTheDocument();
      // fiona.field's rows should NOT be in the filtered view
      expect(screen.queryByTestId('audit-row-aud-msw-002')).not.toBeInTheDocument();
    });
  });
});
