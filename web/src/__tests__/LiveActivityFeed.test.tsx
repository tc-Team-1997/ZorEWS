// Smoke test for the home-dashboard LiveActivityFeed.
//
// Verifies the empty + populated states + typed row classification
// (alert.created vs case.assigned land in different rows with the
// right `data-event-type` attribute).

import { describe, expect, it } from 'vitest';
import { act, screen, waitFor } from '@testing-library/react';
import { LiveActivityFeed } from '@/components/dashboard/LiveActivityFeed';
import { renderWithProviders } from './utils';

interface MockESInstance {
  emit(eventName: string, data: unknown): void;
}
function getES(): MockESInstance {
  const cls = (globalThis as { MockEventSource?: { lastInstance: MockESInstance | null } })
    .MockEventSource;
  if (!cls?.lastInstance) throw new Error('MockEventSource not initialised');
  return cls.lastInstance;
}

describe('LiveActivityFeed', () => {
  it('shows empty-state copy until the first event arrives', async () => {
    renderWithProviders(<LiveActivityFeed />);
    expect(
      screen.getByText(/No activity yet/i),
    ).toBeInTheDocument();
  });

  it('flips to "Live" when the EventSource opens', async () => {
    renderWithProviders(<LiveActivityFeed />);
    await waitFor(() => {
      expect(screen.getByTestId('live-activity-status')).toHaveTextContent(/Live/);
    });
  });

  it('renders typed rows for alert.created + case.assigned in arrival order', async () => {
    renderWithProviders(<LiveActivityFeed />);
    await waitFor(() => {
      expect(screen.getByTestId('live-activity-status')).toHaveTextContent(/Live/);
    });

    act(() => {
      getES().emit('notification', {
        id: 'a-1',
        ts: new Date().toISOString(),
        level: 'warning',
        title: 'New high-risk alert · CUST-1',
        type: 'alert.created',
        href: '/alerts',
      });
      getES().emit('notification', {
        id: 'c-1',
        ts: new Date().toISOString(),
        level: 'info',
        title: 'Case 42 assigned to jane',
        type: 'case.assigned',
        href: '/cms/cases/42',
      });
    });

    const list = await screen.findByTestId('live-activity-list');
    const rows = list.querySelectorAll('[data-event-type]');
    expect(rows.length).toBe(2);
    // Newest first
    expect(rows[0].getAttribute('data-event-type')).toBe('case.assigned');
    expect(rows[1].getAttribute('data-event-type')).toBe('alert.created');
  });

  it('caps the visible list at MAX_VISIBLE = 8', async () => {
    renderWithProviders(<LiveActivityFeed />);
    await waitFor(() => {
      expect(screen.getByTestId('live-activity-status')).toHaveTextContent(/Live/);
    });
    act(() => {
      for (let i = 0; i < 12; i++) {
        getES().emit('notification', {
          id: `n-${i}`,
          ts: new Date(Date.now() - i * 1000).toISOString(),
          level: 'info',
          title: `Event ${i}`,
          type: 'system',
        });
      }
    });
    await waitFor(() => {
      const list = screen.getByTestId('live-activity-list');
      expect(list.querySelectorAll('[data-event-type]').length).toBe(8);
    });
  });
});
