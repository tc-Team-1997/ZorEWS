import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { InsuranceHeatmapPage } from '@/modules/insurance/InsuranceHeatmapPage';
import { renderWithProviders } from './utils';

describe('InsuranceHeatmapPage — render', () => {
  it('renders header + metric selector + dimension toggle + default branch grid', async () => {
    renderWithProviders(<InsuranceHeatmapPage />);
    expect(screen.getByRole('heading', { name: /^Insurance Heatmaps$/ })).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByTestId('ih-grid')).toBeInTheDocument();
    });
    // 12 insurance branches in the default (fraud / branch) view
    expect(screen.getByTestId('ih-kpi-total')).toHaveTextContent('12');
    expect(screen.getByTestId('ih-cell-IB-W-01')).toBeInTheDocument();
  });

  it('metric selector exposes all 5 metrics', async () => {
    renderWithProviders(<InsuranceHeatmapPage />);
    // metric buttons are catalog-data-gated — wait on one before asserting all
    await waitFor(() => expect(screen.getByTestId('ih-metric-fraud')).toBeInTheDocument());
    for (const m of ['fraud', 'lapse_risk', 'channel_risk', 'solvency_stress', 'persistency_weakness']) {
      expect(screen.getByTestId(`ih-metric-${m}`)).toBeInTheDocument();
    }
  });

  it('dimension toggle has branch/region/channel', async () => {
    renderWithProviders(<InsuranceHeatmapPage />);
    await waitFor(() => expect(screen.getByTestId('ih-dimension-toggle')).toBeInTheDocument());
    expect(screen.getByTestId('ih-dim-branch')).toBeInTheDocument();
    expect(screen.getByTestId('ih-dim-region')).toBeInTheDocument();
    expect(screen.getByTestId('ih-dim-channel')).toBeInTheDocument();
  });
});

describe('InsuranceHeatmapPage — interactions', () => {
  it('switching to channel dimension shows 5 channel cells', async () => {
    renderWithProviders(<InsuranceHeatmapPage />);
    await waitFor(() => expect(screen.getByTestId('ih-grid')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('ih-dim-channel'));
    await waitFor(() => {
      expect(screen.getByTestId('ih-kpi-total')).toHaveTextContent('5');
    });
    expect(screen.getByTestId('ih-cell-Agency')).toBeInTheDocument();
    expect(screen.getByTestId('ih-cell-Bancassurance')).toBeInTheDocument();
  });

  it('selecting persistency_weakness jumps to its natural (channel) dimension', async () => {
    renderWithProviders(<InsuranceHeatmapPage />);
    await waitFor(() => expect(screen.getByTestId('ih-grid')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('ih-metric-persistency_weakness'));
    await waitFor(() => {
      // natural dimension for persistency is channel → 5 cells
      expect(screen.getByTestId('ih-kpi-total')).toHaveTextContent('5');
    });
    expect(screen.getByTestId('ih-cell-Agency')).toBeInTheDocument();
  });

  it('selecting region dimension shows 6 region cells', async () => {
    renderWithProviders(<InsuranceHeatmapPage />);
    await waitFor(() => expect(screen.getByTestId('ih-grid')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('ih-dim-region'));
    await waitFor(() => {
      expect(screen.getByTestId('ih-kpi-total')).toHaveTextContent('6');
    });
    expect(screen.getByTestId('ih-cell-West')).toBeInTheDocument();
  });
});
