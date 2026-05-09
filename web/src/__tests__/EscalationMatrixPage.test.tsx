// Coverage for /admin/escalation-matrix (T6 M14.20):
//   - Seeded list renders with priority + chain rendering (L1/L2/L3)
//   - Status pivot + priority filter + search narrow the list
//   - Create modal: 3-level paired-column validation (L2 > L1, L3 needs L2)
//   - Toggling L2 off forces L3 off
//   - Archive removes from default ACTIVE pivot

import { describe, expect, it, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
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
});
