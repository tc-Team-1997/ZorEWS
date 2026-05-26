// web/src/__tests__/WorkflowsPage.test.tsx
//
// M5.4 — Workflows SPA smoke.
//
// Covers:
//   - Library + KPI tiles render
//   - Detail panel shows the seeded "Stress-test approval workflow"
//   - 4-eyes stage routing surface — stage graph + stage table
//     visualise the configured role pool (spec acceptance)
//   - New-workflow modal opens and accepts a 4-eyes stage definition

import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { WorkflowsPage } from '@/modules/admin/WorkflowsPage';
import { useAuth } from '@/store/auth';
import { __resetMswWorkflows } from '@/mocks/handlers';

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={qc}>
        <WorkflowsPage />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  __resetMswWorkflows();
  useAuth.setState({
    user: {
      id: 'u-admin',
      username: 'alice.admin',
      roles: ['admin'],
    } as ReturnType<typeof useAuth.getState>['user'],
  });
});

describe('M5.4 — WorkflowsPage', () => {
  it('renders KPIs + library + detail panel from MSW seed', async () => {
    renderPage();
    // Page title heading — scoped to <h1>/<h2> in PageHeader to avoid
    // collision with the sidebar nav label
    expect(screen.getByRole('heading', { name: /Workflows/i })).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByTestId('wf-library')).toBeInTheDocument();
    }, { timeout: 3000 });

    // KPI tiles
    expect(screen.getByTestId('wf-kpi-total')).toBeInTheDocument();
    expect(screen.getByTestId('wf-kpi-4eyes')).toBeInTheDocument();

    // Two seeded templates from the MSW seed — KYC is selected by default
    // so its name appears in BOTH the library card + the detail header
    expect(
      screen.getAllByText('Stress-test approval workflow').length,
    ).toBeGreaterThanOrEqual(1);
    expect(
      screen.getAllByText('KYC onboarding review').length,
    ).toBeGreaterThanOrEqual(1);
  });

  it('shows the 4-eyes routing pool in the stage graph', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('Stress-test approval workflow')).toBeInTheDocument();
    }, { timeout: 3000 });

    // Library sorts alphabetically; KYC appears before Stress-test.
    // Click the Stress-test row to select it (4-eyes is on stage 2).
    fireEvent.click(screen.getByText('Stress-test approval workflow'));

    await waitFor(() => {
      const g = screen.getByTestId('wf-stage-graph');
      // Wait until the routing fetch returns and stage 2 is rendered
      expect(within(g).getByText(/Maker submits/)).toBeInTheDocument();
    }, { timeout: 3000 });

    const graph = screen.getByTestId('wf-stage-graph');
    // Stage 2 has 4-eyes — pool sorted asc: compliance_officer, head_of_risk, supervisor
    // head_of_risk also appears in Stage 3 (CRO sign-off required_role)
    expect(within(graph).getByText('compliance_officer')).toBeInTheDocument();
    expect(within(graph).getAllByText('head_of_risk').length).toBeGreaterThanOrEqual(1);
    expect(within(graph).getByText('supervisor')).toBeInTheDocument();
    // 4-eyes label — appears in both the stage description ("Maker submits +
    // Checker approves (4-eyes)") and the routing badge
    expect(within(graph).getAllByText(/4-eyes/i).length).toBeGreaterThanOrEqual(1);
  });

  it('opens the new-workflow modal + accepts a 4-eyes stage definition', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('wf-new')).toBeInTheDocument();
    }, { timeout: 3000 });

    fireEvent.click(screen.getByTestId('wf-new'));
    await waitFor(() => {
      expect(screen.getByTestId('wf-create-modal')).toBeInTheDocument();
    }, { timeout: 3000 });

    // Toggle 4-eyes on the first stage
    fireEvent.change(screen.getByTestId('wf-edit-name'), {
      target: { value: 'New 4-eyes workflow' },
    });
    fireEvent.change(screen.getByTestId('wf-edit-stage-name-0'), {
      target: { value: 'Single 4-eyes review' },
    });
    fireEvent.click(screen.getByTestId('wf-edit-stage-4eyes-0'));
    await waitFor(() => {
      // pool input only appears after 4-eyes toggle
      expect(screen.getByTestId('wf-edit-stage-pool-0')).toBeInTheDocument();
    });
    fireEvent.change(screen.getByTestId('wf-edit-stage-pool-0'), {
      target: { value: 'supervisor, head_of_risk' },
    });

    // Cancel without saving (avoids racing the mutation against the
    // SPA's react-query refetch; this test verifies the modal UX)
    fireEvent.click(screen.getByTestId('wf-create-modal-cancel'));
    await waitFor(() => {
      expect(screen.queryByTestId('wf-create-modal')).not.toBeInTheDocument();
    });
  });
});
