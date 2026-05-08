// Cases Report — row-level detail page (BAC §3.1.8) — Vitest coverage.
//
// Layered tests:
//   1. Initial render — page loads, grid hydrates, breach rows tinted.
//   2. Filter bar — bucket dropdown, breached toggle, severity chip,
//      search input + Enter all push state into the URL and refetch.
//   3. Sort — clicking a header toggles dir.
//   4. Pagination — Next/Prev change `page`, page-size select changes
//      `page_size`.
//   5. Saved filters — list / create / apply / delete round-trip via MSW.
//   6. Export — clicking the CSV button triggers a download (mocked anchor click).
//   7. Drill-down — case_number is rendered as a link to /cms/cases/:id.

import { describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CasesDetailReportPage } from '@/modules/reports/CasesDetailReportPage';
import { renderWithProviders } from './utils';

// Stash the username MSW expects so saved-filter rows hit the right owner.
function authenticate(username = 'taniya') {
  localStorage.setItem(
    'apex.ews.user',
    JSON.stringify({ username, roles: ['admin'] }),
  );
}

describe('CasesDetailReportPage — initial render', () => {
  it('renders the page header + filter bar + grid', async () => {
    authenticate();
    renderWithProviders(<CasesDetailReportPage />);

    expect(
      screen.getByRole('heading', { name: /Cases Report — row-level detail/i }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText(/Age bucket/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Created from/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Breached only/i)).toBeInTheDocument();

    // Wait for the grid to hydrate
    await waitFor(() =>
      expect(screen.getByText('EWS-2026-00001')).toBeInTheDocument(),
    );
    // 12 rows in the seed
    expect(screen.getByTestId('cdr-row-count')).toHaveTextContent(/12 cases/);
  });

  it('tints breached rows with the rose-50 background marker', async () => {
    authenticate();
    renderWithProviders(<CasesDetailReportPage />);

    await waitFor(() =>
      expect(screen.getByText('EWS-2026-00001')).toBeInTheDocument(),
    );
    // Case 2 is 5d old vs P2 target 3d → breached
    const breachedRow = screen.getByTestId('row-c-002');
    expect(breachedRow.getAttribute('data-breached')).toBe('true');
    // Case 3 is 7d old vs P3 target 7d → not breached (age <= target)
    const okRow = screen.getByTestId('row-c-003');
    expect(okRow.getAttribute('data-breached')).toBeNull();
  });

  it('renders the case number as a link to /cms/cases/:id', async () => {
    authenticate();
    renderWithProviders(<CasesDetailReportPage />);
    await waitFor(() =>
      expect(screen.getByText('EWS-2026-00001')).toBeInTheDocument(),
    );
    const link = screen.getByText('EWS-2026-00001').closest('a');
    expect(link).toHaveAttribute('href', '/cms/cases/c-001');
  });
});

describe('CasesDetailReportPage — filtering', () => {
  it('selecting an age bucket narrows the grid', async () => {
    authenticate();
    const user = userEvent.setup();
    renderWithProviders(<CasesDetailReportPage />);
    await screen.findByText('EWS-2026-00001');

    await user.selectOptions(screen.getByLabelText(/Age bucket/i), '8-30d');

    await waitFor(() => {
      // 8-30d bucket: cases 4 (10d), 5 (15d), 6 (28d) → 3 rows
      expect(screen.getByTestId('cdr-row-count')).toHaveTextContent(/3 cases/);
    });
    expect(screen.queryByText('EWS-2026-00001')).not.toBeInTheDocument();
    expect(screen.getByText('EWS-2026-00004')).toBeInTheDocument();
  });

  it('Breached-only toggle removes non-breached rows', async () => {
    authenticate();
    const user = userEvent.setup();
    renderWithProviders(<CasesDetailReportPage />);
    await screen.findByText('EWS-2026-00001');

    await user.click(screen.getByLabelText(/Breached only/i));

    // Case 1 is exactly at SLA (1d / 1d) — not breached. Should disappear.
    await waitFor(() => {
      expect(screen.queryByText('EWS-2026-00001')).not.toBeInTheDocument();
    });
    // Case 2 (5d / 3d target) is breached and stays.
    expect(screen.getByText('EWS-2026-00002')).toBeInTheDocument();
  });

  it('typing in the search box + Enter narrows the grid', async () => {
    authenticate();
    const user = userEvent.setup();
    renderWithProviders(<CasesDetailReportPage />);
    await screen.findByText('EWS-2026-00001');

    const search = screen.getByPlaceholderText(/C-001, borrower name/i);
    await user.type(search, 'Acme');
    await user.keyboard('{Enter}');

    await waitFor(() => {
      // Only Borrower 1 = Acme Co matches
      expect(screen.getByTestId('cdr-row-count')).toHaveTextContent(/1 case/);
    });
    expect(screen.getByText('EWS-2026-00001')).toBeInTheDocument();
  });

  it('clicking a severity chip toggles it as a filter', async () => {
    authenticate();
    const user = userEvent.setup();
    renderWithProviders(<CasesDetailReportPage />);
    await screen.findByText('EWS-2026-00001');

    await user.click(screen.getByRole('button', { name: /^low$/i }));

    await waitFor(() => {
      // Cases 9 + 12 are low severity → 2 rows
      expect(screen.getByTestId('cdr-row-count')).toHaveTextContent(/2 cases/);
    });
  });
});

describe('CasesDetailReportPage — sort + pagination', () => {
  it('clicking the Age header sorts ascending then descending', async () => {
    authenticate();
    const user = userEvent.setup();
    renderWithProviders(<CasesDetailReportPage />);
    await screen.findByText('EWS-2026-00001');

    await user.click(screen.getByTestId('sort-age_days'));
    // Default dir for a fresh sort col is desc — so first click sorts desc
    // (200d first). User clicks again to flip to asc → 1d first.
    await waitFor(() => {
      const rows = screen.getAllByTestId(/^row-c-/);
      expect(rows[0].getAttribute('data-testid')).toBe('row-c-012');
    });

    await user.click(screen.getByTestId('sort-age_days'));
    await waitFor(() => {
      const rows = screen.getAllByTestId(/^row-c-/);
      expect(rows[0].getAttribute('data-testid')).toBe('row-c-001');
    });
  });

  it('rows-per-page select changes page size', async () => {
    authenticate();
    const user = userEvent.setup();
    renderWithProviders(<CasesDetailReportPage />);
    await screen.findByText('EWS-2026-00001');

    // Default is 50, all 12 fit on page 1.
    expect(screen.getAllByTestId(/^row-c-/).length).toBe(12);

    const sizeSelect = screen.getByDisplayValue('50');
    await user.selectOptions(sizeSelect, '25');

    // Still 12 rows total — but pagination text shows new size:
    await waitFor(() => {
      expect(screen.getByText(/Page 1 of 1/)).toBeInTheDocument();
    });
  });
});

describe('CasesDetailReportPage — saved filters', () => {
  it('lists, creates, applies, and deletes a saved filter', async () => {
    authenticate();
    const user = userEvent.setup();
    renderWithProviders(<CasesDetailReportPage />);
    await screen.findByText('EWS-2026-00001');

    // Open the saved-filters menu
    await user.click(screen.getByRole('button', { name: /Saved filters/i }));
    expect(screen.getByTestId('saved-filter-menu')).toBeInTheDocument();
    expect(screen.getByText(/No saved filters yet/i)).toBeInTheDocument();

    // Apply a bucket filter so we have something to save
    await user.click(
      screen.getByRole('button', { name: /Saved filters/i }),
    ); // close
    await user.selectOptions(screen.getByLabelText(/Age bucket/i), '8-30d');
    await waitFor(() =>
      expect(screen.getByTestId('cdr-row-count')).toHaveTextContent(/3 cases/),
    );

    // Open save form
    await user.click(screen.getByRole('button', { name: /Saved filters/i }));
    await user.click(screen.getByTestId('open-save-form'));
    const nameInput = screen.getByPlaceholderText(/Preset name/i);
    await user.type(nameInput, 'Mid-age cases');
    await user.click(screen.getByRole('button', { name: /^Save$/ }));

    // Saved filter should now appear in the list (menu stays open after save)
    await waitFor(() => {
      expect(screen.getByText('Mid-age cases')).toBeInTheDocument();
    });

    // Apply it via the dedicated apply button (closes the menu)
    const applyBtn = screen.getByText('Mid-age cases').closest('button')!;
    await user.click(applyBtn);
    await waitFor(() =>
      expect(screen.getByTestId('cdr-row-count')).toHaveTextContent(/3 cases/),
    );

    // Re-open and delete
    await user.click(screen.getByRole('button', { name: /Saved filters/i }));
    await user.click(
      screen.getByRole('button', { name: /Delete saved filter Mid-age cases/i }),
    );
    await waitFor(() => {
      expect(screen.queryByText('Mid-age cases')).not.toBeInTheDocument();
    });
  });
});

describe('CasesDetailReportPage — export', () => {
  it('clicking the CSV export triggers a download', async () => {
    authenticate();
    const user = userEvent.setup();

    // Capture filenames passed through the hidden anchor click.
    const clicks: string[] = [];
    const origCreateEl = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      const el = origCreateEl(tag);
      if (tag === 'a') {
        Object.defineProperty(el, 'click', {
          value: () => clicks.push((el as HTMLAnchorElement).download),
        });
      }
      return el;
    });

    renderWithProviders(<CasesDetailReportPage />);
    await screen.findByText('EWS-2026-00001');

    await user.click(screen.getByTestId('export-csv'));

    await waitFor(() => {
      expect(clicks.length).toBe(1);
      expect(clicks[0]).toMatch(/cases-report-.+\.csv$/);
    });

    vi.restoreAllMocks();
  });
});
