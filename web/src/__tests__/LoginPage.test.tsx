import { describe, expect, it, beforeEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import { Route, Routes } from 'react-router-dom';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LoginPage } from '@/modules/auth/LoginPage';
import { renderWithProviders } from './utils';
import { server } from '@/mocks/server';
import { useAuth } from '@/store/auth';
import { getOrganization } from '@/lib/organizations';

describe('LoginPage', () => {
  it('renders the premium sign-in form (demo accounts hint + subtitle removed per refined spec)', () => {
    renderWithProviders(<LoginPage />);
    expect(screen.getByRole('heading', { name: /sign in/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /sign in/i })).toBeInTheDocument();
    // The following copy was deliberately removed per the user's refined spec
    // (2026-05-30) — keep negative assertions so they can't quietly come back
    // via re-merge.
    expect(screen.queryByText(/Risk operations for authorised staff only/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/alice\.admin/)).not.toBeInTheDocument();
    expect(screen.queryByText(/ravi\.risk/)).not.toBeInTheDocument();
    expect(screen.queryByText(/fiona\.field/)).not.toBeInTheDocument();
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

describe('LoginPage — inline domain/country/tenant selectors', () => {
  beforeEach(() => {
    // Isolate from the auth tests above (which leave status=authenticated)
    // + clear any persisted onboarding context.
    useAuth.setState({ status: 'idle', token: null, user: null });
    for (const k of ['zorews.country', 'zorews.domainChosen', 'zorews.vertical', 'zorews.tenantContext']) {
      localStorage.removeItem(k);
    }
  });

  it('renders the country, domain, tenant dropdowns + remember-me on one card', () => {
    renderWithProviders(<LoginPage />);
    expect(screen.getByTestId('login-country')).toBeInTheDocument();
    expect(screen.getByTestId('login-domain')).toBeInTheDocument();
    expect(screen.getByTestId('login-tenant')).toBeInTheDocument();
    expect(screen.getByTestId('login-remember')).toBeInTheDocument();
  });

  it('tenant options follow the selected domain (banking ⇄ insurance)', async () => {
    const user = userEvent.setup();
    renderWithProviders(<LoginPage />);
    const tenant = screen.getByTestId('login-tenant') as HTMLSelectElement;
    // Default domain = banking → selected tenant resolves to a banking org.
    expect(getOrganization(tenant.value)?.domain).toBe('banking');
    // Switch to insurance → tenant auto-resets to an insurance org.
    await user.selectOptions(screen.getByTestId('login-domain'), 'insurance');
    await waitFor(() => expect(getOrganization(tenant.value)?.domain).toBe('insurance'));
  });

  it('redirects to /banking/dashboard after a banking sign-in', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <Routes>
        <Route path="/" element={<LoginPage />} />
        <Route path="/banking/dashboard" element={<div>banking-dash</div>} />
        <Route path="/insurance/dashboard" element={<div>insurance-dash</div>} />
      </Routes>,
      { route: '/' },
    );
    await user.type(screen.getByLabelText(/username/i), 'alice.admin');
    await user.type(screen.getByLabelText(/^password$/i), 'Admin!Pass1');
    await user.click(screen.getByRole('button', { name: /sign in/i }));
    expect(await screen.findByText('banking-dash')).toBeInTheDocument();
  });

  it('redirects to /insurance/dashboard after an insurance sign-in', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <Routes>
        <Route path="/" element={<LoginPage />} />
        <Route path="/banking/dashboard" element={<div>banking-dash</div>} />
        <Route path="/insurance/dashboard" element={<div>insurance-dash</div>} />
      </Routes>,
      { route: '/' },
    );
    await user.selectOptions(screen.getByTestId('login-domain'), 'insurance');
    await user.type(screen.getByLabelText(/username/i), 'alice.admin');
    await user.type(screen.getByLabelText(/^password$/i), 'Admin!Pass1');
    await user.click(screen.getByRole('button', { name: /sign in/i }));
    expect(await screen.findByText('insurance-dash')).toBeInTheDocument();
  });
});
