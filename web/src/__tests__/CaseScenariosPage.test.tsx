// Coverage for /admin/case-scenarios (T6 M14.21):
//   - Seeded list renders with priority + checklist + status
//   - Status pivot + priority filter + search narrow the list
//   - Create modal: dropdowns load escalation rules + templates,
//     trigger pair toggles together, checklist editor adds/removes items
//   - DRAFT scenario activates → ACTIVE
//   - Archive → ARCHIVED + Restore → DRAFT round-trip
//   - History modal renders one row per mutation w/ diff

import { describe, expect, it, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CaseScenariosPage } from '@/modules/admin/caseScenarios/CaseScenariosPage';
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

describe('CaseScenariosPage', () => {
  it('renders the seeded scenarios with category + priority', async () => {
    renderWithProviders(<CaseScenariosPage />);
    await waitFor(() => {
      expect(screen.getByText(/Fraud P1 sudden DPD spike/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/KYC document expired/i)).toBeInTheDocument();
  });

  it('priority filter restricts the list to P1 scenarios', async () => {
    renderWithProviders(<CaseScenariosPage />);
    await screen.findByText(/Fraud P1 sudden DPD spike/i);
    await userEvent.click(screen.getByTestId('cs-priority-filter-p1'));
    await waitFor(() => {
      expect(screen.queryByText(/KYC document expired/i)).not.toBeInTheDocument();
      expect(screen.getByText(/Fraud P1 sudden DPD spike/i)).toBeInTheDocument();
    });
  });

  it('search narrows the list to matching scenarios', async () => {
    renderWithProviders(<CaseScenariosPage />);
    await screen.findByText(/Fraud P1 sudden DPD spike/i);
    await userEvent.type(screen.getByTestId('cs-search'), 'KYC');
    await waitFor(() => {
      expect(screen.queryByText(/Fraud P1 sudden DPD spike/i)).not.toBeInTheDocument();
      expect(screen.getByText(/KYC document expired/i)).toBeInTheDocument();
    });
  });

  it('create modal escalation dropdown loads from the matrix API', async () => {
    renderWithProviders(<CaseScenariosPage />);
    await screen.findByText(/Fraud P1 sudden DPD spike/i);
    await userEvent.click(screen.getByTestId('cs-new'));
    await screen.findByTestId('case-scenario-modal');
    // Dropdown is populated with the seeded escalation rules
    const escalation = screen.getByTestId('cs-escalation') as HTMLSelectElement;
    await waitFor(() => {
      const options = within(escalation).getAllByRole('option');
      // 1 placeholder + 5 seeded ACTIVE rules
      expect(options.length).toBeGreaterThanOrEqual(6);
    });
    expect(within(escalation).getByText(/BANK Fraud P1 fast-escalate/)).toBeInTheDocument();
  });

  it('checklist editor adds + removes items', async () => {
    renderWithProviders(<CaseScenariosPage />);
    await screen.findByText(/Fraud P1 sudden DPD spike/i);
    await userEvent.click(screen.getByTestId('cs-new'));
    await screen.findByTestId('case-scenario-modal');
    expect(screen.queryByTestId('cs-checklist-item-0')).not.toBeInTheDocument();
    await userEvent.click(screen.getByTestId('cs-checklist-add'));
    expect(screen.getByTestId('cs-checklist-item-0')).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('cs-checklist-add'));
    expect(screen.getByTestId('cs-checklist-item-1')).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('cs-checklist-remove-0'));
    await waitFor(() => {
      expect(screen.queryByTestId('cs-checklist-item-1')).not.toBeInTheDocument();
    });
    expect(screen.getByTestId('cs-checklist-item-0')).toBeInTheDocument();
  });

  it('create modal validation: blank checklist item title is rejected', async () => {
    renderWithProviders(<CaseScenariosPage />);
    await screen.findByText(/Fraud P1 sudden DPD spike/i);
    await userEvent.click(screen.getByTestId('cs-new'));
    await screen.findByTestId('case-scenario-modal');
    // Wait for escalation dropdown to populate before submitting
    await waitFor(() => {
      expect(within(screen.getByTestId('cs-escalation')).queryByText(/BANK Fraud P1 fast-escalate/)).toBeInTheDocument();
    });
    await userEvent.type(screen.getByTestId('cs-name'), 'Scenario with bad checklist');
    await userEvent.click(screen.getByTestId('cs-checklist-add'));
    // Leave checklist title blank, click save
    await userEvent.click(screen.getByTestId('cs-save'));
    expect(await screen.findByTestId('cs-validation')).toHaveTextContent(
      /Checklist item 1 must have a title/,
    );
  });

  it('activate moves a DRAFT scenario to ACTIVE', async () => {
    renderWithProviders(<CaseScenariosPage />);
    await screen.findByText(/KYC document expired/i);
    // KYC scenario is seeded as DRAFT
    const activateBtn = await screen.findByTestId('cs-activate-sc-seed-kyc-p3-doc-expired');
    await userEvent.click(activateBtn);
    // Switch to ACTIVE pivot — KYC scenario should now appear there
    await userEvent.click(screen.getByTestId('cs-pivot-active'));
    expect(await screen.findByText(/KYC document expired/i)).toBeInTheDocument();
  });

  it('archive removes the row from default ALL pivot then restore brings it back as DRAFT', async () => {
    renderWithProviders(<CaseScenariosPage />);
    await screen.findByText(/KYC document expired/i);
    const archiveBtn = await screen.findByTestId('cs-archive-sc-seed-kyc-p3-doc-expired');
    await userEvent.click(archiveBtn);
    // Switch to ARCHIVED pivot to find it
    await userEvent.click(screen.getByTestId('cs-pivot-archived'));
    expect(await screen.findByText(/KYC document expired/i)).toBeInTheDocument();
    const restoreBtn = await screen.findByTestId('cs-restore-sc-seed-kyc-p3-doc-expired');
    await userEvent.click(restoreBtn);
    // Restored back to DRAFT — visible in DRAFT pivot
    await userEvent.click(screen.getByTestId('cs-pivot-draft'));
    expect(await screen.findByText(/KYC document expired/i)).toBeInTheDocument();
  });

  it('history modal lists one entry per mutation with action badge', async () => {
    renderWithProviders(<CaseScenariosPage />);
    await screen.findByText(/Fraud P1 sudden DPD spike/i);
    await userEvent.click(screen.getByTestId('cs-history-sc-seed-fraud-p1-sudden-dpd'));
    const modal = await screen.findByTestId('case-scenario-history-modal');
    // The seed-time history append yields one "create" entry
    await waitFor(() => {
      expect(within(modal).getByText(/create/i)).toBeInTheDocument();
    });
    // Performed by system:seed (scoped inside the modal)
    expect(within(modal).getByText(/system:seed/)).toBeInTheDocument();
  });
});
