// Vitest for RecycleBinPage (Recovery Center).
//
// Mocks api.recoveryList + recoveryStats so the page renders against a
// controlled fixture. Asserts:
//   - Stats tile renders
//   - Status tabs toggle the list
//   - Filter chips narrow the visible rows
//   - Row expand reveals JSON payload
//   - Restore button opens confirm modal → submits → success
//   - Purge button opens confirm modal → submits → success

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { RecycleBinPage } from '@/modules/admin/RecycleBinPage';
import { renderWithProviders } from './utils';
import { api, type DeletedRecord, type RecoveryStats } from '@/lib/api';

const SAMPLE: DeletedRecord[] = [
  {
    recovery_id: 'rec-1',
    tenant_id: 'BANK_DEMO',
    module: 'bff',
    entity_type: 'webhook_subscription',
    original_id: 'wh-1',
    original_table: 'app_bff.webhook_subscriptions',
    payload: { id: 'wh-1', name: 'Slack hook', url: 'https://hooks.slack.com/x' },
    deleted_by: 'alice.admin',
    deleted_at: '2026-05-17T08:00:00Z',
    deletion_reason: 'replaced',
    source_action: 'user_initiated',
    prior_status: 'active',
    restored_at: null,
    restored_by: null,
    purged_at: null,
    purged_by: null,
    status: 'archived',
  },
  {
    recovery_id: 'rec-2',
    tenant_id: 'BANK_DEMO',
    module: 'bff',
    entity_type: 'saved_scenario',
    original_id: 's-1',
    original_table: 'app_scenario.saved_scenarios',
    payload: { id: 's-1', name: 'Q1 stress' },
    deleted_by: 'ravi.risk',
    deleted_at: '2026-05-15T10:00:00Z',
    deletion_reason: null,
    source_action: 'user_initiated',
    prior_status: null,
    restored_at: null,
    restored_by: null,
    purged_at: null,
    purged_by: null,
    status: 'archived',
  },
];

const STATS: RecoveryStats = {
  total: 2,
  by_status: { archived: 2, restored: 0, purged: 0 },
  by_module: { bff: 2 },
  by_entity_type: { webhook_subscription: 1, saved_scenario: 1 },
  most_recent_at: '2026-05-17T08:00:00Z',
  adapters: [
    { entity_type: 'webhook_subscription', display_name: 'Webhook subscription', module: 'bff' },
    { entity_type: 'saved_scenario', display_name: 'Saved scenario', module: 'bff' },
  ],
};

describe('RecycleBinPage', () => {
  beforeEach(() => {
    vi.spyOn(api, 'recoveryList').mockResolvedValue({ items: SAMPLE, total: SAMPLE.length });
    vi.spyOn(api, 'recoveryStats').mockResolvedValue(STATS);
    vi.spyOn(api, 'recoveryRestore').mockResolvedValue({ ...SAMPLE[0], status: 'restored' });
    vi.spyOn(api, 'recoveryPurge').mockResolvedValue(undefined);
  });

  it('renders the page header + stats tile + table', async () => {
    renderWithProviders(<RecycleBinPage />);
    await waitFor(() => {
      expect(screen.getByText(/Recovery Center/i)).toBeInTheDocument();
    });
    expect(await screen.findByTestId('recycle-bin-stats')).toBeInTheDocument();
    expect(await screen.findByTestId('recycle-bin-table')).toBeInTheDocument();
    expect(screen.getByText('webhook_subscription')).toBeInTheDocument();
    expect(screen.getByText('saved_scenario')).toBeInTheDocument();
  });

  it('clicking a status tab calls api.recoveryList with the new status', async () => {
    renderWithProviders(<RecycleBinPage />);
    await waitFor(() => screen.getByTestId('recycle-bin-table'));
    fireEvent.click(screen.getByTestId('recycle-bin-tab-restored'));
    await waitFor(() => {
      expect(api.recoveryList).toHaveBeenLastCalledWith(
        expect.objectContaining({ status: 'restored' }),
      );
    });
  });

  it('filter chip toggles the module filter', async () => {
    renderWithProviders(<RecycleBinPage />);
    await waitFor(() => screen.getByTestId('recycle-bin-table'));
    fireEvent.click(screen.getByTestId('recycle-bin-filter-module-bff'));
    await waitFor(() => {
      expect(api.recoveryList).toHaveBeenLastCalledWith(
        expect.objectContaining({ module: 'bff' }),
      );
    });
  });

  it('expanding a row reveals the JSON payload', async () => {
    renderWithProviders(<RecycleBinPage />);
    await waitFor(() => screen.getByTestId('recycle-bin-table'));
    fireEvent.click(screen.getByTestId('recycle-bin-toggle-rec-1'));
    await waitFor(() => {
      expect(screen.getByTestId('recycle-bin-payload-rec-1')).toBeInTheDocument();
    });
  });

  it('Restore button → confirm modal → confirm calls api.recoveryRestore', async () => {
    renderWithProviders(<RecycleBinPage />);
    await waitFor(() => screen.getByTestId('recycle-bin-table'));
    fireEvent.click(screen.getByTestId('recycle-bin-restore-rec-1'));
    await waitFor(() => {
      expect(screen.getByTestId('recycle-bin-restore-modal')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('recycle-bin-restore-confirm'));
    await waitFor(() => {
      expect(api.recoveryRestore).toHaveBeenCalledWith('rec-1');
    });
  });

  it('Purge button → confirm modal → confirm calls api.recoveryPurge', async () => {
    renderWithProviders(<RecycleBinPage />);
    await waitFor(() => screen.getByTestId('recycle-bin-table'));
    fireEvent.click(screen.getByTestId('recycle-bin-purge-rec-1'));
    await waitFor(() => {
      expect(screen.getByTestId('recycle-bin-purge-modal')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('recycle-bin-purge-confirm'));
    await waitFor(() => {
      expect(api.recoveryPurge).toHaveBeenCalledWith('rec-1');
    });
  });

  it('renders empty-state when the list is empty', async () => {
    vi.spyOn(api, 'recoveryList').mockResolvedValue({ items: [], total: 0 });
    renderWithProviders(<RecycleBinPage />);
    await waitFor(() => {
      expect(screen.getByTestId('recycle-bin-empty')).toBeInTheDocument();
    });
  });
});
