// Route-level domain guard — a Banking user URL-hopping to an Insurance
// route is bounced; super-admin + unset-domain pass through (non-breaking).

import { describe, test, expect, beforeEach } from 'vitest';
import { Route, Routes } from 'react-router-dom';
import { screen } from '@testing-library/react';
import { renderWithProviders } from './utils';
import { useAuth } from '@/store/auth';
import { RequireDomain } from '@/components/layout/RequireDomain';

function authenticateAs(roles: string[]) {
  useAuth.setState({
    status: 'authenticated',
    token: 't',
    user: { id: 'u-001', username: 'u', roles: roles as never[] },
  });
}
function setDomain(domain: 'banking' | 'insurance' | null) {
  if (domain === null) {
    localStorage.removeItem('zorews.vertical');
    localStorage.removeItem('zorews.domainChosen');
    return;
  }
  localStorage.setItem('zorews.vertical', domain === 'insurance' ? 'insurance' : 'bank');
  localStorage.setItem('zorews.domainChosen', '1');
}

function renderGuarded() {
  return renderWithProviders(
    <Routes>
      <Route element={<RequireDomain domain="insurance" />}>
        <Route path="/insurance/x" element={<div>insurance-page</div>} />
      </Route>
      <Route path="/banking/dashboard" element={<div>banking-dash</div>} />
      <Route path="/insurance/dashboard" element={<div>insurance-dash</div>} />
    </Routes>,
    { route: '/insurance/x' },
  );
}

beforeEach(() => {
  setDomain(null);
  useAuth.setState({ status: 'idle', token: null, user: null });
});

describe('RequireDomain', () => {
  test('banking user (non-admin) is bounced off an insurance route', () => {
    authenticateAs(['risk_analyst']);
    setDomain('banking');
    renderGuarded();
    expect(screen.queryByText('insurance-page')).not.toBeInTheDocument();
    expect(screen.getByText('banking-dash')).toBeInTheDocument();
  });

  test('insurance user reaches the insurance route', () => {
    authenticateAs(['risk_analyst']);
    setDomain('insurance');
    renderGuarded();
    expect(screen.getByText('insurance-page')).toBeInTheDocument();
  });

  test('super-admin reaches the insurance route regardless of active domain', () => {
    authenticateAs(['admin']);
    setDomain('banking');
    renderGuarded();
    expect(screen.getByText('insurance-page')).toBeInTheDocument();
  });

  test('no active domain → pass through (no-op, keeps direct renders working)', () => {
    authenticateAs(['risk_analyst']);
    setDomain(null);
    renderGuarded();
    expect(screen.getByText('insurance-page')).toBeInTheDocument();
  });
});
