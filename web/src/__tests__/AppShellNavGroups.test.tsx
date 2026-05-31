// web/src/__tests__/AppShellNavGroups.test.tsx
//
// Sidebar reorganisation smoke — verifies the 6-category structure +
// collapsibility + RBAC + every route still reachable.

import { describe, expect, it, beforeEach } from 'vitest';
import { Route, Routes } from 'react-router-dom';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AppShell } from '@/components/layout/AppShell';
import { NAV_GROUPS, NAV_HOME, listAllNavRoutes } from '@/components/layout/navConfig';
import { renderWithProviders } from './utils';
import { useAuth } from '@/store/auth';

function authenticateAs(roles: string[]) {
  useAuth.setState({
    status: 'authenticated',
    token: 't',
    user: { id: 'u-001', username: 'alice.admin', roles: roles as never[] },
  });
}

function renderShell() {
  return renderWithProviders(
    <Routes>
      <Route element={<AppShell />}>
        <Route path="/" element={<div>home</div>} />
      </Route>
    </Routes>,
  );
}

beforeEach(() => {
  // Wipe persisted collapse state so every test starts with all groups expanded
  if (typeof window !== 'undefined') window.localStorage.removeItem('apex.ews.nav.collapsed');
});

describe('AppShell sidebar — 6-category enterprise structure', () => {
  it('exposes the enterprise category groups in declared order', () => {
    authenticateAs(['admin']);
    renderShell();

    const expectedOrder = [
      'data-cleaning',
      'bank-ews',
      'insurance-ews',
      'action-center',
      'ai-workbench',
      'configuration',
      'admin',
    ];
    expect(NAV_GROUPS.map((g) => g.id)).toEqual(expectedOrder);

    // Each group's header button rendered with proper aria-expanded
    for (const id of expectedOrder) {
      const header = screen.getByTestId(`nav-group-header-${id}`);
      expect(header).toBeInTheDocument();
      expect(header.getAttribute('aria-expanded')).toBe('true');
    }
  });

  it('renders Dashboard at the top, outside the categories', () => {
    authenticateAs(['admin']);
    renderShell();
    const home = screen.getByTestId('nav-home');
    expect(within(home).getByTestId(`nav-link-${NAV_HOME.to}`)).toBeInTheDocument();
  });

  it('admin sees every primary screen mapped to its declared category', () => {
    authenticateAs(['admin']);
    renderShell();

    // Per the Navigation Simplification (2026-05-31), AI explainability moved
    // under AI Workbench (/ai/workbench/explainability) and overlay-center
    // sub-routes (rule-center/audit-center/recovery-center/iam/etc.) are
    // hidden from the sidebar in favour of their overlay landings. The
    // featured-anchor assertions below were updated to reflect the current
    // hidden-via-card-grid IA. Every removed route still resolves via its
    // overlay center landing + URL bar + bookmarks.
    const featuredByGroup: Record<string, string[]> = {
      'data-cleaning': ['/admin/ingestion', '/admin/data-profiling', '/admin/anomalies', '/admin/reconciliation', '/admin/dq-score'],
      'bank-ews': ['/borrower-watch', '/account-behaviour', '/financial-ratios', '/banking/sma', '/banking/npa-prediction', '/fraud-signals', '/banking/sectors'],
      'action-center': ['/alerts', '/cms/cases', '/cms/workflow', '/reports'],
      'ai-workbench': ['/ai/workbench', '/ai/registry', '/ai/workbench/explainability'],
      'configuration': ['/admin/master-setup', '/admin/governance', '/rule-center', '/admin/thresholds-limits', '/admin/workflows'],
      'admin': ['/admin/users', '/admin/iam', '/admin/security', '/audit-center', '/recovery-center', '/admin/testing-hub', '/glossary'],
    };

    for (const [groupId, routes] of Object.entries(featuredByGroup)) {
      const list = screen.getByTestId(`nav-group-${groupId}-items`);
      for (const to of routes) {
        expect(within(list).getByTestId(`nav-link-${to}`)).toBeInTheDocument();
      }
    }
  });

  it('every mounted nav route appears in exactly one group (no duplicates)', () => {
    authenticateAs(['admin']);
    renderShell();

    const allRoutes = listAllNavRoutes();
    // De-dup check at config level
    expect(new Set(allRoutes).size).toBe(allRoutes.length);

    // Every route ends up in at most one group section of the rendered sidebar
    for (const to of allRoutes) {
      if (to === NAV_HOME.to) continue; // home lives outside groups
      const matches = screen.queryAllByTestId(`nav-link-${to}`);
      expect(matches.length).toBe(1);
    }
  });

  it('clicking a category header collapses it + a second click re-opens', async () => {
    const user = userEvent.setup();
    authenticateAs(['admin']);
    renderShell();

    const header = screen.getByTestId('nav-group-header-data-cleaning');
    expect(screen.getByTestId('nav-group-data-cleaning-items')).toBeInTheDocument();

    await user.click(header);
    expect(screen.queryByTestId('nav-group-data-cleaning-items')).not.toBeInTheDocument();
    expect(header.getAttribute('aria-expanded')).toBe('false');

    await user.click(header);
    expect(screen.getByTestId('nav-group-data-cleaning-items')).toBeInTheDocument();
    expect(header.getAttribute('aria-expanded')).toBe('true');
  });

  it('collapse state persists across remount via localStorage', () => {
    authenticateAs(['admin']);
    const { unmount } = renderShell();
    // Manually toggle state in storage so we don't rely on the click handler ordering
    window.localStorage.setItem('apex.ews.nav.collapsed', JSON.stringify(['admin']));
    unmount();
    renderShell();
    expect(screen.queryByTestId('nav-group-admin-items')).not.toBeInTheDocument();
    expect(screen.getByTestId('nav-group-header-admin').getAttribute('aria-expanded')).toBe('false');
  });

  it('field_officer sees role-permitted items only (admin-only groups hidden)', () => {
    authenticateAs(['field_officer']);
    renderShell();
    // Admin group should hide because no admin-tier item permits field_officer
    // (Users + audit_trail + testing_hub + tenants etc. all require admin/supervisor).
    // But /glossary inside admin has no requireRole — group is still rendered.
    expect(screen.getByTestId('nav-group-header-admin')).toBeInTheDocument();
    // /admin/users (admin-only) must NOT render for field_officer
    expect(screen.queryByTestId('nav-link-/admin/users')).not.toBeInTheDocument();
    // /glossary (no role gate) MUST render
    expect(screen.getByTestId('nav-link-/glossary')).toBeInTheDocument();
  });

  it('NavLink active-state class still applies for matching routes', () => {
    authenticateAs(['admin']);
    renderWithProviders(
      <Routes>
        <Route element={<AppShell />}>
          <Route path="/" element={<div>home</div>} />
        </Route>
      </Routes>,
      { route: '/' },
    );
    const link = screen.getByTestId(`nav-link-${NAV_HOME.to}`);
    // react-router NavLink emits class with 'bg-sidebar-hover' when active.
    expect(link.className).toMatch(/bg-sidebar-hover/);
  });
});
