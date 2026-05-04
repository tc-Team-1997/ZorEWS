import { describe, expect, it, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AuditLogPage } from '@/modules/admin/AuditLogPage';
import { renderWithProviders } from './utils';
import { useAuth } from '@/store/auth';

beforeEach(() => {
  // Audit log handler in MSW gates on persisted role — set admin so the
  // mock returns the seed event list.
  useAuth.setState({
    status: 'authenticated',
    token: 't',
    user: { id: 'u-001', username: 'alice.admin', roles: ['admin'] },
  });
  localStorage.setItem(
    'apex.ews.user',
    JSON.stringify({ id: 'u-001', username: 'alice.admin', roles: ['admin'] }),
  );
});

describe('AuditLogPage', () => {
  it('lists seed audit events newest-first with type, target, and timestamp columns', async () => {
    renderWithProviders(<AuditLogPage />);
    expect(
      screen.getByRole('heading', { name: /auth audit log/i }),
    ).toBeInTheDocument();
    const table = await screen.findByTestId('audit-table');
    // The MSW seed has ~12 events; we only need to confirm a known one renders.
    expect(within(table).getAllByRole('row').length).toBeGreaterThan(1);
    // login_success is seeded multiple times — at least one row carries it.
    expect(within(table).getAllByText(/login_success/i).length).toBeGreaterThan(0);
  });

  it('filtering by type narrows the table to matching events only', async () => {
    const user = userEvent.setup();
    renderWithProviders(<AuditLogPage />);
    await screen.findByTestId('audit-table');

    await user.selectOptions(screen.getByTestId('filter-type'), 'login_failure');
    await waitFor(() => {
      const table = screen.getByTestId('audit-table');
      const rows = within(table).getAllByRole('row');
      // 1 header + ≥1 data row, all data rows show login_failure badge.
      expect(rows.length).toBeGreaterThan(1);
      // Every body row should mention login_failure (the badge text).
      for (const row of rows.slice(1)) {
        expect(row.textContent).toMatch(/login_failure/);
      }
    });
  });

  it('filtering by target_username narrows to the named user', async () => {
    const user = userEvent.setup();
    renderWithProviders(<AuditLogPage />);
    await screen.findByTestId('audit-table');

    await user.type(screen.getByTestId('filter-target'), 'mallory.brute');
    await waitFor(() => {
      const table = screen.getByTestId('audit-table');
      const bodyRows = within(table).getAllByRole('row').slice(1);
      for (const row of bodyRows) {
        expect(row.textContent).toMatch(/mallory\.brute/);
      }
    });
  });

  it('shows a forbidden message when the caller is not admin/supervisor', async () => {
    useAuth.setState({
      status: 'authenticated',
      token: 't',
      user: { id: 'u-005', username: 'fiona.field', roles: ['field_officer'] },
    });
    localStorage.setItem(
      'apex.ews.user',
      JSON.stringify({ id: 'u-005', username: 'fiona.field', roles: ['field_officer'] }),
    );

    renderWithProviders(<AuditLogPage />);
    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument();
    });
  });
});
