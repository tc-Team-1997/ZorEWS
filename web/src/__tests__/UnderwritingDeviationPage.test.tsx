// Insurance EWS Module 6 — Underwriting Deviation page tests.

import { describe, test, expect } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from './utils';
import { UnderwritingDeviationPage } from '@/modules/insurance/UnderwritingDeviationPage';

describe('UnderwritingDeviationPage', () => {
  test('renders header + KPI row + dashboard body', async () => {
    renderWithProviders(<UnderwritingDeviationPage />);
    expect(screen.getByText('Underwriting Deviation')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByTestId('uw-dashboard')).toBeInTheDocument();
    });
    expect(screen.getByText('Proposals reviewed')).toBeInTheDocument();
    expect(screen.getByText('Total deviations')).toBeInTheDocument();
  });

  test('renders the 4 widgets', async () => {
    renderWithProviders(<UnderwritingDeviationPage />);
    await screen.findByTestId('uw-dashboard');
    expect(screen.getByTestId('high-risk-underwriters')).toBeInTheDocument();
    expect(screen.getByTestId('deviation-heatmap')).toBeInTheDocument();
    expect(screen.getByText(/Medical waiver analysis/i)).toBeInTheDocument();
    expect(screen.getByTestId('rule-violation-alerts')).toBeInTheDocument();
  });

  test('analyze modal opens, runs, shows score + severity', async () => {
    const user = userEvent.setup();
    renderWithProviders(<UnderwritingDeviationPage />);
    await screen.findByTestId('uw-dashboard');

    await user.click(screen.getByTestId('uw-analyze-open'));
    expect(await screen.findByTestId('uw-analyze-modal')).toBeInTheDocument();

    await user.click(screen.getByTestId('uw-analyze-run'));
    const result = await screen.findByTestId('uw-analyze-result');
    expect(result.textContent).toMatch(/Deviation score/i);
    expect(result.textContent).toMatch(/%/);
  });
});
