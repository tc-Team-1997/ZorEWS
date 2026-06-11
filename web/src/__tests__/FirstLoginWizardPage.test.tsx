import { describe, expect, it, beforeEach } from 'vitest';
import { Route, Routes } from 'react-router-dom';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FirstLoginWizardPage } from '@/modules/auth/FirstLoginWizardPage';
import { renderWithProviders } from './utils';
import { useAuth } from '@/store/auth';
import { DEMO_USERS } from '@/mocks/data';

beforeEach(() => {
  // Stand up an authenticated user with the must_change_password flag
  // raised so the wizard renders. Mirror the demo-user shape so the MSW
  // first-login handler resolves the right account when called.
  const seed = DEMO_USERS.find((u) => u.username === 'fiona.field')!;
  // Reset any state mutations from prior tests in this file.
  seed.must_change_password = true;
  seed.terms_accepted_at = null;
  seed.password = 'Field!Pass1';
  useAuth.setState({
    status: 'authenticated',
    token: `mock.${seed.id}.${Date.now()}`,
    user: {
      id: seed.id,
      username: seed.username,
      roles: seed.roles,
      display_name: seed.display_name,
      must_change_password: true,
      terms_accepted_at: null,
    },
  });
  localStorage.setItem(
    'apex.ews.user',
    JSON.stringify({ id: seed.id, username: seed.username, roles: seed.roles }),
  );
  localStorage.setItem('apex.ews.token', 't');
});

describe('FirstLoginWizardPage', () => {
  it('renders the wizard with password fields and T&C checkbox', () => {
    renderWithProviders(<FirstLoginWizardPage />);
    expect(screen.getByTestId('first-login-wizard')).toBeInTheDocument();
    expect(screen.getByLabelText(/^new password$/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/confirm new password/i)).toBeInTheDocument();
    expect(screen.getByTestId('accept-terms')).toBeInTheDocument();
  });

  it('rejects submission without T&C acceptance', async () => {
    const user = userEvent.setup();
    renderWithProviders(<FirstLoginWizardPage />);
    await user.type(screen.getByLabelText(/^new password$/i), 'Brand!New123');
    await user.type(screen.getByLabelText(/confirm new password/i), 'Brand!New123');
    await user.click(screen.getByTestId('first-login-submit'));
    await waitFor(() => {
      expect(screen.getByText(/must accept the platform terms/i)).toBeInTheDocument();
    });
  });

  it('completes the wizard, clears must_change_password locally, and routes to /', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <Routes>
        <Route path="/" element={<div data-testid="home">Home</div>} />
        <Route path="/first-login" element={<FirstLoginWizardPage />} />
      </Routes>,
      { route: '/first-login' },
    );

    await user.type(screen.getByLabelText(/^new password$/i), 'Brand!New123');
    await user.type(screen.getByLabelText(/confirm new password/i), 'Brand!New123');
    await user.click(screen.getByTestId('accept-terms'));
    await user.click(screen.getByTestId('first-login-submit'));

    await waitFor(() => {
      expect(screen.getByTestId('home')).toBeInTheDocument();
    });
    expect(useAuth.getState().user?.must_change_password).toBe(false);
    expect(useAuth.getState().user?.terms_accepted_at).toBeTruthy();
  });
});
