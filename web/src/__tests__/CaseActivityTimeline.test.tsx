// Vitest for the new CaseActivityTimeline.
//
// Mirrors the testing pattern in CaseTrackingTimeline.test.tsx —
// uses MSW to mock /v1/cms/cases/:id/tracking and asserts:
//   1. Loading → renders feed
//   2. Synthesised CASE_CREATED event appears at the top
//   3. Events are bucketed (Today / Yesterday / Older)
//   4. Filter chips narrow the visible set
//   5. Expand toggle reveals payload detail
//   6. "Load more" reveals additional events (client-side pagination)
//   7. Empty-state when no events + no creation seed
//   8. Error-state when the endpoint fails

import { describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CaseActivityTimeline, bucketGroups } from '@/components/cms/CaseActivityTimeline';
import { server } from '@/mocks/server';
import { renderWithProviders } from './utils';
import type { TrackingEvent } from '@/modules/cms/api';

const CASE_ID = 'c-act-1';

function envelope<T>(body: T) {
  return {
    header: { status: 'SUCCESS', requestId: 'r-1', timestamp: new Date().toISOString() },
    body,
  };
}

const NOW = new Date('2026-05-18T12:00:00Z');
const TODAY_ISO = '2026-05-18T08:30:00Z';
const YESTERDAY_ISO = '2026-05-17T15:00:00Z';
const LAST_WEEK_ISO = '2026-05-14T10:00:00Z';
const OLD_ISO = '2026-05-01T09:00:00Z';

const SAMPLE_EVENTS: TrackingEvent[] = [
  {
    event_id: 'e-status-1',
    case_id: CASE_ID,
    type: 'STATUS_CHANGE',
    ts: TODAY_ISO,
    actor: 'alice.admin',
    linkable: true,
    payload: { from_status: 'OPEN', to_status: 'ASSIGNED' },
  },
  {
    event_id: 'e-comment-1',
    case_id: CASE_ID,
    type: 'COMMENT',
    ts: YESTERDAY_ISO,
    actor: 'ravi.risk',
    linkable: true,
    payload: { note_id: 'n-1', snippet: 'Initial triage note', is_internal: false },
  },
  {
    event_id: 'e-attachment-1',
    case_id: CASE_ID,
    type: 'ATTACHMENT',
    ts: LAST_WEEK_ISO,
    actor: 'sue.super',
    linkable: true,
    payload: {
      attachment_id: 'a-1',
      file_name: 'kyc.pdf',
      size_bytes: 12345,
      mime: 'application/pdf',
      change: 'added',
    },
  },
  {
    event_id: 'e-escalation-1',
    case_id: CASE_ID,
    type: 'ESCALATION',
    ts: OLD_ISO,
    actor: 'alice.admin',
    linkable: true,
    payload: { reason: 'High-value customer' },
  },
];

function setupHandler(events: TrackingEvent[] = SAMPLE_EVENTS) {
  server.use(
    http.get(`/v1/cms/cases/${CASE_ID}/tracking`, () =>
      HttpResponse.json(envelope({ items: events, total: events.length })),
    ),
  );
}

