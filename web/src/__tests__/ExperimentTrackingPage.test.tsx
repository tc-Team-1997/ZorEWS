import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { ExperimentTrackingPage } from '@/modules/ai/ExperimentTrackingPage';
import { renderWithProviders } from './utils';
import { useAuth } from '@/store/auth';

// The "Log experiment" button + lifecycle controls are gated on a mutating
// role — seed an admin so the create/lifecycle paths are exercised.
function asAdmin() {
  useAuth.setState({
    status: 'authenticated',
    token: 't',
    user: { username: 'alice.admin', roles: ['admin'], tenant_id: 'BANK_DEMO' } as never,
  });
}

describe('ExperimentTrackingPage — render', () => {
  it('renders header + 5 KPIs + seeded experiment table', async () => {
    asAdmin();
    renderWithProviders(<ExperimentTrackingPage />);
    expect(screen.getByRole('heading', { name: /Experiment Tracking/ })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('exp-table')).toBeInTheDocument());
    expect(screen.getByTestId('exp-kpi-total')).toBeInTheDocument();
    expect(screen.getByTestId('exp-kpi-running')).toBeInTheDocument();
    expect(screen.getByTestId('exp-kpi-completed')).toBeInTheDocument();
    expect(screen.getByTestId('exp-kpi-pending')).toBeInTheDocument();
    expect(screen.getByTestId('exp-kpi-best-auc')).toBeInTheDocument();
    expect((await screen.findAllByTestId(/^exp-row-/)).length).toBeGreaterThan(0);
  });

  it('domain filter chips render', async () => {
    asAdmin();
    renderWithProviders(<ExperimentTrackingPage />);
    await waitFor(() => expect(screen.getByTestId('exp-filter-domain-banking')).toBeInTheDocument());
    expect(screen.getByTestId('exp-filter-domain-insurance')).toBeInTheDocument();
    expect(screen.getByTestId('exp-filter-status-running')).toBeInTheDocument();
  });
});

describe('ExperimentTrackingPage — interactions', () => {
  it('status filter narrows the table to running runs', async () => {
    asAdmin();
    renderWithProviders(<ExperimentTrackingPage />);
    await waitFor(() => expect(screen.getByTestId('exp-table')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('exp-filter-status-running'));
    await waitFor(() => {
      const rows = within(screen.getByTestId('exp-table')).getAllByTestId(/^exp-row-/);
      // every visible row carries a running badge
      for (const r of rows) expect(within(r).getByText('running')).toBeInTheDocument();
    });
  });

  it('logging a new experiment adds it to the table', async () => {
    asAdmin();
    renderWithProviders(<ExperimentTrackingPage />);
    await waitFor(() => expect(screen.getByTestId('exp-table')).toBeInTheDocument());
    const before = screen.getAllByTestId(/^exp-row-/).length;

    fireEvent.click(screen.getByTestId('exp-log-btn'));
    await waitFor(() => expect(screen.getByTestId('exp-create-modal')).toBeInTheDocument());
    fireEvent.change(screen.getByTestId('exp-c-name'), { target: { value: 'Churn GBM holdout test' } });
    fireEvent.change(screen.getByTestId('exp-c-model_type'), { target: { value: 'churn' } });
    fireEvent.change(screen.getByTestId('exp-c-owner'), { target: { value: 'dsci.test' } });
    fireEvent.click(screen.getByTestId('exp-c-submit'));

    await waitFor(() => {
      expect(screen.queryByTestId('exp-create-modal')).not.toBeInTheDocument();
      expect(screen.getAllByTestId(/^exp-row-/).length).toBe(before + 1);
    });
    expect(screen.getByText('Churn GBM holdout test')).toBeInTheDocument();
  });

  it('opening a run shows params + metrics + lifecycle controls', async () => {
    asAdmin();
    renderWithProviders(<ExperimentTrackingPage />);
    await waitFor(() => expect(screen.getByTestId('exp-table')).toBeInTheDocument());
    const rows = screen.getAllByTestId(/^exp-row-/);
    fireEvent.click(rows[0]);
    await waitFor(() => expect(screen.getByTestId('exp-detail-modal')).toBeInTheDocument());
    const modal = screen.getByTestId('exp-detail-modal');
    await waitFor(() => expect(within(modal).getByTestId('exp-lifecycle')).toBeInTheDocument());
  });

  it('advances a running experiment to completed', async () => {
    asAdmin();
    renderWithProviders(<ExperimentTrackingPage />);
    await waitFor(() => expect(screen.getByTestId('exp-table')).toBeInTheDocument());
    // pick the seeded fraud run (stays running) by filtering to running first
    fireEvent.click(screen.getByTestId('exp-filter-status-running'));
    await waitFor(() => expect(within(screen.getByTestId('exp-table')).getAllByTestId(/^exp-row-/).length).toBeGreaterThan(0));
    fireEvent.click(within(screen.getByTestId('exp-table')).getAllByTestId(/^exp-row-/)[0]);
    await waitFor(() => expect(screen.getByTestId('exp-detail-modal')).toBeInTheDocument());
    const modal = screen.getByTestId('exp-detail-modal');
    await waitFor(() => expect(within(modal).getByTestId('exp-to-completed')).toBeInTheDocument());
    fireEvent.click(within(modal).getByTestId('exp-to-completed'));
    await waitFor(() => {
      expect(within(screen.getByTestId('exp-detail-modal')).getByTestId('exp-set-outcome')).toBeInTheDocument();
    });
  });
});
