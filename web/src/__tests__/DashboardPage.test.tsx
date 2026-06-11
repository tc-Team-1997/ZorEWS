import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DashboardPage } from '@/modules/dashboard/DashboardPage';
import { renderWithProviders } from './utils';

describe('DashboardPage', () => {
  it('renders the headline metric cards from mock data', async () => {
    renderWithProviders(<DashboardPage />);
    expect(screen.getByRole('heading', { name: /EWS Dashboard/i })).toBeInTheDocument();
    expect(screen.getByText(/Customers monitored/i)).toBeInTheDocument();
    expect(screen.getByText(/High-Risk Accounts/i)).toBeInTheDocument();
    // KPI card label is "Active Alerts" — use testId to avoid ambiguity
    // with the ChatWidget WelcomeScreen that also renders the same text.
    expect(screen.getByTestId('kpi-active-alerts')).toBeInTheDocument();
    expect(screen.getByTestId('kpi-cases-open')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByText('18,432')).toBeInTheDocument();
    });
  });

  it('renders the SLA breaches card + matrix + most-overdue panel', async () => {
    renderWithProviders(<DashboardPage />);
    expect(await screen.findByText(/SLA breaches/i)).toBeInTheDocument();

    const matrix = await screen.findByTestId('sla-matrix');
    expect(within(matrix).getByText(/Critical/i)).toBeInTheDocument();
    expect(within(matrix).getByText(/Approaching/i)).toBeInTheDocument();
    expect(within(matrix).getByText(/Breached/i)).toBeInTheDocument();

    const overdue = await screen.findByTestId('breached-cases-list');
    expect(within(overdue).getAllByText(/min overdue/i).length).toBeGreaterThan(0);
  });

  // Drill-down — clicking a severity bar opens the 5-angle breakdown
  it('opens the severity drill-down with 5 non-repetitive angles', async () => {
    const user = userEvent.setup();
    renderWithProviders(<DashboardPage />);
    // Wait for the chart to mount before interacting
    await screen.findByTestId('alerts-bar-drill-hint');
    const criticalCell = await screen.findByTestId('alerts-bar-cell-critical');
    await user.click(criticalCell);
    const drill = await screen.findByTestId('severity-drilldown');
    // All five panels render — each panel = a distinct angle
    expect(within(drill).getByTestId('severity-drilldown-rules')).toBeInTheDocument();
    expect(within(drill).getByTestId('severity-drilldown-customers')).toBeInTheDocument();
    expect(within(drill).getByTestId('severity-drilldown-age')).toBeInTheDocument();
    expect(within(drill).getByTestId('severity-drilldown-assignee')).toBeInTheDocument();
    expect(within(drill).getByTestId('severity-drilldown-indicators')).toBeInTheDocument();
    // Subtitle names the severity + a count
    expect(screen.getByTestId('severity-drilldown-subtitle').textContent).toMatch(
      /critical/i,
    );
  });

  it('closes the drill-down via the Close button', async () => {
    const user = userEvent.setup();
    renderWithProviders(<DashboardPage />);
    await screen.findByTestId('alerts-bar-drill-hint');
    await user.click(await screen.findByTestId('alerts-bar-cell-high'));
    await screen.findByTestId('severity-drilldown');
    await user.click(screen.getByTestId('severity-drilldown-close'));
    expect(screen.queryByTestId('severity-drilldown')).not.toBeInTheDocument();
  });

  it('clicking a different severity bar swaps the drill-down', async () => {
    const user = userEvent.setup();
    renderWithProviders(<DashboardPage />);
    await screen.findByTestId('alerts-bar-drill-hint');
    await user.click(await screen.findByTestId('alerts-bar-cell-critical'));
    await waitFor(() => {
      expect(screen.getByTestId('severity-drilldown-subtitle').textContent).toMatch(
        /critical/i,
      );
    });
    await user.click(await screen.findByTestId('alerts-bar-cell-medium'));
    await waitFor(() => {
      expect(screen.getByTestId('severity-drilldown-subtitle').textContent).toMatch(
        /medium/i,
      );
    });
  });

  // URL-bound drill state — boot with ?drill=severity:critical and the
  // drill is already open on first render. Shareable + refresh-stable.
  it('boots with the severity drill open when ?drill=severity:<sev> is in the URL', async () => {
    renderWithProviders(<DashboardPage />, { route: '/?drill=severity:high' });
    const drill = await screen.findByTestId('severity-drilldown');
    expect(within(drill).getByTestId('severity-drilldown-rules')).toBeInTheDocument();
    // Subtitle starts as "Loading…" while the alerts query resolves;
    // wait for it to flip to the settled "high" text.
    await waitFor(() => {
      expect(screen.getByTestId('severity-drilldown-subtitle').textContent).toMatch(/high/i);
    });
    // Chip button for `high` shows pressed state
    const highBtn = screen.getByTestId('alerts-bar-cell-high');
    expect(highBtn.getAttribute('aria-pressed')).toBe('true');
  });

  it('ignores ?drill=<malformed> and renders without a drill', async () => {
    renderWithProviders(<DashboardPage />, { route: '/?drill=garbage:value' });
    await screen.findByTestId('alerts-bar-drill-hint');
    expect(screen.queryByTestId('severity-drilldown')).not.toBeInTheDocument();
    expect(screen.queryByTestId('trend-drilldown')).not.toBeInTheDocument();
  });

  // Trend drill via URL — the line chart's activeDot click is hard to
  // fire in jsdom, but the URL-bound state makes the drill testable.
  it('boots with the trend drill open when ?drill=week:<N> is in the URL', async () => {
    // Default range is 30d → trendSlice has ~5 weeks. Index 2 is safe.
    renderWithProviders(<DashboardPage />, { route: '/?drill=week:2' });
    const drill = await screen.findByTestId('trend-drilldown');
    // All 4 trend-drill angles render
    expect(within(drill).getByTestId('trend-drilldown-severity')).toBeInTheDocument();
    expect(within(drill).getByTestId('trend-drilldown-rules')).toBeInTheDocument();
    expect(within(drill).getByTestId('trend-drilldown-customers')).toBeInTheDocument();
    expect(within(drill).getByTestId('trend-drilldown-indicators')).toBeInTheDocument();
    // Subtitle names the week + a "Week of …" prefix
    await waitFor(() => {
      expect(screen.getByTestId('trend-drilldown-subtitle').textContent).toMatch(/Week of/);
    });
  });

  it('ignores out-of-range ?drill=week:<N> against the current time slice', async () => {
    renderWithProviders(<DashboardPage />, { route: '/?drill=week:999' });
    await screen.findByTestId('alerts-bar-drill-hint');
    expect(screen.queryByTestId('trend-drilldown')).not.toBeInTheDocument();
  });
});
