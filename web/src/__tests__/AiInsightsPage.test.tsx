import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { AiInsightsPage } from '@/modules/ai/AiInsightsPage';
import { renderWithProviders } from './utils';

describe('AiInsightsPage — render', () => {
  it('renders header + KPI strip + a grid of reusable insight panels', async () => {
    renderWithProviders(<AiInsightsPage />);
    expect(screen.getByRole('heading', { name: /AI Insights/ })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('ai-ins-grid')).toBeInTheDocument());
    expect(screen.getByTestId('ai-ins-kpi-total')).toBeInTheDocument();
    expect(screen.getByTestId('ai-ins-kpi-critical')).toBeInTheDocument();
    // the seeded feed has ≥ 6 panels (one per catalog insight)
    expect((await screen.findAllByTestId(/^insight-panel-/)).length).toBeGreaterThanOrEqual(6);
    // every panel names its powering model
    expect(screen.getAllByText(/powered by/i).length).toBeGreaterThanOrEqual(6);
  });

  it('the top_risky_borrowers panel is present', async () => {
    renderWithProviders(<AiInsightsPage />);
    await waitFor(() => expect(screen.getByTestId('insight-panel-top_risky_borrowers')).toBeInTheDocument());
  });
});

describe('AiInsightsPage — filter + detail', () => {
  it('domain filter narrows to insurance panels', async () => {
    renderWithProviders(<AiInsightsPage />);
    await waitFor(() => expect(screen.getByTestId('ai-ins-grid')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('ai-ins-dom-insurance'));
    await waitFor(() => {
      // banking panel drops out under the insurance filter
      expect(screen.queryByTestId('insight-panel-top_risky_borrowers')).not.toBeInTheDocument();
      expect(screen.getByTestId('insight-panel-lapse_prediction_insights')).toBeInTheDocument();
    });
  });

  it('category=fraud narrows to fraud panels', async () => {
    renderWithProviders(<AiInsightsPage />);
    await waitFor(() => expect(screen.getByTestId('ai-ins-grid')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('ai-ins-cat-fraud'));
    await waitFor(() => {
      expect(screen.getByTestId('insight-panel-fraud_anomaly_highlights')).toBeInTheDocument();
      expect(screen.queryByTestId('insight-panel-lapse_prediction_insights')).not.toBeInTheDocument();
    });
  });

  it('opening a panel shows the full ranked item table', async () => {
    renderWithProviders(<AiInsightsPage />);
    fireEvent.click(await screen.findByTestId('insight-open-top_risky_borrowers'));
    await waitFor(() => expect(screen.getByTestId('ai-ins-detail-modal')).toBeInTheDocument());
    const modal = screen.getByTestId('ai-ins-detail-modal');
    await waitFor(() => expect(within(modal).getByTestId('ai-ins-item-table')).toBeInTheDocument());
    expect(within(modal).getAllByRole('row').length).toBeGreaterThan(1);
  });
});
