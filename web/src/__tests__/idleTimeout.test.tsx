import { describe, expect, it, beforeEach, vi, afterEach } from 'vitest';
import { Route, Routes } from 'react-router-dom';
import { act, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AppShell } from '@/components/layout/AppShell';
import { LoginPage } from '@/modules/auth/LoginPage';
import { renderWithProviders } from './utils';
import { useAuth } from '@/store/auth';

// Shorten the idle window for tests so timers are practical. The AppShell
// reads these via import.meta.env.VITE_IDLE_MS / VITE_IDLE_WARN_MS — we
// stub them on the global env before the component renders.
beforeEach(() => {
  import.meta.env.VITE_IDLE_MS = '1000';
  import.meta.env.VITE_IDLE_WARN_MS = '300';
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.useRealTimers();
  delete import.meta.env.VITE_IDLE_MS;
  delete import.meta.env.VITE_IDLE_WARN_MS;
});

function authenticate() {
  useAuth.setState({
    status: 'authenticated',
    token: 't',
    user: { id: 'u-001', username: 'alice.admin', roles: ['admin'] },
  });
}

describe('idle timeout', () => {
  it('shows the warning modal once warnBeforeMs window opens', async () => {
    authenticate();
    renderWithProviders(
      <Routes>
        <Route element={<AppShell />}>
          <Route path="/" element={<div>home</div>} />
        </Route>
        <Route path="/login" element={<LoginPage />} />
      </Routes>,
    );

    expect(screen.queryByTestId('idle-warning')).not.toBeInTheDocument();

    // Advance past warn threshold (1000 - 300 = 700ms) but not past timeout.
    await act(async () => {
      vi.advanceTimersByTime(750);
    });
    expect(screen.getByTestId('idle-warning')).toBeInTheDocument();
    // Still authenticated — modal is just a warning, not a sign-out.
    expect(useAuth.getState().status).toBe('authenticated');
  });

  it('"Stay signed in" extends the session and clears the warning', async () => {
    authenticate();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderWithProviders(
      <Routes>
        <Route element={<AppShell />}>
          <Route path="/" element={<div>home</div>} />
        </Route>
        <Route path="/login" element={<LoginPage />} />
      </Routes>,
    );

    await act(async () => {
      vi.advanceTimersByTime(750);
    });
    expect(screen.getByTestId('idle-warning')).toBeInTheDocument();

    await user.click(screen.getByTestId('idle-stay'));
    expect(screen.queryByTestId('idle-warning')).not.toBeInTheDocument();
    expect(useAuth.getState().status).toBe('authenticated');

    // Advance another 600ms — would have timed out without extend, but
    // the timer was reset so we're back in safe territory.
    await act(async () => {
      vi.advanceTimersByTime(600);
    });
    expect(screen.queryByTestId('idle-warning')).not.toBeInTheDocument();
    expect(useAuth.getState().status).toBe('authenticated');
  });

  it('after idleMs of inactivity, logs the user out and routes to /login?reason=idle', async () => {
    authenticate();
    renderWithProviders(
      <Routes>
        <Route element={<AppShell />}>
          <Route path="/" element={<div>home</div>} />
        </Route>
        <Route path="/login" element={<LoginPage />} />
      </Routes>,
    );

    await act(async () => {
      vi.advanceTimersByTime(1100); // past idleMs
    });

    expect(useAuth.getState().status).toBe('idle');
    expect(useAuth.getState().user).toBeNull();
    // The login page should be rendered with the idle banner.
    expect(await screen.findByTestId('idle-signout-banner')).toBeInTheDocument();
  });
});
