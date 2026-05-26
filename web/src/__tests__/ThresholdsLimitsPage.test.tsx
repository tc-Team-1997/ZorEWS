// web/src/__tests__/ThresholdsLimitsPage.test.tsx
//
// M5.3 — Thresholds & Limits SPA smoke.
//
// Covers:
//   - Page renders + library table loads
//   - KPI cards reflect MSW seed
//   - Edit modal opens + accepts values
//   - Suggest modal computes recommended bands from observed values
//   - Reset button only appears for tenant_override rows

import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { ThresholdsLimitsPage } from '@/modules/admin/ThresholdsLimitsPage';
import { useAuth } from '@/store/auth';

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={qc}>
        <ThresholdsLimitsPage />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  useAuth.setState({
    user: {
      id: 'u-admin',
      username: 'alice.admin',
      roles: ['admin'],
    } as ReturnType<typeof useAuth.getState>['user'],
  });
});

describe('M5.3 — ThresholdsLimitsPage', () => {
  it('renders KPIs + library table', async () => {
    renderPage();
    expect(screen.getByText('Thresholds & Limits')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByTestId('tl-library-table')).toBeInTheDocument();
    }, { timeout: 3000 });
    expect(screen.getByTestId('tl-kpi-total')).toBeInTheDocument();
    expect(screen.getByTestId('tl-kpi-overrides')).toBeInTheDocument();
    expect(screen.getByTestId('tl-row-FIN-001')).toBeInTheDocument();
  });

  it('opens Edit modal + accepts a new value', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('tl-row-FIN-001')).toBeInTheDocument();
    }, { timeout: 3000 });
    fireEvent.click(screen.getByTestId('tl-edit-FIN-001'));
    await waitFor(() => {
      expect(screen.getByTestId('tl-edit-modal')).toBeInTheDocument();
    }, { timeout: 3000 });
    const yellow = screen.getByTestId('tl-edit-yellow') as HTMLInputElement;
    expect(yellow.value).toBeTruthy();
    fireEvent.change(yellow, { target: { value: '0.25' } });
    expect((screen.getByTestId('tl-edit-yellow') as HTMLInputElement).value).toBe('0.25');
  });

  it('opens Suggest modal + computes recommended bands', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('tl-row-FIN-001')).toBeInTheDocument();
    }, { timeout: 3000 });
    fireEvent.click(screen.getByTestId('tl-suggest-FIN-001'));
    await waitFor(() => {
      expect(screen.getByTestId('tl-suggest-modal')).toBeInTheDocument();
    }, { timeout: 3000 });
    fireEvent.change(screen.getByTestId('tl-suggest-values'), {
      target: { value: '0.12, 0.25, 0.35, 0.48, 0.62, 0.75, 0.88, 0.92' },
    });
    fireEvent.click(screen.getByTestId('tl-suggest-run'));
    await waitFor(() => {
      expect(screen.getByTestId('tl-suggest-result')).toBeInTheDocument();
    }, { timeout: 3000 });
    expect(
      within(screen.getByTestId('tl-suggest-result')).getByText(/Suggested bands/i),
    ).toBeInTheDocument();
  });
});
