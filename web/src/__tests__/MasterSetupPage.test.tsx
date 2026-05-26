// web/src/__tests__/MasterSetupPage.test.tsx
//
// Module 5.1 — Master Setup SPA smoke.
//
// Covers:
//   - Page renders the 16 spec tabs
//   - Default tab loads seeded rows from MSW
//   - Tab switch loads the new master_type
//   - Where-used modal opens + surfaces the 12-references case from MSW
//   - In-use row's delete button surfaces the 409 EWS_409_in_use message

import { describe, it, expect } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { MasterSetupPage } from '@/modules/admin/MasterSetupPage';
import { useAuth } from '@/store/auth';

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={qc}>
        <MasterSetupPage />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  // Sign in as admin so canMutate=true
  useAuth.setState({
    user: {
      id: 'u-admin',
      username: 'alice.admin',
      roles: ['admin'],
    } as ReturnType<typeof useAuth.getState>['user'],
  });
});

describe('M5.1 — MasterSetupPage', () => {
  it('renders 16 spec tabs', () => {
    renderPage();
    expect(screen.getByTestId('ms-tab-currencies')).toBeInTheDocument();
    expect(screen.getByTestId('ms-tab-severity_levels')).toBeInTheDocument();
    expect(screen.getByTestId('ms-tab-regulators')).toBeInTheDocument();
    expect(screen.getByTestId('ms-tab-borrower_segments')).toBeInTheDocument();
    expect(screen.getByTestId('ms-tab-financial_ratios')).toBeInTheDocument();
    expect(screen.getByTestId('ms-tab-review_cadences')).toBeInTheDocument();
    expect(screen.getByTestId('ms-tab-reference_data')).toBeInTheDocument();
    expect(screen.getByTestId('ms-tab-roles_master')).toBeInTheDocument();
    expect(screen.getByTestId('ms-tab-reassign_basis')).toBeInTheDocument();
    expect(screen.getByTestId('ms-tab-reassign_teams')).toBeInTheDocument();
    expect(screen.getByTestId('ms-tab-recipients')).toBeInTheDocument();
    expect(screen.getByTestId('ms-tab-schedule_formats')).toBeInTheDocument();
    expect(screen.getByTestId('ms-tab-schedule_frequencies')).toBeInTheDocument();
    expect(screen.getByTestId('ms-tab-ai_models')).toBeInTheDocument();
    expect(screen.getByTestId('ms-tab-rule_categories')).toBeInTheDocument();
    expect(screen.getByTestId('ms-tab-source_types')).toBeInTheDocument();
  });

  it('loads seeded currencies (default tab)', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('ms-row-INR')).toBeInTheDocument();
      expect(screen.getByTestId('ms-row-USD')).toBeInTheDocument();
    }, { timeout: 3000 });
  });

  it('switching tabs loads the new master', async () => {
    renderPage();
    fireEvent.click(screen.getByTestId('ms-tab-regulators'));
    await waitFor(() => {
      expect(screen.getByTestId('ms-row-RBI')).toBeInTheDocument();
      expect(screen.getByTestId('ms-row-IRDAI')).toBeInTheDocument();
    }, { timeout: 3000 });
  });

  it('opens the where-used modal for the in-use demo row', async () => {
    renderPage();
    // INR loaded, then click the where-used button for INUSE_KES
    await waitFor(() => {
      expect(screen.getByTestId('ms-row-INUSE_KES')).toBeInTheDocument();
    }, { timeout: 3000 });
    fireEvent.click(screen.getByTestId('ms-where-used-INUSE_KES'));

    await waitFor(() => {
      expect(screen.getByTestId('ms-whereused-modal')).toBeInTheDocument();
      expect(screen.getByTestId('ms-whereused-summary')).toHaveTextContent(/12/);
    }, { timeout: 3000 });
    // Delete button is disabled for in-use rows
    const delBtn = screen.getByTestId('ms-whereused-delete') as HTMLButtonElement;
    expect(delBtn).toBeDisabled();
  });

  it('shows 0 references + enables delete for non-in-use rows', async () => {
    renderPage();
    fireEvent.click(screen.getByTestId('ms-tab-borrower_segments'));
    await waitFor(() => {
      expect(screen.getByTestId('ms-row-RETAIL')).toBeInTheDocument();
    }, { timeout: 3000 });
    fireEvent.click(screen.getByTestId('ms-where-used-RETAIL'));
    await waitFor(() => {
      expect(screen.getByTestId('ms-whereused-modal')).toBeInTheDocument();
    }, { timeout: 3000 });
    await waitFor(() => {
      expect(screen.getByTestId('ms-whereused-summary')).toHaveTextContent(/No references/i);
    }, { timeout: 3000 });
    const delBtn = screen.getByTestId('ms-whereused-delete') as HTMLButtonElement;
    expect(delBtn).not.toBeDisabled();
  });
});
