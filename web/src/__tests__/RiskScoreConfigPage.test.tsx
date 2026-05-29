import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { RiskScoreConfigPage } from '@/modules/admin/RiskScoreConfigPage';
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

describe('RiskScoreConfigPage', () => {
  it('renders header, domain tabs, KPIs and the seeded banking factors (balanced 100%)', async () => {
    asAdmin();
    renderWithProviders(<RiskScoreConfigPage />);
    expect(screen.getByRole('heading', { name: /Risk Score Configuration/ })).toBeInTheDocument();
    expect(screen.getByTestId('rsc-domain-banking')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('rsc-table')).toBeInTheDocument());
    // 4 seeded banking factors, summing to 100 → balanced banner.
    expect(screen.getByTestId('rsc-row-OVERDUE')).toBeInTheDocument();
    expect(screen.getByTestId('rsc-row-EMI_BOUNCE')).toBeInTheDocument();
    expect(screen.getByTestId('rsc-kpi-total').textContent).toMatch(/100%/);
    expect(screen.getByTestId('rsc-balance-banner').textContent).toMatch(/Balanced/);
  });

  it('switching to insurance shows the insurance factor set', async () => {
    asAdmin();
    renderWithProviders(<RiskScoreConfigPage />);
    await waitFor(() => expect(screen.getByTestId('rsc-table')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('rsc-domain-insurance'));
    await waitFor(() => expect(screen.getByTestId('rsc-row-PREMIUM_MISSED')).toBeInTheDocument());
    expect(screen.queryByTestId('rsc-row-OVERDUE')).not.toBeInTheDocument();
  });

  it('editing a weight to break the sum flips the banner to Imbalanced; Normalize restores 100%', async () => {
    asAdmin();
    renderWithProviders(<RiskScoreConfigPage />);
    await waitFor(() => expect(screen.getByTestId('rsc-table')).toBeInTheDocument());
    const weightInput = screen.getByTestId('rsc-weight-OVERDUE') as HTMLInputElement;
    fireEvent.change(weightInput, { target: { value: '5' } });
    fireEvent.blur(weightInput);
    await waitFor(() => expect(screen.getByTestId('rsc-balance-banner').textContent).toMatch(/Imbalanced/));
    // Normalize → back to 100% balanced.
    fireEvent.click(screen.getByTestId('rsc-normalize'));
    await waitFor(() => expect(screen.getByTestId('rsc-balance-banner').textContent).toMatch(/Balanced/));
    expect(screen.getByTestId('rsc-kpi-total').textContent).toMatch(/100%/);
  });

  it('adds a new factor via the modal', async () => {
    asAdmin();
    renderWithProviders(<RiskScoreConfigPage />);
    await waitFor(() => expect(screen.getByTestId('rsc-table')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('rsc-create-btn'));
    const modal = await screen.findByTestId('rsc-create-modal');
    fireEvent.change(within(modal).getByTestId('rsc-create-code'), { target: { value: 'COLLATERAL' } });
    fireEvent.change(within(modal).getByTestId('rsc-create-name'), { target: { value: 'Collateral Cover' } });
    fireEvent.change(within(modal).getByTestId('rsc-create-weight'), { target: { value: '10' } });
    fireEvent.click(within(modal).getByTestId('rsc-create-submit'));
    await waitFor(() => expect(screen.getByTestId('rsc-row-COLLATERAL')).toBeInTheDocument());
  });

  it('reorder moves a factor down', async () => {
    asAdmin();
    renderWithProviders(<RiskScoreConfigPage />);
    await waitFor(() => expect(screen.getByTestId('rsc-table')).toBeInTheDocument());
    const firstRowCodeBefore = screen.getAllByTestId(/^rsc-row-/)[0].getAttribute('data-testid');
    fireEvent.click(screen.getByTestId('rsc-down-OVERDUE'));
    await waitFor(() => {
      const firstRowCodeAfter = screen.getAllByTestId(/^rsc-row-/)[0].getAttribute('data-testid');
      expect(firstRowCodeAfter).not.toBe(firstRowCodeBefore);
    });
    // OVERDUE should no longer be first.
    expect(screen.getAllByTestId(/^rsc-row-/)[0].getAttribute('data-testid')).not.toBe('rsc-row-OVERDUE');
  });

  it('deletes a factor', async () => {
    asAdmin();
    const orig = window.confirm;
    window.confirm = () => true;
    try {
      renderWithProviders(<RiskScoreConfigPage />);
      await waitFor(() => expect(screen.getByTestId('rsc-table')).toBeInTheDocument());
      fireEvent.click(screen.getByTestId('rsc-delete-BUREAU_SCORE'));
      await waitFor(() => expect(screen.queryByTestId('rsc-row-BUREAU_SCORE')).not.toBeInTheDocument());
    } finally {
      window.confirm = orig;
    }
  });

  it('non-admin sees read-only badges + no create/normalize/edit affordances', async () => {
    asViewer();
    renderWithProviders(<RiskScoreConfigPage />);
    await waitFor(() => expect(screen.getByTestId('rsc-table')).toBeInTheDocument());
    expect(screen.queryByTestId('rsc-create-btn')).not.toBeInTheDocument();
    expect(screen.queryByTestId('rsc-normalize')).not.toBeInTheDocument();
    expect(screen.queryByTestId('rsc-weight-OVERDUE')).not.toBeInTheDocument();
    expect(screen.queryByTestId('rsc-delete-OVERDUE')).not.toBeInTheDocument();
  });
});
