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
    // Navigation Simplification (2026-05-31): the standalone "Rules" sidebar
    // entry was retired in favour of "Rule Center" — the overlay landing
    // surfaces every rules sub-route via its card grid. The /rules legacy
    // URL still resolves directly (App.tsx route untouched).
    expect(screen.getByRole('link', { name: /^rule center$/i })).toBeInTheDocument();
    // Legacy "Cases" nav was retired — Case Management is the operational entry.
    // Exact match: "Case Management Setup" (admin #13) also matches a loose regex.
    expect(screen.getByRole('link', { name: /^case management$/i })).toBeInTheDocument();
    // Disambiguated from /admin/case-scenarios admin entry (M14.21)
    expect(screen.getByRole('link', { name: /^scenario/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /sign out/i })).toBeInTheDocument();
    expect(screen.getByText('alice.admin')).toBeInTheDocument();
  });
});
