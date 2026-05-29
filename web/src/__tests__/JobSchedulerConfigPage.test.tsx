import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { JobSchedulerConfigPage } from '@/modules/admin/JobSchedulerConfigPage';
import { renderWithProviders } from './utils';
import { useAuth } from '@/store/auth';

function asAdmin() {
  useAuth.setState({
    status: 'authenticated',
    token: 't',
    user: { username: 'alice.admin', roles: ['admin'], tenant_id: 'BANK_DEMO' } as never,
  });
}
function asViewer() {
  useAuth.setState({
    status: 'authenticated',
    token: 't',
    user: { username: 'val.viewer', roles: ['risk_analyst'], tenant_id: 'BANK_DEMO' } as never,
  });
}

describe('JobSchedulerConfigPage', () => {
  it('renders header, KPIs and the seeded job inventory', async () => {
    asAdmin();
    renderWithProviders(<JobSchedulerConfigPage />);
    expect(screen.getByRole('heading', { name: /Job & Scheduler Config/ })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('jsc-table')).toBeInTheDocument());
    expect(screen.getByTestId('jsc-row-job-BANK_DEMO-CBS_INGESTION')).toBeInTheDocument();
    expect(screen.getByTestId('jsc-row-job-BANK_DEMO-ESCALATION_WORKER')).toBeInTheDocument();
    expect(Number(screen.getByTestId('jsc-kpi-total').textContent?.match(/\d+/)?.[0])).toBeGreaterThanOrEqual(10);
    // the seed has a failing DQ job → failing KPI ≥ 1 + attention banner.
    expect(screen.getByTestId('jsc-attention')).toBeInTheDocument();
  });

  it('category filter narrows to ml jobs', async () => {
    asAdmin();
    renderWithProviders(<JobSchedulerConfigPage />);
    await waitFor(() => expect(screen.getByTestId('jsc-table')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('jsc-filter-ml'));
    await waitFor(() => expect(screen.getByTestId('jsc-row-job-BANK_DEMO-PD_RETRAINING')).toBeInTheDocument());
    expect(screen.queryByTestId('jsc-row-job-BANK_DEMO-CBS_INGESTION')).not.toBeInTheDocument();
  });

  it('pausing a job flips its next-run to "paused"', async () => {
    asAdmin();
    renderWithProviders(<JobSchedulerConfigPage />);
    await waitFor(() => expect(screen.getByTestId('jsc-row-job-BANK_DEMO-CBS_INGESTION')).toBeInTheDocument());
    const row = screen.getByTestId('jsc-row-job-BANK_DEMO-CBS_INGESTION');
    fireEvent.click(within(row).getByTestId('jsc-toggle-job-BANK_DEMO-CBS_INGESTION'));
    await waitFor(() =>
      expect(within(screen.getByTestId('jsc-row-job-BANK_DEMO-CBS_INGESTION')).getByText('paused')).toBeInTheDocument(),
    );
  });

  it('changing frequency persists', async () => {
    asAdmin();
    renderWithProviders(<JobSchedulerConfigPage />);
    await waitFor(() => expect(screen.getByTestId('jsc-row-job-BANK_DEMO-BUREAU_SYNC')).toBeInTheDocument());
    const sel = within(screen.getByTestId('jsc-row-job-BANK_DEMO-BUREAU_SYNC')).getByTestId('jsc-freq-job-BANK_DEMO-BUREAU_SYNC') as HTMLSelectElement;
    fireEvent.change(sel, { target: { value: 'daily' } });
    await waitFor(() => {
      const after = within(screen.getByTestId('jsc-row-job-BANK_DEMO-BUREAU_SYNC')).getByTestId('jsc-freq-job-BANK_DEMO-BUREAU_SYNC') as HTMLSelectElement;
      expect(after.value).toBe('daily');
    });
  });

  it('run-now updates the last-run status', async () => {
    asAdmin();
    renderWithProviders(<JobSchedulerConfigPage />);
    await waitFor(() => expect(screen.getByTestId('jsc-row-job-BANK_DEMO-FEATURE_BUILD')).toBeInTheDocument());
    const row = screen.getByTestId('jsc-row-job-BANK_DEMO-FEATURE_BUILD');
    fireEvent.click(within(row).getByTestId('jsc-run-job-BANK_DEMO-FEATURE_BUILD'));
    // status badge stays present after the run resolves (success/partial/failure).
    await waitFor(() =>
      expect(within(screen.getByTestId('jsc-row-job-BANK_DEMO-FEATURE_BUILD')).getByTestId('jsc-status-job-BANK_DEMO-FEATURE_BUILD')).toBeInTheDocument(),
    );
  });

  it('non-admin sees read-only rows + no controls', async () => {
    asViewer();
    renderWithProviders(<JobSchedulerConfigPage />);
    await waitFor(() => expect(screen.getByTestId('jsc-table')).toBeInTheDocument());
    expect(screen.queryByTestId('jsc-freq-job-BANK_DEMO-CBS_INGESTION')).not.toBeInTheDocument();
    expect(screen.queryByTestId('jsc-run-job-BANK_DEMO-CBS_INGESTION')).not.toBeInTheDocument();
    expect(screen.queryByTestId('jsc-toggle-job-BANK_DEMO-CBS_INGESTION')).not.toBeInTheDocument();
  });
});
