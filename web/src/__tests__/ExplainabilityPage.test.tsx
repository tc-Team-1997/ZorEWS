// web/src/__tests__/ExplainabilityPage.test.tsx
//
// Module 4.3 — Explainability page smoke.
//
// Covers the visible-state assertions that matter for the spec acceptance:
//   - Empty state until prediction_id entered
//   - Sample Explanation + Trust Signals render once a pid loads
//   - 410 expired path surfaces a clear error to the operator
//   - Help card toggles on/off

import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { ExplainabilityPage } from '@/modules/ai/ExplainabilityPage';

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter initialEntries={['/ai/explainability']}>
      <QueryClientProvider client={qc}>
        <ExplainabilityPage />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  // Reset DOM between tests
});

describe('M4.3 — ExplainabilityPage', () => {
  it('renders empty state when no prediction is selected', async () => {
    renderPage();
    expect(screen.getByText('Explainability')).toBeInTheDocument();
    expect(screen.getByTestId('ex-empty')).toBeInTheDocument();
  });

  it('shows the How-to-read card by default and toggles off', async () => {
    renderPage();
    expect(screen.getByTestId('ex-help-card')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('ex-toggle-help'));
    await waitFor(() => {
      expect(screen.queryByTestId('ex-help-card')).not.toBeInTheDocument();
    });
  });

  it('loads explanation + trust signals when a valid pid is entered', async () => {
    renderPage();
    const input = screen.getByTestId('ex-search-input');
    fireEvent.change(input, { target: { value: 'pred-fresh-001' } });
    fireEvent.click(screen.getByTestId('ex-search-btn'));

    await waitFor(() => {
      expect(screen.getByTestId('ex-sample-card')).toBeInTheDocument();
      expect(screen.getByTestId('ex-trust-card')).toBeInTheDocument();
    }, { timeout: 3000 });

    // KPI for the predicted PD is shown
    expect(screen.getByTestId('ex-kpi-pd')).toBeInTheDocument();
    // Export button surfaces once explanation is loaded
    expect(screen.getByTestId('ex-export-pdf')).toBeInTheDocument();
    // At least one feature bar rendered
    const bars = document.querySelectorAll('[data-testid^="ex-feature-bar-"]');
    expect(bars.length).toBeGreaterThan(0);
  });

  it('renders 410 expired error state for a too-old prediction', async () => {
    renderPage();
    fireEvent.change(screen.getByTestId('ex-search-input'), {
      target: { value: 'expired-xx' },
    });
    fireEvent.click(screen.getByTestId('ex-search-btn'));
    await waitFor(() => {
      expect(screen.getByTestId('ex-error')).toBeInTheDocument();
    }, { timeout: 3000 });
    // EWS_410 code is shown inside the error panel (scope query — the
    // string also appears in the "How to read this" help card, so use
    // within(panel) to disambiguate).
    const errorPanel = screen.getByTestId('ex-error');
    expect(
      within(errorPanel).getByText(/EWS_410_explanation_expired/),
    ).toBeInTheDocument();
    // 24-month-window hint surfaces only when the gate triggered.
    expect(
      within(errorPanel).getByText(/24-month audit window/),
    ).toBeInTheDocument();
  });

  it('opens the full feature importance modal', async () => {
    renderPage();
    fireEvent.change(screen.getByTestId('ex-search-input'), {
      target: { value: 'pred-modal-001' },
    });
    fireEvent.click(screen.getByTestId('ex-search-btn'));
    await waitFor(() => {
      expect(screen.getByTestId('ex-sample-card')).toBeInTheDocument();
    }, { timeout: 3000 });
    fireEvent.click(screen.getByTestId('ex-open-importance'));
    await waitFor(() => {
      expect(screen.getByTestId('ex-importance-modal')).toBeInTheDocument();
      expect(screen.getByTestId('ex-importance-table')).toBeInTheDocument();
    }, { timeout: 3000 });
  });

  // ── T7 M8 enhancement — prediction audit-action trail ─────────────────
  it('renders the prediction audit log trail when a prediction loads', async () => {
    renderPage();
    fireEvent.change(screen.getByTestId('ex-search-input'), { target: { value: 'pred-fresh-001' } });
    fireEvent.click(screen.getByTestId('ex-search-btn'));
    await waitFor(() => expect(screen.getByTestId('ex-audit-card')).toBeInTheDocument(), { timeout: 3000 });
    // the seeded trail surfaces the system 'created' + 'alert_triggered' events
    await waitFor(() => expect(screen.getByTestId('ex-audit-trail')).toBeInTheDocument(), { timeout: 3000 });
    expect(screen.getByTestId('ex-audit-row-alert_triggered')).toBeInTheDocument();
  });

  it('records an operator action and appends it to the trail', async () => {
    renderPage();
    fireEvent.change(screen.getByTestId('ex-search-input'), { target: { value: 'pred-fresh-001' } });
    fireEvent.click(screen.getByTestId('ex-search-btn'));
    await waitFor(() => expect(screen.getByTestId('ex-audit-trail')).toBeInTheDocument(), { timeout: 3000 });

    fireEvent.change(screen.getByTestId('ex-audit-action'), { target: { value: 'escalated' } });
    fireEvent.change(screen.getByTestId('ex-audit-note'), { target: { value: 'routing to SIU' } });
    fireEvent.click(screen.getByTestId('ex-audit-record'));

    await waitFor(() => {
      expect(within(screen.getByTestId('ex-audit-trail')).getByTestId('ex-audit-row-escalated')).toBeInTheDocument();
    }, { timeout: 3000 });
    expect(screen.getByText(/routing to SIU/)).toBeInTheDocument();
  });
});
