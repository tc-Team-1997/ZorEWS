// Vitest for the multi-source admin activity page.
//
// Verifies it surfaces UAO + report_export + ews_rule_version rows
// from the BFF, that the entity_type dropdown narrows correctly, that
// the page summary counters update, and that the rule-revert row deep-
// links to the diff viewer.

import { describe, expect, it } from 'vitest';
import { Route, Routes } from 'react-router-dom';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AdminActivityPage } from '@/modules/admin/AdminActivityPage';
import { renderWithProviders } from './utils';

function authAsAdmin() {
  localStorage.setItem(
    'apex.ews.user',
    JSON.stringify({ username: 'alice.admin', roles: ['admin'] }),
  );
}

function renderAt(path = '/admin/activity') {
  return renderWithProviders(
    <Routes>
      <Route path="/admin/activity" element={<AdminActivityPage />} />
    </Routes>,
    { route: path },
  );
}

describe('AdminActivityPage — initial render', () => {
  it('shows the page header + filter row', async () => {
    authAsAdmin();
    renderAt();
    expect(
      await screen.findByRole('heading', { name: /Admin activity/i }),
    ).toBeInTheDocument();
    expect(screen.getByTestId('filter-entity-type')).toBeInTheDocument();
    expect(screen.getByTestId('filter-actor')).toBeInTheDocument();
  });

  it('hydrates rows from the seed: 2 UAO + 2 exports + 1 revert', async () => {
    authAsAdmin();
    renderAt();
    await waitFor(() =>
      expect(screen.getByTestId('activity-table')).toBeInTheDocument(),
    );
    // Each entity type appears in the rendered table
    const table = screen.getByTestId('activity-table');
    expect(table.querySelectorAll('[data-entity-type="user_access_override"]').length).toBeGreaterThanOrEqual(1);
    expect(table.querySelectorAll('[data-entity-type="report_export"]').length).toBe(2);
    expect(table.querySelectorAll('[data-entity-type="ews_rule_version"]').length).toBe(1);
  });
});

describe('AdminActivityPage — entity_type filter', () => {
  it('switching to report_export hides UAO + revert rows', async () => {
    authAsAdmin();
    const user = userEvent.setup();
    renderAt();
    await waitFor(() => expect(screen.getByTestId('activity-table')).toBeInTheDocument());
    await user.selectOptions(screen.getByTestId('filter-entity-type'), 'report_export');
    await waitFor(() => {
      const table = screen.getByTestId('activity-table');
      expect(table.querySelectorAll('[data-entity-type="user_access_override"]').length).toBe(0);
      expect(table.querySelectorAll('[data-entity-type="ews_rule_version"]').length).toBe(0);
      expect(table.querySelectorAll('[data-entity-type="report_export"]').length).toBe(2);
    });
  });

  it('switching to ews_rule_version shows just the revert row', async () => {
    authAsAdmin();
    const user = userEvent.setup();
    renderAt();
    await waitFor(() => expect(screen.getByTestId('activity-table')).toBeInTheDocument());
    await user.selectOptions(screen.getByTestId('filter-entity-type'), 'ews_rule_version');
    await waitFor(() => {
      const table = screen.getByTestId('activity-table');
      expect(table.querySelectorAll('[data-entity-type="ews_rule_version"]').length).toBe(1);
      expect(table.querySelectorAll('[data-entity-type="report_export"]').length).toBe(0);
    });
  });

  it('URL ?entity_type= prefills the dropdown', async () => {
    authAsAdmin();
    renderAt('/admin/activity?entity_type=report_export');
    await waitFor(() => {
      const sel = screen.getByTestId('filter-entity-type') as HTMLSelectElement;
      expect(sel.value).toBe('report_export');
    });
  });
});

describe('AdminActivityPage — Phase 9 T1-full admin_user_action source', () => {
  it('All-sources view merges auth-svc admin events into the timeline', async () => {
    authAsAdmin();
    renderAt();
    await waitFor(() => expect(screen.getByTestId('activity-table')).toBeInTheDocument());
    // The 4 MSW seed admin actions (user_disabled, user_force_logout,
    // user_enabled, user_role_changed) should ALL render rows with the
    // new admin_user_action entity type when no filter is applied.
    await waitFor(() => {
      const table = screen.getByTestId('activity-table');
      const adminActionRows = table.querySelectorAll('[data-entity-type="admin_user_action"]');
      expect(adminActionRows.length).toBeGreaterThanOrEqual(4);
    });
  });

  it('stat counter reflects the merged admin_user_action count', async () => {
    authAsAdmin();
    renderAt();
    await waitFor(() => {
      const stat = screen.getByTestId('stat-admin-user-action');
      expect(Number(stat.textContent)).toBeGreaterThanOrEqual(4);
    });
  });

  it('switching to admin_user_action filter shows only auth-svc rows (no UAO/exports)', async () => {
    authAsAdmin();
    const user = userEvent.setup();
    renderAt();
    await waitFor(() => expect(screen.getByTestId('activity-table')).toBeInTheDocument());
    await user.selectOptions(screen.getByTestId('filter-entity-type'), 'admin_user_action');
    await waitFor(() => {
      const table = screen.getByTestId('activity-table');
      expect(
        table.querySelectorAll('[data-entity-type="user_access_override"]').length,
      ).toBe(0);
      expect(table.querySelectorAll('[data-entity-type="report_export"]').length).toBe(0);
      expect(table.querySelectorAll('[data-entity-type="ews_rule_version"]').length).toBe(0);
      expect(
        table.querySelectorAll('[data-entity-type="admin_user_action"]').length,
      ).toBeGreaterThanOrEqual(4);
    });
  });

  it('admin_user_action rows render the target_username + action badge', async () => {
    authAsAdmin();
    const user = userEvent.setup();
    renderAt();
    await waitFor(() => expect(screen.getByTestId('activity-table')).toBeInTheDocument());
    await user.selectOptions(screen.getByTestId('filter-entity-type'), 'admin_user_action');
    await waitFor(() => {
      const table = screen.getByTestId('activity-table');
      // The 4 MSW seed targets should be visible (eve.eve, mallory.brute,
      // ravi.risk) as entity_id text.
      expect(table.textContent).toMatch(/eve\.eve/);
      expect(table.textContent).toMatch(/mallory\.brute/);
      // And the action vocabulary should map to the new badges.
      expect(table.textContent).toMatch(/force_logout/);
      expect(table.textContent).toMatch(/role_change/);
    });
  });
});

describe('AdminActivityPage — deep links', () => {
  it('rule-revert row links to the diff viewer with reverted_to_semver as ?from', async () => {
    authAsAdmin();
    const user = userEvent.setup();
    renderAt();
    await user.selectOptions(
      await screen.findByTestId('filter-entity-type'),
      'ews_rule_version',
    );
    await waitFor(() => {
      // The text appears in both the link cell + the summary cell —
      // pick the one wrapped in an <a>.
      const links = screen
        .getAllByText(/RULE_CREDIT_001/)
        .map((n) => n.closest('a'))
        .filter((a): a is HTMLAnchorElement => a !== null);
      expect(links.length).toBeGreaterThan(0);
      expect(links[0]).toHaveAttribute(
        'href',
        '/rules/ews/RULE_CREDIT_001/diff?from=1.0.0',
      );
    });
  });
});
