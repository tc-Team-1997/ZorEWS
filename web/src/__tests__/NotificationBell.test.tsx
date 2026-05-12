import { describe, expect, it } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NotificationBell } from '@/components/notifications/NotificationBell';
import { renderWithProviders } from './utils';

interface MockESInstance {
  emit(eventName: string, data: unknown): void;
  close(): void;
  closed: boolean;
  dispatchEvent(ev: Event): boolean;
}

function getES(): MockESInstance {
  // The setup.ts polyfill exposes MockEventSource on globalThis.
  const cls = (globalThis as { MockEventSource?: { lastInstance: MockESInstance | null } })
    .MockEventSource;
  if (!cls?.lastInstance) throw new Error('MockEventSource not initialised');
  return cls.lastInstance;
}

// Some bell tests assert the unread badge transitions on SSE events.
// The badge value = unread SSE events + count of ACTIVE case scenarios
// (so the bell shows non-zero on a fresh login). Helper to read the
// current badge text (or 0 when the badge is absent).
function readBadge(): number {
  const el = screen.queryByTestId('notification-unread-badge');
  if (!el) return 0;
  const txt = el.textContent ?? '';
  if (txt === '9+') return 10; // good enough for asserting +1
  return Number(txt) || 0;
}

describe('NotificationBell', () => {
  it('mounts the bell and surfaces the active-scenarios count badge', async () => {
    renderWithProviders(<NotificationBell />);
    expect(screen.getByTestId('notification-bell')).toBeInTheDocument();
    // Wait for the EventSource to open + connection dot to flip green.
    await waitFor(() => {
      const dot = screen.getByTestId('notification-connection-dot');
      expect(dot.className).toMatch(/bg-success/);
    });
    // The MSW seed includes ACTIVE case scenarios so the badge renders
    // non-zero on first paint — that's the M14 feature surfacing.
    await waitFor(() => {
      expect(screen.getByTestId('notification-unread-badge')).toBeInTheDocument();
    });
  });

  it('increments the unread badge on each pushed notification', async () => {
    renderWithProviders(<NotificationBell />);
    await waitFor(() => {
      expect(screen.getByTestId('notification-connection-dot').className).toMatch(/bg-success/);
    });
    // Wait for the active-scenarios query to settle. The dropdown is
    // closed at this point, but the badge IS rendered when count > 0;
    // a stable badge is our signal that the query resolved.
    await waitFor(() => {
      expect(screen.getByTestId('notification-unread-badge')).toBeInTheDocument();
    });
    const baseline = readBadge();
    act(() => {
      getES().emit('notification', {
        id: 'n-1',
        ts: '2026-04-29T12:00:00Z',
        level: 'info',
        title: 'first',
      });
    });
    await waitFor(() => {
      expect(readBadge()).toBe(baseline + 1);
    });
    act(() => {
      getES().emit('notification', {
        id: 'n-2',
        ts: '2026-04-29T12:01:00Z',
        level: 'warning',
        title: 'second',
      });
    });
    await waitFor(() => {
      expect(readBadge()).toBe(baseline + 2);
    });
  });

  it('opens the dropdown on click and clears the unread SSE portion of the badge', async () => {
    const user = userEvent.setup();
    renderWithProviders(<NotificationBell />);
    await waitFor(() => {
      expect(screen.getByTestId('notification-connection-dot').className).toMatch(/bg-success/);
    });
    await waitFor(() => {
      expect(screen.getByTestId('notification-unread-badge')).toBeInTheDocument();
    });
    const baseline = readBadge(); // active-scenarios floor
    act(() => {
      getES().emit('notification', {
        id: 'n-3',
        ts: '2026-04-29T12:02:00Z',
        level: 'success',
        title: 'cleared',
        body: 'opening dropdown clears me',
      });
    });
    await waitFor(() => {
      expect(readBadge()).toBe(baseline + 1);
    });

    await user.click(screen.getByTestId('notification-bell'));

    const dropdown = await screen.findByTestId('notification-dropdown');
    expect(within(dropdown).getByText(/cleared/i)).toBeInTheDocument();
    expect(within(dropdown).getByText(/opening dropdown clears me/i)).toBeInTheDocument();
    // The SSE-unread portion is cleared on open; badge drops back to
    // the active-scenarios baseline (which doesn't get cleared).
    await waitFor(() => {
      expect(readBadge()).toBe(baseline);
    });
  });

  it('dedupes by id — same notification published twice only counts once', async () => {
    renderWithProviders(<NotificationBell />);
    await waitFor(() => {
      expect(screen.getByTestId('notification-connection-dot').className).toMatch(/bg-success/);
    });
    await waitFor(() => {
      expect(screen.getByTestId('notification-unread-badge')).toBeInTheDocument();
    });
    const baseline = readBadge();
    const payload = {
      id: 'dup-1',
      ts: '2026-04-29T12:03:00Z',
      level: 'info',
      title: 'dedupe-me',
    };
    act(() => {
      getES().emit('notification', payload);
      getES().emit('notification', payload);
    });
    await waitFor(() => {
      expect(readBadge()).toBe(baseline + 1);
    });
  });

  it('shows empty SSE state + active-scenarios section when no live notifications', async () => {
    const user = userEvent.setup();
    renderWithProviders(<NotificationBell />);
    await waitFor(() => {
      expect(screen.getByTestId('notification-connection-dot').className).toMatch(/bg-success/);
    });
    await user.click(screen.getByTestId('notification-bell'));
    const dropdown = await screen.findByTestId('notification-dropdown');
    expect(within(dropdown).getByText(/No live notifications yet/i)).toBeInTheDocument();
    // The Currently-running-scenarios section is always present.
    expect(within(dropdown).getByTestId('notification-active-scenarios')).toBeInTheDocument();
  });

  it('renders the active-scenarios list with a count chip; rows link to /admin/case-scenarios', async () => {
    const user = userEvent.setup();
    renderWithProviders(<NotificationBell />);
    await user.click(screen.getByTestId('notification-bell'));
    const dropdown = await screen.findByTestId('notification-dropdown');
    // Wait for the active scenarios query to settle.
    await waitFor(() => {
      expect(within(dropdown).getByTestId('notification-active-scenarios-count').textContent)
        .not.toBe('…');
    });
    const count = Number(
      within(dropdown).getByTestId('notification-active-scenarios-count').textContent,
    );
    expect(count).toBeGreaterThan(0);
    // First active scenario row links to the admin page with ?focus=<id>.
    const firstLink = within(dropdown).getAllByTestId(/^notification-active-scenario-/)[0];
    expect(firstLink.getAttribute('href')).toMatch(
      /^\/admin\/case-scenarios\?focus=/,
    );
  });
});
