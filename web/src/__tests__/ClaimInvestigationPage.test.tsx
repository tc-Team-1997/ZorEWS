import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { ClaimInvestigationPage } from '@/modules/insurance/ClaimInvestigationPage';
import { renderWithProviders } from './utils';

// Open the worst-first claim in the queue and return the opened modal element.
async function openFirstInvestigation(): Promise<HTMLElement> {
  await waitFor(() => expect(screen.getByTestId('siu-queue-table')).toBeInTheDocument());
  const openBtns = await screen.findAllByTestId(/^siu-open-/);
  fireEvent.click(openBtns[0]);
  await waitFor(() => expect(screen.getByTestId('siu-detail-modal')).toBeInTheDocument());
  const modal = screen.getByTestId('siu-detail-modal');
  // wait for the detail query to resolve (lifecycle controls render once data lands)
  await waitFor(() => expect(within(modal).getByTestId('siu-lifecycle')).toBeInTheDocument());
  return modal;
}

describe('ClaimInvestigationPage — render', () => {
  it('renders header + 4 KPIs + suspicious-claims queue', async () => {
    renderWithProviders(<ClaimInvestigationPage />);
    expect(screen.getByRole('heading', { name: /Claim Investigation \(SIU\)/ })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('siu-queue-table')).toBeInTheDocument());
    expect(screen.getByTestId('siu-kpi-queue')).toBeInTheDocument();
    expect(screen.getByTestId('siu-kpi-open')).toBeInTheDocument();
    expect(screen.getByTestId('siu-kpi-escalated')).toBeInTheDocument();
    expect(screen.getByTestId('siu-kpi-confirmed')).toBeInTheDocument();
    // worst-first queue has rows
    expect((await screen.findAllByTestId(/^siu-open-/)).length).toBeGreaterThan(0);
  });

  it('shows an empty investigations panel before anything is opened', async () => {
    renderWithProviders(<ClaimInvestigationPage />);
    await waitFor(() => expect(screen.getByTestId('siu-list-empty')).toBeInTheDocument());
  });
});

describe('ClaimInvestigationPage — investigation workflow', () => {
  it('opening a claim creates an investigation + the detail modal opens', async () => {
    renderWithProviders(<ClaimInvestigationPage />);
    const modal = await openFirstInvestigation();
    // fresh investigation starts in triage
    expect(within(modal).getByText(/Triage/)).toBeInTheDocument();
    // and the investigations list now has the row
    fireEvent.click(within(modal).getByTestId('siu-detail-modal-close'));
    await waitFor(() => expect(screen.getByTestId('siu-list')).toBeInTheDocument());
    expect(within(screen.getByTestId('siu-list')).getAllByTestId(/^siu-inv-/).length).toBe(1);
  });

  it('adds an investigation note', async () => {
    renderWithProviders(<ClaimInvestigationPage />);
    const modal = await openFirstInvestigation();
    fireEvent.change(within(modal).getByTestId('siu-note-input'), { target: { value: 'Claimant phone disconnected.' } });
    fireEvent.click(within(modal).getByTestId('siu-note-add'));
    await waitFor(() => {
      const list = within(screen.getByTestId('siu-detail-modal')).getByTestId('siu-notes-list');
      expect(within(list).getByText(/Claimant phone disconnected\./)).toBeInTheDocument();
    });
  });

  it('attaches typed evidence', async () => {
    renderWithProviders(<ClaimInvestigationPage />);
    const modal = await openFirstInvestigation();
    fireEvent.change(within(modal).getByTestId('siu-ev-title'), { target: { value: 'Hospital bill mismatch' } });
    fireEvent.change(within(modal).getByTestId('siu-ev-ref'), { target: { value: 'dms://doc/123' } });
    fireEvent.click(within(modal).getByTestId('siu-ev-add'));
    await waitFor(() => {
      const list = within(screen.getByTestId('siu-detail-modal')).getByTestId('siu-evidence-list');
      expect(within(list).getByText(/Hospital bill mismatch/)).toBeInTheDocument();
    });
  });

  it('advances the lifecycle triage → evidence_gathering', async () => {
    renderWithProviders(<ClaimInvestigationPage />);
    const modal = await openFirstInvestigation();
    fireEvent.click(within(modal).getByTestId('siu-to-evidence_gathering'));
    await waitFor(() => {
      expect(within(screen.getByTestId('siu-detail-modal')).getByText(/Evidence gathering/)).toBeInTheDocument();
    });
  });

  it('escalates to the SIU lead', async () => {
    renderWithProviders(<ClaimInvestigationPage />);
    const modal = await openFirstInvestigation();
    fireEvent.click(within(modal).getByTestId('siu-escalate'));
    await waitFor(() => {
      expect(within(screen.getByTestId('siu-detail-modal')).getByText(/Escalated/)).toBeInTheDocument();
    });
  });
});
