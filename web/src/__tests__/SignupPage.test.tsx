import { describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { SignupPage } from '@/modules/auth/SignupPage';
import { LoginPage } from '@/modules/auth/LoginPage';
import { renderWithProviders } from './utils';
import { server } from '@/mocks/server';

function renderRoutes(initial = '/signup') {
  return renderWithProviders(
    <Routes>
      <Route path="/signup" element={<SignupPage />} />
      <Route path="/login" element={<LoginPage />} />
    </Routes>,
    { route: initial },
  );
}

describe('SignupPage', () => {
  it('renders the create-account form with role choices, email, and password fields', () => {
    renderRoutes();
    expect(screen.getByRole('heading', { name: /create account/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/full name/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^username$/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^email$/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^role$/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^password$/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/confirm password/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /create account/i })).toBeInTheDocument();
  });

  it('shows zod validation errors on submit when fields are empty / weak', async () => {
    const user = userEvent.setup();
    renderRoutes();
    await user.click(screen.getByRole('button', { name: /create account/i }));
    expect(await screen.findByText(/full name required/i)).toBeInTheDocument();
    expect(screen.getByText(/username must be at least 3/i)).toBeInTheDocument();
    expect(screen.getByText(/email required/i)).toBeInTheDocument();
    expect(screen.getByText(/password must be at least 8/i)).toBeInTheDocument();
  });

  it('rejects an invalid email format', async () => {
    const user = userEvent.setup();
    renderRoutes();
    await user.type(screen.getByLabelText(/full name/i), 'Tina Tester');
    await user.type(screen.getByLabelText(/^username$/i), 'tina.tester');
    await user.type(screen.getByLabelText(/^email$/i), 'not-an-email');
    await user.type(screen.getByLabelText(/^password$/i), 'GoodPass!1');
    await user.type(screen.getByLabelText(/confirm password/i), 'GoodPass!1');
    await user.click(screen.getByRole('button', { name: /create account/i }));
    expect(await screen.findByText(/Enter a valid email address/i)).toBeInTheDocument();
  });

  it('flags password mismatch on confirm', async () => {
    const user = userEvent.setup();
    renderRoutes();
    await user.type(screen.getByLabelText(/full name/i), 'Tina Tester');
    await user.type(screen.getByLabelText(/^username$/i), 'tina.tester');
    await user.type(screen.getByLabelText(/^email$/i), 'tina@example.com');
    await user.type(screen.getByLabelText(/^password$/i), 'GoodPass!1');
    await user.type(screen.getByLabelText(/confirm password/i), 'Different!2');
    await user.click(screen.getByRole('button', { name: /create account/i }));
    expect(await screen.findByText(/passwords do not match/i)).toBeInTheDocument();
  });

  it('on success, shows the created username + Continue-to-sign-in CTA', async () => {
    const user = userEvent.setup();
    renderRoutes();
    const stamp = Date.now();
    const username = `tina${stamp}`;
    await user.type(screen.getByLabelText(/full name/i), 'Tina Tester');
    await user.type(screen.getByLabelText(/^username$/i), username);
    await user.type(screen.getByLabelText(/^email$/i), `tina${stamp}@example.com`);
    await user.type(screen.getByLabelText(/^password$/i), 'GoodPass!1');
    await user.type(screen.getByLabelText(/confirm password/i), 'GoodPass!1');
    await user.click(screen.getByRole('button', { name: /create account/i }));

    expect(await screen.findByRole('heading', { name: /account created/i })).toBeInTheDocument();
    const created = await screen.findByTestId('created-username');
    expect(created).toHaveTextContent(username);
    expect(screen.getByRole('button', { name: /continue to sign in/i })).toBeInTheDocument();
  });

  it('surfaces a 409 username_taken as an inline error', async () => {
    server.use(
      http.post('/auth/register', () =>
        HttpResponse.json(
          { error: 'username_taken', message: 'username alice.admin already exists' },
          { status: 409 },
        ),
      ),
    );
    const user = userEvent.setup();
    renderRoutes();
    await user.type(screen.getByLabelText(/full name/i), 'Imposter');
    await user.type(screen.getByLabelText(/^username$/i), 'alice.admin');
    await user.type(screen.getByLabelText(/^email$/i), 'fake@example.com');
    await user.type(screen.getByLabelText(/^password$/i), 'GoodPass!1');
    await user.type(screen.getByLabelText(/confirm password/i), 'GoodPass!1');
    await user.click(screen.getByRole('button', { name: /create account/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/username is already taken/i);
  });

  it('surfaces a 400 password_too_weak with the server message', async () => {
    server.use(
      http.post('/auth/register', () =>
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
    renderRoutes();
    await user.type(screen.getByLabelText(/full name/i), 'Tina');
    await user.type(screen.getByLabelText(/^username$/i), 'tina2');
    await user.type(screen.getByLabelText(/^email$/i), 'tina2@example.com');
    await user.type(screen.getByLabelText(/^password$/i), 'GoodPass!1');
    await user.type(screen.getByLabelText(/confirm password/i), 'GoodPass!1');
    await user.click(screen.getByRole('button', { name: /create account/i }));
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(/password must be/i),
    );
  });
});

describe('LoginPage — Create-account link', () => {
  it('shows a Create-account link that points to /signup', () => {
    renderRoutes('/login');
    const link = screen.getByRole('link', { name: /create an account/i });
    expect(link).toBeInTheDocument();
    expect(link).toHaveAttribute('href', '/signup');
  });
});
