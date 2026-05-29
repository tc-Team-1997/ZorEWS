import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { AccessControlConfigPage } from '@/modules/admin/AccessControlConfigPage';
import { renderWithProviders } from './utils';
import { useAuth } from '@/store/auth';

function asAdmin() {
  useAuth.setState({
    status: 'authenticated',
    token: 't',
    user: { username: 'alice.admin', roles: ['admin'], tenant_id: 'BANK_DEMO' } as never,
  });
}

describe('AccessControlConfigPage', () => {
  it('renders header, KPIs and the role roster', async () => {
    asAdmin();
    renderWithProviders(<AccessControlConfigPage />);
    expect(screen.getByRole('heading', { name: /Access Control Config/ })).toBeInTheDocument();
    // wait for a data-dependent node (the container renders empty before the query resolves)
    await waitFor(() => expect(screen.getByTestId('acc-role-card-admin')).toBeInTheDocument());
    // 5 roles seeded in the mock matrix
    expect(screen.getByTestId('acc-role-card-field_officer')).toBeInTheDocument();
    expect(Number(screen.getByTestId('acc-kpi-roles').textContent?.match(/\d+/)?.[0])).toBe(5);
    expect(Number(screen.getByTestId('acc-kpi-operations').textContent?.match(/\d+/)?.[0])).toBeGreaterThanOrEqual(8);
    expect(screen.getByTestId('acc-kpi-version')).toHaveTextContent('1.0.0');
  });

  it('renders the matrix grouped by resource with grant/deny cells', async () => {
    asAdmin();
    renderWithProviders(<AccessControlConfigPage />);
    await waitFor(() => expect(screen.getByTestId('acc-matrix-table')).toBeInTheDocument());
    // resource section header for alerts
    expect(screen.getByTestId('acc-resource-alerts')).toBeInTheDocument();
    // alerts:list is granted to admin (✓ cell present)
    expect(screen.getByTestId('acc-cell-alerts:list-admin')).toHaveAttribute('aria-label', 'granted');
    // audit:read is denied to field_officer
    expect(screen.getByTestId('acc-cell-audit:read-field_officer')).toHaveAttribute('aria-label', 'denied');
  });

  it('role filter chip narrows the grid to a single role column', async () => {
    asAdmin();
    renderWithProviders(<AccessControlConfigPage />);
    await waitFor(() => expect(screen.getByTestId('acc-matrix-table')).toBeInTheDocument());
    // before filter: admin cell for alerts:list exists
    expect(screen.getByTestId('acc-cell-alerts:list-admin')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('acc-filter-supervisor'));
    await waitFor(() =>
      expect(screen.getByTestId('acc-cell-alerts:list-supervisor')).toBeInTheDocument(),
    );
    // admin column dropped from the matrix when filtered to supervisor
    expect(screen.queryByTestId('acc-cell-alerts:list-admin')).not.toBeInTheDocument();
  });

  it('clicking a role card toggles the matrix filter', async () => {
    asAdmin();
    renderWithProviders(<AccessControlConfigPage />);
    await waitFor(() => expect(screen.getByTestId('acc-role-card-risk_analyst')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('acc-role-card-risk_analyst'));
    await waitFor(() => {
      const card = screen.getByTestId('acc-role-card-risk_analyst');
      expect(card).toHaveAttribute('aria-pressed', 'true');
    });
    // grid now shows only the risk_analyst column
    await waitFor(() => expect(screen.getByTestId('acc-cell-alerts:list-risk_analyst')).toBeInTheDocument());
    expect(screen.queryByTestId('acc-cell-alerts:list-admin')).not.toBeInTheDocument();
  });

  it('shows the read-only governance note + refresh control', async () => {
    asAdmin();
    renderWithProviders(<AccessControlConfigPage />);
    expect(screen.getByTestId('acc-readonly-note')).toBeInTheDocument();
    expect(screen.getByTestId('acc-refresh')).toBeInTheDocument();
    // 'All roles' filter is active by default → admin column present
    await waitFor(() => expect(screen.getByTestId('acc-matrix-table')).toBeInTheDocument());
    const filterAll = screen.getByTestId('acc-filter-all');
    expect(within(filterAll).queryByText(/All roles/)).toBeTruthy();
  });

  it('Test access — a granted pair reads Allowed', async () => {
    asAdmin();
    renderWithProviders(<AccessControlConfigPage />);
    await waitFor(() => expect(screen.getByTestId('acc-matrix-table')).toBeInTheDocument());
    fireEvent.change(screen.getByTestId('acc-check-role'), { target: { value: 'supervisor' } });
    fireEvent.change(screen.getByTestId('acc-check-operation'), { target: { value: 'audit:read' } });
    fireEvent.click(screen.getByTestId('acc-check-run'));
    await waitFor(() => expect(screen.getByTestId('acc-check-result')).toBeInTheDocument());
    expect(screen.getByTestId('acc-check-verdict').textContent).toBe('Allowed');
  });

  it('Test access — a non-granted pair reads Denied', async () => {
    asAdmin();
    renderWithProviders(<AccessControlConfigPage />);
    await waitFor(() => expect(screen.getByTestId('acc-matrix-table')).toBeInTheDocument());
    fireEvent.change(screen.getByTestId('acc-check-role'), { target: { value: 'field_officer' } });
    fireEvent.change(screen.getByTestId('acc-check-operation'), { target: { value: 'audit:read' } });
    fireEvent.click(screen.getByTestId('acc-check-run'));
    await waitFor(() => expect(screen.getByTestId('acc-check-verdict').textContent).toBe('Denied'));
  });

  it('Test access — unknown operation flags + denies', async () => {
    asAdmin();
    renderWithProviders(<AccessControlConfigPage />);
    await waitFor(() => expect(screen.getByTestId('acc-matrix-table')).toBeInTheDocument());
    fireEvent.change(screen.getByTestId('acc-check-role'), { target: { value: 'admin' } });
    fireEvent.change(screen.getByTestId('acc-check-operation'), { target: { value: 'nonsense:op' } });
    fireEvent.click(screen.getByTestId('acc-check-run'));
    await waitFor(() => expect(screen.getByTestId('acc-check-verdict').textContent).toBe('Denied'));
    expect(within(screen.getByTestId('acc-check-result')).getByText(/unknown operation/)).toBeInTheDocument();
  });
});
