// Coverage for /admin/sla-config:
//   - List loads + status pivot filters
//   - Search narrows the list
//   - Edit modal: target validation + supersede success
//   - Archive confirm dialog

import { describe, expect, it, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SlaConfigPage } from '@/modules/admin/slaConfig/SlaConfigPage';
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

describe('SlaConfigPage', () => {
  it('renders the seeded ACTIVE rows', async () => {
    renderWithProviders(<SlaConfigPage />);
    await waitFor(() => {
      // Default filter is ACTIVE — multiple priorities per category
      expect(screen.getAllByText('credit_risk').length).toBeGreaterThan(0);
      expect(screen.getAllByText('fraud').length).toBeGreaterThan(0);
    });
  });

  it('search filter narrows the list', async () => {
    renderWithProviders(<SlaConfigPage />);
    await screen.findAllByText('credit_risk');
    await userEvent.type(screen.getByTestId('sla-search'), 'fraud');
    expect(screen.queryByText('credit_risk')).not.toBeInTheDocument();
    expect(screen.getAllByText('fraud').length).toBeGreaterThan(0);
  });

  it('opens the edit modal and validates the target', async () => {
    renderWithProviders(<SlaConfigPage />);
    await screen.findAllByText('credit_risk');
    // Pick the credit_risk P3 row's edit button (the seed gives it id 'sla-seed-credit_risk-P3-all')
    await userEvent.click(screen.getByTestId('sla-edit-sla-seed-credit_risk-P3-all'));
    expect(screen.getByRole('dialog', { name: /Edit SLA target/i })).toBeInTheDocument();
    // Set a bad value (out of range)
    const input = screen.getByTestId('sla-target-input') as HTMLInputElement;
    await userEvent.clear(input);
    await userEvent.type(input, '500');
    await userEvent.click(screen.getByTestId('sla-save'));
    expect(await screen.findByTestId('sla-edit-error')).toHaveTextContent(/365/);
  });

  it('preview strip surfaces +N delta when target is tightened (sub-day)', async () => {
    renderWithProviders(<SlaConfigPage />);
    await screen.findAllByText('credit_risk');
    await userEvent.click(screen.getByTestId('sla-edit-sla-seed-credit_risk-P3-all'));
    const input = screen.getByTestId('sla-target-input') as HTMLInputElement;
    await userEvent.clear(input);
    // Sub-day target (0.5 = 12h) — MSW fixture treats this as tighter
    // and returns +3 breaches.
    await userEvent.type(input, '0.5');
    expect(await screen.findByTestId('sla-preview-positive')).toHaveTextContent(/\+3/);
  });

  it('preview strip stays hidden when target equals the current value', async () => {
    renderWithProviders(<SlaConfigPage />);
    await screen.findAllByText('credit_risk');
    await userEvent.click(screen.getByTestId('sla-edit-sla-seed-credit_risk-P3-all'));
    // The seed target is 7d — leave it at 7 → no preview should fire.
    expect(screen.queryByTestId('sla-preview-loading')).not.toBeInTheDocument();
    expect(screen.queryByTestId('sla-preview-positive')).not.toBeInTheDocument();
    expect(screen.queryByTestId('sla-preview-negative')).not.toBeInTheDocument();
  });

  it('happy-path edit: supersede creates a new ACTIVE row', async () => {
    renderWithProviders(<SlaConfigPage />);
    await screen.findAllByText('credit_risk');
    await userEvent.click(screen.getByTestId('sla-edit-sla-seed-credit_risk-P3-all'));
    const input = screen.getByTestId('sla-target-input') as HTMLInputElement;
    await userEvent.clear(input);
    await userEvent.type(input, '5');
    await userEvent.click(screen.getByTestId('sla-save'));
    // Modal closes; the row should now show 5d
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: /Edit SLA target/i })).not.toBeInTheDocument();
    });
    // Switch to SUPERSEDED filter — old row should be there
    await userEvent.click(screen.getByTestId('sla-pivot-superseded'));
    await waitFor(() => {
      expect(screen.getAllByText('credit_risk').length).toBeGreaterThan(0);
    });
  });

  it('Add SLA target opens the create modal and warns on duplicate', async () => {
    renderWithProviders(<SlaConfigPage />);
    await screen.findAllByText('credit_risk');
    await userEvent.click(screen.getByTestId('sla-add'));
    expect(screen.getByRole('dialog', { name: /Add SLA target/i })).toBeInTheDocument();
    // Picking an existing seeded combination triggers the duplicate
    // warning + disables the submit button.
    await userEvent.type(screen.getByTestId('sla-create-category'), 'credit_risk');
    await userEvent.click(screen.getByTestId('sla-create-priority-P1'));
    await userEvent.type(screen.getByTestId('sla-create-days'), '1');
    expect(screen.getByTestId('sla-create-dup-warn')).toBeInTheDocument();
    expect((screen.getByTestId('sla-create-submit') as HTMLButtonElement).disabled).toBe(true);
  });

  it('happy-path create: brand-new (category, priority) row appears in the list', async () => {
    renderWithProviders(<SlaConfigPage />);
    await screen.findAllByText('credit_risk');
    await userEvent.click(screen.getByTestId('sla-add'));
    await userEvent.type(screen.getByTestId('sla-create-category'), 'aml_kyc');
    await userEvent.click(screen.getByTestId('sla-create-priority-P2'));
    await userEvent.type(screen.getByTestId('sla-create-days'), '4');
    await userEvent.type(
      screen.getByTestId('sla-create-notes'),
      'New AML/KYC fast track for sanctions hits',
    );
    await userEvent.click(screen.getByTestId('sla-create-submit'));
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: /Add SLA target/i })).not.toBeInTheDocument();
    });
    // The new row should be visible in the ACTIVE list
    await waitFor(() => {
      expect(screen.getByText('aml_kyc')).toBeInTheDocument();
    });
  });

  it('Add SLA target — out-of-range target is rejected', async () => {
    renderWithProviders(<SlaConfigPage />);
    await screen.findAllByText('credit_risk');
    await userEvent.click(screen.getByTestId('sla-add'));
    // Use a fresh category that no prior test could have created so
    // the client-side duplicate guard doesn't disable submit.
    await userEvent.type(
      screen.getByTestId('sla-create-category'),
      'regulatory_returns_test',
    );
    await userEvent.click(screen.getByTestId('sla-create-priority-P2'));
    await userEvent.type(screen.getByTestId('sla-create-days'), '500');
    await userEvent.click(screen.getByTestId('sla-create-submit'));
    expect(await screen.findByTestId('sla-create-error')).toHaveTextContent(/365/);
  });

  it('archive confirm dialog renders + archives the row', async () => {
    renderWithProviders(<SlaConfigPage />);
    await screen.findAllByText('credit_risk');
    await userEvent.click(screen.getByTestId('sla-archive-sla-seed-credit_risk-P4-all'));
    expect(screen.getByRole('dialog', { name: /Archive SLA target/i })).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('sla-archive-confirm'));
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: /Archive SLA target/i })).not.toBeInTheDocument();
    });
    // Status pivot to ARCHIVED — the just-archived row is here
    await userEvent.click(screen.getByTestId('sla-pivot-archived'));
    await waitFor(() => {
      expect(screen.getAllByText('credit_risk').length).toBeGreaterThan(0);
    });
  });
});
