import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { DriftMonitoringPage } from '@/modules/ai/DriftMonitoringPage';
import { renderWithProviders } from './utils';

describe('DriftMonitoringPage — render', () => {
  it('renders header + 4 status KPIs + monitored-models table', async () => {
    renderWithProviders(<DriftMonitoringPage />);
    expect(screen.getByRole('heading', { name: /Drift Detection/ })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('drift-table')).toBeInTheDocument());
    expect(screen.getByTestId('drift-kpi-total')).toBeInTheDocument();
    expect(screen.getByTestId('drift-kpi-stable')).toBeInTheDocument();
    expect(screen.getByTestId('drift-kpi-warn')).toBeInTheDocument();
    expect(screen.getByTestId('drift-kpi-drift')).toBeInTheDocument();
    // the seeded monitored fleet has ≥ 5 models
    expect((await screen.findAllByTestId(/^drift-row-/)).length).toBeGreaterThanOrEqual(5);
  });

  it('the pd model row is present', async () => {
    renderWithProviders(<DriftMonitoringPage />);
    await waitFor(() => expect(screen.getByTestId('drift-row-pd_xgb_v3')).toBeInTheDocument());
  });
});

describe('DriftMonitoringPage — detail + recompute', () => {
  it('opening a model shows the KS/perf/anomaly blocks + per-feature PSI table', async () => {
    renderWithProviders(<DriftMonitoringPage />);
    fireEvent.click(await screen.findByTestId('drift-row-pd_xgb_v3'));
    await waitFor(() => expect(screen.getByTestId('drift-detail-modal')).toBeInTheDocument());
    const modal = screen.getByTestId('drift-detail-modal');
    await waitFor(() => expect(within(modal).getByTestId('drift-feature-table')).toBeInTheDocument());
    expect(within(modal).getByTestId('drift-ks')).toBeInTheDocument();
    expect(within(modal).getByTestId('drift-perf')).toBeInTheDocument();
    expect(within(modal).getByTestId('drift-anomaly')).toBeInTheDocument();
  });

  it('recompute keeps the detail modal alive (fresh snapshot loads)', async () => {
    renderWithProviders(<DriftMonitoringPage />);
    fireEvent.click(await screen.findByTestId('drift-row-pd_xgb_v3'));
    await waitFor(() => expect(screen.getByTestId('drift-feature-table')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('drift-recompute'));
    await waitFor(() => {
      expect(within(screen.getByTestId('drift-detail-modal')).getByTestId('drift-feature-table')).toBeInTheDocument();
    });
  });
});
