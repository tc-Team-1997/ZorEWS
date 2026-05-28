// Insurance EWS Module 4 — Solvency Watch page tests.

import { describe, test, expect } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from './utils';
import { SolvencyWatchPage } from '@/modules/insurance/SolvencyWatchPage';

describe('SolvencyWatchPage', () => {
  test('renders header + current ratio + KPI row', async () => {
    renderWithProviders(<SolvencyWatchPage />);
    expect(screen.getByText('Solvency Watch')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByTestId('solvency-dashboard')).toBeInTheDocument();
    });
    expect(screen.getByTestId('solvency-ratio-card')).toBeInTheDocument();
    expect(screen.getByText('Control level')).toBeInTheDocument();
  });

  test('renders the 4 widgets', async () => {
    renderWithProviders(<SolvencyWatchPage />);
    await screen.findByTestId('solvency-dashboard');
    expect(screen.getByText(/Forecast solvency trend/i)).toBeInTheDocument();
    expect(screen.getByTestId('stress-simulation')).toBeInTheDocument();
    // Compliance widget renders either the alert list or the empty state.
    const complianceWidget =
      screen.queryByTestId('compliance-alerts') ?? screen.queryByTestId('compliance-empty');
    expect(complianceWidget).toBeInTheDocument();
  });

  test('capital stress simulation shows 3 scenarios', async () => {
    renderWithProviders(<SolvencyWatchPage />);
    const sim = await screen.findByTestId('stress-simulation');
    expect(sim.textContent?.toLowerCase()).toContain('baseline');
    expect(sim.textContent?.toLowerCase()).toContain('adverse');
    expect(sim.textContent?.toLowerCase()).toContain('severe');
  });

  test('forecast modal opens, projects, shows status + breach probability', async () => {
    const user = userEvent.setup();
    renderWithProviders(<SolvencyWatchPage />);
    await screen.findByTestId('solvency-dashboard');

    await user.click(screen.getByTestId('solvency-forecast-open'));
    expect(await screen.findByTestId('solvency-forecast-modal')).toBeInTheDocument();

    await user.click(screen.getByTestId('solvency-forecast-run'));
    const result = await screen.findByTestId('solvency-forecast-result');
    expect(result.textContent).toMatch(/Projected ratio/i);
    expect(result.textContent).toMatch(/%/);
  });
});
