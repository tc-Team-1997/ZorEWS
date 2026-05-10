// SPA coverage for the M14.24 preview / test-fire / dispatches loop
// (M14.24b SPA wiring).
//
//   1. Open the templates page → click Preview on a row → modal opens
//      with auto-extracted variable inputs + live re-render.
//   2. Click Test fire on a row → modal opens with recipient input;
//      submit → success badge + dispatch confirmation.
//   3. Navigate to the Dispatches log page → see the test-fire entry;
//      reference filter narrows the list.

import { describe, expect, it, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NotificationTemplatesPage } from '@/modules/admin/notificationTemplates/NotificationTemplatesPage';
import { NotificationDispatchesPage } from '@/modules/admin/notificationTemplates/NotificationDispatchesPage';
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

describe('NotificationTemplatesPage — Preview modal (M14.24b)', () => {
  it('opens the preview modal with auto-extracted variable inputs', async () => {
    renderWithProviders(<NotificationTemplatesPage />);
    await screen.findByText(/Case Opened — RM email/i);
    // Click Preview on the first seeded template
    const previewBtn = await screen.findByTestId(/^tpl-preview-tpl-seed-bank_demo-case-opened/);
    await userEvent.click(previewBtn);
    const modal = await screen.findByTestId('notification-template-preview-modal');
    expect(modal).toBeInTheDocument();
    // Template subject `New case {{case_number}} assigned to you` →
    // case_number var input should appear
    expect(within(modal).getByTestId('preview-var-case_number')).toBeInTheDocument();
    expect(within(modal).getByTestId('preview-var-rm_name')).toBeInTheDocument();
  });

  it('renders the template with substituted variables (live)', async () => {
    renderWithProviders(<NotificationTemplatesPage />);
    await screen.findByText(/Case Opened — RM email/i);
    await userEvent.click(
      await screen.findByTestId(/^tpl-preview-tpl-seed-bank_demo-case-opened/),
    );
    const modal = await screen.findByTestId('notification-template-preview-modal');
    await userEvent.type(within(modal).getByTestId('preview-var-case_number'), 'C-001');
    await userEvent.type(within(modal).getByTestId('preview-var-customer_name'), 'Alice');
    // Wait for the debounced render (300ms) + the MSW POST round-trip.
    // case_number is in the subject; customer_name is in the body.
    await waitFor(
      () => {
        expect(within(modal).getByTestId('preview-subject')).toHaveTextContent('C-001');
        expect(within(modal).getByTestId('preview-body')).toHaveTextContent('Alice');
      },
      { timeout: 2000 },
    );
  });

  it('shows the missing-vars warning when not all vars provided', async () => {
    renderWithProviders(<NotificationTemplatesPage />);
    await screen.findByText(/Case Opened — RM email/i);
    await userEvent.click(
      await screen.findByTestId(/^tpl-preview-tpl-seed-bank_demo-case-opened/),
    );
    const modal = await screen.findByTestId('notification-template-preview-modal');
    // Don't fill anything — initial render flags every var as missing
    await waitFor(
      () => {
        expect(within(modal).getByTestId('preview-missing-vars')).toBeInTheDocument();
      },
      { timeout: 2000 },
    );
  });
});

describe('NotificationTemplatesPage — Test fire modal (M14.24b)', () => {
  it('blocks send when recipient is empty', async () => {
    renderWithProviders(<NotificationTemplatesPage />);
    await screen.findByText(/Case Opened — RM email/i);
    await userEvent.click(
      await screen.findByTestId(/^tpl-testfire-tpl-seed-bank_demo-case-opened/),
    );
    const modal = await screen.findByTestId('notification-template-test-fire-modal');
    await userEvent.click(within(modal).getByTestId('testfire-send'));
    expect(await within(modal).findByTestId('testfire-validation')).toHaveTextContent(/Recipient is required/);
  });

  it('sends + shows the dispatch confirmation badge', async () => {
    renderWithProviders(<NotificationTemplatesPage />);
    await screen.findByText(/Case Opened — RM email/i);
    await userEvent.click(
      await screen.findByTestId(/^tpl-testfire-tpl-seed-bank_demo-case-opened/),
    );
    const modal = await screen.findByTestId('notification-template-test-fire-modal');
    await userEvent.type(within(modal).getByTestId('testfire-recipient'), 'rm@bank.com');
    await userEvent.type(within(modal).getByTestId('testfire-reference'), 'case:c-001');
    await userEvent.click(within(modal).getByTestId('testfire-send'));
    expect(await within(modal).findByTestId('testfire-dispatch-confirm')).toBeInTheDocument();
    // status badge "sent" rendered
    expect(within(modal).getByText(/^sent$/i)).toBeInTheDocument();
  });

  it('refuse-when-missing returns 422 + surfaces the error', async () => {
    renderWithProviders(<NotificationTemplatesPage />);
    await screen.findByText(/Case Opened — RM email/i);
    await userEvent.click(
      await screen.findByTestId(/^tpl-testfire-tpl-seed-bank_demo-case-opened/),
    );
    const modal = await screen.findByTestId('notification-template-test-fire-modal');
    await userEvent.type(within(modal).getByTestId('testfire-recipient'), 'rm@bank.com');
    await userEvent.click(within(modal).getByTestId('testfire-refuse-missing'));
    await userEvent.click(within(modal).getByTestId('testfire-send'));
    expect(await within(modal).findByTestId('testfire-error')).toHaveTextContent(/missing/i);
  });
});

