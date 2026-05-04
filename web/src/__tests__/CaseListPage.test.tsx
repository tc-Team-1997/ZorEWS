import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { CaseListPage } from '@/modules/cases/CaseListPage';
import { renderWithProviders } from './utils';

describe('CaseListPage', () => {
  it('renders case rows from mock data', async () => {
    renderWithProviders(<CaseListPage />);
    expect(screen.getByRole('heading', { name: /^Cases$/ })).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByText(/case-501/)).toBeInTheDocument();
    });
  });

  it('honours ?state=open deep-link — only "open" cases appear', async () => {
    renderWithProviders(<CaseListPage />, { route: '/cases?state=open' });
    // case-503 is the only seeded "open" case.
    await waitFor(() => {
      expect(screen.getByText('case-503')).toBeInTheDocument();
    });
    expect(screen.queryByText('case-501')).not.toBeInTheDocument();
    expect(screen.queryByText('case-502')).not.toBeInTheDocument();
  });

  it('honours ?sla=breached,approaching deep-link from dashboard SLA card', async () => {
    renderWithProviders(<CaseListPage />, {
      route: '/cases?sla=breached,approaching',
    });
    // Mock seed: case-501 is approaching, case-503 is breached, case-502 is on_track.
    await waitFor(() => {
      expect(screen.getByText('case-501')).toBeInTheDocument();
    });
    expect(screen.getByText('case-503')).toBeInTheDocument();
    expect(screen.queryByText('case-502')).not.toBeInTheDocument();

    // The active-filter chip is visible and clearable.
    const chip = screen.getByTestId('active-chip-sla');
    expect(chip.textContent).toMatch(/SLA: breached, approaching/);

    fireEvent.click(screen.getByRole('button', { name: /clear filter/i }));
    await waitFor(() => {
      expect(screen.queryByTestId('active-chip-sla')).not.toBeInTheDocument();
      // case-502 (on_track) reappears once the SLA filter is cleared.
      expect(screen.getByText('case-502')).toBeInTheDocument();
    });
  });
});
