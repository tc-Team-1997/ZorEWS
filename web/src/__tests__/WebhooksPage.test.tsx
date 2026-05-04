// Coverage for the admin /admin/webhooks page:
//   - Empty state when no subscriptions exist
//   - Create flow → secret reveal dialog → list refresh
//   - Test-fire button calls the test endpoint and refreshes deliveries
//   - Delete flow removes the subscription
//   - Non-admin role gets 403 from MSW (defence-in-depth check)
//
// We rely on the MSW handlers in src/mocks/handlers.ts which already
// implement the subscription lifecycle in-memory. Each test resets the
// store via the BEFOREACH so subscriptions don't leak across runs.

import { describe, expect, it, beforeEach, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { WebhooksPage } from '@/modules/admin/WebhooksPage';
import { renderWithProviders } from './utils';
import { useAuth } from '@/store/auth';

function setAdmin() {
  const user = {
    id: 'u-001',
    username: 'alice.admin',
    roles: ['admin' as const],
  };
  localStorage.setItem('apex.ews.user', JSON.stringify(user));
  localStorage.setItem('apex.ews.token', 'mock.test.token');
  useAuth.setState({ status: 'authenticated', user, token: 'mock.test.token' });
}

function setNonAdmin() {
  const user = {
    id: 'u-002',
    username: 'ravi.risk',
    roles: ['risk_analyst' as const],
  };
  localStorage.setItem('apex.ews.user', JSON.stringify(user));
  localStorage.setItem('apex.ews.token', 'mock.test.token');
  useAuth.setState({ status: 'authenticated', user, token: 'mock.test.token' });
}

beforeEach(async () => {
  // Reset the in-memory MSW webhook store between tests by deleting any
  // subscription that survived the previous test. The handler stores
  // them in module-scoped arrays, so we hit the API to clean up.
  setAdmin();
  const { api } = await import('@/lib/api');
  const { items } = await api.webhookList();
  await Promise.all(items.map((s) => api.webhookDelete(s.id)));
  // Mock confirm so delete clicks don't block on user input.
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});

describe('WebhooksPage — empty state', () => {
  it('shows the "no subscriptions" message when the list is empty', async () => {
    renderWithProviders(<WebhooksPage />);
    expect(
      await screen.findByText(/No webhook subscriptions yet/i),
    ).toBeInTheDocument();
  });
});

describe('WebhooksPage — create flow', () => {
  it('creates a subscription and surfaces the signing secret in a one-time dialog', async () => {
    const user = userEvent.setup();
    renderWithProviders(<WebhooksPage />);
    await screen.findByText(/No webhook subscriptions yet/i);

    await user.type(screen.getByTestId('webhook-create-name'), 'AML hub');
    await user.type(screen.getByTestId('webhook-create-url'), 'https://aml.example.com/x');
    // alert.created is checked by default; that's enough to submit.
    await user.click(screen.getByTestId('webhook-create-submit'));

    // Secret reveal dialog should appear once.
    const dialog = await screen.findByTestId('webhook-secret-dialog');
    const secret = within(dialog).getByTestId('webhook-secret-value');
    expect(secret.textContent).toMatch(/^[0-9a-f]{64}$/);

    // Subscription should now appear in the list.
    const list = await screen.findByTestId('webhook-list');
    expect(within(list).getByText('AML hub')).toBeInTheDocument();
    expect(within(list).getByText(/aml\.example\.com\/x/)).toBeInTheDocument();
  });

  it('submit button is disabled until name + URL are filled', async () => {
    renderWithProviders(<WebhooksPage />);
    await screen.findByText(/No webhook subscriptions yet/i);
    expect(screen.getByTestId('webhook-create-submit')).toBeDisabled();
  });
});

describe('WebhooksPage — test-fire', () => {
  it('test button records a successful delivery and refreshes the list status', async () => {
    const user = userEvent.setup();
    renderWithProviders(<WebhooksPage />);
    await screen.findByText(/No webhook subscriptions yet/i);

    // Create a subscription first (also closes the secret dialog).
    await user.type(screen.getByTestId('webhook-create-name'), 'Collection');
    await user.type(screen.getByTestId('webhook-create-url'), 'https://col.example.com/x');
    await user.click(screen.getByTestId('webhook-create-submit'));
    await user.click(await screen.findByTestId('webhook-secret-close'));

    // Find the row + click Test.
    const list = await screen.findByTestId('webhook-list');
    const row = within(list).getByText('Collection').closest('li')!;
    expect(row).not.toBeNull();
    const testBtn = within(row).getByRole('button', { name: /test/i });
    await user.click(testBtn);

    // The list refreshes — last_delivery_status should now show "success".
    await waitFor(() => {
      expect(within(row).getByText(/last: success/i)).toBeInTheDocument();
    });
  });
});

describe('WebhooksPage — delete', () => {
  it('removes the subscription from the list', async () => {
    const user = userEvent.setup();
    renderWithProviders(<WebhooksPage />);
    await screen.findByText(/No webhook subscriptions yet/i);

    await user.type(screen.getByTestId('webhook-create-name'), 'Branch ops');
    await user.type(screen.getByTestId('webhook-create-url'), 'https://branch.example.com/x');
    await user.click(screen.getByTestId('webhook-create-submit'));
    await user.click(await screen.findByTestId('webhook-secret-close'));

    const list = await screen.findByTestId('webhook-list');
    const row = within(list).getByText('Branch ops').closest('li')!;
    const deleteBtn = within(row).getByRole('button', {
      name: /delete webhook subscription: branch ops/i,
    });
    await user.click(deleteBtn);

    await waitFor(() => {
      expect(screen.queryByText('Branch ops')).not.toBeInTheDocument();
    });
  });
});

describe('WebhooksPage — non-admin role', () => {
  it('non-admin gets a 403 from the MSW handler and the page renders an error', async () => {
    setNonAdmin();
    renderWithProviders(<WebhooksPage />);
    // The list query fails — the page surfaces the error inside the
    // "Subscriptions" panel.
    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument();
    });
  });
});
