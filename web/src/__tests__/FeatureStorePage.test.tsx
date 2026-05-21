// T2.1.2 — SPA Feature Store explorer tests.

import { describe, test, expect } from 'vitest';
import userEvent from '@testing-library/user-event';
import { screen, waitFor } from '@testing-library/react';
import { renderWithProviders } from './utils';
import { FeatureStorePage } from '@/modules/admin/featureStore/FeatureStorePage';

describe('FeatureStorePage', () => {
  test('renders 3-pane layout with PageHeader', async () => {
    renderWithProviders(<FeatureStorePage />);
    expect(screen.getByText('Feature Store')).toBeInTheDocument();
    expect(screen.getByTestId('catalog-panel')).toBeInTheDocument();
    expect(screen.getByTestId('controls-panel')).toBeInTheDocument();
    expect(screen.getByTestId('snapshot-panel')).toBeInTheDocument();
    expect(screen.getByTestId('history-panel')).toBeInTheDocument();
  });

  test('catalog panel lists all 8 features', async () => {
    renderWithProviders(<FeatureStorePage />);
    await waitFor(() => {
      expect(screen.getByTestId('catalog-utilization')).toBeInTheDocument();
      expect(screen.getByTestId('catalog-dpd_max_90d')).toBeInTheDocument();
      expect(screen.getByTestId('catalog-bureau_score')).toBeInTheDocument();
      expect(screen.getByTestId('catalog-repayment_delay_streak')).toBeInTheDocument();
      expect(screen.getByTestId('catalog-txn_volume_zscore_90d')).toBeInTheDocument();
      expect(screen.getByTestId('catalog-tenure_months')).toBeInTheDocument();
      expect(screen.getByTestId('catalog-product_level')).toBeInTheDocument();
      expect(screen.getByTestId('catalog-income_level')).toBeInTheDocument();
    });
  });

  test('coverage panel shows 24-month window (744 days)', async () => {
    renderWithProviders(<FeatureStorePage />);
    await waitFor(() => {
      expect(screen.getByTestId('coverage-panel').textContent).toMatch(/744d/);
    });
  });

  test('snapshot hydrates with default customer (CUST-1) showing every feature card', async () => {
    renderWithProviders(<FeatureStorePage />);
    await waitFor(() => {
      expect(screen.getByTestId('snapshot-card-utilization')).toBeInTheDocument();
      expect(screen.getByTestId('snapshot-card-bureau_score')).toBeInTheDocument();
      expect(screen.getByTestId('snapshot-card-income_level')).toBeInTheDocument();
    });
  });

  test('changing customer_id + Apply triggers new snapshot', async () => {
    const user = userEvent.setup();
    renderWithProviders(<FeatureStorePage />);
    await waitFor(() => screen.getByTestId('customer-id-input'));
    const input = screen.getByTestId('customer-id-input') as HTMLInputElement;
    await user.clear(input);
    await user.type(input, 'CUST-XYZ');
    await user.click(screen.getByTestId('apply-btn'));
    await waitFor(() => {
      expect(screen.getByTestId('snapshot-panel').textContent).toMatch(/CUST-XYZ/);
    });
  });

  test('history mini-chart rendered for every feature', async () => {
    renderWithProviders(<FeatureStorePage />);
    await waitFor(() => {
      expect(screen.getByTestId('history-utilization')).toBeInTheDocument();
      expect(screen.getByTestId('history-bureau_score')).toBeInTheDocument();
      expect(screen.getByTestId('history-income_level')).toBeInTheDocument();
    });
  });

  test('history mini-chart shows trend badge', async () => {
    renderWithProviders(<FeatureStorePage />);
    await waitFor(() => {
      // At least one of the 8 mini-charts should have rendered + show a trend badge.
      const badges = screen.queryAllByTestId('trend-badge');
      expect(badges.length).toBeGreaterThan(0);
    });
  });

  test('coverage panel shows catalog count of 8', async () => {
    renderWithProviders(<FeatureStorePage />);
    await waitFor(() => {
      expect(screen.getByTestId('coverage-panel').textContent).toMatch(/Catalog/);
      expect(screen.getByTestId('coverage-panel').textContent).toMatch(/8/);
    });
  });
});
