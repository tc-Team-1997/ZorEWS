// Phase 9 T2 — AdminSessionsPage test.
//
// Covers admin-only gate, status filter, username search, table row render,
// + the per-session revoke button (with window.prompt for the reason).

import { describe, expect, it, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { AdminSessionsPage } from '@/modules/admin/AdminSessionsPage';
import { DashboardPage } from '@/modules/dashboard/DashboardPage';
import { renderWithProviders } from './utils';
import { useAuth } from '@/store/auth';

function setUser(role: 'admin' | 'risk_analyst') {
  const user = {
    id: 'u-001',
    username: role === 'admin' ? 'alice.admin' : 'test.risk_analyst',
    roles: [role] as ('admin' | 'risk_analyst')[],
  };
  localStorage.setItem('apex.ews.user', JSON.stringify(user));
  localStorage.setItem('apex.ews.token', 'mock.test.token');
  useAuth.setState({ status: 'authenticated', user: user as never, token: 'mock.test.token' });
}

function renderPage() {
  return renderWithProviders(
    <Routes>
      <Route path="/admin/sessions" element={<AdminSessionsPage />} />
      <Route path="/" element={<DashboardPage />} />
    </Routes>,
    { route: '/admin/sessions' },
  );
}

beforeEach(() => {
  localStorage.clear();
});

describe('AdminSessionsPage', () => {
  it('redirects non-admin to / (no admin UI exposure)', async () => {
    setUser('risk_analyst');
    renderPage();
    expect(await screen.findByText(/EWS Dashboard/i)).toBeInTheDocument();
    expect(screen.queryByTestId('admin-sessions-page')).not.toBeInTheDocument();
  });

  it('renders the page chrome + status filter chips for admins', async () => {
    setUser('admin');
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('admin-sessions-page')).toBeInTheDocument();
    });
    expect(screen.getByTestId('status-filter-active')).toBeInTheDocument();
    expect(screen.getByTestId('status-filter-revoked')).toBeInTheDocument();
    expect(screen.getByTestId('status-filter-all')).toBeInTheDocument();
    expect(screen.getByTestId('admin-sessions-search')).toBeInTheDocument();
  });

  it('renders rows from MSW seed (≥ 2 cross-user sessions)', async () => {
    setUser('admin');
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('admin-sessions-table')).toBeInTheDocument();
    });
    // MSW seeds at least 2 sessions across u-002 + u-003
    const table = screen.getByTestId('admin-sessions-table');
    expect(table.textContent).toMatch(/ravi\.risk|sara\.supervisor/);
  });

  it('switching to status=revoked shows the empty state (no revoked rows in seed)', async () => {
    setUser('admin');
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('admin-sessions-table')).toBeInTheDocument();
    });
    await user.click(screen.getByTestId('status-filter-revoked'));
    await waitFor(() => {
      expect(screen.getByTestId('admin-sessions-empty')).toBeInTheDocument();
    });
  });

  it('search by username narrows the table client-side', async () => {
    setUser('admin');
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('admin-sessions-table')).toBeInTheDocument();
    });
    await user.type(screen.getByTestId('admin-sessions-search'), 'ravi');
    await waitFor(() => {
      const table = screen.getByTestId('admin-sessions-table');
      expect(table.textContent).toMatch(/ravi\.risk/);
      expect(table.textContent).not.toMatch(/sara\.supervisor/);
    });
  });

  it('revoke button fires POST /auth/admin/sessions/:sid/revoke after window.prompt', async () => {
    setUser('admin');
    const origPrompt = window.prompt;
    window.prompt = () => 'leaked refresh token';
    try {
      const user = userEvent.setup();
      renderPage();
      await waitFor(() => {
        expect(screen.getByTestId('admin-sessions-table')).toBeInTheDocument();
      });
      // Pick any revoke button
      const revokeBtns = screen.getAllByRole('button', { name: /Revoke session sid-/i });
      expect(revokeBtns.length).toBeGreaterThan(0);
      const firstBtn = revokeBtns[0]!;
      const sid = firstBtn.getAttribute('aria-label')!.replace('Revoke session ', '');
      await user.click(firstBtn);
      // After mutation the row should be removed from the table (MSW deletes
      // from _mockSessions). Wait for the row to disappear.
      await waitFor(() => {
        expect(screen.queryByTestId(`admin-session-row-${sid}`)).not.toBeInTheDocument();
      });
    } finally {
      window.prompt = origPrompt;
    }
  });

  it('revoke is cancelled when window.prompt returns null', async () => {
    setUser('admin');
    const origPrompt = window.prompt;
    window.prompt = () => null;
    try {
      const user = userEvent.setup();
      renderPage();
      await waitFor(() => {
        expect(screen.getByTestId('admin-sessions-table')).toBeInTheDocument();
      });
      const revokeBtns = screen.getAllByRole('button', { name: /Revoke session sid-/i });
      const firstBtn = revokeBtns[0]!;
      const sid = firstBtn.getAttribute('aria-label')!.replace('Revoke session ', '');
      await user.click(firstBtn);
      // Row should still be present (cancel = no mutation)
      expect(screen.getByTestId(`admin-session-row-${sid}`)).toBeInTheDocument();
    } finally {
      window.prompt = origPrompt;
    }
  });
});
