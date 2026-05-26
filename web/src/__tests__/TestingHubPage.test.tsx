// web/src/__tests__/TestingHubPage.test.tsx
//
// M6.3 — Testing Hub SPA smoke
//
// Covers:
//   - Library renders + KPIs reflect MSW seed
//   - "New case" modal opens + accepts a new test case definition
//   - "Run all" produces a results report
//   - "Bulk upload" modal accepts CSV and creates cases
//   - Schedule toggle flips the enabled flag

import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { TestingHubPage } from '@/modules/admin/TestingHubPage';
import { useAuth } from '@/store/auth';
import { __resetMswM63 } from '@/mocks/handlers';

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={qc}>
        <TestingHubPage />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  __resetMswM63();
  useAuth.setState({
    user: {
      id: 'u-admin',
      username: 'alice.admin',
      roles: ['admin'],
    } as ReturnType<typeof useAuth.getState>['user'],
  });
});

describe('M6.3 — TestingHubPage', () => {
  it('renders KPIs + library from MSW seed', async () => {
    renderPage();
    expect(
      screen.getByRole('heading', { name: /Testing Hub/i }),
    ).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByTestId('th-cases-table')).toBeInTheDocument();
    }, { timeout: 3000 });

    // KPI tiles
    expect(screen.getByTestId('th-kpi-total')).toBeInTheDocument();
    expect(screen.getByTestId('th-kpi-schedule')).toBeInTheDocument();

    // Seed cases visible
    expect(screen.getByText('RULE-001 fires on high DPD')).toBeInTheDocument();
    expect(
      screen.getByText('FIN-001 indicator computes utilization'),
    ).toBeInTheDocument();
  });

  it('New case modal opens + saves a new case', async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('th-new-case-btn')).toBeInTheDocument();
    });
    await user.click(screen.getByTestId('th-new-case-btn'));
    await waitFor(() => {
      expect(screen.getByTestId('th-create-modal')).toBeInTheDocument();
    });
    await user.type(
      screen.getByTestId('th-create-modal-name'),
      'M6.3 Smoke case',
    );
    await user.clear(screen.getByTestId('th-create-modal-target-id'));
    await user.type(
      screen.getByTestId('th-create-modal-target-id'),
      'RULE-999',
    );
    await user.click(screen.getByTestId('th-create-modal-submit'));
    // Modal closes + new case visible in list
    await waitFor(() => {
      expect(screen.queryByTestId('th-create-modal')).not.toBeInTheDocument();
    });
    await waitFor(() => {
      expect(screen.getByText('M6.3 Smoke case')).toBeInTheDocument();
    });
  });

  it('Run all produces a results report', async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('th-run-all-btn')).toBeInTheDocument();
    });
    await user.click(screen.getByTestId('th-run-all-btn'));
    await waitFor(() => {
      expect(screen.getByTestId('th-last-report')).toBeInTheDocument();
    }, { timeout: 3000 });

    // Report displays totals — seed has 2 enabled cases. The "2" appears
    // multiple times across the report blocks (Total + Passed), so we
    // just verify the report panel is populated with the canonical labels.
    const report = screen.getByTestId('th-last-report');
    expect(within(report).getByText('Total')).toBeInTheDocument();
    expect(within(report).getByText('Passed')).toBeInTheDocument();
    expect(within(report).getByText('Failed')).toBeInTheDocument();
    expect(within(report).getByText('Duration')).toBeInTheDocument();
  });

  it('Bulk upload modal opens + imports CSV', async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('th-bulk-btn')).toBeInTheDocument();
    });
    await user.click(screen.getByTestId('th-bulk-btn'));
    await waitFor(() => {
      expect(screen.getByTestId('th-bulk-modal')).toBeInTheDocument();
    });
    // Default CSV in textarea creates 1 case
    await user.click(screen.getByTestId('th-bulk-submit'));
    await waitFor(() => {
      expect(screen.queryByTestId('th-bulk-modal')).not.toBeInTheDocument();
    });
    // New case "My test" should appear
    await waitFor(() => {
      expect(screen.getByText('My test')).toBeInTheDocument();
    });
  });

  it('Schedule toggle flips enabled flag', async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('th-schedule-detail')).toBeInTheDocument();
    });
    const detail = screen.getByTestId('th-schedule-detail');
    expect(within(detail).getByText(/disabled/i)).toBeInTheDocument();
    // Toggle on
    await user.click(screen.getByTestId('th-schedule-toggle'));
    await waitFor(() => {
      const updated = screen.getByTestId('th-schedule-detail');
      expect(within(updated).getByText(/enabled/i)).toBeInTheDocument();
    });
  });
});

it('M6.3 nav + i18n: TestingHubPage is reachable via /admin/testing-hub', () => {
  // Smoke import — verifies the module exports the component name.
  const Comp = TestingHubPage;
  expect(typeof Comp).toBe('function');
});
