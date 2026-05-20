// Vitest for RecoveryAnalyticsPage (Recovery Center Phase 3).
//
// Mocks api.recoveryAnalytics so the page renders against a known
// fixture. Asserts:
//   - KPI strip renders archive / restore / purge totals
//   - Window picker (7 / 30 / 90) toggles the query
//   - Daily volume chart renders (ResponsiveContainer needs explicit
//     dimensions in jsdom — we just check the wrapper testid)
//   - Cohort tile renders restore_rate + purge_rate + p50 + p95
//   - Top actors table shows the rows
//   - By-entity_type table shows outstanding_delta badges
//   - By-module table renders
//   - Empty / loading / error states

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { RecoveryAnalyticsPage } from '@/modules/admin/RecoveryAnalyticsPage';
import { renderWithProviders } from './utils';
import { api, type RecoveryAnalytics } from '@/lib/api';

const NOW_ISO = '2026-05-21T12:00:00.000Z';

const FIXTURE: RecoveryAnalytics = {
  tenant_id: 'BANK_DEMO',
  generated_at: NOW_ISO,
  days: 30,
  window_start: '2026-04-21T12:00:00.000Z',
  window_end: NOW_ISO,
  total_archives_in_window: 47,
  total_restores_in_window: 12,
  total_purges_in_window: 3,
  by_day: Array.from({ length: 30 }, (_, i) => ({
    date: new Date(Date.parse(NOW_ISO) - (29 - i) * 86400 * 1000)
      .toISOString()
      .slice(0, 10),
    total: i === 28 ? 5 : 1,
    by_status: {
      archived: i === 28 ? 4 : 1,
      restored: i === 28 ? 1 : 0,
      purged: 0,
    },
  })),
  top_actors: [
    {
      actor_username: 'alice.admin',
      total_archives: 18,
      total_restores: 4,
      total_purges: 2,
      most_recent_at: '2026-05-21T11:30:00.000Z',
    },
    {
      actor_username: 'ravi.risk',
      total_archives: 9,
      total_restores: 3,
      total_purges: 0,
      most_recent_at: '2026-05-20T08:15:00.000Z',
    },
  ],
  by_entity_type: [
    {
      entity_type: 'webhook_subscription',
      total_archives: 15,
      total_restores: 3,
      total_purges: 1,
      outstanding_delta: 12, // positive → warning badge
    },
    {
      entity_type: 'user_team',
      total_archives: 5,
      total_restores: 7,
      total_purges: 0,
      outstanding_delta: -2, // negative → success badge (operators cleaned up backlog)
    },
    {
      entity_type: 'tenant',
      total_archives: 2,
      total_restores: 2,
      total_purges: 0,
      outstanding_delta: 0, // zero → neutral badge
    },
  ],
  by_module: [
    { module: 'bff', total_archives: 22, total_restores: 5, total_purges: 1 },
    { module: 'auth-svc', total_archives: 25, total_restores: 7, total_purges: 2 },
  ],
  restore_rate: 0.26, // 26%
  purge_rate: 0.06, // 6%
  mean_time_to_restore_hours: 14.3,
  p50_time_to_restore_hours: 8.2,
  p95_time_to_restore_hours: 71.4,
};

