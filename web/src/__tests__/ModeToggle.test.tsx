// web/src/__tests__/ModeToggle.test.tsx
//
// G1 — covers the BANK / INSURANCE vertical mode toggle (Playbook H1).

import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ModeToggle } from '@/components/layout/ModeToggle';
import { getVerticalMode } from '@/lib/useVerticalMode';

beforeEach(() => {
  window.localStorage.removeItem('zorews.vertical');
});

describe('ModeToggle', () => {
  it('defaults to BANK when nothing is persisted', () => {
    render(<ModeToggle />);
    const bank = screen.getByTestId('mode-bank');
    const ins = screen.getByTestId('mode-insurance');
    expect(bank.getAttribute('aria-checked')).toBe('true');
    expect(ins.getAttribute('aria-checked')).toBe('false');
    expect(getVerticalMode()).toBe('bank');
  });

  it('clicking INSURANCE persists + flips aria-checked', async () => {
    const user = userEvent.setup();
    render(<ModeToggle />);
    await user.click(screen.getByTestId('mode-insurance'));
    expect(screen.getByTestId('mode-insurance').getAttribute('aria-checked')).toBe('true');
    expect(screen.getByTestId('mode-bank').getAttribute('aria-checked')).toBe('false');
    expect(window.localStorage.getItem('zorews.vertical')).toBe('insurance');
  });

  it('hydrates from localStorage on mount', () => {
    window.localStorage.setItem('zorews.vertical', 'insurance');
    render(<ModeToggle />);
    expect(screen.getByTestId('mode-insurance').getAttribute('aria-checked')).toBe('true');
  });

  it('cross-tab storage event updates the toggle', () => {
    render(<ModeToggle />);
    expect(screen.getByTestId('mode-bank').getAttribute('aria-checked')).toBe('true');
    // Simulate another tab writing to localStorage
    act(() => {
      window.localStorage.setItem('zorews.vertical', 'insurance');
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: 'zorews.vertical',
          newValue: 'insurance',
          oldValue: 'bank',
        }),
      );
    });
    expect(screen.getByTestId('mode-insurance').getAttribute('aria-checked')).toBe('true');
  });

  it('renders both options with their icons + labels', () => {
    render(<ModeToggle />);
    expect(screen.getByText('BANK')).toBeInTheDocument();
    expect(screen.getByText('INSURANCE')).toBeInTheDocument();
  });
});
