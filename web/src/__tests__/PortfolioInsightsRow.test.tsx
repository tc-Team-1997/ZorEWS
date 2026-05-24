// web/src/__tests__/PortfolioInsightsRow.test.tsx
//
// G3 — Dashboard portfolio-insights row (Monday Playbook H2 widgets).

import { describe, it, expect } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PortfolioInsightsRow } from '@/modules/dashboard/PortfolioInsightsRow';

function renderRow() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <PortfolioInsightsRow />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('PortfolioInsightsRow', () => {
  it('renders all 3 panels', async () => {
    renderRow();
    expect(screen.getByTestId('portfolio-insights-row')).toBeInTheDocument();
    expect(screen.getByTestId('dashboard-sector-heatmap')).toBeInTheDocument();
    expect(screen.getByTestId('dashboard-ai-confidence')).toBeInTheDocument();
    expect(screen.getByTestId('dashboard-dq-by-source')).toBeInTheDocument();
  });

  it('sector heatmap shows top sectors + bucket chips', async () => {
    renderRow();
    await waitFor(() => {
      expect(screen.getByTestId('heatmap-cells')).toBeInTheDocument();
      // 5 sectors in MSW seed → all rendered (≤6 cap)
      expect(screen.getByTestId('heatmap-cell-Power')).toBeInTheDocument();
      expect(screen.getByTestId('heatmap-cell-Real_Estate')).toBeInTheDocument();
      expect(screen.getByTestId('heatmap-bucket-critical')).toBeInTheDocument();
    });
  });

  it('AI confidence card shows production AUC + SLO verdict', async () => {
    renderRow();
    await waitFor(() => {
      expect(screen.getByTestId('ai-confidence-auc')).toBeInTheDocument();
      // 0.847 from MSW seed is above 0.78 SLO → 'within SLA' text
      expect(screen.getByText('within SLA')).toBeInTheDocument();
    });
  });

  it('DQ-by-source shows 4 status cells + attention list', async () => {
    renderRow();
    await waitFor(() => {
      expect(screen.getByTestId('dq-status-healthy')).toBeInTheDocument();
      expect(screen.getByTestId('dq-status-degraded')).toBeInTheDocument();
      expect(screen.getByTestId('dq-status-failing')).toBeInTheDocument();
      expect(screen.getByTestId('dq-status-paused')).toBeInTheDocument();
      expect(screen.getByTestId('dq-attention-list')).toBeInTheDocument();
      // Agent Productivity is the seeded degraded connector
      expect(screen.getByText('Agent Productivity')).toBeInTheDocument();
    });
  });
});
