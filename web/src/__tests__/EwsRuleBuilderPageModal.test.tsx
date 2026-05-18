// Integration check that the New Rule fix renders the builder as a
// modal overlay (not inline below the rules list).
//
// The original "opens create form" test in EwsRuleBuilderPage.test.tsx
// remains valid (form labels still appear). This file locks in the
// MODAL specifics: backdrop, role=dialog, Escape close, X close.

import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EwsRuleBuilderPage } from '@/modules/rules/EwsRuleBuilderPage';
import { renderWithProviders } from './utils';
import { http } from '@/lib/http';

// Same minimal mock pattern the existing test file uses — return empty
// rules + a single indicator so CreateRuleForm renders without errors.
const RULES_FIXTURE = { items: [], total: 0 };
const INDICATORS_FIXTURE = [
  { name: 'dpd_days', type: 'number', range: { min: 0, max: 360 } },
];

function mockHttp() {
  vi.spyOn(http, 'get').mockImplementation(async (url: string) => {
    if (url.includes('/v1/ews/rules/indicators')) {
      return { data: INDICATORS_FIXTURE } as never;
    }
    if (url.includes('/v1/ews/rules')) {
      return { data: RULES_FIXTURE } as never;
    }
    return { data: {} } as never;
  });
}

describe('EwsRuleBuilderPage — New Rule modal', () => {
  it('clicking "New rule" opens a role="dialog" overlay (not inline)', async () => {
    mockHttp();
    const user = userEvent.setup();
    renderWithProviders(<EwsRuleBuilderPage />);
    await waitFor(() => screen.getByText('New rule'));

    expect(screen.queryByTestId('ews-rule-create-modal')).toBeNull();

    await user.click(screen.getByText('New rule'));
    await waitFor(() => {
      expect(screen.getByTestId('ews-rule-create-modal')).toBeInTheDocument();
    });
    const dialog = screen.getByRole('dialog', { name: /new ews rule/i });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    // The form lives INSIDE the dialog (was previously a sibling below)
    expect(dialog.contains(screen.getByText('rule_id'))).toBe(true);
  });

  it('Escape key closes the modal', async () => {
    mockHttp();
    const user = userEvent.setup();
    renderWithProviders(<EwsRuleBuilderPage />);
    await waitFor(() => screen.getByText('New rule'));
    await user.click(screen.getByText('New rule'));
    await waitFor(() => screen.getByTestId('ews-rule-create-modal'));

    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByTestId('ews-rule-create-modal')).toBeNull();
    });
  });

  it('backdrop click closes the modal but inner click does NOT', async () => {
    mockHttp();
    const user = userEvent.setup();
    renderWithProviders(<EwsRuleBuilderPage />);
    await waitFor(() => screen.getByText('New rule'));
    await user.click(screen.getByText('New rule'));
    await waitFor(() => screen.getByTestId('ews-rule-create-modal'));

    // Click inside the content first — should stay open
    fireEvent.click(screen.getByTestId('ews-rule-create-modal-content'));
    expect(screen.getByTestId('ews-rule-create-modal')).toBeInTheDocument();

    // Click the backdrop — should close
    fireEvent.click(screen.getByTestId('ews-rule-create-modal'));
    await waitFor(() => {
      expect(screen.queryByTestId('ews-rule-create-modal')).toBeNull();
    });
  });

  it('top-right X closes the modal', async () => {
    mockHttp();
    const user = userEvent.setup();
    renderWithProviders(<EwsRuleBuilderPage />);
    await waitFor(() => screen.getByText('New rule'));
    await user.click(screen.getByText('New rule'));
    await waitFor(() => screen.getByTestId('ews-rule-create-modal'));

    fireEvent.click(screen.getByTestId('ews-rule-create-modal-close'));
    await waitFor(() => {
      expect(screen.queryByTestId('ews-rule-create-modal')).toBeNull();
    });
  });

  it('clicking the form\'s own Cancel button still closes the modal', async () => {
    // Verifies CreateRuleForm internals were NOT changed — its
    // onCancel prop still drives setShowCreate(false) which unmounts
    // the modal wrapper.
    mockHttp();
    const user = userEvent.setup();
    renderWithProviders(<EwsRuleBuilderPage />);
    await waitFor(() => screen.getByText('New rule'));
    await user.click(screen.getByText('New rule'));
    await waitFor(() => screen.getByTestId('ews-rule-create-modal'));

    const cancelButtons = screen.getAllByText('Cancel');
    await user.click(cancelButtons[0]);
    await waitFor(() => {
      expect(screen.queryByTestId('ews-rule-create-modal')).toBeNull();
    });
  });
});
