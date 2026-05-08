// Analytics Dashboard — T4.1 / EWS.docx §5.5 / §8 — Vitest coverage.
//
// Smoke layer focused on:
//   1. Tabbed chrome — all 4 tabs render, the 3 unbuilt tabs show
//      `coming soon` placeholders.
//   2. Alert-resolution tab — funnel chart + KPI cards hydrate from
//      MSW seed (200 alerts spread across 4 weeks).
//   3. Severity filter — switching it round-trips through the URL and
//      changes the funnel `created` count.

import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AnalyticsPage } from '@/modules/dashboard/AnalyticsPage';
import { renderWithProviders } from './utils';

function authenticate(role = 'admin') {
  localStorage.setItem(
    'apex.ews.user',
    JSON.stringify({ username: 'taniya', roles: [role] }),
  );
}

describe('AnalyticsPage — chrome', () => {
  it('renders all 4 tabs (alert-resolution + risk-trend live; pd/stage placeholders)', async () => {
    authenticate();
    renderWithProviders(<AnalyticsPage />);
    expect(
      screen.getByRole('heading', { name: /Analytics Dashboard/i }),
    ).toBeInTheDocument();
    expect(screen.getByTestId('analytics-tab-alert-resolution')).toBeInTheDocument();
    expect(screen.getByTestId('analytics-tab-risk-trend')).toBeInTheDocument();
    expect(screen.getByTestId('analytics-tab-pd-distribution')).toBeInTheDocument();
    expect(screen.getByTestId('analytics-tab-stage-migration')).toBeInTheDocument();
  });

  it('switching to the stage-migration placeholder shows the coming-soon panel', async () => {
    authenticate();
    const user = userEvent.setup();
    renderWithProviders(<AnalyticsPage />);
    await user.click(screen.getByTestId('analytics-tab-stage-migration'));
    expect(screen.getByTestId('coming-soon-stage-migration')).toBeInTheDocument();
    expect(screen.queryByTestId('alert-resolution-panel')).not.toBeInTheDocument();
  });
});

describe('AnalyticsPage — alert-resolution tab', () => {
  it('hydrates funnel + KPI cards from MSW seed', async () => {
    authenticate();
    renderWithProviders(<AnalyticsPage />);

    // The 200-row seed: severity round-robin (50 each), pseudo-random ack/close
    await waitFor(() =>
      expect(screen.getByText(/Alerts created/i)).toBeInTheDocument(),
    );

    // Funnel chart panel renders
    expect(screen.getByTestId('funnel-chart')).toBeInTheDocument();

    // Funnel summary list shows all 4 stages
    const panel = screen.getByTestId('alert-resolution-panel');
    expect(within(panel).getByText('created')).toBeInTheDocument();
    expect(within(panel).getByText('acked')).toBeInTheDocument();
    expect(within(panel).getByText('investigated')).toBeInTheDocument();
    expect(within(panel).getByText('closed')).toBeInTheDocument();
  });

  it('switching severity narrows the funnel created count', async () => {
    authenticate();
    const user = userEvent.setup();
    renderWithProviders(<AnalyticsPage />);

    await waitFor(() =>
      expect(screen.getByText(/Alerts created/i)).toBeInTheDocument(),
    );

    // The MetricCard for "Alerts created" lives next to the value;
    // capture the value before the filter change.
    const allCardValue = screen
      .getByText(/Alerts created/i)
      .parentElement!.textContent ?? '';

    await user.selectOptions(screen.getByLabelText(/Severity/i), 'critical');

    await waitFor(() => {
      const next = screen
        .getByText(/Alerts created/i)
        .parentElement!.textContent ?? '';
      // Critical is ~25% of the 200-seed (round-robin), so the count drops
      expect(next).not.toBe(allCardValue);
    });
  });
});

describe('AnalyticsPage — pd-distribution tab', () => {
  it('hydrates KPI cards + histogram from MSW seed', async () => {
    authenticate();
    const user = userEvent.setup();
    renderWithProviders(<AnalyticsPage />);

    await user.click(screen.getByTestId('analytics-tab-pd-distribution'));
    await waitFor(() =>
      expect(screen.getByTestId('pd-kpis')).toBeInTheDocument(),
    );
    expect(screen.getByTestId('pd-kpi-customers')).toBeInTheDocument();
    expect(screen.getByTestId('pd-kpi-bands')).toBeInTheDocument();
    expect(screen.getByTestId('pd-distribution-chart')).toBeInTheDocument();
  });

  it('changing compare-to dropdown triggers a refetch', async () => {
    authenticate();
    const user = userEvent.setup();
    renderWithProviders(<AnalyticsPage />);

    await user.click(screen.getByTestId('analytics-tab-pd-distribution'));
    await waitFor(() =>
      expect(screen.getByTestId('pd-kpi-customers')).toBeInTheDocument(),
    );
    const before = screen.getByTestId('pd-kpi-customers').textContent ?? '';
    await user.selectOptions(screen.getByLabelText(/Compare to/i), '0');

    await waitFor(() => {
      const after = screen.getByTestId('pd-kpi-customers').textContent ?? '';
      // No-comparison mode → "no prior comparison" sub instead of "vs N 30d ago"
      expect(after).not.toBe(before);
    });
  });
});

describe('AnalyticsPage — risk-trend tab', () => {
  it('hydrates KPI cards + the composed chart from the MSW seed', async () => {
    authenticate();
    const user = userEvent.setup();
    renderWithProviders(<AnalyticsPage />);

    await user.click(screen.getByTestId('analytics-tab-risk-trend'));
    await waitFor(() =>
      expect(screen.getByTestId('rt-kpis')).toBeInTheDocument(),
    );
    expect(screen.getByTestId('rt-kpi-alerts')).toBeInTheDocument();
    expect(screen.getByTestId('risk-trend-chart')).toBeInTheDocument();
  });

  it('changing range to 7d narrows the alert count', async () => {
    authenticate();
    const user = userEvent.setup();
    renderWithProviders(<AnalyticsPage />);

    await user.click(screen.getByTestId('analytics-tab-risk-trend'));
    await waitFor(() =>
      expect(screen.getByTestId('rt-kpi-alerts')).toBeInTheDocument(),
    );
    const before = screen.getByTestId('rt-kpi-alerts').textContent ?? '';

    await user.selectOptions(screen.getByLabelText(/Time range/i), '7d');

    await waitFor(() => {
      const after = screen.getByTestId('rt-kpi-alerts').textContent ?? '';
      // 7d window contains fewer rows than the default 30d → text differs
      expect(after).not.toBe(before);
    });
  });
});
