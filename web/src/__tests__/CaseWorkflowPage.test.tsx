// web/src/__tests__/CaseWorkflowPage.test.tsx
//
// Smoke tests for the CaseWorkflowPage (Module 3.2 — 4-eyes maker-checker).
// Covers:
//   1. Pipeline cards render on mount (stats come from MSW /v1/cms/cases/stats)
//   2. Pending actions table is shown when the workflow list returns items
//   3. Approve button is present when there are pending items

import { describe, expect, it, beforeEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CaseWorkflowPage } from '@/modules/cms/CaseWorkflowPage';
import { renderWithProviders } from './utils';
import { server } from '@/mocks/server';
import { useAuth } from '@/store/auth';

// Minimal WorkflowAction shape that matches the BFF surface.
const PENDING_ACTION = {
  action_id: 'wf-001',
  case_id: 'cs-test-001',
  action_type: 'case.close' as const,
  status: 'pending' as const,
  maker_username: 'alice.analyst',
  maker_at: new Date(Date.now() - 3_600_000).toISOString(), // 1h ago → SLA green
  rationale: 'Customer has cleared all outstanding dues.',
  payload: { resolution_category: 'resolved' },
  checker_username: null,
  checker_at: null,
  decision_notes: null,
};

// Envelope helper that matches the BFF `{header, body}` response shape.
function envelope<T>(body: T) {
  return { header: { status: 'ok', code: '200', message: 'OK', requestId: 'r1', timestamp: new Date().toISOString() }, body };
}

describe('CaseWorkflowPage', () => {
  beforeEach(() => {
    // Set up an admin user so canDecide = true and the Approve/Reject buttons
    // appear in the detail modal (component gates on admin/supervisor role).
    useAuth.setState({
      status: 'authenticated',
      token: 'mock-token',
      user: {
        id: 'u-001',
        username: 'bob.supervisor',
        roles: ['supervisor'],
        display_name: 'Bob Supervisor',
        must_change_password: false,
        terms_accepted_at: new Date().toISOString(),
      },
    });
  });

  it('renders the pipeline cards and pending-requests panel', async () => {
    renderWithProviders(<CaseWorkflowPage />);
    // The pipeline cards header from PageHeader
    await waitFor(() => {
      expect(screen.getByText('Case Workflow')).toBeInTheDocument();
    });
    // The 5 pipeline cards should be present (by their stage testIds)
    await waitFor(() => {
      expect(screen.getByTestId('pipeline-card-open')).toBeInTheDocument();
      expect(screen.getByTestId('pipeline-card-review')).toBeInTheDocument();
      expect(screen.getByTestId('pipeline-card-action-proposed')).toBeInTheDocument();
      expect(screen.getByTestId('pipeline-card-approved')).toBeInTheDocument();
      expect(screen.getByTestId('pipeline-card-closed')).toBeInTheDocument();
    });
    // The pending requests panel is rendered
    expect(screen.getByText('Pending requests')).toBeInTheDocument();
  });

  it('shows approve + reject buttons in the detail modal for pending actions', async () => {
    const user = userEvent.setup();
    // Override the maker-checker list endpoint to return a pending action.
    server.use(
      http.get('/v1/cases/maker-checker', () =>
        HttpResponse.json(
          envelope({ items: [PENDING_ACTION], total: 1, page: 1, page_size: 100 }),
        ),
      ),
      http.get('/v1/cases/maker-checker/wf-001', () =>
        HttpResponse.json(envelope(PENDING_ACTION)),
      ),
    );

    renderWithProviders(<CaseWorkflowPage />);

    // Wait for the table row to appear
    await waitFor(() => {
      expect(screen.getByTestId('workflow-pending-table')).toBeInTheDocument();
    });

    // The pending action row should show the action label and maker username
    const table = screen.getByTestId('workflow-pending-table');
    expect(within(table).getByText('Close case')).toBeInTheDocument();
    expect(within(table).getByText('alice.analyst')).toBeInTheDocument();

    // Click the View button to open the detail modal
    await user.click(screen.getByTestId('workflow-detail-wf-001'));

    // The detail modal should appear with Approve + Reject buttons
    await waitFor(() => {
      expect(screen.getByTestId('workflow-detail-modal')).toBeInTheDocument();
    });
    expect(screen.getByTestId('workflow-approve-btn')).toBeInTheDocument();
    expect(screen.getByTestId('workflow-reject-btn')).toBeInTheDocument();
  });

  it('rejects button is disabled until reason is entered', async () => {
    const user = userEvent.setup();
    server.use(
      http.get('/v1/cases/maker-checker', () =>
        HttpResponse.json(
          envelope({ items: [PENDING_ACTION], total: 1, page: 1, page_size: 100 }),
        ),
      ),
      http.get('/v1/cases/maker-checker/wf-001', () =>
        HttpResponse.json(envelope(PENDING_ACTION)),
      ),
    );

    renderWithProviders(<CaseWorkflowPage />);

    await waitFor(() => {
      expect(screen.getByTestId('workflow-pending-table')).toBeInTheDocument();
    });
    await user.click(screen.getByTestId('workflow-detail-wf-001'));
    await waitFor(() => {
      expect(screen.getByTestId('workflow-reject-btn')).toBeInTheDocument();
    });

    // Reject is disabled until decision_notes ≥ 3 chars
    expect(screen.getByTestId('workflow-reject-btn')).toBeDisabled();

    // Type a reason
    await user.type(screen.getByTestId('workflow-decision-notes'), 'Not valid');
    expect(screen.getByTestId('workflow-reject-btn')).not.toBeDisabled();
  });
});
