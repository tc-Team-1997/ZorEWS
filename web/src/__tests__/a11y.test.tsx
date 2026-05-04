import { describe, expect, it, beforeEach, vi, afterEach } from 'vitest';
import { Route, Routes } from 'react-router-dom';
import { act, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AppShell } from '@/components/layout/AppShell';
import { ReportsPage } from '@/modules/reports/ReportsPage';
import { renderWithProviders } from './utils';
import { useAuth } from '@/store/auth';

function authenticate() {
  useAuth.setState({
    status: 'authenticated',
    token: 't',
    user: { id: 'u-001', username: 'alice.admin', roles: ['admin'] },
  });
}

describe('accessibility', () => {
  it('AppShell renders a skip-to-main-content link targeting the main element', () => {
    authenticate();
    renderWithProviders(
      <Routes>
        <Route element={<AppShell />}>
          <Route path="/" element={<div>home</div>} />
        </Route>
      </Routes>,
    );
    const skip = screen.getByTestId('skip-to-main');
    expect(skip).toBeInTheDocument();
    expect(skip).toHaveAttribute('href', '#main-content');
    // The target exists with the matching id.
    expect(document.getElementById('main-content')).toBeInTheDocument();
  });

  it('AppShell main landmark is focusable for the skip-link to land on', () => {
    authenticate();
    renderWithProviders(
      <Routes>
        <Route element={<AppShell />}>
          <Route path="/" element={<div>home</div>} />
        </Route>
      </Routes>,
    );
    const main = document.getElementById('main-content')!;
    expect(main).toBeInTheDocument();
    expect(main.getAttribute('tabindex')).toBe('-1');
  });

  it('Idle warning modal moves focus to "Stay signed in" when it opens', async () => {
    import.meta.env.VITE_IDLE_MS = '600';
    import.meta.env.VITE_IDLE_WARN_MS = '300';
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      authenticate();
      renderWithProviders(
        <Routes>
          <Route element={<AppShell />}>
            <Route path="/" element={<div>home</div>} />
          </Route>
        </Routes>,
      );
      await act(async () => {
        vi.advanceTimersByTime(400);
      });
      const stayBtn = await screen.findByTestId('idle-stay');
      expect(document.activeElement).toBe(stayBtn);
    } finally {
      vi.useRealTimers();
      delete import.meta.env.VITE_IDLE_MS;
      delete import.meta.env.VITE_IDLE_WARN_MS;
    }
  });

  it('Reports download menu closes on Escape and returns focus to the trigger', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ReportsPage />);
    await screen.findByTestId('report-body');

    const trigger = screen.getByTestId('download-menu-trigger');
    await user.click(trigger);
    expect(screen.getByTestId('download-menu')).toBeInTheDocument();

    await user.keyboard('{Escape}');
    expect(screen.queryByTestId('download-menu')).not.toBeInTheDocument();
    expect(document.activeElement).toBe(trigger);
  });
});

afterEach(() => {
  // Clean up any forced auth state so other suites start fresh.
});

beforeEach(() => {
  // No-op — left for symmetry with the test setup file's afterEach reset.
});
