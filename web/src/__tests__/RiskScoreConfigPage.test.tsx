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

describe('RiskScoreConfigPage — scorecard evaluator (config → runtime)', () => {
  it('renders a signal input per enabled banking factor', async () => {
    asAdmin();
    renderWithProviders(<RiskScoreConfigPage />);
    await waitFor(() => expect(screen.getByTestId('rsc-eval-inputs')).toBeInTheDocument());
    expect(screen.getByTestId('rsc-eval-input-OVERDUE')).toBeInTheDocument();
    expect(screen.getByTestId('rsc-eval-input-BUREAU_SCORE')).toBeInTheDocument();
  });

  it('evaluating maxed signals yields a red composite via the configured bands', async () => {
    asAdmin();
    renderWithProviders(<RiskScoreConfigPage />);
    await waitFor(() => expect(screen.getByTestId('rsc-eval-inputs')).toBeInTheDocument());
    for (const code of ['OVERDUE', 'EMI_BOUNCE', 'TXN_BEHAVIOUR', 'BUREAU_SCORE']) {
      fireEvent.change(screen.getByTestId(`rsc-eval-input-${code}`), { target: { value: '100' } });
    }
    fireEvent.click(screen.getByTestId('rsc-eval-run'));
    await waitFor(() => expect(screen.getByTestId('rsc-eval-result')).toBeInTheDocument());
    // weights sum to 100, all signals 100 → composite 100 → red (red_min default 100)
    expect(screen.getByTestId('rsc-eval-composite').textContent).toBe('100');
    expect(within(screen.getByTestId('rsc-eval-band')).getByText('Red')).toBeInTheDocument();
    expect(screen.getByTestId('rsc-eval-row-OVERDUE')).toBeInTheDocument();
  });

  it('low signals stay green', async () => {
    asAdmin();
    renderWithProviders(<RiskScoreConfigPage />);
    await waitFor(() => expect(screen.getByTestId('rsc-eval-inputs')).toBeInTheDocument());
    fireEvent.change(screen.getByTestId('rsc-eval-input-OVERDUE'), { target: { value: '20' } });
    fireEvent.click(screen.getByTestId('rsc-eval-run'));
    await waitFor(() => expect(screen.getByTestId('rsc-eval-result')).toBeInTheDocument());
    // only OVERDUE (30%) at 20 → composite 6 → green; 3 factors defaulted to 0
    expect(screen.getByTestId('rsc-eval-composite').textContent).toBe('6');
    expect(within(screen.getByTestId('rsc-eval-band')).getByText('Green')).toBeInTheDocument();
    expect(screen.getByTestId('rsc-eval-warnings').textContent).toMatch(/defaulted to 0/);
  });

  it('viewer (risk_analyst) can run the scorecard — it is a scoring action', async () => {
    asViewer();
    renderWithProviders(<RiskScoreConfigPage />);
    await waitFor(() => expect(screen.getByTestId('rsc-eval-run')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('rsc-eval-run'));
    await waitFor(() => expect(screen.getByTestId('rsc-eval-result')).toBeInTheDocument());
  });

  it('the Both domain shows a per-vertical note instead of the evaluator', async () => {
    asAdmin();
    renderWithProviders(<RiskScoreConfigPage />);
    await waitFor(() => expect(screen.getByTestId('rsc-table')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('rsc-domain-both'));
    await waitFor(() => expect(screen.getByTestId('rsc-eval-both-note')).toBeInTheDocument());
    expect(screen.queryByTestId('rsc-eval-run')).not.toBeInTheDocument();
  });

  it('Score sample portfolio runs a batch + shows the RAG distribution', async () => {
    asAdmin();
    renderWithProviders(<RiskScoreConfigPage />);
    await waitFor(() => expect(screen.getByTestId('rsc-eval-inputs')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('rsc-batch-run'));
    await waitFor(() => expect(screen.getByTestId('rsc-batch-result')).toBeInTheDocument());
    // 3 profiles scored (low / medium / high signals)
    const rows = within(screen.getByTestId('rsc-batch-table')).getAllByTestId(/rsc-batch-row-/);
    expect(rows.length).toBe(3);
    // distribution badges present; the high-signal profile lands red on default bands
    expect(screen.getByTestId('rsc-batch-red').textContent).toMatch(/Red \d/);
    expect(screen.getByTestId('rsc-batch-row-high-signal')).toBeInTheDocument();
  });
});
