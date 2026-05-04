import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RuleConfigPage } from '@/modules/rules/RuleConfigPage';
import { renderWithProviders } from './utils';

describe('RuleConfigPage', () => {
  it('renders headline KPIs + seed rules', async () => {
    renderWithProviders(<RuleConfigPage />);
    expect(screen.getByRole('heading', { name: /Rule Configuration/i })).toBeInTheDocument();
    await screen.findByTestId('rule-row-r-22');
    expect(screen.getAllByText(/Pending review/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Performing/i).length).toBeGreaterThan(0);
  });

  it('opens the first rule by default with the Overview tab active (Plain English + Visual builder visible)', async () => {
    renderWithProviders(<RuleConfigPage />);
    await screen.findByTestId('rule-row-r-22');
    // Overview tab is the default — plain-english + visual-builder live here.
    expect(await screen.findByTestId('plain-english')).toBeInTheDocument();
    expect(screen.getByTestId('visual-builder')).toBeInTheDocument();
    // Other tab panels are conditionally rendered, so they should NOT be in
    // the DOM until their tab is selected.
    expect(screen.queryByTestId('transition-actions')).not.toBeInTheDocument();
    expect(screen.queryByTestId('performance-grid')).not.toBeInTheDocument();
    expect(screen.queryByTestId('audit-trail')).not.toBeInTheDocument();
  });

  it('each tab loads its expected sub-panel when selected', async () => {
    const user = userEvent.setup();
    renderWithProviders(<RuleConfigPage />);
    await screen.findByTestId('rule-row-r-22');

    // Workflow tab → maker-checker actions
    await user.click(screen.getByTestId('detail-tab-workflow'));
    expect(await screen.findByTestId('transition-actions')).toBeInTheDocument();

    // Performance tab → live performance grid
    await user.click(screen.getByTestId('detail-tab-performance'));
    expect(await screen.findByTestId('performance-grid')).toBeInTheDocument();

    // Audit tab → audit trail
    await user.click(screen.getByTestId('detail-tab-audit'));
    expect(await screen.findByTestId('audit-trail')).toBeInTheDocument();

    // Back to Overview
    await user.click(screen.getByTestId('detail-tab-overview'));
    expect(await screen.findByTestId('plain-english')).toBeInTheDocument();
  });

  it('selecting a different row swaps the detail panel', async () => {
    const user = userEvent.setup();
    renderWithProviders(<RuleConfigPage />);
    await screen.findByTestId('rule-row-r-22');
    await user.click(screen.getByTestId('rule-row-r-14'));
    await waitFor(() => {
      expect(screen.getByTestId('plain-english')).toHaveTextContent(/Cheque returns/i);
    });
  });

  it('product filter narrows the list', async () => {
    const user = userEvent.setup();
    renderWithProviders(<RuleConfigPage />);
    await screen.findByTestId('rule-row-r-22');
    await user.selectOptions(screen.getByTestId('filter-product'), 'msme');
    await waitFor(() => {
      const list = screen.getByTestId('rule-list');
      expect(within(list).getByTestId('rule-row-r-14')).toBeInTheDocument();
      expect(within(list).queryByTestId('rule-row-r-09')).not.toBeInTheDocument();
    });
  });

  it('state filter narrows the list', async () => {
    const user = userEvent.setup();
    renderWithProviders(<RuleConfigPage />);
    await screen.findByTestId('rule-row-r-22');
    await user.selectOptions(screen.getByTestId('filter-state'), 'pending_review');
    await waitFor(() => {
      const list = screen.getByTestId('rule-list');
      expect(within(list).getByTestId('rule-row-r-14')).toBeInTheDocument();
      expect(within(list).queryByTestId('rule-row-r-22')).not.toBeInTheDocument();
    });
  });

  it('shows legal transitions for the active rule (Deprecate + Edit) on the Workflow tab', async () => {
    const user = userEvent.setup();
    renderWithProviders(<RuleConfigPage />);
    await screen.findByTestId('rule-row-r-22');
    await user.click(screen.getByTestId('detail-tab-workflow'));
    const actions = await screen.findByTestId('transition-actions');
    expect(within(actions).getByTestId('transition-deprecate')).toBeInTheDocument();
    expect(within(actions).getByTestId('transition-edit')).toBeInTheDocument();
  });

  it('Run backtest produces the result panel with metrics + chart (Backtest tab)', async () => {
    const user = userEvent.setup();
    renderWithProviders(<RuleConfigPage />);
    await screen.findByTestId('rule-row-r-22');
    await user.click(screen.getByTestId('detail-tab-backtest'));
    await user.click(await screen.findByTestId('run-backtest'));
    expect(await screen.findByTestId('backtest-result')).toBeInTheDocument();
    expect(screen.getByText(/Total alerts/i)).toBeInTheDocument();
    expect(screen.getByText(/True positives/i)).toBeInTheDocument();
  });

  it('plain-English preview reads as a sentence', async () => {
    renderWithProviders(<RuleConfigPage />);
    await screen.findByTestId('rule-row-r-22');
    const pe = await screen.findByTestId('plain-english');
    // The Panel title prefixes the textContent — assert against the inner <p>.
    const sentence = pe.querySelector('p');
    expect(sentence?.textContent ?? '').toMatch(/^If .+ then .+ risk/i);
  });
});

