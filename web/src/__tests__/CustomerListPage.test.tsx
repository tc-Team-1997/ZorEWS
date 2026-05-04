import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { CustomerListPage } from '@/modules/customers/CustomerListPage';
import { renderWithProviders } from './utils';

describe('CustomerListPage', () => {
  it('renders the full customer list when no filters are set', async () => {
    renderWithProviders(<CustomerListPage />);
    expect(screen.getByRole('heading', { name: /^Customers$/ })).toBeInTheDocument();

    // The mock seeds 12 customer records; expect at least the highest-PD ones
    // to appear since the handler sorts by PD desc.
    await waitFor(() => {
      expect(screen.getByText('Achieng Otieno')).toBeInTheDocument();
      expect(screen.getByText('Faisal Hussein')).toBeInTheDocument();
    });
  });

  it('honours the ?level=High&pdMin=0.5 deep-link from the dashboard', async () => {
    renderWithProviders(<CustomerListPage />, {
      route: '/customers?level=High&pdMin=0.5',
    });

    // The active-filter chip surfaces the PD floor with a clear-X.
    const chip = await screen.findByTestId('active-chip-pdMin');
    expect(chip.textContent).toMatch(/PD ≥ 0\.50/);

    // Only High customers with PD ≥ 0.5 — Achieng (0.78) and Faisal (0.74)
    // qualify; Brian (0.42) does NOT.
    await waitFor(() => {
      expect(screen.getByText('Achieng Otieno')).toBeInTheDocument();
    });
    expect(screen.queryByText('Brian Kamau')).not.toBeInTheDocument();
  });

  it('clearing the active PD chip removes the filter', async () => {
    renderWithProviders(<CustomerListPage />, {
      route: '/customers?level=High&pdMin=0.5',
    });
    const chip = await screen.findByTestId('active-chip-pdMin');
    const clearBtn = within(chip).getByRole('button', { name: /clear filter/i });
    fireEvent.click(clearBtn);

    // After clearing pdMin, level=High is still applied — Brian (Medium)
    // should still be hidden, but the chip should now be gone.
    await waitFor(() => {
      expect(screen.queryByTestId('active-chip-pdMin')).not.toBeInTheDocument();
    });
  });
});
