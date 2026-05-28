// Insurance EWS Module 5 — Persistency Watch page tests.

import { describe, test, expect } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from './utils';
import { PersistencyWatchPage } from '@/modules/insurance/PersistencyWatchPage';

describe('PersistencyWatchPage', () => {
  test('renders header + KPI row + dashboard body', async () => {
    renderWithProviders(<PersistencyWatchPage />);
    expect(screen.getByText('Persistency Watch')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByTestId('persistency-dashboard')).toBeInTheDocument();
    });
    expect(screen.getByText('13-month persistency')).toBeInTheDocument();
    expect(screen.getByText('61-month persistency')).toBeInTheDocument();
  });

  test('renders the 4 widgets', async () => {
    renderWithProviders(<PersistencyWatchPage />);
    await screen.findByTestId('persistency-dashboard');
    expect(screen.getByText(/Persistency trend/i)).toBeInTheDocument();
    expect(screen.getByTestId('product-retention')).toBeInTheDocument();
    expect(screen.getByTestId('channel-risk')).toBeInTheDocument();
    expect(screen.getByTestId('location-persistency')).toBeInTheDocument();
  });

  test('analyze modal opens, runs, shows band + root causes', async () => {
    const user = userEvent.setup();
    renderWithProviders(<PersistencyWatchPage />);
    await screen.findByTestId('persistency-dashboard');

    await user.click(screen.getByTestId('persistency-analyze-open'));
    expect(await screen.findByTestId('persistency-analyze-modal')).toBeInTheDocument();

    await user.click(screen.getByTestId('persistency-analyze-run'));
    const result = await screen.findByTestId('persistency-analyze-result');
    expect(result.textContent).toMatch(/Root causes/i);
    expect(result.textContent).toMatch(/%/);
  });
});