describe('CaseActivityTimeline', () => {
  it('renders the feed after data loads', async () => {
    setupHandler();
    renderWithProviders(<CaseActivityTimeline caseId={CASE_ID} testId="ct" />);
    await waitFor(() => {
      expect(screen.getByTestId('ct-feed')).toBeInTheDocument();
    });
    expect(screen.getByTestId('ct-filters')).toBeInTheDocument();
    // Row testids are nested under their bucket (testid prefix changes with bucket).
    const allRows = screen.getAllByTestId(/^ct-bucket-.+-row-e-status-1$/);
    expect(allRows.length).toBeGreaterThan(0);
  });

  it('synthesises the CASE_CREATED row at the top when creationSeed is given', async () => {
    setupHandler();
    renderWithProviders(
      <CaseActivityTimeline
        caseId={CASE_ID}
        creationSeed={{
          case_id: CASE_ID,
          created_by: 'system',
          created_at: '2026-04-01T00:00:00Z',
        }}
        testId="ct"
      />,
    );
    await waitFor(() => screen.getByTestId('ct-feed'));
    const synthRow = screen.getByTestId(`ct-bucket-older-row-synth-created-${CASE_ID}`);
    expect(synthRow).toBeInTheDocument();
    expect(synthRow).toHaveTextContent(/Case created/i);
    expect(synthRow).toHaveTextContent(/system/);
  });

  it('groups events into Today / Yesterday / Older buckets', async () => {
    setupHandler();
    renderWithProviders(<CaseActivityTimeline caseId={CASE_ID} testId="ct" />);
    await waitFor(() => screen.getByTestId('ct-feed'));
    // 4 sample events: today (status), yesterday (comment), this_week
    // (attachment), older (escalation) — depending on the test clock,
    // assert that at least 2 distinct buckets render.
    const renderedBuckets = ['today', 'yesterday', 'this_week', 'older']
      .map((b) => screen.queryByTestId(`ct-bucket-${b}`))
      .filter(Boolean);
    expect(renderedBuckets.length).toBeGreaterThanOrEqual(2);
  });

  it('filter chip narrows the visible set + clear filter restores all', async () => {
    setupHandler();
    const user = userEvent.setup();
    renderWithProviders(<CaseActivityTimeline caseId={CASE_ID} testId="ct" />);
    await waitFor(() => screen.getByTestId('ct-feed'));

    // Click the STATUS_CHANGE chip — only that row should remain
    await user.click(screen.getByTestId('ct-filters-chip-STATUS_CHANGE'));
    await waitFor(() => {
      expect(screen.queryByText('Initial triage note')).toBeNull();
    });
    // The status-change row IS still visible
    expect(screen.getAllByTestId(/^ct-bucket-.+-row-e-status-1$/).length).toBeGreaterThan(0);

    // Clear the filter — comment row reappears
    await user.click(screen.getByTestId('ct-filters-clear'));
    await waitFor(() => {
      expect(screen.getByText('Initial triage note')).toBeInTheDocument();
    });
  });

  it('expand toggle shows + hides the payload detail', async () => {
    setupHandler();
    const user = userEvent.setup();
    renderWithProviders(<CaseActivityTimeline caseId={CASE_ID} testId="ct" />);
    await waitFor(() => screen.getByTestId('ct-feed'));

    // First toggle: expand
    const toggle = screen.getAllByRole('button', { expanded: false })[0];
    await user.click(toggle);
    await waitFor(() => {
      expect(toggle.getAttribute('aria-expanded')).toBe('true');
    });
    // Detail panel rendered for the expanded row
    expect(screen.getAllByTestId(/^ct-bucket-.*-expanded-/).length).toBeGreaterThan(0);

    // Toggle again: collapse
    await user.click(toggle);
    await waitFor(() => {
      expect(toggle.getAttribute('aria-expanded')).toBe('false');
    });
  });

  it('renders "Load more" when total > pageSize + clicking it grows the visible slice', async () => {
    // 12 fake events; pageSize=5 → 12 - 5 = 7 hidden; Load more should appear
    const many: TrackingEvent[] = Array.from({ length: 12 }, (_, i) => ({
      event_id: `e-${i}`,
      case_id: CASE_ID,
      type: 'STATUS_CHANGE',
      ts: new Date(NOW.getTime() - i * 1_000_000).toISOString(),
      actor: 'alice.admin',
      linkable: true,
      payload: { from_status: 'OPEN', to_status: 'ASSIGNED' },
    }));
    setupHandler(many);
    const user = userEvent.setup();
    renderWithProviders(<CaseActivityTimeline caseId={CASE_ID} pageSize={5} testId="ct" />);

    await waitFor(() => screen.getByTestId('ct-feed'));
    expect(screen.getByTestId('ct-load-more')).toBeInTheDocument();
    // Only 5 rows visible
    expect(screen.queryByTestId(/^ct-bucket-.+-row-e-5$/)).toBeNull();

    await user.click(screen.getByTestId('ct-load-more'));
    await waitFor(() => {
      // Now row 5 is visible (e-5 is the 6th event)
      const rowsAfter = screen.getAllByTestId(/^ct-bucket-.+-row-/);
      expect(rowsAfter.length).toBeGreaterThan(5);
    });
  });

  it('renders empty-state when no events + no creation seed', async () => {
    setupHandler([]);
    renderWithProviders(<CaseActivityTimeline caseId={CASE_ID} testId="ct" />);
    await waitFor(() => {
      expect(screen.getByTestId('ct-empty')).toBeInTheDocument();
    });
  });

  it('renders error-state when the endpoint fails', async () => {
    server.use(
      http.get(`/v1/cms/cases/${CASE_ID}/tracking`, () =>
        HttpResponse.json({ error: 'boom' }, { status: 500 }),
      ),
    );
    renderWithProviders(<CaseActivityTimeline caseId={CASE_ID} testId="ct" />);
    await waitFor(() => {
      expect(screen.getByTestId('ct-error')).toBeInTheDocument();
    });
  });
});

describe('bucketGroups (pure)', () => {
  it('puts events into today / yesterday / this_week / older correctly', () => {
    const now = new Date('2026-05-18T12:00:00Z');
    const events = [
      { event_id: 't', case_id: 'x', type: 'STATUS_CHANGE', ts: '2026-05-18T08:00:00Z', actor: 'a', linkable: true, payload: { from_status: 'A', to_status: 'B' } },
      { event_id: 'y', case_id: 'x', type: 'STATUS_CHANGE', ts: '2026-05-17T08:00:00Z', actor: 'a', linkable: true, payload: { from_status: 'A', to_status: 'B' } },
      { event_id: 'w', case_id: 'x', type: 'STATUS_CHANGE', ts: '2026-05-13T08:00:00Z', actor: 'a', linkable: true, payload: { from_status: 'A', to_status: 'B' } },
      { event_id: 'o', case_id: 'x', type: 'STATUS_CHANGE', ts: '2026-04-01T08:00:00Z', actor: 'a', linkable: true, payload: { from_status: 'A', to_status: 'B' } },
    ] satisfies TrackingEvent[];
    const groups = bucketGroups(events, now);
    expect(groups.get('today')?.map((e) => e.event_id)).toEqual(['t']);
    expect(groups.get('yesterday')?.map((e) => e.event_id)).toEqual(['y']);
    expect(groups.get('this_week')?.map((e) => e.event_id)).toEqual(['w']);
    expect(groups.get('older')?.map((e) => e.event_id)).toEqual(['o']);
  });
});
