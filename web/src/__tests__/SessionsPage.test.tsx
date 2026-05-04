import { describe, expect, it, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SessionsPage } from '@/modules/profile/SessionsPage';
import { renderWithProviders } from './utils';
import { useAuth } from '@/store/auth';

beforeEach(() => {
  // The MSW mock seeds two sessions for the logged-in user — set up the
  // authenticated state + persist the user blob so the handler can read it.
  useAuth.setState({
    status: 'authenticated',
    token: 't',
    user: { id: 'u-001', username: 'alice.admin', roles: ['admin'] },
  });
  localStorage.setItem(
    'apex.ews.user',
    JSON.stringify({ id: 'u-001', username: 'alice.admin', roles: ['admin'] }),
  );
  localStorage.setItem('apex.ews.token', 't');
});

describe('SessionsPage', () => {
  it('lists active sessions with the current device flagged', async () => {
    renderWithProviders(<SessionsPage />);
    expect(
      screen.getByRole('heading', { name: /active sessions/i }),
    ).toBeInTheDocument();

    const list = await screen.findByTestId('sessions-list');
    const rows = within(list).getAllByRole('listitem');
    expect(rows.length).toBeGreaterThanOrEqual(2);

    // Exactly one current-badge present.
    expect(screen.getAllByTestId('current-badge')).toHaveLength(1);
  });

  it('Sign out other devices revokes other sessions and shows a confirmation', async () => {
    const user = userEvent.setup();
    renderWithProviders(<SessionsPage />);
    await screen.findByTestId('sessions-list');

    await user.click(screen.getByTestId('revoke-others'));
    const result = await screen.findByTestId('bulk-result');
    expect(result.textContent).toMatch(/Signed out/i);

    // After revoke, only the current session remains.
    await waitFor(() => {
      const list = screen.getByTestId('sessions-list');
      expect(within(list).getAllByRole('listitem')).toHaveLength(1);
    });
    expect(screen.getAllByTestId('current-badge')).toHaveLength(1);
  });
});
