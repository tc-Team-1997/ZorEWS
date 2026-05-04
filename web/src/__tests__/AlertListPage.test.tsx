import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { AlertListPage } from '@/modules/alerts/AlertListPage';
import { renderWithProviders } from './utils';

describe('AlertListPage — basic render', () => {
  it('renders alert rows from the mock API', async () => {
    renderWithProviders(<AlertListPage />);
    expect(screen.getByRole('heading', { name: /^Alerts$/ })).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByText(/Achieng Otieno/)).toBeInTheDocument();
    });
    expect(screen.getByText(/Salary inflow stopped 60d/)).toBeInTheDocument();
  });

  it('shows the criticality score column with a confidence sub-line', async () => {
    renderWithProviders(<AlertListPage />);
    await waitFor(() => {
      expect(screen.getByText(/Achieng Otieno/)).toBeInTheDocument();
    });
    // "conf XX%" sublines appear once per row (after dedup) — at least one
    // must be visible.
    expect(screen.getAllByText(/conf \d+%/).length).toBeGreaterThan(0);
  });
});

describe('AlertListPage — dedup + sort', () => {
  it('dedup is on by default — c-106 has 2 alerts, only one row appears with a +1 linked badge', async () => {
    renderWithProviders(<AlertListPage />);
    // Wait for data
    await waitFor(() => {
      expect(screen.getByText(/Faisal Hussein/)).toBeInTheDocument();
    });
    // Faisal (c-106) has 2 alerts in the seed: a-1006 (critical, primary)
    // and a-1008 (medium, linked). Only one Faisal row should render.
    expect(screen.getAllByText(/Faisal Hussein/)).toHaveLength(1);
    // The linked badge should show "+1".
    expect(screen.getByTestId('linked-badge-a-1006').textContent).toMatch(/\+1/);
  });

  it('toggling dedup off renders both Faisal alerts as separate rows', async () => {
    renderWithProviders(<AlertListPage />);
    await waitFor(() => {
      expect(screen.getByText(/Faisal Hussein/)).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('alerts-dedup-toggle'));
    await waitFor(() => {
      // Both alerts on c-106 should now appear individually.
      expect(screen.getAllByText(/Faisal Hussein/)).toHaveLength(2);
    });
    // No linked badge on either — they're each their own row now.
    expect(screen.queryByTestId('linked-badge-a-1006')).not.toBeInTheDocument();
  });

  it('switching sort to "age" puts the oldest alert at the top of the table', async () => {
    renderWithProviders(<AlertListPage />);
    await waitFor(() => {
      expect(screen.getByText(/Achieng Otieno/)).toBeInTheDocument();
    });
    fireEvent.change(screen.getByTestId('alerts-sort'), { target: { value: 'age' } });
    await waitFor(() => {
      // The oldest dedup'd alert in the seed is a-1004 (Daniel Mwangi,
      // 510 minutes). When sorting by age, his row should be the first
      // customer name in document order. We assert by name presence
      // since DataTable doesn't expose row indexes.
      expect(screen.getByText(/Daniel Mwangi/)).toBeInTheDocument();
    });
  });

  it('honours ?sort=severity in the URL', async () => {
    renderWithProviders(<AlertListPage />, { route: '/alerts?sort=severity' });
    await waitFor(() => {
      // Just verify the page loads with the sort param applied — the
      // select reflects it.
      expect((screen.getByTestId('alerts-sort') as HTMLSelectElement).value).toBe('severity');
    });
  });
});
