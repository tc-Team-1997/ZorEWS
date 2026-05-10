// Coverage for /admin/escalation-matrix (T6 M14.20):
//   - Seeded list renders with priority + chain rendering (L1/L2/L3)
//   - Status pivot + priority filter + search narrow the list
//   - Create modal: 3-level paired-column validation (L2 > L1, L3 needs L2)
//   - Toggling L2 off forces L3 off
//   - Archive removes from default ACTIVE pivot

import { describe, expect, it, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EscalationMatrixPage } from '@/modules/admin/escalationMatrix/EscalationMatrixPage';
import { renderWithProviders } from './utils';
import { useAuth } from '@/store/auth';

function setAdmin() {
  const user = {
    id: 'u-001',
    username: 'alice.admin',
    roles: ['admin' as const],
    display_name: 'Alice',
  };
  localStorage.setItem('apex.ews.user', JSON.stringify(user));
  localStorage.setItem('apex.ews.token', 'test-token');
  useAuth.setState({ status: 'authenticated', user, token: 'test-token' });
}

beforeEach(() => {
  localStorage.clear();
  setAdmin();
});

describe('EscalationMatrixPage', () => {
  it('renders the seeded rules with chain (L1/L2/L3) labels', async () => {
    renderWithProviders(<EscalationMatrixPage />);
    await waitFor(() => {
      expect(screen.getByText(/BANK Fraud P1 fast-escalate/i)).toBeInTheDocument();
    });
    // 3-level rule shows L2 + L3 markers
    expect(screen.getAllByText(/L1:/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/L2:/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/L3:/).length).toBeGreaterThan(0);
  });

  it('priority filter restricts the list to P1 rules', async () => {
    renderWithProviders(<EscalationMatrixPage />);
    await screen.findByText(/BANK Fraud P1 fast-escalate/i);
    await userEvent.click(screen.getByTestId('esc-priority-filter-p1'));
    await waitFor(() => {
      // P3 KYC rule should disappear
      expect(screen.queryByText(/BANK KYC P3 reminder/i)).not.toBeInTheDocument();
      expect(screen.getByText(/BANK Fraud P1 fast-escalate/i)).toBeInTheDocument();
    });
  });

  it('search narrows the list to matching rules', async () => {
    renderWithProviders(<EscalationMatrixPage />);
    await screen.findByText(/BANK Fraud P1 fast-escalate/i);
    await userEvent.type(screen.getByTestId('esc-search'), 'KYC');
    await waitFor(() => {
      expect(screen.queryByText(/BANK Fraud P1 fast-escalate/i)).not.toBeInTheDocument();
      expect(screen.getByText(/BANK KYC P3 reminder/i)).toBeInTheDocument();
    });
  });

  it('create modal blocks L2 minutes <= L1 minutes', async () => {
    renderWithProviders(<EscalationMatrixPage />);
    await screen.findByText(/BANK Fraud P1 fast-escalate/i);
    await userEvent.click(screen.getByTestId('esc-new'));
    await screen.findByTestId('escalation-matrix-modal');
    await userEvent.type(screen.getByTestId('esc-name'), 'Bad chain rule');
    // L2 starts off in create mode — turn it on first
    await userEvent.click(screen.getByTestId('esc-l2-toggle'));
    // L1 = 60 (default); set L2 to 30 (less than L1)
    const l2Minutes = screen.getByTestId('esc-l2-minutes');
    await userEvent.clear(l2Minutes);
    await userEvent.type(l2Minutes, '30');
    await userEvent.click(screen.getByTestId('esc-save'));
    expect(await screen.findByTestId('esc-validation')).toHaveTextContent(
      /Level 2 minutes must be greater than level 1/,
    );
  });

  it('L2 toggle gates the L3 toggle (paired-column rule)', async () => {
    renderWithProviders(<EscalationMatrixPage />);
    await screen.findByText(/BANK Fraud P1 fast-escalate/i);
    await userEvent.click(screen.getByTestId('esc-new'));
    await screen.findByTestId('escalation-matrix-modal');
    // Both off by default in create mode → L3 toggle is disabled
    expect(screen.getByTestId('esc-l3-toggle')).toBeDisabled();
    // Turn L2 on → L3 toggle becomes enabled
    await userEvent.click(screen.getByTestId('esc-l2-toggle'));
    await waitFor(() => {
      expect(screen.getByTestId('esc-l3-toggle')).not.toBeDisabled();
    });
    // Turn L2 off again → L3 toggle re-disabled
    await userEvent.click(screen.getByTestId('esc-l2-toggle'));
    await waitFor(() => {
      expect(screen.getByTestId('esc-l3-toggle')).toBeDisabled();
    });
  });

  it('create succeeds for a single-level rule (L2 + L3 off by default)', async () => {
    renderWithProviders(<EscalationMatrixPage />);
    await screen.findByText(/BANK Fraud P1 fast-escalate/i);
    await userEvent.click(screen.getByTestId('esc-new'));
    await screen.findByTestId('escalation-matrix-modal');
    await userEvent.type(screen.getByTestId('esc-name'), 'Single-level test rule');
    // L2 + L3 default OFF in create mode — submit as L1-only
    await userEvent.click(screen.getByTestId('esc-save'));
    await waitFor(() => {
      expect(screen.queryByTestId('escalation-matrix-modal')).not.toBeInTheDocument();
    });
    expect(await screen.findByText(/Single-level test rule/i)).toBeInTheDocument();
  });

  it('archive removes the row from the ACTIVE pivot + reveals it in ARCHIVED', async () => {
    renderWithProviders(<EscalationMatrixPage />);
    await screen.findByText(/BANK KYC P3 reminder/i);
    const archiveBtn = await screen.findByTestId(/^esc-archive-esc-seed-bank_demo-bank-kyc-p3-reminde/);
    await userEvent.click(archiveBtn);
    await waitFor(() => {
      expect(screen.queryByText(/BANK KYC P3 reminder/i)).not.toBeInTheDocument();
    });
    await userEvent.click(screen.getByTestId('esc-pivot-archived'));
    expect(await screen.findByText(/BANK KYC P3 reminder/i)).toBeInTheDocument();
  });

  // M14.33 — Used-by scenarios count per rule
  it('shows "Used by N scenarios" for rules referenced by case scenarios', async () => {
    renderWithProviders(<EscalationMatrixPage />);
    // Wait for the rule rows to render
    await screen.findByText(/BANK Fraud P1 fast-escalate/i);
    // The seeded fast-escalate rule is the default escalation for the
    // seeded "Fraud P1 sudden DPD spike" scenario → should show usage>=1
    const usage = await screen.findByTestId(
      /^esc-usage-esc-seed-bank_demo-bank-fraud-p1-fast/,
    );
    expect(usage.textContent).toMatch(/Used by \d+ scenario/);
  });

  it('shows "Unused" for rules with no scenario references', async () => {
    renderWithProviders(<EscalationMatrixPage />);
    // BANK Operations P4 routine rule has no seeded scenario depending on it
    await screen.findByText(/BANK Operations P4 routine/i);
    const usage = await screen.findByTestId(
      /^esc-usage-esc-seed-bank_demo-bank-operations-p4-rou/,
    );
    expect(usage.textContent).toMatch(/Unused/);
  });

  // M14.32 — ?focus=<escalation_id> deep-link from Case Scenarios
  it('honors ?focus=<id> by highlighting the matched row + broadening pivot to ALL', async () => {
    const FOCUS_ID = 'esc-seed-bank_demo-bank-fraud-p1-fast-escal';
    renderWithProviders(<EscalationMatrixPage />, {
      route: `/admin/escalation-matrix?focus=${FOCUS_ID}`,
    });
    await screen.findByText(/BANK Fraud P1 fast-escalate/i);
    // Pivot should auto-broaden to ALL so an archived rule could still appear
    await waitFor(() => {
      const allBtn = screen.getByTestId('esc-pivot-all');
      expect(allBtn.className).toContain('border-blue-400');
    });
    // The matched row carries the focus marker
    const focusedRow = await waitFor(() =>
      document.querySelector('[data-focus-row="true"]'),
    );
    expect(focusedRow).not.toBeNull();
    expect(focusedRow?.getAttribute('data-row-id')).toBe(FOCUS_ID);
  });

  // M14.28 — Duplicate (clone-with-prefill via the create-modal)
  it('duplicate opens the create modal pre-filled with the source rule timings', async () => {
    renderWithProviders(<EscalationMatrixPage />);
    await screen.findByText(/BANK Fraud P1 fast-escalate/i);
    const dupBtn = await screen.findByTestId(/^esc-duplicate-esc-seed-bank_demo-bank-fraud-p1-fast/);
    await userEvent.click(dupBtn);

    const modal = await screen.findByTestId('escalation-matrix-modal');
    // Heading + hint surface the duplicate intent
    expect(within(modal).getByText(/Duplicate escalation rule/i)).toBeInTheDocument();
    expect(within(modal).getByTestId('esc-duplicate-hint')).toHaveTextContent(
      /Pick a fresh name/,
    );
    // Identity fields are blank (must be filled by operator)
    expect(within(modal).getByTestId('esc-name')).toHaveValue('');
    // Level-1 minutes pre-fill matches the source rule (15 minutes)
    const l1Input = within(modal).getByTestId('esc-l1-minutes') as HTMLInputElement;
    expect(l1Input.value).toBe('15');
  });

  // M14.30 — Test resolver panel
  it('resolver returns the matching rule chain for (fraud, P1)', async () => {
    renderWithProviders(<EscalationMatrixPage />);
    await screen.findByText(/BANK Fraud P1 fast-escalate/i);
    // Defaults: category=fraud, priority=P1 → matches the seeded fast-escalate rule
    await userEvent.click(screen.getByTestId('esc-resolver-run'));
    const match = await screen.findByTestId('esc-resolver-match');
    expect(within(match).getByText(/BANK Fraud P1 fast-escalate/i)).toBeInTheDocument();
    // L1/L2/L3 chain rendered (15m supervisor → 1h risk_analyst → 4h admin)
    expect(within(match).getByText(/L1:/)).toBeInTheDocument();
    expect(within(match).getByText(/L2:/)).toBeInTheDocument();
    expect(within(match).getByText(/L3:/)).toBeInTheDocument();
  });

  it('resolver surfaces a no-match warning for an uncovered (category, priority)', async () => {
    renderWithProviders(<EscalationMatrixPage />);
    await screen.findByText(/BANK Fraud P1 fast-escalate/i);
    const catInput = screen.getByTestId('esc-resolver-category');
    await userEvent.clear(catInput);
    await userEvent.type(catInput, 'no-such-category');
    await userEvent.click(screen.getByTestId('esc-resolver-run'));
    expect(await screen.findByTestId('esc-resolver-no-match')).toHaveTextContent(
      /No active rule for/,
    );
  });

  it('duplicate submit clears the modal + lands the new rule in ACTIVE pivot', async () => {
    renderWithProviders(<EscalationMatrixPage />);
    await screen.findByText(/BANK Fraud P1 fast-escalate/i);
    const dupBtn = await screen.findByTestId(/^esc-duplicate-esc-seed-bank_demo-bank-fraud-p1-fast/);
    await userEvent.click(dupBtn);
    await screen.findByTestId('escalation-matrix-modal');

    // Provide a fresh name + flip priority to P2 to clear the
    // (case_category, priority) uniqueness guard server-side
    await userEvent.type(screen.getByTestId('esc-name'), 'Cloned fraud P2 rule');
    await userEvent.selectOptions(screen.getByTestId('esc-priority'), 'P2');
    await userEvent.click(screen.getByTestId('esc-save'));

    await waitFor(() => {
      expect(screen.queryByTestId('escalation-matrix-modal')).not.toBeInTheDocument();
    });
    expect(await screen.findByText(/Cloned fraud P2 rule/i)).toBeInTheDocument();
  });
});
