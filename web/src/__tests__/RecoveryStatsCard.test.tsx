// Vitest for the admin-only Recovery Center dashboard tile.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { RecoveryStatsCard } from '@/components/dashboard/RecoveryStatsCard';
import { renderWithProviders } from './utils';
import { api, type RecoveryStats } from '@/lib/api';
import { useAuth } from '@/store/auth';

const STATS: RecoveryStats = {
  total: 7,
  by_status: { archived: 4, restored: 2, purged: 1 },
  by_module: { bff: 7 },
  by_entity_type: { webhook_subscription: 4, saved_scenario: 2, saved_report_filter: 1 },
  most_recent_at: '2026-05-19T10:30:00Z',
  adapters: [
    { entity_type: 'webhook_subscription', display_name: 'Webhook subscription', module: 'bff' },
    { entity_type: 'saved_scenario', display_name: 'Saved scenario', module: 'bff' },
    { entity_type: 'saved_report_filter', display_name: 'Saved report filter', module: 'bff' },
  ],
};

function setRole(role: 'admin' | 'risk_analyst' | null) {
  useAuth.setState({
    status: role ? 'authenticated' : 'idle',
    user: role
      ? {
          id: 'u-1',
          username: 'alice',
          display_name: 'Alice',
          roles: [role],
          must_change_password: false,
        }
      : null,
    token: role ? 'tok' : null,
  });
}

describe('RecoveryStatsCard', () => {
  beforeEach(() => {
    vi.spyOn(api, 'recoveryStats').mockResolvedValue(STATS);
  });

  it('renders nothing for non-admin', async () => {
    setRole('risk_analyst');
    const { container } = renderWithProviders(<RecoveryStatsCard />);
    expect(container.querySelector('[data-testid="recovery-stats-card"]')).toBeNull();
    expect(api.recoveryStats).not.toHaveBeenCalled();
  });

  it('renders nothing when no user is signed in', () => {
    setRole(null);
    const { container } = renderWithProviders(<RecoveryStatsCard />);
    expect(container.firstChild).toBeNull();
  });

  it('renders the 3 stat tiles + open link for admin', async () => {
    setRole('admin');
    renderWithProviders(<RecoveryStatsCard />);
    await waitFor(() => {
      expect(screen.getByText('Recoverable')).toBeInTheDocument();
    });
    expect(screen.getByTestId('recovery-stats-card')).toBeInTheDocument();
    expect(screen.getByText('Restored')).toBeInTheDocument();
    expect(screen.getByText('Permanently deleted')).toBeInTheDocument();
    // Numbers
    expect(screen.getByText('4')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
    expect(screen.getByText('1')).toBeInTheDocument();
    // Deep link
    const link = screen.getByTestId('recovery-stats-card-open');
    expect(link.getAttribute('href')).toBe('/admin/recycle-bin');
    // Most-recent label
    expect(screen.getByTestId('recovery-stats-card-last')).toBeInTheDocument();
  });

  it('shows empty-state line when total=0', async () => {
    setRole('admin');
    vi.spyOn(api, 'recoveryStats').mockResolvedValue({
      ...STATS,
      total: 0,
      by_status: { archived: 0, restored: 0, purged: 0 },
      most_recent_at: null,
    });
    renderWithProviders(<RecoveryStatsCard />);
    await waitFor(() => {
      expect(screen.getByTestId('recovery-stats-card-empty')).toBeInTheDocument();
    });
    // 3 zeros visible (one per stat tile)
    expect(screen.getAllByText('0')).toHaveLength(3);
  });

  it('shows error-state when API call fails', async () => {
    setRole('admin');
    vi.spyOn(api, 'recoveryStats').mockRejectedValue(new Error('boom'));
    renderWithProviders(<RecoveryStatsCard />);
    await waitFor(() => {
      expect(screen.getByTestId('recovery-stats-card-error')).toBeInTheDocument();
    });
  });
});
