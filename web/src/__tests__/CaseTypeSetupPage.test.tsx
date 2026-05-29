import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { CaseTypeSetupPage } from '@/modules/admin/CaseTypeSetupPage';
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

describe('CaseTypeSetupPage', () => {
  it('renders header, KPIs and the 4 seeded case types', async () => {
    asAdmin();
    renderWithProviders(<CaseTypeSetupPage />);
    expect(screen.getByRole('heading', { name: /Case Management Setup/ })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('cty-table')).toBeInTheDocument());
    expect(screen.getByTestId('cty-row-FRAUD_INVESTIGATION')).toBeInTheDocument();
    expect(screen.getByTestId('cty-row-COLLECTIONS_FOLLOWUP')).toBeInTheDocument();
    expect(screen.getByTestId('cty-kpi-total').textContent).toMatch(/4/);
    expect(screen.getByTestId('cty-kpi-fastest').textContent).toMatch(/4h/);
  });

  it('priority filter narrows to P1', async () => {
    asAdmin();
    renderWithProviders(<CaseTypeSetupPage />);
    await waitFor(() => expect(screen.getByTestId('cty-table')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('cty-filter-P1'));
    await waitFor(() => expect(screen.getByTestId('cty-row-FRAUD_INVESTIGATION')).toBeInTheDocument());
    expect(screen.queryByTestId('cty-row-COLLECTIONS_FOLLOWUP')).not.toBeInTheDocument();
  });

  it('changing a row priority persists', async () => {
    asAdmin();
    renderWithProviders(<CaseTypeSetupPage />);
    await waitFor(() => expect(screen.getByTestId('cty-row-KYC_REMEDIATION')).toBeInTheDocument());
    const sel = within(screen.getByTestId('cty-row-KYC_REMEDIATION')).getByTestId('cty-priority-KYC_REMEDIATION') as HTMLSelectElement;
    fireEvent.change(sel, { target: { value: 'P1' } });
    await waitFor(() => {
      const after = within(screen.getByTestId('cty-row-KYC_REMEDIATION')).getByTestId('cty-priority-KYC_REMEDIATION') as HTMLSelectElement;
      expect(after.value).toBe('P1');
    });
  });

  it('adds a new case type via the modal', async () => {
    asAdmin();
    renderWithProviders(<CaseTypeSetupPage />);
    await waitFor(() => expect(screen.getByTestId('cty-table')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('cty-create-btn'));
    const modal = await screen.findByTestId('cty-create-modal');
    fireEvent.change(within(modal).getByTestId('cty-create-code'), { target: { value: 'AML_ESCALATION' } });
    fireEvent.change(within(modal).getByTestId('cty-create-name'), { target: { value: 'AML Escalation' } });
    fireEvent.change(within(modal).getByTestId('cty-create-sla'), { target: { value: '6' } });
    fireEvent.change(within(modal).getByTestId('cty-create-team'), { target: { value: 'Compliance' } });
    fireEvent.click(within(modal).getByTestId('cty-create-submit'));
    await waitFor(() => expect(screen.getByTestId('cty-row-AML_ESCALATION')).toBeInTheDocument());
  });

  it('create submit disabled until code/name/team/sla all valid', async () => {
    asAdmin();
    renderWithProviders(<CaseTypeSetupPage />);
    await waitFor(() => expect(screen.getByTestId('cty-table')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('cty-create-btn'));
    const modal = await screen.findByTestId('cty-create-modal');
    expect(within(modal).getByTestId('cty-create-submit')).toBeDisabled();
    fireEvent.change(within(modal).getByTestId('cty-create-code'), { target: { value: 'XX' } });
    fireEvent.change(within(modal).getByTestId('cty-create-name'), { target: { value: 'X' } });
    expect(within(modal).getByTestId('cty-create-submit')).toBeDisabled(); // team still empty
    fireEvent.change(within(modal).getByTestId('cty-create-team'), { target: { value: 'Team' } });
    expect(within(modal).getByTestId('cty-create-submit')).not.toBeDisabled();
  });

  it('deletes a case type', async () => {
    asAdmin();
    const orig = window.confirm;
    window.confirm = () => true;
    try {
      renderWithProviders(<CaseTypeSetupPage />);
      await waitFor(() => expect(screen.getByTestId('cty-row-COLLECTIONS_FOLLOWUP')).toBeInTheDocument());
      fireEvent.click(screen.getByTestId('cty-delete-COLLECTIONS_FOLLOWUP'));
      await waitFor(() => expect(screen.queryByTestId('cty-row-COLLECTIONS_FOLLOWUP')).not.toBeInTheDocument());
    } finally {
      window.confirm = orig;
    }
  });

  it('non-admin sees read-only badges + no create/edit/delete', async () => {
    asViewer();
    renderWithProviders(<CaseTypeSetupPage />);
    await waitFor(() => expect(screen.getByTestId('cty-table')).toBeInTheDocument());
    expect(screen.queryByTestId('cty-create-btn')).not.toBeInTheDocument();
    expect(screen.queryByTestId('cty-priority-FRAUD_INVESTIGATION')).not.toBeInTheDocument();
    expect(screen.queryByTestId('cty-delete-FRAUD_INVESTIGATION')).not.toBeInTheDocument();
  });
});
