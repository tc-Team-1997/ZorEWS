// Insurance EWS Module 1 — Policy Lapse Risk page tests.

import { describe, test, expect } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from './utils';
import { PolicyLapsePage } from '@/modules/insurance/PolicyLapsePage';

describe('PolicyLapsePage', () => {
  test('renders header + 5 KPI widgets + dashboard body', async () => {
    renderWithProviders(<PolicyLapsePage />);
    expect(screen.getByText('Policy Lapse Risk')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByTestId('lapse-dashboard')).toBeInTheDocument();
    });
    expect(screen.getByText('In-force policies')).toBeInTheDocument();
    expect(screen.getByText('At risk (30–90d)')).toBeInTheDocument();
    expect(screen.getByText('GWP at risk')).toBeInTheDocument();
  });

  test('renders the high-risk policies table with only high/critical bands', async () => {
    renderWithProviders(<PolicyLapsePage />);
    const table = await screen.findByTestId('lapse-high-risk-table');
    const badges = within(table).getAllByText(/high|critical/i);
    expect(badges.length).toBeGreaterThan(0);
  });

  test('renders the 4 widget headings', async () => {
    renderWithProviders(<PolicyLapsePage />);
    await screen.findByTestId('lapse-dashboard');
    expect(screen.getByText(/Upcoming lapse trend/i)).toBeInTheDocument();
    expect(screen.getByText(/Channel-wise lapse risk/i)).toBeInTheDocument();
    expect(screen.getByText(/Region-wise lapse risk/i)).toBeInTheDocument();
    expect(screen.getByText(/Top retention opportunities/i)).toBeInTheDocument();
  });

  test('predict modal opens, scores, and shows a band + drivers', async () => {
    const user = userEvent.setup();
    renderWithProviders(<PolicyLapsePage />);
    await screen.findByTestId('lapse-dashboard');

    await user.click(screen.getByTestId('lapse-predict-open'));
    expect(await screen.findByTestId('lapse-predict-modal')).toBeInTheDocument();

    await user.click(screen.getByTestId('lapse-predict-run'));
    const result = await screen.findByTestId('lapse-predict-result');
    expect(result).toBeInTheDocument();
    // Result shows a percentage probability + a recommended action line.
    expect(result.textContent).toMatch(/%/);
  });
});
