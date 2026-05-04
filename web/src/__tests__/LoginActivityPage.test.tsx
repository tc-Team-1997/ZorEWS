import { describe, expect, it, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { LoginActivityPage } from '@/modules/profile/LoginActivityPage';
import { renderWithProviders } from './utils';
import { useAuth } from '@/store/auth';

beforeEach(() => {
  useAuth.setState({
    status: 'authenticated',
    token: 't',
    user: { id: 'u-002', username: 'ravi.risk', roles: ['risk_analyst'] },
  });
  localStorage.setItem(
    'apex.ews.user',
    JSON.stringify({ id: 'u-002', username: 'ravi.risk', roles: ['risk_analyst'] }),
  );
  localStorage.setItem('apex.ews.token', 't');
});

describe('LoginActivityPage', () => {
  it('renders the activity list with success + failure rows', async () => {
    renderWithProviders(<LoginActivityPage />);
    expect(
      screen.getByRole('heading', { name: /sign-in activity/i }),
    ).toBeInTheDocument();
    const list = await screen.findByTestId('activity-list');
    const rows = within(list).getAllByRole('listitem');
    expect(rows.length).toBeGreaterThan(0);
  });

  it('shows the last successful sign-in card', async () => {
    renderWithProviders(<LoginActivityPage />);
    const card = await screen.findByTestId('last-login');
    expect(card.textContent).toMatch(/Last successful sign-in/);
  });

  it('renders headline counts: success / failure / other', async () => {
    renderWithProviders(<LoginActivityPage />);
    await screen.findByTestId('activity-list');
    await waitFor(() => {
      expect(screen.getByTestId('stat-success')).toBeInTheDocument();
      expect(screen.getByTestId('stat-failure')).toBeInTheDocument();
      expect(screen.getByTestId('stat-other')).toBeInTheDocument();
    });
    // Failures > 0 should render in danger color (we don't assert color
    // directly but the count itself should be > 0 given the mock seed).
    const failure = screen.getByTestId('stat-failure');
    expect(Number(failure.textContent ?? '0')).toBeGreaterThan(0);
  });
});
