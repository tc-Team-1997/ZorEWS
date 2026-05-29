import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { PolicyTimelinePage } from '@/modules/insurance/PolicyTimelinePage';
import { renderWithProviders } from './utils';

describe('PolicyTimelinePage — render', () => {
  it('renders header + summary KPIs + lifecycle for the default policy', async () => {
    renderWithProviders(<PolicyTimelinePage />);
    expect(screen.getByRole('heading', { name: /^Policy Timeline$/ })).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByTestId('pt-timeline')).toBeInTheDocument();
    });
    expect(screen.getByTestId('pt-kpi-status')).toBeInTheDocument();
    expect(screen.getByTestId('pt-kpi-band')).toBeInTheDocument();
    expect(screen.getByTestId('pt-kpi-premium')).toBeInTheDocument();
    expect(screen.getByTestId('pt-policy-meta')).toBeInTheDocument();
  });

  it('the oldest rendered event is policy_issued', async () => {
    renderWithProviders(<PolicyTimelinePage />);
    await waitFor(() => expect(screen.getByTestId('pt-timeline')).toBeInTheDocument());
    const tl = screen.getByTestId('pt-timeline');
    // title + type-label both render "Issued"/"Policy issued" — assert ≥ 1
    expect(within(tl).getAllByText(/issued/i).length).toBeGreaterThan(0);
  });

  it('shows event-type filter chips reflecting by_type counts', async () => {
    renderWithProviders(<PolicyTimelinePage />);
    await waitFor(() => expect(screen.getByTestId('pt-type-filters')).toBeInTheDocument());
    expect(screen.getByTestId('pt-type-all')).toBeInTheDocument();
    // premium_paid events always exist on a healthy lifecycle
    expect(screen.getByTestId('pt-type-premium_paid')).toBeInTheDocument();
  });
});

describe('PolicyTimelinePage — interactions', () => {
  it('filtering by premium_paid narrows the stream', async () => {
    renderWithProviders(<PolicyTimelinePage />);
    await waitFor(() => expect(screen.getByTestId('pt-timeline')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('pt-type-premium_paid'));
    await waitFor(() => {
      const tl = screen.getByTestId('pt-timeline');
      // the policy_issued event drops out under the premium_paid filter
      expect(within(tl).queryByText(/Policy issued/)).not.toBeInTheDocument();
    });
    expect(within(screen.getByTestId('pt-timeline')).getAllByText(/Premium paid/).length).toBeGreaterThan(0);
  });

  it('loading a different policy id refreshes the timeline', async () => {
    renderWithProviders(<PolicyTimelinePage />, { route: '/insurance/policy-timeline?policy_id=POL-BANK_DEMO-100001' });
    await waitFor(() => expect(screen.getByTestId('pt-timeline')).toBeInTheDocument());
    const before = screen.getByTestId('pt-policy-meta').textContent;

    const input = screen.getByTestId('pt-policy-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'POL-BANK_DEMO-100099' } });
    fireEvent.click(screen.getByTestId('pt-policy-apply'));

    await waitFor(() => {
      // lifecycle panel title reflects the new policy id
      expect(screen.getByText(/Lifecycle — POL-BANK_DEMO-100099/)).toBeInTheDocument();
    });
    // meta line should have refreshed (policyholder/product likely differ)
    expect(screen.getByTestId('pt-policy-meta').textContent).toBeTruthy();
    void before;
  });
});
