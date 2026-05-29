// web/src/__tests__/CommandPalette.test.tsx
//
// Aurora ⌘K command palette — pure entry-builder/filter coverage + AppShell
// integration (open via topbar button + ⌘K, type-to-filter, RBAC scoping,
// Escape to close).

import { describe, expect, it, beforeEach } from 'vitest';
import { Route, Routes } from 'react-router-dom';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AppShell } from '@/components/layout/AppShell';
import {
  buildCommandEntries,
  filterCommandEntries,
} from '@/components/layout/CommandPalette';
import { renderWithProviders } from './utils';
import { useAuth } from '@/store/auth';

const idT = (k: string) => k; // identity i18n for deterministic pure tests

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
  if (typeof window !== 'undefined') window.localStorage.removeItem('apex.ews.nav.collapsed');
});

describe('buildCommandEntries', () => {
  it('admin sees home + cross-domain + both domain groups', () => {
    const entries = buildCommandEntries(idT, ['admin'], null, true);
    const tos = entries.map((e) => e.to);
    expect(tos[0]).toBe('/'); // home first
    expect(tos).toContain('/alerts');
    expect(tos).toContain('/admin/users');
    expect(tos).toContain('/borrower-watch'); // bank-ews
    expect(tos).toContain('/insurance/policy-lapse'); // insurance-ews
  });

  it('field_officer is RBAC-filtered (no admin-only destinations)', () => {
    const entries = buildCommandEntries(idT, ['field_officer'], null, false);
    const tos = entries.map((e) => e.to);
    expect(tos).not.toContain('/admin/users');
    expect(tos).toContain('/glossary'); // no role gate
  });

  it('non-super-admin only sees the active domain group', () => {
    const banking = buildCommandEntries(idT, ['risk_analyst'], 'banking', false).map((e) => e.to);
    expect(banking).toContain('/borrower-watch');
    expect(banking).not.toContain('/insurance/policy-lapse');

    const insurance = buildCommandEntries(idT, ['risk_analyst'], 'insurance', false).map((e) => e.to);
    expect(insurance).toContain('/insurance/policy-lapse');
    expect(insurance).not.toContain('/borrower-watch');
  });
});

describe('filterCommandEntries', () => {
  const entries = [
    { to: '/alerts', label: 'Alerts', group: 'Action Center' },
    { to: '/admin/users', label: 'Users', group: 'Admin' },
    { to: '/admin/alert-classification', label: 'Alert Classification', group: 'Configuration' },
  ];

  it('empty query returns all', () => {
    expect(filterCommandEntries(entries, '')).toHaveLength(3);
    expect(filterCommandEntries(entries, '   ')).toHaveLength(3);
  });

  it('matches on label (case-insensitive)', () => {
    const r = filterCommandEntries(entries, 'alert').map((e) => e.to);
    expect(r).toContain('/alerts');
    expect(r).toContain('/admin/alert-classification');
    expect(r).not.toContain('/admin/users');
  });

  it('matches on path', () => {
    const r = filterCommandEntries(entries, '/admin/users').map((e) => e.to);
    expect(r).toEqual(['/admin/users']);
  });
});

describe('CommandPalette — AppShell integration', () => {
  it('is closed until the topbar button opens it, then filters + closes on Escape', async () => {
    const user = userEvent.setup();
    authenticateAs(['admin']);
    renderShell();

    expect(screen.queryByTestId('command-palette')).not.toBeInTheDocument();

    await user.click(screen.getByTestId('open-command-palette'));
    expect(screen.getByTestId('command-palette')).toBeInTheDocument();

    const input = screen.getByTestId('command-palette-input');
    await user.type(input, 'alert');
    expect(screen.getByTestId('command-option-/alerts')).toBeInTheDocument();
    expect(screen.queryByTestId('command-option-/admin/users')).not.toBeInTheDocument();

    await user.keyboard('{Escape}');
    expect(screen.queryByTestId('command-palette')).not.toBeInTheDocument();
  });

  it('⌘K toggles the palette open', async () => {
    const user = userEvent.setup();
    authenticateAs(['admin']);
    renderShell();

    await user.keyboard('{Meta>}k{/Meta}');
    await waitFor(() => expect(screen.getByTestId('command-palette')).toBeInTheDocument());
  });
});
