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
    expect(screen.getByText(/High-risk customers/i)).toBeInTheDocument();
    expect(screen.getByText(/Active alerts/i)).toBeInTheDocument();
    expect(screen.getByText(/Cases open/i)).toBeInTheDocument();
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
});
