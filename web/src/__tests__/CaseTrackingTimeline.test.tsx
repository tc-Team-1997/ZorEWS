// Vitest for the per-case clickable tracking timeline (BAC §3.1.5).
//
// Coverage:
//   1. Renders cards for STATUS_CHANGE / COMMENT / ATTACHMENT /
//      ASSIGNMENT_CHANGE / ESCALATION (5 history-backed types).
//   2. Locked ATTACHMENT renders as disabled with the tooltip reason.
//   3. STATUS_CHANGE click opens the detail modal.
//   4. CAS / CAP stub clicks navigate to /cms/cases/:id/causal-analysis
//      and /cms/cases/:id/cap.
//   5. URL ?tracking=eventId auto-opens the matching event on mount.
//   6. include-stubs toggle re-fetches with the flag.

import { describe, expect, it } from 'vitest';
import { Route, Routes, useLocation } from 'react-router-dom';
import { http, HttpResponse } from 'msw';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CaseTrackingTimeline } from '@/modules/cms/CaseTrackingTimeline';
import { server } from '@/mocks/server';
import { renderWithProviders } from './utils';
import type { TrackingEvent } from '@/modules/cms/api';

const CASE_ID = 'c-001';

function envelope<T>(body: T) {
  return {
    header: { status: 'SUCCESS', requestId: 'r-1', timestamp: new Date().toISOString() },
    body,
  };
}

const mkEvents = (): TrackingEvent[] => [
  {
    event_id: 'h-status',
    case_id: CASE_ID,
    type: 'STATUS_CHANGE',
    ts: '2026-05-09T12:00:00Z',
    actor: 'alice',
    linkable: true,
    payload: { from_status: 'OPEN', to_status: 'INVESTIGATING' },
  },
  {
    event_id: 'h-comment',
    case_id: CASE_ID,
    type: 'COMMENT',
    ts: '2026-05-09T11:00:00Z',
    actor: 'alice',
    linkable: true,
    payload: { note_id: 'n-1', snippet: 'Customer confirms hardship', is_internal: false },
    href: `/cms/cases/${CASE_ID}?tab=Investigation&note=n-1`,
  },
  {
    event_id: 'h-attach-locked',
    case_id: CASE_ID,
    type: 'ATTACHMENT',
    ts: '2026-05-09T10:00:00Z',
    actor: 'alice',
    linkable: false,
    locked: { reason: 'needs cases:download_attachment' },
    payload: {
      attachment_id: 'a-1',
      file_name: 'kyc.pdf',
      mime: 'application/pdf',
      size_bytes: 1234,
      change: 'added',
    },
  },
  {
    event_id: 'h-assign',
    case_id: CASE_ID,
    type: 'ASSIGNMENT_CHANGE',
    ts: '2026-05-09T09:00:00Z',
    actor: 'alice',
    linkable: true,
    payload: { assigned_from: null, assigned_to: 'bob' },
  },
  {
    event_id: 'h-esc',
    case_id: CASE_ID,
    type: 'ESCALATION',
    ts: '2026-05-09T08:00:00Z',
    actor: 'alice',
    linkable: true,
    payload: { reason: 'SLA breach imminent' },
  },
];

function mockTrackingResponse(items: TrackingEvent[], includeStubs: boolean) {
  const stubs: TrackingEvent[] = !includeStubs ? [] : [
    {
      event_id: 'stub-cas',
      case_id: CASE_ID,
      type: 'CAUSAL_ANALYSIS_UPDATE',
      ts: '1970-01-01T00:00:00.000Z',
      actor: 'system',
      linkable: true,
      payload: { stub: true, message: 'Cross-service feed pending' },
      href: `/cms/cases/${CASE_ID}/causal-analysis`,
    },
    {
      event_id: 'stub-cap',
      case_id: CASE_ID,
      type: 'CAP_UPDATE',
      ts: '1970-01-01T00:00:00.000Z',
      actor: 'system',
      linkable: true,
      payload: { stub: true, message: 'Cross-service feed pending' },
      href: `/cms/cases/${CASE_ID}/cap`,
    },
  ];
  return envelope({
    case_id: CASE_ID,
    items: [...items, ...stubs],
    total: items.length + stubs.length,
    generated_at: new Date().toISOString(),
  });
}

function installTrackingHandler(items: TrackingEvent[] = mkEvents()) {
  server.use(
    http.get(`/v1/cms/cases/${CASE_ID}/tracking`, ({ request }) => {
      const url = new URL(request.url);
      const includeStubs = url.searchParams.get('include_stubs') === 'true';
      return HttpResponse.json(mockTrackingResponse(items, includeStubs));
    }),
  );
}

// LocationProbe used to assert navigate() targets without mocking router.
function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="location" data-pathname={loc.pathname} data-search={loc.search} />;
}

function renderTimeline(initialPath = `/cms/cases/${CASE_ID}`) {
  return renderWithProviders(
    <Routes>
      <Route
        path="/cms/cases/:id"
        element={
          <>
            <CaseTrackingTimeline caseId={CASE_ID} />
            <LocationProbe />
          </>
        }
      />
      <Route path="/cms/cases/:id/causal-analysis" element={<LocationProbe />} />
      <Route path="/cms/cases/:id/cap" element={<LocationProbe />} />
    </Routes>,
    { route: initialPath },
  );
}

