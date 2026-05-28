// Domain-aware login enhancement — Country step (STEP 1), RequireOnboarding
// gate, and the domain-filtered sidebar. Additive re-connection of the
// existing 4-step onboarding flow; the login card itself is untouched.

import { describe, test, expect, beforeEach } from 'vitest';
import { Route, Routes } from 'react-router-dom';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from './utils';
import { useAuth } from '@/store/auth';
import { OnboardingCountryPage } from '@/modules/onboarding/OnboardingCountryPage';
import { RequireOnboarding } from '@/components/layout/RequireOnboarding';
import { AppShell } from '@/components/layout/AppShell';

const COUNTRY_KEY = 'zorews.country';
const DOMAIN_CHOSEN_KEY = 'zorews.domainChosen';
const VERTICAL_KEY = 'zorews.vertical';
const TENANT_KEY = 'zorews.tenantContext';

function authenticateAs(roles: string[]) {
  useAuth.setState({
    status: 'authenticated',
    token: 't',
    user: { id: 'u-001', username: 'alice.admin', roles: roles as never[] },
  });
}

function clearOnboarding() {
  localStorage.removeItem(COUNTRY_KEY);
  localStorage.removeItem(DOMAIN_CHOSEN_KEY);
  localStorage.removeItem(VERTICAL_KEY);
  localStorage.removeItem(TENANT_KEY);
  localStorage.removeItem('apex.ews.nav.collapsed');
}

function setDomain(domain: 'banking' | 'insurance') {
  localStorage.setItem(VERTICAL_KEY, domain === 'insurance' ? 'insurance' : 'bank');
  localStorage.setItem(DOMAIN_CHOSEN_KEY, '1');
}

beforeEach(() => {
  clearOnboarding();
  authenticateAs(['admin']);
});

// ── STEP 1 — Country page ──────────────────────────────────────────────

describe('OnboardingCountryPage (STEP 1)', () => {
  test('renders all 6 country cards', () => {
    renderWithProviders(
      <Routes>
        <Route path="/onboarding/country" element={<OnboardingCountryPage />} />
      </Routes>,
      { route: '/onboarding/country' },
    );
    expect(screen.getByText('Select your country')).toBeInTheDocument();
    for (const code of ['IN', 'AE', 'SG', 'US', 'GB', 'CA']) {
      expect(screen.getByTestId(`country-card-${code}`)).toBeInTheDocument();
    }
  });

  test('selecting a country + Continue persists it and routes to /onboarding/domain', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <Routes>
        <Route path="/onboarding/country" element={<OnboardingCountryPage />} />
        <Route path="/onboarding/domain" element={<div>domain-step</div>} />
      </Routes>,
      { route: '/onboarding/country' },
    );
    await user.click(screen.getByTestId('country-card-IN'));
    await user.click(screen.getByTestId('onboarding-country-confirm'));
    expect(await screen.findByText('domain-step')).toBeInTheDocument();
    expect(localStorage.getItem(COUNTRY_KEY)).toBe('IN');
  });

  test('Continue is disabled until a country is chosen', () => {
    renderWithProviders(
      <Routes>
        <Route path="/onboarding/country" element={<OnboardingCountryPage />} />
      </Routes>,
      { route: '/onboarding/country' },
    );
    expect(screen.getByTestId('onboarding-country-confirm')).toBeDisabled();
  });
});

// ── RequireOnboarding gate ─────────────────────────────────────────────

describe('RequireOnboarding gate', () => {
  function renderGate() {
    return renderWithProviders(
      <Routes>
        <Route
          path="/"
          element={
            <RequireOnboarding>
              <div>protected-app</div>
            </RequireOnboarding>
          }
        />
        <Route path="/onboarding/country" element={<div>country-step</div>} />
        <Route path="/onboarding/domain" element={<div>domain-step</div>} />
        <Route path="/onboarding/tenant" element={<div>tenant-step</div>} />
      </Routes>,
      { route: '/' },
    );
  }

  test('no country → redirects to /onboarding/country', () => {
    renderGate();
    expect(screen.getByText('country-step')).toBeInTheDocument();
  });

  test('country set but no domain → redirects to /onboarding/domain', () => {
    localStorage.setItem(COUNTRY_KEY, 'IN');
    renderGate();
    expect(screen.getByText('domain-step')).toBeInTheDocument();
  });

  test('country + domain but no tenant → redirects to /onboarding/tenant', () => {
    localStorage.setItem(COUNTRY_KEY, 'IN');
    setDomain('banking');
    renderGate();
    expect(screen.getByText('tenant-step')).toBeInTheDocument();
  });

  test('country + domain + tenant → renders the protected app', () => {
    localStorage.setItem(COUNTRY_KEY, 'IN');
    setDomain('banking');
    localStorage.setItem(
      TENANT_KEY,
      JSON.stringify({
        country: 'IN',
        domain: 'banking',
        organization_id: 'sbi-in',
        region: 'North',
        branch: 'HQ',
        tenant_id: 'BANK_DEMO',
      }),
    );
    renderGate();
    expect(screen.getByText('protected-app')).toBeInTheDocument();
  });
});

// ── Domain-filtered sidebar ────────────────────────────────────────────

describe('AppShell domain-filtered sidebar', () => {
  function renderShell() {
    return renderWithProviders(
      <Routes>
        <Route element={<AppShell />}>
          <Route path="/" element={<div>home</div>} />
        </Route>
      </Routes>,
      { route: '/' },
    );
  }

  test('insurance domain (non-admin) shows insurance modules, hides banking modules', () => {
    authenticateAs(['risk_analyst']);
    setDomain('insurance');
    const { container } = renderShell();
    expect(container.querySelector('a[href="/insurance/policy-lapse"]')).toBeInTheDocument();
    expect(container.querySelector('a[href="/borrower-watch"]')).not.toBeInTheDocument();
  });

  test('banking domain (non-admin) shows banking modules, hides insurance modules', () => {
    authenticateAs(['risk_analyst']);
    setDomain('banking');
    const { container } = renderShell();
    expect(container.querySelector('a[href="/borrower-watch"]')).toBeInTheDocument();
    expect(container.querySelector('a[href="/insurance/policy-lapse"]')).not.toBeInTheDocument();
  });

  test('super-admin sees BOTH domains regardless of chosen domain', () => {
    authenticateAs(['admin']);
    setDomain('insurance');
    const { container } = renderShell();
    expect(container.querySelector('a[href="/borrower-watch"]')).toBeInTheDocument();
    expect(container.querySelector('a[href="/insurance/policy-lapse"]')).toBeInTheDocument();
  });

  test('no domain chosen → all groups shown (filter is a no-op)', () => {
    authenticateAs(['risk_analyst']);
    const { container } = renderShell();
    expect(container.querySelector('a[href="/borrower-watch"]')).toBeInTheDocument();
    expect(container.querySelector('a[href="/insurance/policy-lapse"]')).toBeInTheDocument();
  });
});
