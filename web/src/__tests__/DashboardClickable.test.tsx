// Coverage for the two new dashboard interactions:
//  1. KPI cards are clickable links with the right href
//  2. The PD-trend time-range selector slices the chart
//
// Existing DashboardPage.test.tsx covers the static-render contract; this
// file exists separately so the legacy test stays focused on the original
// "does the page render at all" guarantee.

import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { DashboardPage } from '@/modules/dashboard/DashboardPage';
import { renderWithProviders } from './utils';

describe('Dashboard KPI cards — clickable nav', () => {
  it('all 5 cards are anchor elements with the documented hrefs', async () => {
    renderWithProviders(<DashboardPage />);
    // Wait for data so the cards are not in their loading state.
    await waitFor(() => {
      expect(screen.getByText('18,432')).toBeInTheDocument();
    });

    expect(screen.getByTestId('kpi-customers-monitored').getAttribute('href')).toBe(
      '/customers',
    );
    expect(screen.getByTestId('kpi-high-risk').getAttribute('href')).toBe(
      '/customers?level=High&pdMin=0.5',
    );
    expect(screen.getByTestId('kpi-active-alerts').getAttribute('href')).toBe('/alerts');
    // Cases-legacy retired → both cards now land in CMS Case Management.
    // casesOpen lands unfiltered (legacy state vocabulary doesn't map);
    // casesSlaBreach preserves the breach filter via ?breached=true.
    expect(screen.getByTestId('kpi-cases-open').getAttribute('href')).toBe('/cms/cases');
    expect(screen.getByTestId('kpi-sla-breaches').getAttribute('href')).toBe(
      '/cms/cases?breached=true',
    );
  });

  it('each card carries an aria-label that explains the destination', async () => {
    renderWithProviders(<DashboardPage />);
    await waitFor(() => screen.getByText('18,432'));
    expect(screen.getByTestId('kpi-high-risk').getAttribute('aria-label')).toMatch(
      /high-risk accounts/i,
    );
    // The SLA breaches aria-label contains the label and count
    expect(screen.getByTestId('kpi-sla-breaches').getAttribute('aria-label')).toMatch(
      /sla breaches/i,
    );
  });
});

describe('Dashboard time-range selector — PD trend', () => {
  it('renders 4 range buttons with 30D selected by default', async () => {
    renderWithProviders(<DashboardPage />);
    await waitFor(() => screen.getByText('18,432'));
    expect(screen.getByTestId('time-range-7d')).toBeInTheDocument();
    expect(screen.getByTestId('time-range-30d')).toBeInTheDocument();
    expect(screen.getByTestId('time-range-90d')).toBeInTheDocument();
    expect(screen.getByTestId('time-range-all')).toBeInTheDocument();
    // Default == 30d → aria-selected
    expect(screen.getByTestId('time-range-30d').getAttribute('aria-selected')).toBe('true');
    expect(screen.getByTestId('time-range-7d').getAttribute('aria-selected')).toBe('false');
  });

  it('clicking a range updates the panel title and the selected button', async () => {
    renderWithProviders(<DashboardPage />);
    await waitFor(() => screen.getByText('18,432'));

    // Default panel title shows "30 days"
    expect(screen.getByText(/Portfolio PD trend · 30 days/i)).toBeInTheDocument();

    // Click "All" — title switches, button reflects new selection
    fireEvent.click(screen.getByTestId('time-range-all'));
    await waitFor(() => {
      expect(screen.getByText(/Portfolio PD trend · all weeks/i)).toBeInTheDocument();
    });
    expect(screen.getByTestId('time-range-all').getAttribute('aria-selected')).toBe('true');
    expect(screen.getByTestId('time-range-30d').getAttribute('aria-selected')).toBe('false');

    // Click 7D — title switches again
    fireEvent.click(screen.getByTestId('time-range-7d'));
    await waitFor(() => {
      expect(screen.getByText(/Portfolio PD trend · 7 days/i)).toBeInTheDocument();
    });
  });
});
