// web/src/__tests__/DataIngestionPage.test.tsx
//
// Module 1.1 — Data Ingestion (Source Feeds management).

import { describe, it, expect } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { DataIngestionPage } from '@/modules/admin/DataIngestionPage';

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <DataIngestionPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('DataIngestionPage (Module 1.1)', () => {
  it('renders header + 4 KPI tiles + 3 main panels', async () => {
    renderPage();
    expect(screen.getByText('Data Ingestion')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByTestId('kpi-ingestion-total')).toBeInTheDocument();
      expect(screen.getByTestId('kpi-ingestion-healthy')).toBeInTheDocument();
      expect(screen.getByTestId('kpi-ingestion-attention')).toBeInTheDocument();
      expect(screen.getByTestId('kpi-ingestion-drift')).toBeInTheDocument();
    });
    expect(screen.getByTestId('ingestion-source-feeds-panel')).toBeInTheDocument();
    expect(screen.getByTestId('ingestion-schema-drift-panel')).toBeInTheDocument();
    expect(screen.getByTestId('ingestion-failure-log-panel')).toBeInTheDocument();
  });

  it('Source Feeds table renders rows from MSW seed', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('ingestion-source-feeds-table')).toBeInTheDocument();
      expect(screen.getByTestId('ingestion-row-cbs_loan_book')).toBeInTheDocument();
      expect(screen.getByTestId('ingestion-row-agent_productivity')).toBeInTheDocument();
    });
  });

  it('Schema Drift card flags the seeded drift row (cbs_loan_book)', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('drift-rows')).toBeInTheDocument();
      expect(screen.getByTestId('drift-row-cbs_loan_book')).toBeInTheDocument();
      expect(screen.getByText(/custom_field_a/)).toBeInTheDocument();
    });
  });

  it('"Add source" opens the Source Editor modal', async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => screen.getByTestId('ingestion-add-source'));
    await user.click(screen.getByTestId('ingestion-add-source'));
    await waitFor(() => {
      expect(screen.getByTestId('ingestion-source-editor')).toBeInTheDocument();
      expect(screen.getByTestId('editor-id')).toBeInTheDocument();
      expect(screen.getByTestId('editor-name')).toBeInTheDocument();
    });
  });

  it('"Edit" on a row opens the Source Editor pre-populated + id-disabled', async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => screen.getByTestId('ingestion-row-cbs_loan_book'));
    await user.click(screen.getByTestId('ingestion-edit-cbs_loan_book'));
    await waitFor(() => {
      const idInput = screen.getByTestId('editor-id') as HTMLInputElement;
      expect(idInput).toBeDisabled();
      expect(idInput.value).toBe('cbs_loan_book');
    });
  });

  it('"Sync now" + "Pause" + "Runs" buttons exist for every row', async () => {
    renderPage();
    await waitFor(() => screen.getByTestId('ingestion-row-cbs_loan_book'));
    expect(screen.getByTestId('ingestion-sync-cbs_loan_book')).toBeInTheDocument();
    expect(screen.getByTestId('ingestion-runs-cbs_loan_book')).toBeInTheDocument();
    expect(screen.getByTestId('ingestion-pause-cbs_loan_book')).toBeInTheDocument();
  });
});
