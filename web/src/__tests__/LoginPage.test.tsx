import { describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LoginPage } from '@/modules/auth/LoginPage';
import { renderWithProviders } from './utils';
import { server } from '@/mocks/server';
import { useAuth } from '@/store/auth';

describe('LoginPage', () => {
  it('renders the DMS-style sign-in form with demo accounts hint', () => {
    renderWithProviders(<LoginPage />);
    expect(screen.getByRole('heading', { name: /sign in/i })).toBeInTheDocument();
    expect(screen.getByText(/Risk operations for authorised staff only/i)).toBeInTheDocument();
    expect(screen.getByText(/alice\.admin/)).toBeInTheDocument();
    expect(screen.getByText(/ravi\.risk/)).toBeInTheDocument();
    expect(screen.getByText(/fiona\.field/)).toBeInTheDocument();
  });

  it('shows zod validation errors when fields are blank', async () => {
    const user = userEvent.setup();
    renderWithProviders(<LoginPage />);
    await user.click(screen.getByRole('button', { name: /sign in/i }));
    expect(await screen.findByText(/Username required/)).toBeInTheDocument();
    expect(screen.getByText(/Password required/)).toBeInTheDocument();
  });

  it('calls login() and authenticates on valid credentials', async () => {
    const user = userEvent.setup();
    renderWithProviders(<LoginPage />);
    await user.type(screen.getByLabelText(/username/i), 'alice.admin');
    await user.type(screen.getByLabelText(/^password$/i), 'Admin!Pass1');
    await user.click(screen.getByRole('button', { name: /sign in/i }));
    await waitFor(() => {
      expect(useAuth.getState().status).toBe('authenticated');
      expect(useAuth.getState().user?.username).toBe('alice.admin');
    });
  });

  it('surfaces a 401 as an inline error message', async () => {
    server.use(
      http.post('/auth/login', () =>
        HttpResponse.json({ message: 'nope' }, { status: 401 }),
      ),
    );
    const user = userEvent.setup();
    renderWithProviders(<LoginPage />);
    await user.type(screen.getByLabelText(/username/i), 'wrong');
    await user.type(screen.getByLabelText(/^password$/i), 'wrong');
    await user.click(screen.getByRole('button', { name: /sign in/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/invalid credentials/i);
  });
});
