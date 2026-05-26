// web/src/__tests__/GlossaryPage.test.tsx
//
// M6.4 — Glossary SPA smoke.
//
// Covers:
//   - Page renders + lists platform seed
//   - Search filters list
//   - Category filter narrows results
//   - Admin "Add term" modal opens and submits a tenant term
//   - Edit + delete admin paths
//   - GlossaryTooltip resolves a term_id via the same backing API

import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, waitFor, within, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { GlossaryPage } from '@/modules/help/GlossaryPage';
import { GlossaryTooltip } from '@/components/help/GlossaryTooltip';
import { useAuth } from '@/store/auth';
import { __resetMswM64 } from '@/mocks/handlers';

function renderPage(initial = '/glossary') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter initialEntries={[initial]}>
      <QueryClientProvider client={qc}>
        <GlossaryPage />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

function renderTooltip(term_id: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={qc}>
        <GlossaryTooltip term_id={term_id} label="NPA" />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  __resetMswM64();
  useAuth.setState({
    user: {
      id: 'u-admin',
      username: 'alice.admin',
      roles: ['admin'],
    } as ReturnType<typeof useAuth.getState>['user'],
  });
});

describe('M6.4 — GlossaryPage', () => {
  it('GS-1 renders heading + KPI tiles + browses platform seed', async () => {
    renderPage();
    expect(screen.getByRole('heading', { name: /Glossary/i })).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByTestId('gl-kpi-total')).toBeInTheDocument();
    });
    // platform seed terms visible
    await waitFor(() => {
      expect(screen.getByTestId('gl-list-item-npa')).toBeInTheDocument();
      expect(screen.getByTestId('gl-list-item-shap')).toBeInTheDocument();
    });
    // detail panel shows the first match
    expect(screen.getByTestId('gl-detail-sma')).toBeInTheDocument();
  });

  it('GS-2 search filters list', async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => screen.getByTestId('gl-list-item-npa'));
    const input = screen.getByTestId('gl-search-input');
    await user.clear(input);
    await user.type(input, 'SHAP');
    await waitFor(() => {
      expect(screen.queryByTestId('gl-list-item-npa')).not.toBeInTheDocument();
      expect(screen.getByTestId('gl-list-item-shap')).toBeInTheDocument();
    });
  });

  it('GS-3 category filter narrows results', async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => screen.getByTestId('gl-list-item-npa'));
    await user.selectOptions(screen.getByTestId('gl-category-select'), 'ai_ml');
    await waitFor(() => {
      expect(screen.queryByTestId('gl-list-item-npa')).not.toBeInTheDocument();
      expect(screen.getByTestId('gl-list-item-shap')).toBeInTheDocument();
    });
  });

  it('GS-4 admin Add term modal submits a tenant term', async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => screen.getByTestId('gl-new-btn'));
    await user.click(screen.getByTestId('gl-new-btn'));
    await waitFor(() => expect(screen.getByTestId('gl-form-modal')).toBeInTheDocument());
    // Modal auto-focuses content on next tick, which interferes with
    // userEvent.type. Use fireEvent.change to set values directly — bypasses
    // focus management while still emitting React onChange.
    fireEvent.change(screen.getByTestId('gl-form-term-id'), { target: { value: 'bil_ews_score' } });
    fireEvent.change(screen.getByTestId('gl-form-term'), { target: { value: 'BIL EWS Score' } });
    fireEvent.change(screen.getByTestId('gl-form-definition'), {
      target: {
        value: 'BIL-specific composite early warning score combining DPD, utilization, and bureau drift.',
      },
    });
    await user.click(screen.getByTestId('gl-form-submit'));
    await waitFor(() => {
      expect(screen.queryByTestId('gl-form-modal')).not.toBeInTheDocument();
    });
    await waitFor(() => {
      expect(screen.getByTestId('gl-list-item-bil_ews_score')).toBeInTheDocument();
    });
  });

  it('GS-5 admin edit panel opens with the active term pre-filled', async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => screen.getByTestId('gl-list-item-npa'));
    await user.click(screen.getByTestId('gl-list-item-npa'));
    await waitFor(() => expect(screen.getByTestId('gl-detail-npa')).toBeInTheDocument());
    await user.click(screen.getByTestId('gl-edit-btn'));
    await waitFor(() => expect(screen.getByTestId('gl-form-modal')).toBeInTheDocument());
    const idInput = screen.getByTestId('gl-form-term-id') as HTMLInputElement;
    expect(idInput.value).toBe('npa');
    expect(idInput).toBeDisabled();
  });

  it('GS-6 non-admin sees no Add/Edit/Delete affordance', async () => {
    useAuth.setState({
      user: {
        id: 'u-analyst',
        username: 'bob.analyst',
        roles: ['risk_analyst'],
      } as ReturnType<typeof useAuth.getState>['user'],
    });
    renderPage();
    await waitFor(() => screen.getByTestId('gl-list-item-npa'));
    expect(screen.queryByTestId('gl-new-btn')).not.toBeInTheDocument();
    expect(screen.queryByTestId('gl-edit-btn')).not.toBeInTheDocument();
    expect(screen.queryByTestId('gl-delete-btn')).not.toBeInTheDocument();
  });
});

describe('M6.4 — GlossaryTooltip', () => {
  it('GT-1 renders the question-mark trigger', () => {
    renderTooltip('npa');
    expect(screen.getByTestId('glossary-tooltip-btn-npa')).toBeInTheDocument();
    expect(screen.queryByTestId('glossary-tooltip-panel-npa')).not.toBeInTheDocument();
  });

  it('GT-2 opens the panel + fetches the definition from /v1/glossary/terms/:id', async () => {
    const user = userEvent.setup();
    renderTooltip('npa');
    await user.click(screen.getByTestId('glossary-tooltip-btn-npa'));
    await waitFor(() => {
      expect(screen.getByTestId('glossary-tooltip-panel-npa')).toBeInTheDocument();
    });
    const panel = await screen.findByTestId('glossary-tooltip-panel-npa');
    await waitFor(() => {
      expect(within(panel).getByText(/Non-Performing Asset/i)).toBeInTheDocument();
    });
  });
});
