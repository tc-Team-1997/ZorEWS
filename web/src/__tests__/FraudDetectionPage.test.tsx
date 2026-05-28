// Insurance EWS Module 3 — Fraud Detection page tests.

import { describe, test, expect } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from './utils';
import { FraudDetectionPage } from '@/modules/insurance/FraudDetectionPage';

describe('FraudDetectionPage', () => {
  test('renders header + KPI widgets + dashboard body', async () => {
    renderWithProviders(<FraudDetectionPage />);
    expect(screen.getByText('Fraud Detection')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByTestId('fraud-dashboard')).toBeInTheDocument();
    });
    expect(screen.getByText('Entities tracked')).toBeInTheDocument();
    expect(screen.getByText('Fraud rings')).toBeInTheDocument();
  });

  test('renders the 4 widgets (graph, rings, providers, identity)', async () => {
    renderWithProviders(<FraudDetectionPage />);
    await screen.findByTestId('fraud-dashboard');
    expect(screen.getByTestId('fraud-network-graph')).toBeInTheDocument();
    expect(screen.getByTestId('fraud-rings-table')).toBeInTheDocument();
    expect(screen.getByTestId('high-risk-providers')).toBeInTheDocument();
    expect(screen.getByTestId('identity-risk')).toBeInTheDocument();
  });

  test('network graph renders nodes (circles) + edges (lines)', async () => {
    renderWithProviders(<FraudDetectionPage />);
    const svg = await screen.findByTestId('fraud-network-graph');
    expect(svg.querySelectorAll('circle').length).toBeGreaterThan(0);
    expect(svg.querySelectorAll('line').length).toBeGreaterThan(0);
  });

  test('analyze modal opens, scores, shows fraud type + ring likelihood', async () => {
    const user = userEvent.setup();
    renderWithProviders(<FraudDetectionPage />);
    await screen.findByTestId('fraud-dashboard');

    await user.click(screen.getByTestId('fraud-analyze-open'));
    expect(await screen.findByTestId('fraud-analyze-modal')).toBeInTheDocument();

    await user.click(screen.getByTestId('fraud-analyze-run'));
    const result = await screen.findByTestId('fraud-analyze-result');
    expect(within(result).getByText(/Ring membership/i)).toBeInTheDocument();
    expect(result.textContent).toMatch(/%/);
  });
});