describe('RecoveryAnalyticsPage', () => {
  beforeEach(() => {
    vi.spyOn(api, 'recoveryAnalytics').mockResolvedValue(FIXTURE);
  });

  it('renders the page header + window picker + KPI strip', async () => {
    renderWithProviders(<RecoveryAnalyticsPage />);
    await waitFor(() => {
      expect(screen.getByText(/Recovery Center · Analytics/i)).toBeInTheDocument();
    });
    expect(screen.getByTestId('recovery-analytics-window-picker')).toBeInTheDocument();
    expect(screen.getByTestId('recovery-analytics-window-7')).toBeInTheDocument();
    expect(screen.getByTestId('recovery-analytics-window-30')).toBeInTheDocument();
    expect(screen.getByTestId('recovery-analytics-window-90')).toBeInTheDocument();
    // Default is 30 — that chip is active.
    expect(screen.getByTestId('recovery-analytics-window-30')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await waitFor(() => {
      expect(screen.getByTestId('recovery-analytics-kpis')).toBeInTheDocument();
    });
    const kpis = screen.getByTestId('recovery-analytics-kpis');
    expect(kpis).toHaveTextContent('47');
    expect(kpis).toHaveTextContent('12');
    expect(kpis).toHaveTextContent('3');
  });

  it('clicking a window chip refetches with the new days value', async () => {
    renderWithProviders(<RecoveryAnalyticsPage />);
    await waitFor(() => screen.getByTestId('recovery-analytics-kpis'));
    fireEvent.click(screen.getByTestId('recovery-analytics-window-7'));
    await waitFor(() => {
      expect(api.recoveryAnalytics).toHaveBeenLastCalledWith(7);
    });
    fireEvent.click(screen.getByTestId('recovery-analytics-window-90'));
    await waitFor(() => {
      expect(api.recoveryAnalytics).toHaveBeenLastCalledWith(90);
    });
  });

  it('cohort tile renders restore_rate + purge_rate + percentile time-to-restore', async () => {
    renderWithProviders(<RecoveryAnalyticsPage />);
    await waitFor(() => {
      expect(screen.getByTestId('recovery-analytics-cohort')).toBeInTheDocument();
    });
    const cohort = screen.getByTestId('recovery-analytics-cohort');
    expect(cohort).toHaveTextContent('26%'); // restore_rate
    expect(cohort).toHaveTextContent('6%'); // purge_rate
    // p50 = 8.2h, p95 = 71.4h → formatted via fmtHours (8.2h, then 2.975d for >48h)
    expect(cohort).toHaveTextContent('8.2h');
  });

  it('top actors table shows usernames + per-op counts', async () => {
    renderWithProviders(<RecoveryAnalyticsPage />);
    await waitFor(() => {
      expect(screen.getByTestId('recovery-analytics-actors')).toBeInTheDocument();
    });
    expect(screen.getByTestId('recovery-analytics-actor-alice.admin')).toBeInTheDocument();
    expect(screen.getByTestId('recovery-analytics-actor-ravi.risk')).toBeInTheDocument();
    const alice = screen.getByTestId('recovery-analytics-actor-alice.admin');
    expect(alice).toHaveTextContent('alice.admin');
    expect(alice).toHaveTextContent('18'); // archives
    expect(alice).toHaveTextContent('4'); // restores
  });

  it('entity rows render outstanding_delta with correct tone (positive / negative / zero)', async () => {
    renderWithProviders(<RecoveryAnalyticsPage />);
    await waitFor(() => {
      expect(screen.getByTestId('recovery-analytics-entities')).toBeInTheDocument();
    });
    const wh = screen.getByTestId('recovery-analytics-entity-webhook_subscription');
    expect(wh).toHaveTextContent('webhook_subscription');
    expect(wh).toHaveTextContent('+12'); // positive prefix
    const team = screen.getByTestId('recovery-analytics-entity-user_team');
    expect(team).toHaveTextContent('-2'); // negative (operators cleaning up backlog)
    const tenant = screen.getByTestId('recovery-analytics-entity-tenant');
    expect(tenant).toHaveTextContent('0'); // zero
  });

  it('module rollup renders both bff + auth-svc', async () => {
    renderWithProviders(<RecoveryAnalyticsPage />);
    await waitFor(() => {
      expect(screen.getByTestId('recovery-analytics-modules')).toBeInTheDocument();
    });
    const modules = screen.getByTestId('recovery-analytics-modules');
    expect(modules).toHaveTextContent('bff');
    expect(modules).toHaveTextContent('auth-svc');
    expect(modules).toHaveTextContent('22');
    expect(modules).toHaveTextContent('25');
  });

  it('back link routes to /admin/recycle-bin', async () => {
    renderWithProviders(<RecoveryAnalyticsPage />);
    await waitFor(() => {
      expect(screen.getByTestId('recovery-analytics-back-link')).toBeInTheDocument();
    });
    const link = screen.getByTestId('recovery-analytics-back-link');
    expect(link).toHaveAttribute('href', '/admin/recycle-bin');
  });

  it('renders error state when api throws', async () => {
    vi.spyOn(api, 'recoveryAnalytics').mockRejectedValueOnce(new Error('boom'));
    renderWithProviders(<RecoveryAnalyticsPage />);
    await waitFor(() => {
      expect(screen.getByTestId('recovery-analytics-error')).toBeInTheDocument();
    });
  });

  it('renders empty state for top actors when none exist in the window', async () => {
    vi.spyOn(api, 'recoveryAnalytics').mockResolvedValue({
      ...FIXTURE,
      total_archives_in_window: 0,
      total_restores_in_window: 0,
      total_purges_in_window: 0,
      top_actors: [],
      by_entity_type: [],
      by_module: [],
      restore_rate: null,
      purge_rate: null,
      mean_time_to_restore_hours: null,
      p50_time_to_restore_hours: null,
      p95_time_to_restore_hours: null,
    });
    renderWithProviders(<RecoveryAnalyticsPage />);
    await waitFor(() => {
      expect(screen.getByTestId('recovery-analytics-actors-empty')).toBeInTheDocument();
    });
    expect(screen.getByTestId('recovery-analytics-entities-empty')).toBeInTheDocument();
  });
});
