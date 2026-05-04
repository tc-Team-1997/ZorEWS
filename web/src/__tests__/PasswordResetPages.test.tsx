import { describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { ForgotPasswordPage } from '@/modules/auth/ForgotPasswordPage';
import { ResetPasswordPage } from '@/modules/auth/ResetPasswordPage';
import { LoginPage } from '@/modules/auth/LoginPage';
import { renderWithProviders } from './utils';
import { server } from '@/mocks/server';

function renderForgot() {
  return renderWithProviders(
    <Routes>
      <Route path="/forgot-password" element={<ForgotPasswordPage />} />
      <Route path="/login" element={<LoginPage />} />
    </Routes>,
    { route: '/forgot-password' },
  );
}

function renderReset(path: string) {
  return renderWithProviders(
    <Routes>
      <Route path="/reset-password" element={<ResetPasswordPage />} />
      <Route path="/forgot-password" element={<ForgotPasswordPage />} />
      <Route path="/login" element={<LoginPage />} />
    </Routes>,
    { route: path },
  );
}

describe('ForgotPasswordPage', () => {
  it('renders the request form (username or email)', () => {
    renderForgot();
    expect(screen.getByRole('heading', { name: /reset your password/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/username or email/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /send reset link/i })).toBeInTheDocument();
  });

  it('shows zod validation when submitted blank', async () => {
    const user = userEvent.setup();
    renderForgot();
    await user.click(screen.getByRole('button', { name: /send reset link/i }));
    expect(await screen.findByText(/Username or email required/i)).toBeInTheDocument();
  });

  it('on success with a username, shows the prototype debug link with a copy button', async () => {
    const user = userEvent.setup();
    renderForgot();
    await user.type(screen.getByLabelText(/username or email/i), 'alice.admin');
    await user.click(screen.getByRole('button', { name: /send reset link/i }));

    expect(await screen.findByRole('heading', { name: /check your inbox/i })).toBeInTheDocument();
    const debug = await screen.findByTestId('debug-reset-link');
    expect(debug).toHaveTextContent(/\/reset-password\?token=/);
    expect(screen.getByRole('button', { name: /copy reset link/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /back to sign in/i })).toBeInTheDocument();
  });

  it('on success with an email, also shows the debug link (email-lookup path)', async () => {
    let captured: { username?: string; email?: string } | null = null;
    server.use(
      http.post('/auth/password/reset-request', async ({ request }) => {
        captured = (await request.json()) as { username?: string; email?: string };
        return HttpResponse.json(
          {
            ok: true,
            message: 'ok',
            debug: {
              token: 'abc',
              reset_link: 'http://localhost:5174/reset-password?token=abc',
              expires_at: new Date(Date.now() + 900_000).toISOString(),
            },
          },
          { status: 202 },
        );
      }),
    );
    const user = userEvent.setup();
    renderForgot();
    await user.type(screen.getByLabelText(/username or email/i), 'alice.admin@apex-ews.test');
    await user.click(screen.getByRole('button', { name: /send reset link/i }));

    await screen.findByRole('heading', { name: /check your inbox/i });
    expect(captured).toEqual({ email: 'alice.admin@apex-ews.test' });
  });

  it('username path posts the username field (no @)', async () => {
    let captured: { username?: string; email?: string } | null = null;
    server.use(
      http.post('/auth/password/reset-request', async ({ request }) => {
        captured = (await request.json()) as { username?: string; email?: string };
        return HttpResponse.json({ ok: true, message: 'ok' }, { status: 202 });
      }),
    );
    const user = userEvent.setup();
    renderForgot();
    await user.type(screen.getByLabelText(/username or email/i), 'sue.super');
    await user.click(screen.getByRole('button', { name: /send reset link/i }));

    await screen.findByRole('heading', { name: /check your inbox/i });
    expect(captured).toEqual({ username: 'sue.super' });
  });

  it('still shows generic success for unknown identifiers (no enumeration)', async () => {
    const user = userEvent.setup();
    renderForgot();
    await user.type(screen.getByLabelText(/username or email/i), 'nobody.here');
    await user.click(screen.getByRole('button', { name: /send reset link/i }));

    expect(await screen.findByRole('heading', { name: /check your inbox/i })).toBeInTheDocument();
    // No debug link for unknown identifiers — backend doesn't issue a token.
    expect(screen.queryByTestId('debug-reset-link')).not.toBeInTheDocument();
  });

  it('surfaces a 400 from the endpoint as an inline error', async () => {
    server.use(
      http.post('/auth/password/reset-request', () =>
        HttpResponse.json({ error: 'username or email required' }, { status: 400 }),
      ),
    );
    const user = userEvent.setup();
    renderForgot();
    await user.type(screen.getByLabelText(/username or email/i), 'whatever');
    await user.click(screen.getByRole('button', { name: /send reset link/i }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });
});

describe('ResetPasswordPage', () => {
  it('redirects to /forgot-password when token is missing', async () => {
    renderReset('/reset-password');
    expect(await screen.findByRole('heading', { name: /reset your password/i })).toBeInTheDocument();
  });

  it('renders the new-password form when token is present', () => {
    renderReset('/reset-password?token=abc123');
    expect(
      screen.getByRole('heading', { name: /choose a new password/i }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText(/^new password$/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/confirm new password/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /reset password/i })).toBeInTheDocument();
  });

  it('shows zod password mismatch on confirm', async () => {
    const user = userEvent.setup();
    renderReset('/reset-password?token=abc123');
    await user.type(screen.getByLabelText(/^new password$/i), 'GoodPass!1');
    await user.type(screen.getByLabelText(/confirm new password/i), 'Different!2');
    await user.click(screen.getByRole('button', { name: /reset password/i }));
    expect(await screen.findByText(/passwords do not match/i)).toBeInTheDocument();
  });

  it('shows the success view on a 200 response', async () => {
    server.use(
      http.post('/auth/password/reset-confirm', () =>
        HttpResponse.json({
          ok: true,
          username: 'alice.admin',
          message: 'Password updated. Sign in with your new password.',
        }),
      ),
    );
    const user = userEvent.setup();
    renderReset('/reset-password?token=valid-token');
    await user.type(screen.getByLabelText(/^new password$/i), 'GoodPass!1');
    await user.type(screen.getByLabelText(/confirm new password/i), 'GoodPass!1');
    await user.click(screen.getByRole('button', { name: /reset password/i }));

    expect(await screen.findByRole('heading', { name: /password updated/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /continue to sign in/i })).toBeInTheDocument();
  });

  it('surfaces an expired-token 400 with a friendly hint', async () => {
    server.use(
      http.post('/auth/password/reset-confirm', () =>
        HttpResponse.json({ error: 'invalid_or_expired_token' }, { status: 400 }),
      ),
    );
    const user = userEvent.setup();
    renderReset('/reset-password?token=expired');
    await user.type(screen.getByLabelText(/^new password$/i), 'GoodPass!1');
    await user.type(screen.getByLabelText(/confirm new password/i), 'GoodPass!1');
    await user.click(screen.getByRole('button', { name: /reset password/i }));
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(/invalid or has expired/i),
    );
  });

  it('surfaces a server-side weak-password rejection', async () => {
    server.use(
      http.post('/auth/password/reset-confirm', () =>
        HttpResponse.json(
          {
            error: 'password_too_weak',
            message: 'password must be ≥8 chars and include lower, upper, and a digit or symbol',
          },
          { status: 400 },
        ),
      ),
    );
    const user = userEvent.setup();
    renderReset('/reset-password?token=ok');
    await user.type(screen.getByLabelText(/^new password$/i), 'GoodPass!1');
    await user.type(screen.getByLabelText(/confirm new password/i), 'GoodPass!1');
    await user.click(screen.getByRole('button', { name: /reset password/i }));
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(/password must be/i),
    );
  });
});

describe('LoginPage — Forgot-password link', () => {
  it('shows a Forgot-password link that points to /forgot-password', () => {
    renderWithProviders(<LoginPage />);
    const link = screen.getByRole('link', { name: /forgot password/i });
    expect(link).toHaveAttribute('href', '/forgot-password');
  });
});
