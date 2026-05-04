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

describe('NotificationBell', () => {
  it('mounts the bell with no unread badge initially', async () => {
    renderWithProviders(<NotificationBell />);
    expect(screen.getByTestId('notification-bell')).toBeInTheDocument();
    expect(screen.queryByTestId('notification-unread-badge')).not.toBeInTheDocument();
    // Wait for the EventSource to open + connection dot to flip green.
    await waitFor(() => {
      const dot = screen.getByTestId('notification-connection-dot');
      expect(dot.className).toMatch(/bg-success/);
    });
  });

  it('increments the unread badge on each pushed notification', async () => {
    renderWithProviders(<NotificationBell />);
    await waitFor(() => {
      expect(screen.getByTestId('notification-connection-dot').className).toMatch(/bg-success/);
    });
    act(() => {
      getES().emit('notification', {
        id: 'n-1',
        ts: '2026-04-29T12:00:00Z',
        level: 'info',
        title: 'first',
      });
    });
    expect(await screen.findByTestId('notification-unread-badge')).toHaveTextContent('1');
    act(() => {
      getES().emit('notification', {
        id: 'n-2',
        ts: '2026-04-29T12:01:00Z',
        level: 'warning',
        title: 'second',
      });
    });
    await waitFor(() => {
      expect(screen.getByTestId('notification-unread-badge')).toHaveTextContent('2');
    });
  });

  it('opens the dropdown on click and clears the unread badge', async () => {
    const user = userEvent.setup();
    renderWithProviders(<NotificationBell />);
    await waitFor(() => {
      expect(screen.getByTestId('notification-connection-dot').className).toMatch(/bg-success/);
    });
    act(() => {
      getES().emit('notification', {
        id: 'n-3',
        ts: '2026-04-29T12:02:00Z',
        level: 'success',
        title: 'cleared',
        body: 'opening dropdown clears me',
      });
    });
    expect(await screen.findByTestId('notification-unread-badge')).toBeInTheDocument();

    await user.click(screen.getByTestId('notification-bell'));

    const dropdown = await screen.findByTestId('notification-dropdown');
    expect(within(dropdown).getByText(/cleared/i)).toBeInTheDocument();
    expect(within(dropdown).getByText(/opening dropdown clears me/i)).toBeInTheDocument();
    // Badge gone now that dropdown was opened.
    expect(screen.queryByTestId('notification-unread-badge')).not.toBeInTheDocument();
  });

  it('dedupes by id — same notification published twice only counts once', async () => {
    renderWithProviders(<NotificationBell />);
    await waitFor(() => {
      expect(screen.getByTestId('notification-connection-dot').className).toMatch(/bg-success/);
    });
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
      expect(screen.getByTestId('notification-unread-badge')).toHaveTextContent('1');
    });
  });

  it('shows empty state when no notifications', async () => {
    const user = userEvent.setup();
    renderWithProviders(<NotificationBell />);
    await waitFor(() => {
      expect(screen.getByTestId('notification-connection-dot').className).toMatch(/bg-success/);
    });
    await user.click(screen.getByTestId('notification-bell'));
    const dropdown = await screen.findByTestId('notification-dropdown');
    expect(within(dropdown).getByText(/No notifications yet/i)).toBeInTheDocument();
  });
});
