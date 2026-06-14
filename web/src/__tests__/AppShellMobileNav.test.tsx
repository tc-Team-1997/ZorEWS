import { describe, expect, it, beforeEach } from 'vitest';
import { Route, Routes } from 'react-router-dom';
import { screen, fireEvent } from '@testing-library/react';
import { AppShell } from '@/components/layout/AppShell';
import { renderWithProviders } from './utils';
import { useAuth } from '@/store/auth';

function renderShell() {
  useAuth.setState({
    status: 'authenticated',
    token: 't',
    user: { id: 'u-001', username: 'alice.admin', roles: ['admin'] },
  });
  return renderWithProviders(
    <Routes>
      <Route element={<AppShell />}>
        <Route path="/" element={<div>home</div>} />
      </Route>
    </Routes>,
  );
}

describe('AppShell — mobile nav drawer', () => {
  beforeEach(() => {
    document.body.style.overflow = '';
  });

  it('renders the hamburger toggle', () => {
    renderShell();
    expect(screen.getByTestId('mobile-nav-toggle')).toBeInTheDocument();
  });

  it('sidebar starts off-canvas (closed)', () => {
    renderShell();
    const aside = screen.getByTestId('primary-sidebar');
    expect(aside.className).toContain('-translate-x-full');
    expect(screen.queryByTestId('mobile-nav-backdrop')).not.toBeInTheDocument();
  });

  it('nav links stay queryable while the drawer is closed (off-canvas ≠ hidden)', () => {
    renderShell();
    // Proves the transform-based approach keeps links in the a11y tree — the
    // whole reason we did NOT use `hidden lg:flex`.
    expect(screen.getByRole('link', { name: /^dashboard$/i })).toBeInTheDocument();
  });

  it('hamburger opens the drawer + shows the backdrop', () => {
    renderShell();
    fireEvent.click(screen.getByTestId('mobile-nav-toggle'));
    const aside = screen.getByTestId('primary-sidebar');
    expect(aside.className).not.toContain('-translate-x-full');
    expect(aside.className).toContain('shadow-xl');
    expect(screen.getByTestId('mobile-nav-backdrop')).toBeInTheDocument();
  });

  it('backdrop click closes the drawer', () => {
    renderShell();
    fireEvent.click(screen.getByTestId('mobile-nav-toggle'));
    expect(screen.getByTestId('mobile-nav-backdrop')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('mobile-nav-backdrop'));
    expect(screen.getByTestId('primary-sidebar').className).toContain('-translate-x-full');
    expect(screen.queryByTestId('mobile-nav-backdrop')).not.toBeInTheDocument();
  });

  it('Escape closes the drawer', () => {
    renderShell();
    fireEvent.click(screen.getByTestId('mobile-nav-toggle'));
    expect(screen.getByTestId('mobile-nav-backdrop')).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByTestId('mobile-nav-backdrop')).not.toBeInTheDocument();
  });
});
