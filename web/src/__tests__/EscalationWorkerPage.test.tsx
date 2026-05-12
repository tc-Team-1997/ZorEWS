// Coverage for /admin/escalation-worker (T6 M14.25c):
//   - The synthetic open-case form renders + accepts presets + manual rows
//   - Preview button posts and surfaces the due[] table with rendered output
//   - Tick button (admin-only) dispatches + shows the dispatched count badge
//   - Validation gate fires on bad input
//   - Idempotency surfaces via already_dispatched_count after re-tick

import { describe, expect, it, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EscalationWorkerPage } from '@/modules/admin/escalationWorker/EscalationWorkerPage';
import { renderWithProviders } from './utils';
import { useAuth } from '@/store/auth';

function setRole(role: 'admin' | 'supervisor') {
  const user = {
    id: 'u-001',
    username: 'alice.admin',
    roles: [role],
    display_name: 'Alice',
  };
  localStorage.setItem('apex.ews.user', JSON.stringify(user));
  localStorage.setItem('apex.ews.token', 'test-token');
  useAuth.setState({ status: 'authenticated', user, token: 'test-token' });
}

beforeEach(() => {
  localStorage.clear();
  setRole('admin');
});

describe('EscalationWorkerPage (M14.25c)', () => {
  it('renders the page with the default seeded row + Preview/Tick buttons', async () => {
    renderWithProviders(<EscalationWorkerPage />);
    expect(screen.getByText(/Escalation worker/i)).toBeInTheDocument();
    // Default row is the "Fraud P1 · 90m old" preset
    expect(screen.getByTestId('esc-worker-case-id-0')).toHaveValue('C-FRAUD-002');
    expect(screen.getByTestId('esc-worker-preview')).toBeInTheDocument();
    expect(screen.getByTestId('esc-worker-tick')).toBeInTheDocument();
  });

  it('blocks submit when case_id is empty', async () => {
    renderWithProviders(<EscalationWorkerPage />);
    const idInput = screen.getByTestId('esc-worker-case-id-0');
    await userEvent.clear(idInput);
    await userEvent.click(screen.getByTestId('esc-worker-preview'));
    expect(await screen.findByTestId('esc-worker-validation')).toHaveTextContent(/case_id required/);
  });

  it('Preview returns due[] for the seeded fraud P1 scenario (90m → L1+L2)', async () => {
    renderWithProviders(<EscalationWorkerPage />);
    await userEvent.click(screen.getByTestId('esc-worker-preview'));
    // BIL escalation rule is 30m / 180m / 720m; BANK_DEMO is 15m / 60m / 240m.
    // Default tenant is BANK_DEMO so a 90m fraud P1 case fires L1 + L2.
    await waitFor(() => {
      expect(screen.getByTestId('esc-worker-stat-inspected')).toHaveTextContent(/Inspected:.*1/);
    });
    // Two due rows visible (L1 + L2)
    const rows = await screen.findAllByText(/^L[12] →/);
    expect(rows.length).toBe(2);
  });

  it('Tick dispatches; subsequent tick shows already_dispatched_count > 0', async () => {
    renderWithProviders(<EscalationWorkerPage />);
    // First tick
    await userEvent.click(screen.getByTestId('esc-worker-tick'));
    await waitFor(() => {
      expect(screen.getByTestId('esc-worker-stat-dispatched')).toHaveTextContent(/Dispatched now:.*2/);
    });
    // Re-tick → 0 dispatched, 2 already_dispatched
    await userEvent.click(screen.getByTestId('esc-worker-tick'));
    await waitFor(() => {
      expect(screen.getByTestId('esc-worker-stat-already')).toHaveTextContent(/Already dispatched:.*2/);
      expect(screen.getByTestId('esc-worker-stat-dispatched')).toHaveTextContent(/Dispatched now:.*0/);
    });
  });

  it('quick-fill preset adds a new row', async () => {
    renderWithProviders(<EscalationWorkerPage />);
    // Default starts with 1 row; click a different preset → 2 rows
    expect(screen.getByTestId('esc-worker-case-row-0')).toBeInTheDocument();
    expect(screen.queryByTestId('esc-worker-case-row-1')).not.toBeInTheDocument();
    const presetBtn = await screen.findByTestId(/^esc-worker-preset-fraud-p1-30m-old/);
    await userEvent.click(presetBtn);
    expect(screen.getByTestId('esc-worker-case-row-1')).toBeInTheDocument();
  });

  it('add-row + remove-row work', async () => {
    renderWithProviders(<EscalationWorkerPage />);
    await userEvent.click(screen.getByTestId('esc-worker-add-row'));
    expect(screen.getByTestId('esc-worker-case-row-1')).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('esc-worker-case-remove-1'));
    await waitFor(() => {
      expect(screen.queryByTestId('esc-worker-case-row-1')).not.toBeInTheDocument();
    });
  });

  it('cases_with_no_scenario diagnostic surfaces when no scenario matches', async () => {
    renderWithProviders(<EscalationWorkerPage />);
    // Change category to something no scenario matches
    const catInput = screen.getByTestId('esc-worker-case-category-0');
    await userEvent.clear(catInput);
    await userEvent.type(catInput, 'no-such-category');
    await userEvent.click(screen.getByTestId('esc-worker-preview'));
    await waitFor(() => {
      expect(screen.getByTestId('esc-worker-stat-no-scenario')).toHaveTextContent(/No scenario:.*1/);
    });
  });

  it('supervisor sees Preview but the Tick button is hidden', async () => {
    setRole('supervisor');
    renderWithProviders(<EscalationWorkerPage />);
    expect(screen.getByTestId('esc-worker-preview')).toBeInTheDocument();
    expect(screen.queryByTestId('esc-worker-tick')).not.toBeInTheDocument();
  });

  // M14.25d — Worker status panel
  it('renders the cron status panel with the disabled badge in the default deployment', async () => {
    renderWithProviders(<EscalationWorkerPage />);
    expect(await screen.findByTestId('esc-worker-status-panel')).toBeInTheDocument();
    expect(await screen.findByTestId('esc-worker-status-disabled-badge')).toHaveTextContent(
      /Cron disabled/i,
    );
    expect(screen.getByTestId('esc-worker-status-disabled-hint')).toHaveTextContent(
      /ESCALATION_WORKER_INTERVAL_SEC/,
    );
    // Disabled state suppresses the metrics grid (interval/tenants/etc).
    expect(screen.queryByTestId('esc-worker-status-interval')).not.toBeInTheDocument();
  });

  // M14.25e — Recent dispatches panel
  it('renders the recent-dispatches panel + full-log link', async () => {
    renderWithProviders(<EscalationWorkerPage />);
    expect(await screen.findByTestId('esc-worker-recent-dispatches')).toBeInTheDocument();
    expect(screen.getByTestId('esc-worker-recent-fulllog')).toHaveAttribute(
      'href',
      '/admin/notification-templates/dispatches?trigger=escalation_worker',
    );
    // The mock dispatch log is pre-seeded with sample escalation_worker
    // entries (mocks/handlers.ts seedSampleDispatches), so the recent
    // list renders out-of-the-box rather than the empty state. The
    // empty branch is exercised when the seed snapshot is cleared,
    // which the "no dispatches" branch elsewhere covers indirectly.
    expect(await screen.findByTestId('esc-worker-recent-list')).toBeInTheDocument();
  });

  it('recent-dispatches list invalidates after a tick (no 5s wait)', async () => {
    renderWithProviders(<EscalationWorkerPage />);
    await screen.findByTestId('esc-worker-recent-list');
    const before = screen.getAllByTestId(/^esc-worker-recent-row-/).length;
    await userEvent.click(screen.getByTestId('esc-worker-tick'));
    // After the tick the seeded fraud P1 scenario fires two new
    // escalation dispatches → the list grows. Invalidate is immediate
    // so this resolves well within the default 1s testing-library
    // timeout, no 5s refetch wait needed.
    await waitFor(() => {
      const after = screen.getAllByTestId(/^esc-worker-recent-row-/).length;
      expect(after).toBeGreaterThan(before);
    });
  });
});
