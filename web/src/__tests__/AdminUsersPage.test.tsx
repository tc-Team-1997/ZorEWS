import { describe, expect, it, beforeEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { AdminUsersPage } from '@/modules/admin/AdminUsersPage';
import { DashboardPage } from '@/modules/dashboard/DashboardPage';
import { renderWithProviders } from './utils';
import { server } from '@/mocks/server';
import { useAuth } from '@/store/auth';

function setUser(role: 'admin' | 'risk_analyst' | 'field_officer') {
  const user = {
    id: 'u-001',
    username: role === 'admin' ? 'alice.admin' : `test.${role}`,
    roles: [role],
  };
  // Persist to localStorage so the MSW handlers can authorize.
  localStorage.setItem('apex.ews.user', JSON.stringify(user));
  localStorage.setItem('apex.ews.token', 'mock.test.token');
  useAuth.setState({ status: 'authenticated', user, token: 'mock.test.token' });
}

function renderAdmin() {
  return renderWithProviders(
    <Routes>
      <Route path="/admin/users" element={<AdminUsersPage />} />
      <Route path="/" element={<DashboardPage />} />
    </Routes>,
    { route: '/admin/users' },
  );
}

beforeEach(() => {
  // Each test sets the role it needs.
  localStorage.clear();
});

describe('AdminUsersPage', () => {
  it('redirects non-admin users to / (no admin UI exposure)', async () => {
    setUser('risk_analyst');
    renderAdmin();
    // Dashboard renders → admin page did NOT render.
    expect(await screen.findByText(/EWS Dashboard/i)).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /^users$/i })).not.toBeInTheDocument();
  });

  it('renders the user list for admins (data from /auth/users)', async () => {
    setUser('admin');
    renderAdmin();
    // Heading + at least the seeded admin row
    expect(await screen.findByRole('heading', { name: /^users$/i })).toBeInTheDocument();
    expect(await screen.findByText('alice.admin')).toBeInTheDocument();
    expect(screen.getByText('ravi.risk')).toBeInTheDocument();
    expect(screen.getByText('fiona.field')).toBeInTheDocument();
  });

  it('shows the email column populated for each user', async () => {
    setUser('admin');
    renderAdmin();
    await screen.findByText('alice.admin');
    expect(screen.getByText('alice.admin@apex-ews.test')).toBeInTheDocument();
    expect(screen.getByText('fiona.field@apex-ews.test')).toBeInTheDocument();
  });

  it('opens the reset form when the row action is clicked', async () => {
    setUser('admin');
    const user = userEvent.setup();
    renderAdmin();
    await screen.findByText('alice.admin');
    // Empty-state copy in the side panel
    expect(screen.getByText(/No action selected/i)).toBeInTheDocument();

    const button = screen.getAllByRole('button', { name: /reset password for/i })[0];
    await user.click(button);

    expect(screen.queryByText(/No action selected/i)).not.toBeInTheDocument();
    expect(screen.getByLabelText(/^new password$/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/confirm new password/i)).toBeInTheDocument();
  });

  it('flags password mismatch on submit', async () => {
    setUser('admin');
    const user = userEvent.setup();
    renderAdmin();
    await screen.findByText('alice.admin');
    await user.click(screen.getAllByRole('button', { name: /reset password for/i })[0]);
    await user.type(screen.getByLabelText(/^new password$/i), 'GoodPass!1');
    await user.type(screen.getByLabelText(/confirm new password/i), 'Different!2');
    await user.click(screen.getByRole('button', { name: /^reset password$/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/Passwords do not match/i);
  });

  it('shows success on a 200 from /auth/password/admin-reset', async () => {
    setUser('admin');
    const user = userEvent.setup();
    renderAdmin();
    await screen.findByText('alice.admin');
    await user.click(screen.getAllByRole('button', { name: /reset password for/i })[0]);
    await user.type(screen.getByLabelText(/^new password$/i), 'GoodPass!1');
    await user.type(screen.getByLabelText(/confirm new password/i), 'GoodPass!1');
    await user.click(screen.getByRole('button', { name: /^reset password$/i }));

    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent(/has been reset/i),
    );
  });

  it('surfaces a 404 from the backend as a friendly message', async () => {
    setUser('admin');
    server.use(
      http.post('/auth/password/admin-reset', () =>
        HttpResponse.json({ error: 'user_not_found' }, { status: 404 }),
      ),
    );
    const user = userEvent.setup();
    renderAdmin();
    await screen.findByText('alice.admin');
    await user.click(screen.getAllByRole('button', { name: /reset password for/i })[0]);
    await user.type(screen.getByLabelText(/^new password$/i), 'GoodPass!1');
    await user.type(screen.getByLabelText(/confirm new password/i), 'GoodPass!1');
    await user.click(screen.getByRole('button', { name: /^reset password$/i }));

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(/User not found/i),
    );
  });

  it('shows a forbidden subtitle when /auth/users returns 403', async () => {
    setUser('admin');
    server.use(
      http.get('/auth/users', () =>
        HttpResponse.json({ error: 'forbidden' }, { status: 403 }),
      ),
    );
    renderAdmin();
    await waitFor(() => expect(screen.getByText(/Forbidden/i)).toBeInTheDocument());
  });

  it('opens the Create-user form via the New-user button', async () => {
    setUser('admin');
    const user = userEvent.setup();
    renderAdmin();
    await screen.findByText('alice.admin');
    await user.click(screen.getByRole('button', { name: /new user/i }));
    expect(screen.getByRole('heading', { name: /^create user$/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/full name/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^email$/i)).toBeInTheDocument();
  });

  it('creates a user and surfaces the new username in the success view', async () => {
    setUser('admin');
    const user = userEvent.setup();
    renderAdmin();
    await screen.findByText('alice.admin');
    await user.click(screen.getByRole('button', { name: /new user/i }));
    const stamp = Date.now();
    const username = `test${stamp}`;
    await user.type(screen.getByLabelText(/full name/i), 'Test User');
    await user.type(screen.getByLabelText(/^username$/i), username);
    await user.type(screen.getByLabelText(/^email$/i), `test${stamp}@example.com`);
    await user.type(screen.getByLabelText(/initial password/i), 'GoodPass!1');
    await user.type(screen.getByLabelText(/^confirm password$/i), 'GoodPass!1');
    await user.click(screen.getByRole('button', { name: /^create user$/i }));

    const created = await screen.findByTestId('created-username');
    expect(created).toHaveTextContent(username);
  });

  it('lock toggle calls /auth/users/:username/lock and refreshes the row badge', async () => {
    setUser('admin');
    const user = userEvent.setup();
    renderAdmin();
    await screen.findByText('alice.admin');
    // Lock ravi.risk (a non-self user)
    const lockBtn = screen.getByRole('button', { name: /lock ravi\.risk/i });
    await user.click(lockBtn);
    // After mutation, the row gets a "locked" badge — query loosely.
    await waitFor(() => {
      const ravisRow = screen.getByText('ravi.risk').closest('tr');
      expect(ravisRow?.textContent).toMatch(/locked/i);
    });
  });

  it('refuses to delete the current admin', async () => {
    setUser('admin');
    renderAdmin();
    await screen.findByText('alice.admin');
    const deleteBtn = screen.getByRole('button', { name: /delete alice\.admin/i });
    expect(deleteBtn).toBeDisabled();
  });

  // ─── M6.1 — Users & RBAC: role-change action ─────────────────────
  it('M6.1 role-change: select reflects the new role after PATCH /auth/users/:u/role', async () => {
    setUser('admin');
    const origConfirm = window.confirm;
    window.confirm = () => true;
    try {
      const user = userEvent.setup();
      renderAdmin();
      // fiona.field starts as field_officer in DEMO_USERS
      await screen.findByText('fiona.field');
      const select = screen.getByTestId('admin-role-select-fiona.field') as HTMLSelectElement;
      expect(select.value).toBe('field_officer');
      // Change to supervisor — userEvent.selectOptions fires the change event
      await user.selectOptions(select, 'supervisor');
      // After mutation succeeds, the select reflects the new role
      await waitFor(() => {
        const updated = screen.getByTestId('admin-role-select-fiona.field') as HTMLSelectElement;
        expect(updated.value).toBe('supervisor');
      });
    } finally {
      window.confirm = origConfirm;
    }
  });

  it('M6.1 role-change: select disabled for the current user (no self-change)', async () => {
    setUser('admin');
    renderAdmin();
    await screen.findByText('alice.admin');
    const selfSelect = screen.getByTestId('admin-role-select-alice.admin') as HTMLSelectElement;
    expect(selfSelect.disabled).toBe(true);
  });

  it('M6.1 role-change: cancelling confirm dialog leaves role unchanged', async () => {
    setUser('admin');
    const origConfirm = window.confirm;
    window.confirm = () => false; // user clicks Cancel
    try {
      const user = userEvent.setup();
      renderAdmin();
      await screen.findByText('fiona.field');
      const select = screen.getByTestId('admin-role-select-fiona.field') as HTMLSelectElement;
      // Capture the current role — DEMO_USERS may have been mutated by an
      // earlier test in the file (in-process Map carries across); we only
      // care that the cancel path doesn't change WHATEVER it currently is.
      const before = select.value;
      // Pick any DIFFERENT role to try changing to — if before is
      // 'risk_analyst', pick 'supervisor' instead, etc.
      const target = before === 'risk_analyst' ? 'supervisor' : 'risk_analyst';
      await user.selectOptions(select, target);
      // Wait briefly to ensure no mutation fires
      await new Promise((r) => setTimeout(r, 50));
      const stillBefore = screen.getByTestId('admin-role-select-fiona.field') as HTMLSelectElement;
      expect(stillBefore.value).toBe(before);
    } finally {
      window.confirm = origConfirm;
    }
  });

  it('delete fires DELETE /auth/users/:username after confirm', async () => {
    setUser('admin');
    // window.confirm always returns true in tests
    const origConfirm = window.confirm;
    window.confirm = () => true;
    try {
      const user = userEvent.setup();
      renderAdmin();
      await screen.findByText('fiona.field');
      const deleteBtn = screen.getByRole('button', { name: /delete fiona\.field/i });
      await user.click(deleteBtn);
      // After the mutation refetches, fiona should no longer appear.
      await waitFor(() => {
        expect(screen.queryByText('fiona.field')).not.toBeInTheDocument();
      });
    } finally {
      window.confirm = origConfirm;
    }
  });
});
