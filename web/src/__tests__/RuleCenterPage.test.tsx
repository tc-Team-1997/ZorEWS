// Unified Rule Center landing page — smoke test.
//
// Covers:
//   • role gate (analyst+ only — non-admin/non-supervisor/non-risk_analyst redirects)
//   • landing card grid renders 6 sub-sections
//   • backwards-compat panel surfaces every legacy URL
//   • exported RULE_CENTER_CARDS array invariants

import { describe, expect, it, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import { RuleCenterPage, RULE_CENTER_CARDS } from '@/modules/rules/RuleCenterPage';
import { DashboardPage } from '@/modules/dashboard/DashboardPage';
import { renderWithProviders } from './utils';
import { useAuth } from '@/store/auth';

function setUser(role: 'admin' | 'risk_analyst' | 'field_officer') {
  const user = {
    id: 'u-001',
    username: role === 'admin' ? 'alice.admin' : `test.${role}`,
    roles: [role] as ('admin' | 'risk_analyst' | 'field_officer')[],
  };
  localStorage.setItem('apex.ews.user', JSON.stringify(user));
  localStorage.setItem('apex.ews.token', 'mock.test.token');
  useAuth.setState({ status: 'authenticated', user: user as never, token: 'mock.test.token' });
}

function renderPage() {
  return renderWithProviders(
    <Routes>
      <Route path="/rule-center" element={<RuleCenterPage />} />
      <Route path="/" element={<DashboardPage />} />
    </Routes>,
    { route: '/rule-center' },
  );
}

beforeEach(() => {
  localStorage.clear();
});

describe('RuleCenterPage', () => {
  it('admin sees the landing page + all 6 cards', () => {
    setUser('admin');
    renderPage();
    expect(screen.getByTestId('rule-center-page')).toBeInTheDocument();
    for (const card of RULE_CENTER_CARDS) {
      expect(screen.getByTestId(`rule-center-card-${card.id}`)).toBeInTheDocument();
    }
  });

  it('risk_analyst can see the page (analyst+ gate)', () => {
    setUser('risk_analyst');
    renderPage();
    expect(screen.getByTestId('rule-center-page')).toBeInTheDocument();
  });

  it('field_officer is redirected (below analyst gate)', () => {
    setUser('field_officer');
    renderPage();
    expect(screen.queryByTestId('rule-center-page')).not.toBeInTheDocument();
  });

  it('renders backwards-compat legacy URL panel', () => {
    setUser('admin');
    renderPage();
    expect(screen.getByTestId('rule-center-legacy-links')).toBeInTheDocument();
  });

  it('exports exactly 6 cards in canonical order', () => {
    const ids = RULE_CENTER_CARDS.map((c) => c.id);
    expect(ids).toEqual([
      'builder',
      'library',
      'testing',
      'reports',
      'history',
      'comparison',
    ]);
  });

  it('every card declares a /rule-center/* target', () => {
    for (const card of RULE_CENTER_CARDS) {
      expect(card.to).toMatch(/^\/rule-center\//);
    }
  });

  it('every card declares a legacy URL pointing at an existing /rules surface', () => {
    for (const card of RULE_CENTER_CARDS) {
      expect(card.legacyTo).toMatch(/^\/rules/);
    }
  });
});
