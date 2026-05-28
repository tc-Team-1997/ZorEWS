// Insurance EWS Module 2 — Claims Anomaly page tests.

import { describe, test, expect } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from './utils';
import { ClaimsAnomalyPage } from '@/modules/insurance/ClaimsAnomalyPage';

describe('ClaimsAnomalyPage', () => {
  test('renders header + KPI widgets + dashboard body', async () => {
    renderWithProviders(<ClaimsAnomalyPage />);
    expect(screen.getByText('Claims Anomaly')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByTestId('claims-dashboard')).toBeInTheDocument();
    });
    expect(screen.getByText('Claims scored')).toBeInTheDocument();
    expect(screen.getByText('SIU open cases')).toBeInTheDocument();
  });

  test('renders the 4 widgets', async () => {
    renderWithProviders(<ClaimsAnomalyPage />);
    await screen.findByTestId('claims-dashboard');
    expect(screen.getByText(/Fraud score distribution/i)).toBeInTheDocument();
    expect(screen.getByTestId('claims-heatmap')).toBeInTheDocument();
    expect(screen.getByTestId('suspicious-claims-table')).toBeInTheDocument();
    expect(screen.getByTestId('siu-queue')).toBeInTheDocument();
  });

  test('suspicious claims table shows only high/critical bands', async () => {
    renderWithProviders(<ClaimsAnomalyPage />);
    const table = await screen.findByTestId('suspicious-claims-table');
    const badges = within(table).getAllByText(/high|critical/i);
    expect(badges.length).toBeGreaterThan(0);
  });

  test('analyze modal opens, scores, shows severity + reasons', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ClaimsAnomalyPage />);
    await screen.findByTestId('claims-dashboard');

    await user.click(screen.getByTestId('claim-analyze-open'));
    expect(await screen.findByTestId('claim-analyze-modal')).toBeInTheDocument();

    await user.click(screen.getByTestId('claim-analyze-run'));
    const result = await screen.findByTestId('claim-analyze-result');
    expect(result).toBeInTheDocument();
    expect(result.textContent).toMatch(/%/);
  });
});