describe('CaseTrackingTimeline — initial render', () => {
  it('renders all 5 history-backed event cards', async () => {
    installTrackingHandler();
    renderTimeline();
    await waitFor(() =>
      expect(screen.getByTestId('tracking-list')).toBeInTheDocument(),
    );
    expect(screen.getByTestId('tracking-card-h-status')).toBeInTheDocument();
    expect(screen.getByTestId('tracking-card-h-comment')).toBeInTheDocument();
    expect(screen.getByTestId('tracking-card-h-attach-locked')).toBeInTheDocument();
    expect(screen.getByTestId('tracking-card-h-assign')).toBeInTheDocument();
    expect(screen.getByTestId('tracking-card-h-esc')).toBeInTheDocument();
  });

  it('locked ATTACHMENT card is disabled with lock icon + tooltip', async () => {
    installTrackingHandler();
    renderTimeline();
    const card = await screen.findByTestId('tracking-card-h-attach-locked');
    expect(card).toBeDisabled();
    expect(card).toHaveAttribute('title', expect.stringMatching(/Insufficient permission/));
    expect(screen.getByTestId('tracking-locked-h-attach-locked')).toBeInTheDocument();
  });

  it('shows empty-state when items[] is empty', async () => {
    installTrackingHandler([]);
    renderTimeline();
    await waitFor(() =>
      expect(screen.getByTestId('tracking-empty')).toBeInTheDocument(),
    );
  });
});

describe('CaseTrackingTimeline — click handlers', () => {
  it('STATUS_CHANGE click opens the detail modal', async () => {
    const user = userEvent.setup();
    installTrackingHandler();
    renderTimeline();
    await user.click(await screen.findByTestId('tracking-card-h-status'));
    const modal = await screen.findByTestId('tracking-modal-h-status');
    expect(modal).toBeInTheDocument();
    expect(modal).toHaveTextContent(/OPEN/);
    expect(modal).toHaveTextContent(/INVESTIGATING/);
  });

  it('ESCALATION modal shows the reason', async () => {
    const user = userEvent.setup();
    installTrackingHandler();
    renderTimeline();
    await user.click(await screen.findByTestId('tracking-card-h-esc'));
    const modal = await screen.findByTestId('tracking-modal-h-esc');
    expect(modal).toHaveTextContent(/SLA breach imminent/);
  });

  it('locked ATTACHMENT click is a no-op (no navigation, no modal)', async () => {
    const user = userEvent.setup();
    installTrackingHandler();
    renderTimeline();
    const probe = await screen.findByTestId('location');
    const startedAt = probe.getAttribute('data-pathname');
    const card = await screen.findByTestId('tracking-card-h-attach-locked');
    // disabled buttons swallow clicks; assert the URL didn't move
    await user.click(card).catch(() => undefined);
    const endedAt = screen.getByTestId('location').getAttribute('data-pathname');
    expect(endedAt).toBe(startedAt);
    expect(screen.queryByTestId('tracking-modal-h-attach-locked')).not.toBeInTheDocument();
  });

  it('CAUSAL_ANALYSIS_UPDATE stub navigates to /causal-analysis', async () => {
    const user = userEvent.setup();
    installTrackingHandler();
    renderTimeline();
    // Toggle stubs on to see the CAS card
    await user.click(await screen.findByTestId('tracking-include-stubs'));
    const card = await screen.findByTestId('tracking-card-stub-cas');
    await user.click(card);
    await waitFor(() => {
      expect(screen.getByTestId('location').getAttribute('data-pathname')).toBe(
        `/cms/cases/${CASE_ID}/causal-analysis`,
      );
    });
  });

  it('CAP_UPDATE stub navigates to /cap', async () => {
    const user = userEvent.setup();
    installTrackingHandler();
    renderTimeline();
    await user.click(await screen.findByTestId('tracking-include-stubs'));
    const card = await screen.findByTestId('tracking-card-stub-cap');
    await user.click(card);
    await waitFor(() => {
      expect(screen.getByTestId('location').getAttribute('data-pathname')).toBe(
        `/cms/cases/${CASE_ID}/cap`,
      );
    });
  });
});

describe('CaseTrackingTimeline — URL state', () => {
  it('?tracking=event_id auto-opens the matching event modal on mount', async () => {
    installTrackingHandler();
    renderTimeline(`/cms/cases/${CASE_ID}?tracking=h-status`);
    await waitFor(() =>
      expect(screen.getByTestId('tracking-modal-h-status')).toBeInTheDocument(),
    );
  });

  it('include-stubs toggle re-fetches with include_stubs=true', async () => {
    const user = userEvent.setup();
    installTrackingHandler();
    renderTimeline();
    await waitFor(() => screen.getByTestId('tracking-list'));
    // Stubs not visible by default
    expect(screen.queryByTestId('tracking-card-stub-cas')).not.toBeInTheDocument();
    await user.click(screen.getByTestId('tracking-include-stubs'));
    await waitFor(() => {
      expect(screen.getByTestId('tracking-card-stub-cas')).toBeInTheDocument();
    });
  });
});
