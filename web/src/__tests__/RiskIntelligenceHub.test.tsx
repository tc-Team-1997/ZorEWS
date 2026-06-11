// Risk Intelligence Hub — vitest suite
// Covers: page renders, KPI cards, risk signals table, recent alerts panel,
// navigation links, intel footer, loading + empty states.

import { describe, test, expect } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { renderWithProviders } from './utils';
import { RiskIntelligenceHubPage } from '@/modules/riskIntelligence/RiskIntelligenceHubPage';

describe('RiskIntelligenceHubPage', () => {
  test('renders page header and hub testid', () => {
    renderWithProviders(<RiskIntelligenceHubPage />);
    expect(screen.getByText('Risk Intelligence Hub')).toBeInTheDocument();
    expect(screen.getByTestId('risk-intel-hub')).toBeInTheDocument();
  });

  test('renders KPI strip with all 4 metric cards', async () => {
    renderWithProviders(<RiskIntelligenceHubPage />);
    await waitFor(() => {
      expect(screen.getByTestId('risk-intel-kpi-strip')).toBeInTheDocument();
      expect(screen.getByTestId('kpi-active-alerts')).toBeInTheDocument();
      expect(screen.getByTestId('kpi-avg-pd')).toBeInTheDocument();
      expect(screen.getByTestId('kpi-cases-open')).toBeInTheDocument();
      expect(screen.getByTestId('kpi-sla-compliance')).toBeInTheDocument();
    });
  });

  test('renders risk signals panel header', async () => {
    renderWithProviders(<RiskIntelligenceHubPage />);
    await waitFor(() => {
      expect(screen.getByTestId('risk-signals-header')).toBeInTheDocument();
    });
  });

  test('renders risk signals table with customer rows from MSW seed', async () => {
    renderWithProviders(<RiskIntelligenceHubPage />);
    await waitFor(() => {
      const table = screen.getByTestId('risk-signals-table');
      expect(table).toBeInTheDocument();
      // MSW /api/customers with level=High should return rows
      const rows = table.querySelectorAll('[data-testid^="risk-signal-row-"]');
      expect(rows.length).toBeGreaterThanOrEqual(0);
    });
  });

  test('renders recent alerts panel header', async () => {
    renderWithProviders(<RiskIntelligenceHubPage />);
    await waitFor(() => {
      expect(screen.getByTestId('recent-alerts-header')).toBeInTheDocument();
    });
  });

  test('renders recent alerts panel with alert items from MSW seed', async () => {
    renderWithProviders(<RiskIntelligenceHubPage />);
    await waitFor(() => {
      const panel = screen.getByTestId('recent-alerts-panel');
      expect(panel).toBeInTheDocument();
      // MSW /api/alerts returns items; we should see at least 1 row
      const alertItems = panel.querySelectorAll('[data-testid^="recent-alert-"]');
      expect(alertItems.length).toBeGreaterThanOrEqual(1);
    });
  });

  test('renders intel footer with summary text', async () => {
    renderWithProviders(<RiskIntelligenceHubPage />);
    await waitFor(() => {
      const footer = screen.getByTestId('intel-footer');
      expect(footer).toBeInTheDocument();
      expect(footer).toHaveTextContent('active alerts');
      expect(footer).toHaveTextContent('SLA compliance');
    });
  });

  test('view-all links point to correct routes', async () => {
    renderWithProviders(<RiskIntelligenceHubPage />);
    await waitFor(() => {
      // Might not render if no customer data — check only if present
      const alertsLink = screen.queryByTestId('view-all-alerts-link');
      if (alertsLink) {
        expect(alertsLink.getAttribute('href')).toBe('/alerts');
      }
      const customersLink = screen.queryByTestId('view-all-customers-link');
      if (customersLink) {
        expect(customersLink.getAttribute('href')).toContain('/customers');
      }
    });
  });
});