describe('RuleConfigPage — UX enhancements', () => {
  it('search input narrows the list by name (case-insensitive)', async () => {
    const user = userEvent.setup();
    renderWithProviders(<RuleConfigPage />);
    await screen.findByTestId('rule-row-r-22');

    await user.type(screen.getByTestId('filter-search'), 'cheque');
    await waitFor(() => {
      const list = screen.getByTestId('rule-list');
      // r-14 ("Cheque return 2x in 30d") should remain
      expect(within(list).getByTestId('rule-row-r-14')).toBeInTheDocument();
      // r-22 ("Salary inflow stopped 60d") should be gone
      expect(within(list).queryByTestId('rule-row-r-22')).not.toBeInTheDocument();
    });
  });

  it('search input also matches the rule id', async () => {
    const user = userEvent.setup();
    renderWithProviders(<RuleConfigPage />);
    await screen.findByTestId('rule-row-r-22');
    await user.type(screen.getByTestId('filter-search'), 'r-22');
    await waitFor(() => {
      const list = screen.getByTestId('rule-list');
      expect(within(list).getByTestId('rule-row-r-22')).toBeInTheDocument();
      expect(within(list).queryByTestId('rule-row-r-14')).not.toBeInTheDocument();
    });
  });

  it('clear-search button restores the unfiltered list', async () => {
    const user = userEvent.setup();
    renderWithProviders(<RuleConfigPage />);
    await screen.findByTestId('rule-row-r-22');
    await user.type(screen.getByTestId('filter-search'), 'nope-no-match');
    await screen.findByTestId('rule-list-empty');
    await user.click(screen.getByTestId('filter-search-clear'));
    await waitFor(() => {
      expect(screen.getByTestId('rule-row-r-22')).toBeInTheDocument();
    });
  });

  it('subtitle shows "X of Y" when filters are active', async () => {
    const user = userEvent.setup();
    renderWithProviders(<RuleConfigPage />);
    await screen.findByTestId('rule-row-r-22');
    await user.selectOptions(screen.getByTestId('filter-state'), 'active');
    await waitFor(() => {
      expect(screen.getByText(/of .+ rules? match/i)).toBeInTheDocument();
    });
  });

  it('empty state surfaces a Clear filters button when filters return zero', async () => {
    const user = userEvent.setup();
    renderWithProviders(<RuleConfigPage />);
    await screen.findByTestId('rule-row-r-22');
    await user.type(screen.getByTestId('filter-search'), 'zzz-no-match-zzz');
    const empty = await screen.findByTestId('rule-list-empty');
    expect(empty).toBeInTheDocument();
    await user.click(screen.getByTestId('rule-list-empty-clear'));
    await waitFor(() => {
      expect(screen.getByTestId('rule-row-r-22')).toBeInTheDocument();
    });
  });

  it('detail panel renders an ARIA tablist with all 5 tabs', async () => {
    renderWithProviders(<RuleConfigPage />);
    await screen.findByTestId('rule-row-r-22');
    const tablist = await screen.findByTestId('detail-tablist');
    expect(tablist.getAttribute('role')).toBe('tablist');
    for (const id of ['overview', 'workflow', 'backtest', 'performance', 'audit']) {
      const tab = within(tablist).getByTestId(`detail-tab-${id}`);
      expect(tab.getAttribute('role')).toBe('tab');
      // aria-selected reflects current active state — overview is the default.
      expect(tab.getAttribute('aria-selected')).toBe(id === 'overview' ? 'true' : 'false');
    }
  });

  it('?tab= URL param controls the initial active tab', async () => {
    renderWithProviders(<RuleConfigPage />, { route: '/rules?tab=audit' });
    await screen.findByTestId('rule-row-r-22');
    // Audit tab is selected → audit-trail panel is in the DOM.
    expect(await screen.findByTestId('audit-trail')).toBeInTheDocument();
    expect(screen.queryByTestId('plain-english')).not.toBeInTheDocument();
    // Tab button reflects aria-selected=true.
    expect(
      screen.getByTestId('detail-tab-audit').getAttribute('aria-selected'),
    ).toBe('true');
  });

  it('switching the open rule preserves the active tab', async () => {
    const user = userEvent.setup();
    renderWithProviders(<RuleConfigPage />);
    await screen.findByTestId('rule-row-r-22');
    // Move to Audit tab on the default rule.
    await user.click(screen.getByTestId('detail-tab-audit'));
    await screen.findByTestId('audit-trail');
    // Click a different rule — Audit tab should remain active.
    await user.click(screen.getByTestId('rule-row-r-14'));
    await waitFor(() => {
      expect(screen.getByTestId('audit-trail')).toBeInTheDocument();
    });
    expect(
      screen.getByTestId('detail-tab-audit').getAttribute('aria-selected'),
    ).toBe('true');
  });

  it('search state is URL-synced (?q=)', async () => {
    const user = userEvent.setup();
    const { container } = renderWithProviders(<RuleConfigPage />, { route: '/rules?q=salary' });
    await screen.findByTestId('rule-row-r-22');
    expect((screen.getByTestId('filter-search') as HTMLInputElement).value).toBe('salary');
    // The list should already be narrowed.
    const list = screen.getByTestId('rule-list');
    expect(within(list).getByTestId('rule-row-r-22')).toBeInTheDocument();
    expect(within(list).queryByTestId('rule-row-r-14')).not.toBeInTheDocument();
    // sanity — typing more updates the displayed value
    await user.clear(screen.getByTestId('filter-search'));
    await user.type(screen.getByTestId('filter-search'), 'cheque');
    expect((screen.getByTestId('filter-search') as HTMLInputElement).value).toBe('cheque');
    expect(container).toBeInTheDocument();
  });

  it('open rule has aria-pressed=true; others have aria-pressed=false', async () => {
    renderWithProviders(<RuleConfigPage />);
    const openRow = await screen.findByTestId('rule-row-r-22');
    expect(openRow.getAttribute('aria-pressed')).toBe('true');
    const otherRow = screen.getByTestId('rule-row-r-14');
    expect(otherRow.getAttribute('aria-pressed')).toBe('false');
  });
});
