// Insurance EWS Module 7 — Channel Risk page tests.

import { describe, test, expect } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from './utils';
import { ChannelRiskPage } from '@/modules/insurance/ChannelRiskPage';

describe('ChannelRiskPage', () => {
  test('renders header + KPI row + dashboard body', async () => {
    renderWithProviders(<ChannelRiskPage />);
    expect(screen.getByText('Channel Risk')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByTestId('chr-dashboard')).toBeInTheDocument();
    });
    expect(screen.getByText('Agents scored')).toBeInTheDocument();
    expect(screen.getByText('Complaints (30d)')).toBeInTheDocument();
  });

  test('renders the 4 widgets', async () => {
    renderWithProviders(<ChannelRiskPage />);
    await screen.findByTestId('chr-dashboard');
    expect(screen.getByTestId('channel-risk-leaderboard')).toBeInTheDocument();
    expect(screen.getByTestId('channel-health')).toBeInTheDocument();
    expect(screen.getByTestId('mis-selling-alerts')).toBeInTheDocument();
    expect(screen.getByText(/Complaint analytics/i)).toBeInTheDocument();
  });

  test('analyze modal opens, runs, shows composite risk + band', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ChannelRiskPage />);
    await screen.findByTestId('chr-dashboard');

    await user.click(screen.getByTestId('chr-analyze-open'));
    expect(await screen.findByTestId('chr-analyze-modal')).toBeInTheDocument();

    await user.click(screen.getByTestId('chr-analyze-run'));
    const result = await screen.findByTestId('chr-analyze-result');
    expect(result.textContent).toMatch(/Composite risk/i);
    expect(result.textContent).toMatch(/Risk drivers/i);
    expect(result.textContent).toMatch(/%/);
  });
});
