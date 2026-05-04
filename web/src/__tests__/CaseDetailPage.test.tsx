import { afterEach, describe, expect, it } from 'vitest';
import { Route, Routes } from 'react-router-dom';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CaseDetailPage } from '@/modules/cases/CaseDetailPage';
import { caseDetails } from '@/mocks/data';
import { renderWithProviders } from './utils';

// Snapshot the mocked case detail set so each test starts from a known state.
// MSW handlers mutate `caseDetails` in place, so we must restore between tests.
const SNAPSHOT = JSON.parse(JSON.stringify(caseDetails)) as typeof caseDetails;
afterEach(() => {
  caseDetails.length = 0;
  caseDetails.push(...JSON.parse(JSON.stringify(SNAPSHOT)));
});

function renderCase(id: string) {
  return renderWithProviders(
    <Routes>
      <Route path="/cases/:id" element={<CaseDetailPage />} />
    </Routes>,
    { route: `/cases/${id}` },
  );
}

describe('CaseDetailPage', () => {
  it('renders header fields and existing actions', async () => {
    renderCase('case-502');
    await screen.findByRole('heading', { name: /Case case-502/ });
    expect(screen.getByText('Brian Kamau')).toBeInTheDocument();
    // Two seeded actions on case-502
    const timeline = await screen.findByLabelText('action timeline');
    expect(within(timeline).getAllByText(/fiona\.field/)).toHaveLength(2);
    expect(within(timeline).getByText(/Customer promised payment/)).toBeInTheDocument();
  });

  it('open case: assign is enabled, action form hidden, monitor disabled', async () => {
    renderCase('case-503');
    await screen.findByRole('heading', { name: /Case case-503/ });
    // Action form should NOT be present (state=open, can't log without assignment)
    expect(screen.queryByLabelText('log action')).not.toBeInTheDocument();
    // Monitor button is disabled.
    expect(screen.getByRole('button', { name: /Mark as monitored/ })).toBeDisabled();
  });

  it('assigning an open case promotes state to assigned and shows action form', async () => {
    const user = userEvent.setup();
    renderCase('case-503');
    await screen.findByRole('heading', { name: /Case case-503/ });

    const assigneeInput = screen.getByLabelText('assignee');
    await user.type(assigneeInput, 'ravi.risk');
    await user.click(screen.getByRole('button', { name: 'Assign' }));

    await waitFor(() => {
      const stateBadges = screen.getAllByText(/^assigned$/i);
      expect(stateBadges.length).toBeGreaterThan(0);
    });
    expect(screen.getByLabelText('log action')).toBeInTheDocument();
  });

  it('logging an action moves state to in_action and appends to timeline', async () => {
    const user = userEvent.setup();
    renderCase('case-501');
    await screen.findByRole('heading', { name: /Case case-501/ });

    const form = screen.getByLabelText('log action');
    await user.type(within(form).getByLabelText('Officer id'), 'fiona.field');
    await user.type(within(form).getByLabelText('Note'), 'First contact');
    await user.click(within(form).getByRole('button', { name: 'Log action' }));

    await waitFor(() => {
      expect(screen.getAllByText(/^in action$/i).length).toBeGreaterThan(0);
    });
    const timeline = screen.getByLabelText('action timeline');
    expect(within(timeline).getByText(/First contact/)).toBeInTheDocument();
  });

  it('illegal close path is not exposed: closing already-closed case disables button', async () => {
    const user = userEvent.setup();
    renderCase('case-501');
    await screen.findByRole('heading', { name: /Case case-501/ });
    // Close from assigned (allowed): pick defaulted, hit close
    fireEvent.change(screen.getByLabelText('outcome'), { target: { value: 'defaulted' } });
    await user.click(screen.getByRole('button', { name: 'Close case' }));

    await waitFor(() => {
      const closed = screen.getAllByText(/^closed$/i);
      expect(closed.length).toBeGreaterThan(0);
    });
    // Subsequent attempts: the close button is now disabled because state=closed.
    expect(screen.getByRole('button', { name: 'Close case' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Mark as monitored' })).toBeDisabled();
  });

  it('illegal monitor before action returns 409 surface (button disabled, hint shown)', async () => {
    renderCase('case-501');
    await screen.findByRole('heading', { name: /Case case-501/ });
    // case-501 is `assigned`, no actions yet — monitor must be unavailable.
    expect(screen.getByRole('button', { name: 'Mark as monitored' })).toBeDisabled();
    expect(screen.getByText(/Available once an action has been logged/)).toBeInTheDocument();
  });

  it('rejects invalid GPS input client-side', async () => {
    const user = userEvent.setup();
    renderCase('case-501');
    await screen.findByRole('heading', { name: /Case case-501/ });

    const form = screen.getByLabelText('log action');
    await user.type(within(form).getByLabelText('Officer id'), 'fiona.field');
    await user.type(within(form).getByLabelText('GPS lat (optional)'), 'not-a-number');
    await user.type(within(form).getByLabelText('GPS lng (optional)'), '36.82');
    await user.click(within(form).getByRole('button', { name: 'Log action' }));

    await within(form).findByText(/GPS lat\/lng must be numbers/);
  });

  it('renders not-found when the case id is unknown', async () => {
    renderCase('nope');
    await waitFor(() => {
      expect(screen.getByText(/Request failed with status code 404/i)).toBeInTheDocument();
    });
  });
});
