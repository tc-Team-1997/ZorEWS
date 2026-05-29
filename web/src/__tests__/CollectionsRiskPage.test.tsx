import { describe, expect, it, afterEach } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CollectionsRiskPage } from '@/modules/banking/CollectionsRiskPage';
import { renderWithProviders } from './utils';
import { __resetMswCollections } from '@/mocks/handlers';

afterEach(() => __resetMswCollections());

describe('CollectionsRiskPage — render', () => {
  it('renders the page header + KPI strip from the mock summary', async () => {
    renderWithProviders(<CollectionsRiskPage />);
    expect(screen.getByRole('heading', { name: /^Collections Risk$/ })).toBeInTheDocument();
    await waitFor(() => {
      // 7 seed accounts in the MSW book
      expect(screen.getByTestId('coll-kpi-accounts')).toHaveTextContent('7');
    });
    expect(screen.getByTestId('coll-kpi-overdue')).toBeInTheDocument();
    expect(screen.getByTestId('coll-kpi-expected')).toBeInTheDocument();
    expect(screen.getByTestId('coll-kpi-rate')).toBeInTheDocument();
  });

  it('renders the DPD funnel with all 4 buckets', async () => {
    renderWithProviders(<CollectionsRiskPage />);
    await waitFor(() => {
      expect(screen.getByTestId('coll-dpd-dpd_90_plus')).toBeInTheDocument();
    });
    expect(screen.getByTestId('coll-dpd-dpd_1_30')).toBeInTheDocument();
    expect(screen.getByTestId('coll-dpd-dpd_31_60')).toBeInTheDocument();
    expect(screen.getByTestId('coll-dpd-dpd_61_90')).toBeInTheDocument();
  });

  it('renders the work-queue priority-sorted (worst-first row carries the deepest arrears)', async () => {
    renderWithProviders(<CollectionsRiskPage />);
    await waitFor(() => {
      expect(screen.getByTestId('coll-queue-table')).toBeInTheDocument();
    });
    // Rajesh Kumar (212 DPD, 52.3M overdue, 14% recovery) has the highest
    // exposure-at-risk → first row.
    const rows = screen.getAllByTestId(/^coll-row-/);
    expect(within(rows[0]).getByText(/Rajesh Kumar/)).toBeInTheDocument();
  });
});

describe('CollectionsRiskPage — filters', () => {
  it('DPD bucket tile narrows the queue to that bucket', async () => {
    renderWithProviders(<CollectionsRiskPage />);
    await waitFor(() => expect(screen.getByTestId('coll-queue-table')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('coll-dpd-dpd_1_30'));
    await waitFor(() => {
      // Vikram Patel (19 DPD) + Kavya Reddy (9 DPD) are the only 1–30 accounts
      expect(screen.getByText(/Vikram Patel/)).toBeInTheDocument();
    });
    expect(screen.queryByText(/Rajesh Kumar/)).not.toBeInTheDocument();
  });

  it('stage chip narrows the queue', async () => {
    renderWithProviders(<CollectionsRiskPage />);
    await waitFor(() => expect(screen.getByTestId('coll-queue-table')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('coll-stage-legal_notice'));
    await waitFor(() => {
      // Rajesh Kumar + Arjun Iyer carry legal_notice
      expect(screen.getByText(/Rajesh Kumar/)).toBeInTheDocument();
    });
    expect(screen.queryByText(/Kavya Reddy/)).not.toBeInTheDocument();
  });
});

describe('CollectionsRiskPage — account detail + actions', () => {
  it('clicking a row opens the account 360 modal with recovery factors + histories', async () => {
    renderWithProviders(<CollectionsRiskPage />);
    await waitFor(() => expect(screen.getByTestId('coll-queue-table')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('coll-row-acc-bd-700000'));
    // wait on a data-gated element — the modal shell renders before the
    // detail query resolves.
    await waitFor(() => {
      expect(screen.getByTestId('coll-factors')).toBeInTheDocument();
    });
    expect(screen.getByTestId('coll-ptp-history')).toBeInTheDocument();
    expect(screen.getByTestId('coll-contact-history')).toBeInTheDocument();
  });

  it('records a promise-to-pay that surfaces in the PTP history', async () => {
    const user = userEvent.setup();
    renderWithProviders(<CollectionsRiskPage />);
    await waitFor(() => expect(screen.getByTestId('coll-queue-table')).toBeInTheDocument());

    // open an account with no prior PTP (Mohan Singh, ptp_status none)
    fireEvent.click(screen.getByTestId('coll-row-acc-bd-700002'));
    await waitFor(() => expect(screen.getByTestId('coll-action-ptp')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('coll-action-ptp'));
    await waitFor(() => expect(screen.getByTestId('coll-ptp-form')).toBeInTheDocument());

    fireEvent.change(screen.getByTestId('coll-ptp-amount'), { target: { value: '3000000' } });
    fireEvent.change(screen.getByTestId('coll-ptp-date'), { target: { value: '2026-06-15' } });
    await user.click(screen.getByTestId('coll-ptp-submit'));

    await waitFor(() => {
      const hist = screen.getByTestId('coll-ptp-history');
      expect(within(hist).getByText(/2026-06-15/)).toBeInTheDocument();
    });
  });

  it('logs a contact attempt that surfaces in the contact history', async () => {
    renderWithProviders(<CollectionsRiskPage />);
    await waitFor(() => expect(screen.getByTestId('coll-queue-table')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('coll-row-acc-bd-700005')); // Kavya — 0 prior contacts
    await waitFor(() => expect(screen.getByTestId('coll-action-contact')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('coll-action-contact'));
    await waitFor(() => expect(screen.getByTestId('coll-contact-form')).toBeInTheDocument());

    fireEvent.change(screen.getByTestId('coll-contact-channel'), { target: { value: 'call' } });
    fireEvent.change(screen.getByTestId('coll-contact-outcome'), { target: { value: 'promised_payment' } });
    fireEvent.click(screen.getByTestId('coll-contact-submit'));

    await waitFor(() => {
      const hist = screen.getByTestId('coll-contact-history');
      expect(within(hist).getByText(/promised_payment/)).toBeInTheDocument();
    });
  });
});
