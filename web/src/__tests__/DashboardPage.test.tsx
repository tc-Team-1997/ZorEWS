import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
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
});
