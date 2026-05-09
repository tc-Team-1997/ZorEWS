import { describe, expect, it } from 'vitest';
import { Route, Routes } from 'react-router-dom';
import { screen } from '@testing-library/react';
import { AppShell } from '@/components/layout/AppShell';
import { renderWithProviders } from './utils';
import { useAuth } from '@/store/auth';

describe('AppShell', () => {
  it('renders all primary nav items', () => {
    // Pretend authenticated so logout button has a username.
    useAuth.setState({
      status: 'authenticated',
      token: 't',
      user: { id: 'u-001', username: 'alice.admin', roles: ['admin'] },
    });

    renderWithProviders(
      <Routes>
        <Route element={<AppShell />}>
          <Route path="/" element={<div>home</div>} />
        </Route>
      </Routes>,
    );

    expect(screen.getByRole('link', { name: /dashboard/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /alerts/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /customers/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /rules/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /cases/i })).toBeInTheDocument();
    // Disambiguated from /admin/case-scenarios admin entry (M14.21)
    expect(screen.getByRole('link', { name: /^scenario/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /sign out/i })).toBeInTheDocument();
    expect(screen.getByText('alice.admin')).toBeInTheDocument();
  });
});
