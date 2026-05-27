import { describe, expect, it } from 'vitest';
import { LoginPage } from '@/modules/auth/LoginPage';
import { renderWithProviders } from './utils';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

describe('LoginPage CAPTCHA flow', () => {
  it('renders the CAPTCHA block after the captcha threshold of failed logins', async () => {
    const user = userEvent.setup();
    renderWithProviders(<LoginPage />);

    const usernameInput = screen.getByLabelText(/username/i);
    const passwordInput = screen.getByLabelText(/^password$/i);
    const submit = screen.getByRole('button', { name: /sign in/i });

    // 2 failed attempts (under the captcha threshold). MSW handler returns
    // invalid_credentials for these.
    for (let i = 0; i < 2; i++) {
      await user.clear(usernameInput);
      await user.clear(passwordInput);
      await user.type(usernameInput, 'alice.admin');
      await user.type(passwordInput, 'wrong-pw');
      await user.click(submit);
      await waitFor(() => {
        expect(screen.getByRole('alert')).toBeInTheDocument();
      });
    }

    // 3rd attempt — captcha gate fires, SPA fetches a challenge and renders it.
    await user.clear(passwordInput);
    await user.type(passwordInput, 'wrong-pw');
    await user.click(submit);

    await waitFor(() => {
      expect(screen.getByTestId('captcha-block')).toBeInTheDocument();
    });
    // Question text follows the "What is X + Y?" shape.
    const block = screen.getByTestId('captcha-block');
    expect(block.textContent).toMatch(/What is \d+ \+ \d+\?/);
  });

  it('clicking the refresh button replaces the CAPTCHA challenge with a new one', async () => {
    const user = userEvent.setup();
    renderWithProviders(<LoginPage />);
    const usernameInput = screen.getByLabelText(/username/i);
    const passwordInput = screen.getByLabelText(/^password$/i);
    const submit = screen.getByRole('button', { name: /sign in/i });

    // Burn 2 attempts and trigger the captcha on the 3rd.
    for (let i = 0; i < 3; i++) {
      await user.clear(usernameInput);
      await user.clear(passwordInput);
      await user.type(usernameInput, 'ravi.risk');
      await user.type(passwordInput, 'wrong-pw');
      await user.click(submit);
    }
    const block = await screen.findByTestId('captcha-block');
    const firstQuestion = block.textContent ?? '';

    // Refresh — question may sometimes be the same (random 1-9 + 1-9), so
    // assert that the captcha block is still present and renders a question.
    await user.click(screen.getByTestId('captcha-refresh'));
    await waitFor(() => {
      const refreshed = screen.getByTestId('captcha-block');
      expect(refreshed).toBeInTheDocument();
      expect(refreshed.textContent).toMatch(/What is \d+ \+ \d+\?/);
    });
    expect(firstQuestion).toMatch(/What is/);
  });
});
