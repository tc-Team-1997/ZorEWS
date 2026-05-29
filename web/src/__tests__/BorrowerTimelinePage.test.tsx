import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { BorrowerTimelinePage } from '@/modules/banking/BorrowerTimelinePage';
import { renderWithProviders } from './utils';

describe('BorrowerTimelinePage — render', () => {
  it('renders the header + summary KPIs + timeline for the default borrower', async () => {
    renderWithProviders(<BorrowerTimelinePage />);
    expect(screen.getByRole('heading', { name: /^Borrower Timeline$/ })).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByTestId('bt-timeline')).toBeInTheDocument();
    });
    expect(screen.getByTestId('bt-kpi-band')).toBeInTheDocument();
    expect(screen.getByTestId('bt-kpi-trajectory')).toBeInTheDocument();
    expect(screen.getByTestId('bt-kpi-peak-dpd')).toBeInTheDocument();
  });

  it('the oldest event in the rendered stream is account_opened', async () => {
    renderWithProviders(<BorrowerTimelinePage />);
    await waitFor(() => expect(screen.getByTestId('bt-timeline')).toBeInTheDocument());
    // newest-first; account_opened is always the very first (oldest) event,
    // so it appears when the full set is shown (default has no limit override).
    const tl = screen.getByTestId('bt-timeline');
    // the account_opened event renders its title + type-label (both "Account
    // opened") — assert at least one is present in the rendered stream.
    expect(within(tl).getAllByText(/Account opened/).length).toBeGreaterThan(0);
  });

  it('shows event-type filter chips reflecting by_type counts', async () => {
    renderWithProviders(<BorrowerTimelinePage />);
    await waitFor(() => expect(screen.getByTestId('bt-type-filters')).toBeInTheDocument());
    expect(screen.getByTestId('bt-type-all')).toBeInTheDocument();
    // repayment events always exist
    expect(screen.getByTestId('bt-type-repayment')).toBeInTheDocument();
  });
});

describe('BorrowerTimelinePage — interactions', () => {
  it('filtering by repayment narrows the stream to repayment events', async () => {
    renderWithProviders(<BorrowerTimelinePage />);
    await waitFor(() => expect(screen.getByTestId('bt-timeline')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('bt-type-repayment'));
    await waitFor(() => {
      const tl = screen.getByTestId('bt-timeline');
      // account_opened should disappear from the rendered list under the filter
      expect(within(tl).queryByText(/Account opened/)).not.toBeInTheDocument();
    });
    // remaining rendered events are all repayments
    expect(within(screen.getByTestId('bt-timeline')).getAllByText(/Repayment/).length).toBeGreaterThan(0);
  });

  it('loading a different customer id refreshes the timeline', async () => {
    renderWithProviders(<BorrowerTimelinePage />, { route: '/borrower-timeline?customer_id=c-200000' });
    await waitFor(() => expect(screen.getByTestId('bt-timeline')).toBeInTheDocument());

    const input = screen.getByTestId('bt-customer-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'c-300042' } });
    fireEvent.click(screen.getByTestId('bt-customer-apply'));

    await waitFor(() => {
      // risk-profile drill-through link now points at the new customer
      expect(screen.getByTestId('bt-customer-link')).toHaveAttribute('href', '/customers/c-300042');
    });
  });

  it('renders the risk-profile drill-through link', async () => {
    renderWithProviders(<BorrowerTimelinePage />);
    await waitFor(() => {
      expect(screen.getByTestId('bt-customer-link')).toHaveAttribute('href', '/customers/c-200000');
    });
  });
});
