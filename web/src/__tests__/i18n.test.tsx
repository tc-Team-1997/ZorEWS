import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { Route, Routes } from 'react-router-dom';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AppShell } from '@/components/layout/AppShell';
import { LoginPage } from '@/modules/auth/LoginPage';
import { renderWithProviders } from './utils';
import { useAuth } from '@/store/auth';
import { i18n } from '@/lib/i18n';

beforeEach(async () => {
  // Force a fresh EN baseline before each test — other tests may have
  // flipped the language to HI mid-run.
  await i18n.changeLanguage('en');
  localStorage.removeItem('apex.ews.lang');
});

afterEach(async () => {
  await i18n.changeLanguage('en');
});

function authenticate() {
  useAuth.setState({
    status: 'authenticated',
    token: 't',
    user: { id: 'u-001', username: 'alice.admin', roles: ['admin'] },
  });
}

describe('i18n', () => {
  it('AppShell sidebar nav renders Hindi labels after switching language', async () => {
    authenticate();
    const user = userEvent.setup();
    renderWithProviders(
      <Routes>
        <Route element={<AppShell />}>
          <Route path="/" element={<div>home</div>} />
        </Route>
      </Routes>,
    );
    // Baseline: English visible.
    expect(screen.getByRole('link', { name: /^dashboard$/i })).toBeInTheDocument();

    const toggle = screen.getByTestId('language-toggle');
    await user.selectOptions(toggle, 'hi');

    await waitFor(() => {
      // "डैशबोर्ड" is the HI translation of "Dashboard". Use getAllByRole
      // since the nav may render the label in both the desktop sidebar and a
      // mobile nav — multiple matching elements are acceptable here.
      const links = screen.getAllByRole('link', { name: /डैशबोर्ड/ });
      expect(links.length).toBeGreaterThanOrEqual(1);
    });
    // English label should be gone after the switch.
    expect(screen.queryByRole('link', { name: /^dashboard$/i })).not.toBeInTheDocument();
  });

  it('AppShell language switch flips i18n.resolvedLanguage to the picked code', async () => {
    authenticate();
    const user = userEvent.setup();
    renderWithProviders(
      <Routes>
        <Route element={<AppShell />}>
          <Route path="/" element={<div>home</div>} />
        </Route>
      </Routes>,
    );
    await user.selectOptions(screen.getByTestId('language-toggle'), 'hi');
    await waitFor(() => {
      expect(i18n.resolvedLanguage).toBe('hi');
    });
  });

  it('Login page heading flips to Hindi when language is HI', async () => {
    await i18n.changeLanguage('hi');
    renderWithProviders(
      <Routes>
        <Route path="/login" element={<LoginPage />} />
      </Routes>,
      { route: '/login' },
    );
    // The HI heading is "साइन इन करें" — appears as both the H2 and the
    // submit button caption, so check the heading specifically.
    expect(screen.getByRole('heading', { name: /साइन इन करें/ })).toBeInTheDocument();
  });
});
