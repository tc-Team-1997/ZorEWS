// Coverage for /admin/notification-templates (T6 M14.19):
//   - Seeded list renders with channel + status badges
//   - Status pivot + channel filter narrow the list
//   - Search narrows the list
//   - Create modal validates SMS-no-subject + EMAIL-needs-subject
//   - Activate moves DRAFT → ACTIVE
//   - Archive sets status=ARCHIVED

import { describe, expect, it, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NotificationTemplatesPage } from '@/modules/admin/notificationTemplates/NotificationTemplatesPage';
import { renderWithProviders } from './utils';
import { useAuth } from '@/store/auth';

function setAdmin() {
  const user = {
    id: 'u-001',
    username: 'alice.admin',
    roles: ['admin' as const],
    display_name: 'Alice',
  };
  localStorage.setItem('apex.ews.user', JSON.stringify(user));
  localStorage.setItem('apex.ews.token', 'test-token');
  useAuth.setState({ status: 'authenticated', user, token: 'test-token' });
}

beforeEach(() => {
  localStorage.clear();
  setAdmin();
});

describe('NotificationTemplatesPage', () => {
  it('renders the seeded templates with channel + status badges', async () => {
    renderWithProviders(<NotificationTemplatesPage />);
    await waitFor(() => {
      expect(screen.getByText(/Case Opened — RM email/i)).toBeInTheDocument();
    });
    // Three channels seeded
    expect(screen.getAllByText(/EMAIL/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/SMS/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/IN_APP/).length).toBeGreaterThan(0);
  });

  it('channel filter restricts the list to SMS rows', async () => {
    renderWithProviders(<NotificationTemplatesPage />);
    await screen.findByText(/Case Opened — RM email/i);
    await userEvent.click(screen.getByTestId('tpl-channel-filter-sms'));
    await waitFor(() => {
      expect(screen.queryByText(/Case Opened — RM email/i)).not.toBeInTheDocument();
      expect(screen.getByText(/Case SLA breach warning — RM SMS/i)).toBeInTheDocument();
    });
  });

  it('search narrows the list to matching templates', async () => {
    renderWithProviders(<NotificationTemplatesPage />);
    await screen.findByText(/Case Opened — RM email/i);
    await userEvent.type(screen.getByTestId('tpl-search'), 'KYC');
    await waitFor(() => {
      expect(screen.queryByText(/Case Opened — RM email/i)).not.toBeInTheDocument();
      expect(screen.getByText(/Customer KYC reminder — SMS/i)).toBeInTheDocument();
    });
  });

  it('status pivot DRAFT shows only the seeded draft template', async () => {
    renderWithProviders(<NotificationTemplatesPage />);
    await screen.findByText(/Case Opened — RM email/i);
    await userEvent.click(screen.getByTestId('tpl-pivot-draft'));
    await waitFor(() => {
      expect(screen.getByText(/Case Closed — RM email/i)).toBeInTheDocument();
      expect(screen.queryByText(/Case Opened — RM email/i)).not.toBeInTheDocument();
    });
  });

  it('create modal blocks EMAIL without subject; succeeds with subject', async () => {
    renderWithProviders(<NotificationTemplatesPage />);
    await screen.findByText(/Case Opened — RM email/i);
    await userEvent.click(screen.getByTestId('tpl-new'));
    await screen.findByTestId('notification-template-modal');
    await userEvent.type(screen.getByTestId('tpl-name'), 'Brand new EMAIL template');
    await userEvent.type(screen.getByTestId('tpl-body'), 'Hi {{rm_name}}, this is the body.');
    // No subject typed yet — Save should surface validation
    await userEvent.click(screen.getByTestId('tpl-save'));
    expect(await screen.findByTestId('tpl-validation')).toHaveTextContent(/Subject required/);
    // Now type a subject + save
    await userEvent.type(screen.getByTestId('tpl-subject'), 'New subject');
    await userEvent.click(screen.getByTestId('tpl-save'));
    await waitFor(() => {
      expect(screen.queryByTestId('notification-template-modal')).not.toBeInTheDocument();
    });
    // Switch to DRAFT pivot to confirm it landed
    await userEvent.click(screen.getByTestId('tpl-pivot-draft'));
    expect(await screen.findByText(/Brand new EMAIL template/i)).toBeInTheDocument();
  });

  it('SMS channel hides the subject field + locks subject to null', async () => {
    renderWithProviders(<NotificationTemplatesPage />);
    await screen.findByText(/Case Opened — RM email/i);
    await userEvent.click(screen.getByTestId('tpl-new'));
    await screen.findByTestId('notification-template-modal');
    await userEvent.selectOptions(screen.getByTestId('tpl-channel'), 'SMS');
    await waitFor(() => {
      expect(screen.queryByTestId('tpl-subject')).not.toBeInTheDocument();
    });
    expect(screen.getByText(/SMS templates have no subject/)).toBeInTheDocument();
  });

  it('activate moves a DRAFT template to ACTIVE', async () => {
    renderWithProviders(<NotificationTemplatesPage />);
    await screen.findByText(/Case Opened — RM email/i);
    await userEvent.click(screen.getByTestId('tpl-pivot-draft'));
    const draftRow = await screen.findByText(/Case Closed — RM email/i);
    expect(draftRow).toBeInTheDocument();
    // Find the Activate button for the seeded DRAFT row
    const activateBtn = await screen.findByTestId(/^tpl-activate-tpl-seed-bank_demo-case-closed-rm-em/);
    await userEvent.click(activateBtn);
    // After activate the DRAFT pivot should be empty (or at least no longer have this row)
    await waitFor(() => {
      expect(screen.queryByText(/Case Closed — RM email/i)).not.toBeInTheDocument();
    });
    await userEvent.click(screen.getByTestId('tpl-pivot-active'));
    expect(await screen.findByText(/Case Closed — RM email/i)).toBeInTheDocument();
  });

  it('archive removes the row from the default ACTIVE pivot', async () => {
    // Case Opened — RM email is referenced by the seeded Fraud P1 scenario,
    // so M14.35 surfaces a confirm prompt — accept it to proceed.
    const origConfirm = window.confirm;
    window.confirm = () => true;
    try {
      renderWithProviders(<NotificationTemplatesPage />);
      await userEvent.click(screen.getByTestId('tpl-pivot-active'));
      const row = await screen.findByText(/Case Opened — RM email/i);
      expect(row).toBeInTheDocument();
      const archiveBtn = await screen.findByTestId(/^tpl-archive-tpl-seed-bank_demo-case-opened/);
      await userEvent.click(archiveBtn);
      await waitFor(() => {
        // Same name should disappear from ACTIVE pivot
        expect(screen.queryByText(/Case Opened — RM email/i)).not.toBeInTheDocument();
      });
      // ARCHIVED pivot reveals it again
      await userEvent.click(screen.getByTestId('tpl-pivot-archived'));
      expect(await screen.findByText(/Case Opened — RM email/i)).toBeInTheDocument();
    } finally {
      window.confirm = origConfirm;
    }
  });

  // M14.35 — archive confirm guard when a template has dependents
  it('archive shows a confirm prompt when scenarios depend on the template; cancel keeps it', async () => {
    const origConfirm = window.confirm;
    let confirmMessage = '';
    window.confirm = (msg?: string) => {
      confirmMessage = msg ?? '';
      return false; // cancel
    };
    try {
      renderWithProviders(<NotificationTemplatesPage />);
      await userEvent.click(screen.getByTestId('tpl-pivot-active'));
      await screen.findByText(/Case Opened — RM email/i);
      const archiveBtn = await screen.findByTestId(/^tpl-archive-tpl-seed-bank_demo-case-opened/);
      await userEvent.click(archiveBtn);
      // Cancelled → row remains in ACTIVE pivot
      expect(screen.getByText(/Case Opened — RM email/i)).toBeInTheDocument();
      expect(confirmMessage).toMatch(/referenced by \d+ active scenario/);
    } finally {
      window.confirm = origConfirm;
    }
  });

  // M14.36 — ?focus=<template_id> deep-link from Dispatches log
  it('honors ?focus=<id> by highlighting the matched row + broadening pivot to ALL', async () => {
    const FOCUS_ID = 'tpl-seed-bank_demo-case-opened-rm-email';
    renderWithProviders(<NotificationTemplatesPage />, {
      route: `/admin/notification-templates?focus=${FOCUS_ID}`,
    });
    await screen.findByText(/Case Opened — RM email/i);
    // Pivot auto-broadens to ALL
    await waitFor(() => {
      const allBtn = screen.getByTestId('tpl-pivot-all');
      expect(allBtn.className).toContain('border-blue-400');
    });
    // Matching row carries the focus marker
    const focused = await waitFor(() =>
      document.querySelector('[data-focus-row="true"]'),
    );
    expect(focused).not.toBeNull();
    expect(focused?.getAttribute('data-row-id')).toBe(FOCUS_ID);
  });

  // M14.34 — Used-by scenarios usage hint per template
  it('shows "Used by N scenarios" for the Case Opened email referenced by Fraud P1 scenario', async () => {
    renderWithProviders(<NotificationTemplatesPage />);
    await screen.findByText(/Case Opened — RM email/i);
    const usage = await screen.findByTestId(
      /^tpl-usage-tpl-seed-bank_demo-case-opened/,
    );
    expect(usage.textContent).toMatch(/Used by \d+ scenario/);
  });

  it('shows "Unused" for templates not referenced by any scenario', async () => {
    renderWithProviders(<NotificationTemplatesPage />);
    // Case SLA breach warning SMS — not bound to any seeded scenario
    await screen.findByText(/Case SLA breach warning — RM SMS/i);
    const usage = await screen.findByTestId(
      /^tpl-usage-tpl-seed-bank_demo-case-sla-breach/,
    );
    expect(usage.textContent).toMatch(/Unused/);
  });

  // M14.26 — Duplicate
  it('duplicate clones a row as a new DRAFT with " (copy)" suffix', async () => {
    renderWithProviders(<NotificationTemplatesPage />);
    await screen.findByText(/Case Opened — RM email/i);
    const dupBtn = await screen.findByTestId(/^tpl-duplicate-tpl-seed-bank_demo-case-opened/);
    await userEvent.click(dupBtn);
    // The clone lands as a DRAFT — switch pivot and confirm
    await userEvent.click(screen.getByTestId('tpl-pivot-draft'));
    await waitFor(() => {
      expect(screen.getByText(/Case Opened — RM email \(copy\)/i)).toBeInTheDocument();
    });
  });
});
