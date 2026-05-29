import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { BranchHeatmapPage } from '@/modules/banking/BranchHeatmapPage';
import { renderWithProviders } from './utils';

describe('BranchHeatmapPage — render', () => {
  it('renders the header + KPI strip + branch grid by default', async () => {
    renderWithProviders(<BranchHeatmapPage />);
    expect(screen.getByRole('heading', { name: /Branch & Geography Risk/ })).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByTestId('bh-grid')).toBeInTheDocument();
    });
    // 16 branches in the default (branch) dimension
    expect(screen.getByTestId('bh-kpi-total')).toHaveTextContent('16');
    expect(screen.getByTestId('bh-cell-BR-W-01')).toBeInTheDocument();
  });

  it('dimension toggle switches to region rollup (6 regions)', async () => {
    renderWithProviders(<BranchHeatmapPage />);
    await waitFor(() => expect(screen.getByTestId('bh-grid')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('bh-dim-region'));
    await waitFor(() => {
      expect(screen.getByTestId('bh-kpi-total')).toHaveTextContent('6');
    });
    expect(screen.getByTestId('bh-cell-West')).toBeInTheDocument();
  });

  it('renders exactly 16 branch cells in the default dimension', async () => {
    renderWithProviders(<BranchHeatmapPage />);
    await waitFor(() => expect(screen.getByTestId('bh-grid')).toBeInTheDocument());
    expect(screen.getAllByTestId(/^bh-cell-/)).toHaveLength(16);
  });
});

describe('BranchHeatmapPage — drill-through', () => {
  it('clicking a branch tile opens the summary modal with a deep-dive button', async () => {
    renderWithProviders(<BranchHeatmapPage />);
    await waitFor(() => expect(screen.getByTestId('bh-grid')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('bh-cell-BR-W-01'));
    await waitFor(() => {
      expect(screen.getByTestId('bh-open-deep-dive')).toBeInTheDocument();
    });
  });

  it('opening the deep-dive shows the NPA trend + top customers + sector mix', async () => {
    renderWithProviders(<BranchHeatmapPage />);
    await waitFor(() => expect(screen.getByTestId('bh-grid')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('bh-cell-BR-S-01'));
    await waitFor(() => expect(screen.getByTestId('bh-open-deep-dive')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('bh-open-deep-dive'));

    // wait on a data-gated element — the modal shell renders before the
    // deep-dive query resolves.
    await waitFor(() => {
      expect(screen.getByTestId('bh-npa-trend-chart')).toBeInTheDocument();
    });
    expect(screen.getByTestId('bh-top-customers')).toBeInTheDocument();
    expect(screen.getByTestId('bh-sector-mix')).toBeInTheDocument();
  });
});
