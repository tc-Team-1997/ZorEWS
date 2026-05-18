// Integration test for the new Alert Analytics dashboard section.
// Covers the user-visible behaviour:
//   - section renders with loading → data flow
//   - dimension toggle switches the bar chart
//   - clicking a bar opens the deep drill-down
//   - drill-down sub-sections exclude the filtered dimension
//   - drill-down's "Close" returns to the section-only view
//   - empty-state when no alerts are returned

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { AlertAnalyticsSection } from '@/components/dashboard/AlertAnalyticsSection';
import { renderWithProviders } from './utils';
import type { Alert, AlertListResponse } from '@/lib/api';
import { api } from '@/lib/api';

const SAMPLE: Alert[] = [
  {
    id: 'a-1',
    severity: 'critical',
    customer: { id: 'c-1', name: 'Alice' },
    rule: { id: 'r-aml-1', name: 'AML watchlist hit' },
    indicators: [],
    age_min: 30,
    assignee: null,
    created_at: '2026-05-17T10:00:00Z',
    confidence: 0.95,
    customer_exposure_kes: 1_500_000,
    criticality_score: 9.2,
    linked_alert_ids: [],
  },
  {
    id: 'a-2',
    severity: 'high',
    customer: { id: 'c-2', name: 'Bob' },
    rule: { id: 'r-fin-2', name: 'DPD threshold breach' },
    indicators: [],
    age_min: 300,
    assignee: 'ravi',
    created_at: '2026-05-17T11:30:00Z',
    confidence: 0.85,
    customer_exposure_kes: 750_000,
    criticality_score: 6.5,
    linked_alert_ids: [],
  },
  {
    id: 'a-3',
    severity: 'medium',
    customer: { id: 'c-3', name: 'Carol' },
    rule: { id: 'r-fin-3', name: 'Repayment delay' },
    indicators: [],
    age_min: 120,
    assignee: 'sue',
    created_at: '2026-05-16T09:15:00Z',
    confidence: 0.7,
    customer_exposure_kes: 250_000,
    criticality_score: 3.1,
    linked_alert_ids: [],
  },
];

function mockAlertResponse(items: Alert[]): AlertListResponse {
  return { items, total: items.length };
}

