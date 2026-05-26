// web/src/__tests__/AuditTrailPage.test.tsx
//
// G2 — Compliance Audit Trail page (Monday Playbook H9).

import { describe, it, expect } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuditTrailPage } from '@/modules/admin/AuditTrailPage';

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <AuditTrailPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('AuditTrailPage', () => {
  it('renders header + 4 KPI tiles', async () => {
    renderPage();
    expect(screen.getByText('Audit Trail')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByTestId('audit-kpi-total')).toBeInTheDocument();
      expect(screen.getByTestId('audit-kpi-critical')).toBeInTheDocument();
      expect(screen.getByTestId('audit-kpi-denied')).toBeInTheDocument();
      expect(screen.getByTestId('audit-kpi-integrity')).toBeInTheDocument();
    });
  });

  it('shows filter controls + events table', async () => {
    renderPage();
    expect(screen.getByTestId('audit-filters')).toBeInTheDocument();
    expect(screen.getByTestId('audit-filter-actor')).toBeInTheDocument();
    expect(screen.getByTestId('audit-filter-resource')).toBeInTheDocument();
    expect(screen.getByTestId('audit-filter-outcome')).toBeInTheDocument();
    expect(screen.getByTestId('audit-filter-severity')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByTestId('audit-events-table')).toBeInTheDocument();
    });
  });

  it('row click opens detail modal with payload + hash chain', async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => screen.getByTestId('audit-events-table'));
    const firstRow = await screen.findByTestId('audit-row-aud-msw-001');
    await user.click(firstRow);
    await waitFor(() => {
      expect(screen.getByTestId('audit-detail-modal')).toBeInTheDocument();
      expect(screen.getByTestId('audit-payload-json')).toBeInTheDocument();
      expect(screen.getByTestId('audit-prev-hash')).toBeInTheDocument();
      expect(screen.getByTestId('audit-this-hash')).toBeInTheDocument();
    });
  });

  it('correlation-bearing event surfaces drill button', async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => screen.getByTestId('audit-events-table'));
    // event 004 has correlation_id='corr-c-115'
    await user.click(await screen.findByTestId('audit-row-aud-msw-004'));
    await waitFor(() => {
      expect(screen.getByTestId('audit-drill-correlation')).toBeInTheDocument();
    });
  });

  it('filter input narrows events table', async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => screen.getByTestId('audit-events-table'));
    await user.type(screen.getByTestId('audit-filter-actor'), 'alice');
    await waitFor(() => {
      // alice.admin actor → 2 rows (config.update + report.run) — both should be present
      expect(screen.getByTestId('audit-row-aud-msw-004')).toBeInTheDocument();
      expect(screen.getByTestId('audit-row-aud-msw-007')).toBeInTheDocument();
      // fiona.field's rows should NOT be in the filtered view
      expect(screen.queryByTestId('audit-row-aud-msw-002')).not.toBeInTheDocument();
    });
  });

  // ── M6.2 — Audit Trail: Evidence Packages + Retention Policies ────
  it('M6.2 evidence-packages panel renders + build modal opens', async () => {
    const user = userEvent.setup();
    renderPage();
    // The panel is below the events table; should render after load
    await waitFor(() => {
      expect(screen.getByTestId('audit-build-evidence-btn')).toBeInTheDocument();
    });
    // Click Build → modal opens with default filter form
    await user.click(screen.getByTestId('audit-build-evidence-btn'));
    await waitFor(() => {
      expect(screen.getByTestId('audit-evidence-modal')).toBeInTheDocument();
    });
    expect(screen.getByTestId('audit-evidence-form-actor')).toBeInTheDocument();
    expect(screen.getByTestId('audit-evidence-form-action')).toBeInTheDocument();
    expect(screen.getByTestId('audit-evidence-form-submit')).toBeInTheDocument();
  });

  it('M6.2 evidence-packages: submitting form creates a new package', async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('audit-build-evidence-btn')).toBeInTheDocument();
    });
    await user.click(screen.getByTestId('audit-build-evidence-btn'));
    await waitFor(() => {
      expect(screen.getByTestId('audit-evidence-modal')).toBeInTheDocument();
    });
    // Fill action filter and submit
    await user.type(screen.getByTestId('audit-evidence-form-action'), 'config.update');
    await user.click(screen.getByTestId('audit-evidence-form-submit'));
    // Modal closes + list shows ≥1 package
    await waitFor(() => {
      expect(screen.queryByTestId('audit-evidence-modal')).not.toBeInTheDocument();
    });
    await waitFor(() => {
      expect(screen.getByTestId('audit-evidence-list')).toBeInTheDocument();
    });
  });

  it('M6.2 retention-policies panel renders + new-policy modal opens', async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('audit-retention-new-btn')).toBeInTheDocument();
    });
    await user.click(screen.getByTestId('audit-retention-new-btn'));
    await waitFor(() => {
      expect(screen.getByTestId('audit-retention-modal')).toBeInTheDocument();
    });
    expect(screen.getByTestId('audit-retention-form-id')).toBeInTheDocument();
    expect(screen.getByTestId('audit-retention-form-strategy')).toBeInTheDocument();
    expect(screen.getByTestId('audit-retention-form-days')).toBeInTheDocument();
  });

  it('M6.2 retention-policies: submitting form creates a policy + lists it', async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('audit-retention-new-btn')).toBeInTheDocument();
    });
    await user.click(screen.getByTestId('audit-retention-new-btn'));
    await waitFor(() => {
      expect(screen.getByTestId('audit-retention-modal')).toBeInTheDocument();
    });
    // Form defaults are valid (policy_id is auto-generated, strategy=time_window,
    // retention_days=365). Just click submit.
    await user.click(screen.getByTestId('audit-retention-form-submit'));
    await waitFor(() => {
      expect(screen.queryByTestId('audit-retention-modal')).not.toBeInTheDocument();
    });
    await waitFor(() => {
      expect(screen.getByTestId('audit-retention-list')).toBeInTheDocument();
    });
  });
});
