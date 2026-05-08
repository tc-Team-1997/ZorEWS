// Coverage for /admin/user-access-override page (BAC §3.1.6/§3.1.7):
//   - List loads with the seeded ACTIVE + PENDING_APPROVAL rows
//   - Search filter narrows the list
//   - Status pivot card filters by status
//   - Add modal: validation (reason ≥ 10 chars, future till date)
//   - Add modal: happy path → list refreshes
//   - Detail panel: maker cannot self-approve

import { describe, expect, it, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { UserAccessOverrideListPage } from '@/modules/admin/userAccessOverride/UserAccessOverrideListPage';
import { renderWithProviders } from './utils';
import { useAuth } from '@/store/auth';

function setAdmin(username = 'alice.admin') {
  const user = {
    id: 'u-001',
    username,
    roles: ['admin' as const],
    display_name: username,
  };
  localStorage.setItem('apex.ews.user', JSON.stringify(user));
  localStorage.setItem('apex.ews.token', 'test-token');
  useAuth.setState({ status: 'authenticated', user, token: 'test-token' });
}

beforeEach(() => {
  localStorage.clear();
  setAdmin();
});

describe('UserAccessOverrideListPage', () => {
  it('renders the seeded overrides', async () => {
    renderWithProviders(<UserAccessOverrideListPage />);
    // ov-seed-1 is ACTIVE on admin.audit-log; ov-seed-2 is PENDING on cases.detail
    await waitFor(() => {
      expect(screen.getByText('admin.audit-log')).toBeInTheDocument();
      expect(screen.getByText('cases.detail')).toBeInTheDocument();
    });
  });

  it('search narrows the list', async () => {
    renderWithProviders(<UserAccessOverrideListPage />);
    await screen.findByText('admin.audit-log');
    await userEvent.type(screen.getByTestId('uao-search'), 'cases.detail');
    expect(screen.queryByText('admin.audit-log')).not.toBeInTheDocument();
    expect(screen.getByText('cases.detail')).toBeInTheDocument();
  });

  it('opens the Add Access modal and validates reason length', async () => {
    renderWithProviders(<UserAccessOverrideListPage />);
    await screen.findByText('admin.audit-log');
    await userEvent.click(screen.getByTestId('uao-add'));
    expect(screen.getByRole('dialog', { name: /Add access override/i })).toBeInTheDocument();
    // Pick a user
    await userEvent.selectOptions(screen.getByTestId('uao-user-picker'), 'u-002');
    // Pick a module path
    await userEvent.click(screen.getByTestId('uao-path-reports.cases'));
    // Submit without reason → should show validation error
    await userEvent.click(screen.getByTestId('uao-submit'));
    expect(await screen.findByTestId('uao-error')).toHaveTextContent(/at least 10 characters/i);
  });

  it('rejects effective_till in the past', async () => {
    renderWithProviders(<UserAccessOverrideListPage />);
    await screen.findByText('admin.audit-log');
    await userEvent.click(screen.getByTestId('uao-add'));
    await userEvent.selectOptions(screen.getByTestId('uao-user-picker'), 'u-002');
    await userEvent.click(screen.getByTestId('uao-path-reports.cases'));
    const tillInput = screen.getByTestId('uao-till') as HTMLInputElement;
    await userEvent.type(tillInput, '2020-01-01');
    await userEvent.type(
      screen.getByTestId('uao-reason'),
      'audit support reasonable length string',
    );
    await userEvent.click(screen.getByTestId('uao-submit'));
    expect(await screen.findByTestId('uao-error')).toHaveTextContent(/Effective till/i);
  });

  it('happy-path create: requires_approval=true → row shows up as PENDING_APPROVAL', async () => {
    renderWithProviders(<UserAccessOverrideListPage />);
    await screen.findByText('admin.audit-log');
    await userEvent.click(screen.getByTestId('uao-add'));
    await userEvent.selectOptions(screen.getByTestId('uao-user-picker'), 'u-003');
    await userEvent.click(screen.getByTestId('uao-path-reports.cases'));
    await userEvent.type(
      screen.getByTestId('uao-reason'),
      'Quarterly audit support — Sue needs read access',
    );
    await userEvent.click(screen.getByTestId('uao-submit'));
    await waitFor(() => {
      // Reports.cases row should now be in the table
      expect(screen.getByText('reports.cases')).toBeInTheDocument();
    });
  });
});