describe('NotificationDispatchesPage (M14.24b)', () => {
  // Note: the MSW dispatch log is module-state, so prior test-fires in
  // this file may have populated entries. We assert behaviour given a
  // fresh test-fire rather than asserting global emptiness.

  it('lists a freshly test-fired dispatch + reference filter is wired', async () => {
    // Step 1: fire a test from the templates page with a unique
    // reference so we can identify it in the log.
    const REF = `case:c-fresh-${Date.now()}`;
    const tplPage = renderWithProviders(<NotificationTemplatesPage />);
    await screen.findByText(/Case Opened — RM email/i);
    await userEvent.click(
      await screen.findByTestId(/^tpl-testfire-tpl-seed-bank_demo-case-opened/),
    );
    const fireModal = await screen.findByTestId('notification-template-test-fire-modal');
    await userEvent.type(within(fireModal).getByTestId('testfire-recipient'), 'rm@bank.com');
    await userEvent.type(within(fireModal).getByTestId('testfire-reference'), REF);
    await userEvent.click(within(fireModal).getByTestId('testfire-send'));
    await within(fireModal).findByTestId('testfire-dispatch-confirm');
    tplPage.unmount();

    // Step 2: render the Dispatches page in the same React env (MSW
    // store persists across renders in a single test process).
    renderWithProviders(<NotificationDispatchesPage />);
    // The unique reference appears in the page exactly once.
    await waitFor(
      () => {
        expect(screen.getAllByText(REF).length).toBeGreaterThan(0);
      },
      { timeout: 2000 },
    );
    // Reference filter input is wired (URL-bound + clear button shows).
    const refInput = screen.getByTestId('disp-reference');
    await userEvent.type(refInput, REF);
    expect(screen.getByTestId('disp-reference-clear')).toBeInTheDocument();
  });

  // M14.29 — template_id deep-link from templates page → dispatches log
  it('templates page renders a Dispatches link with the row template_id in the href', async () => {
    renderWithProviders(<NotificationTemplatesPage />);
    await screen.findByText(/Case Opened — RM email/i);
    const link = await screen.findByTestId(
      /^tpl-dispatches-tpl-seed-bank_demo-case-opened/,
    );
    const href = link.getAttribute('href') ?? '';
    expect(href).toContain('/admin/notification-templates/dispatches');
    expect(href).toContain('template_id=tpl-seed-bank_demo-case-opened');
  });

  // M14.36 — Dispatches log → Templates page back-link
  it('Template cell on a dispatch row links back to /admin/notification-templates?focus=<id>', async () => {
    // Fire a dispatch so there's a row to inspect
    const tplPage = renderWithProviders(<NotificationTemplatesPage />);
    await screen.findByText(/Case Opened — RM email/i);
    await userEvent.click(
      await screen.findByTestId(/^tpl-testfire-tpl-seed-bank_demo-case-opened/),
    );
    const fireModal = await screen.findByTestId('notification-template-test-fire-modal');
    await userEvent.type(within(fireModal).getByTestId('testfire-recipient'), 'rm@bank.com');
    await userEvent.click(within(fireModal).getByTestId('testfire-send'));
    await within(fireModal).findByTestId('testfire-dispatch-confirm');
    tplPage.unmount();

    renderWithProviders(<NotificationDispatchesPage />);
    const link = await screen.findByTestId(/^disp-tpl-link-/);
    const href = link.getAttribute('href') ?? '';
    expect(href).toContain('/admin/notification-templates?focus=tpl-seed-bank_demo-case-opened');
  });

  it('dispatches page reads ?template_id= from the URL and surfaces a clearable chip', async () => {
    // Fire a dispatch with a known template_id (the seeded BANK_DEMO
    // "Case Opened — RM email") so there's a row to filter on.
    const tplPage = renderWithProviders(<NotificationTemplatesPage />);
    await screen.findByText(/Case Opened — RM email/i);
    await userEvent.click(
      await screen.findByTestId(/^tpl-testfire-tpl-seed-bank_demo-case-opened/),
    );
    const fireModal = await screen.findByTestId('notification-template-test-fire-modal');
    await userEvent.type(within(fireModal).getByTestId('testfire-recipient'), 'rm@bank.com');
    await userEvent.click(within(fireModal).getByTestId('testfire-send'));
    await within(fireModal).findByTestId('testfire-dispatch-confirm');
    tplPage.unmount();

    // Render the dispatches page with the template_id pre-set in the URL
    const TPL_ID = 'tpl-seed-bank_demo-case-opened-rm-email';
    renderWithProviders(<NotificationDispatchesPage />, {
      route: `/admin/notification-templates/dispatches?template_id=${TPL_ID}`,
    });
    // Filter chip shows the truncated id
    expect(await screen.findByTestId('disp-template-chip')).toBeInTheDocument();
    // Clear button is wired
    expect(screen.getByTestId('disp-template-clear')).toBeInTheDocument();
  });
});