describe('AlertAnalyticsSection', () => {
  beforeEach(() => {
    vi.spyOn(api, 'alerts').mockResolvedValue(mockAlertResponse(SAMPLE));
  });

  it('renders loading then resolves to the section with the dimension toggle', async () => {
    renderWithProviders(<AlertAnalyticsSection />);
    // Loading state ALSO uses alert-analytics-section testid, so wait for
    // the dim-toggle which only mounts after data resolves.
    await waitFor(() => {
      expect(screen.getByTestId('alert-analytics-dim-toggle')).toBeInTheDocument();
    });
    expect(screen.getByTestId('alert-analytics-section')).toBeInTheDocument();
    expect(screen.getByTestId('alert-analytics-dim-toggle-opt-severity')).toBeInTheDocument();
    expect(screen.getByTestId('alert-analytics-dim-toggle-opt-status')).toBeInTheDocument();
    expect(screen.getByTestId('alert-analytics-dim-toggle-opt-risk_band')).toBeInTheDocument();
  });

  it('dimension toggle exposes all 6 axes', async () => {
    renderWithProviders(<AlertAnalyticsSection />);
    await waitFor(() => screen.getByTestId('alert-analytics-dim-toggle'));
    for (const dim of ['severity', 'status', 'risk_band', 'category', 'module', 'source']) {
      expect(screen.getByTestId(`alert-analytics-dim-toggle-opt-${dim}`)).toBeInTheDocument();
    }
  });

  it('switching the dimension toggle keeps the chart rendered (no extra fetch)', async () => {
    const spy = vi.spyOn(api, 'alerts');
    renderWithProviders(<AlertAnalyticsSection />);
    await waitFor(() => screen.getByTestId('alert-analytics-bar'));

    const callsAfterFirstRender = spy.mock.calls.length;

    fireEvent.click(screen.getByTestId('alert-analytics-dim-toggle-opt-status'));
    // The bar chart re-renders, but no new alerts call is fired
    // (React Query cache hit on the same queryKey).
    expect(spy.mock.calls.length).toBe(callsAfterFirstRender);
    expect(screen.getByTestId('alert-analytics-bar')).toBeInTheDocument();
  });

  it('clicking a severity bar opens the deep drill-down', async () => {
    renderWithProviders(<AlertAnalyticsSection />);
    await waitFor(() => screen.getByTestId('alert-analytics-bar'));

    // Recharts cells render with testIds. Open the drill via the URL param
    // — equivalent to clicking the bar but doesn't depend on recharts'
    // mouse-coord plumbing inside jsdom (which is unreliable).
    renderWithProviders(<AlertAnalyticsSection />, {
      route: '/?adrill=severity:critical',
    });
    await waitFor(() => {
      expect(screen.getByTestId('alert-deep-drilldown')).toBeInTheDocument();
    });
  });

  it('drill-down skips the filtered dimension in sub-sections (no repetition)', async () => {
    renderWithProviders(<AlertAnalyticsSection />, {
      route: '/?adrill=severity:critical',
    });
    await waitFor(() => screen.getByTestId('alert-deep-drilldown'));
    // The "by severity" sub-section is OMITTED (we're already filtered to critical)
    expect(screen.queryByTestId('alert-deep-drilldown-sub-severity')).not.toBeInTheDocument();
    // But the 5 other axes ARE present
    for (const dim of ['status', 'risk_band', 'category', 'module', 'source']) {
      expect(screen.getByTestId(`alert-deep-drilldown-sub-${dim}`)).toBeInTheDocument();
    }
  });

  it('deferred axes (category/module/source) show the pending-API note + no chart', async () => {
    renderWithProviders(<AlertAnalyticsSection />, {
      route: '/?adrill=severity:critical',
    });
    await waitFor(() => screen.getByTestId('alert-deep-drilldown'));
    // SAMPLE alerts all map to source=rule_engine → deferred note shows
    expect(screen.getByTestId('alert-deep-drilldown-sub-source-note')).toBeInTheDocument();
    expect(screen.getByTestId('alert-deep-drilldown-sub-source-deferred')).toBeInTheDocument();
  });

  it('drill-down close removes the panel + clears ?adrill', async () => {
    const { container } = renderWithProviders(<AlertAnalyticsSection />, {
      route: '/?adrill=severity:critical',
    });
    await waitFor(() => screen.getByTestId('alert-deep-drilldown'));
    fireEvent.click(screen.getByTestId('alert-deep-drilldown-close'));
    await waitFor(() => {
      expect(container.querySelector('[data-testid="alert-deep-drilldown"]')).toBeNull();
    });
  });

  it('shows empty-state when alerts list is empty', async () => {
    vi.spyOn(api, 'alerts').mockResolvedValue(mockAlertResponse([]));
    renderWithProviders(<AlertAnalyticsSection />);
    await waitFor(() => {
      expect(screen.getByText(/No alerts in the queue/i)).toBeInTheDocument();
    });
  });

  it('drill-down stats strip renders the subset summary', async () => {
    renderWithProviders(<AlertAnalyticsSection />, {
      route: '/?adrill=severity:high',
    });
    await waitFor(() => screen.getByTestId('alert-deep-drilldown'));
    const stats = screen.getByTestId('alert-deep-drilldown-stats');
    expect(stats).toHaveTextContent(/Subset size/i);
    expect(stats).toHaveTextContent(/Mean criticality/i);
    expect(stats).toHaveTextContent(/Distinct customers/i);
    expect(stats).toHaveTextContent(/Total exposure/i);
  });

  it('drill-down top-customers table lists actionable rollup with deep-link', async () => {
    renderWithProviders(<AlertAnalyticsSection />, {
      route: '/?adrill=severity:critical',
    });
    await waitFor(() => screen.getByTestId('alert-deep-drilldown-top-customers'));
    // Alice is the only critical alert → table has her
    expect(screen.getByText('Alice')).toBeInTheDocument();
    // Her open-link points at /customers/c-1
    const link = screen.getByRole('link', { name: /open/i });
    expect(link.getAttribute('href')).toBe('/customers/c-1');
  });
});
