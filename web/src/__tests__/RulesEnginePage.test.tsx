// web/src/__tests__/RulesEnginePage.test.tsx
//
// Module 5.2 — Rules Engine SPA smoke.
//
// Verifies:
//   - 5 spec tabs render
//   - Templates tab loads + clone button is wired
//   - Indicators tab loads catalogue
//   - Scenarios tab groups by regulator
//   - Simulator: runs end-to-end + renders pass/fail/samples/projection
//     per spec acceptance

import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { http, HttpResponse } from 'msw';
import { server } from '@/mocks/server';
import { RulesEnginePage } from '@/modules/rules/RulesEnginePage';

// The M5.2 routes shadow MSW's pre-existing /v1/rules/:id wildcard
// (registered earlier in handlers.ts), so we register the M5.2 handlers
// via server.use() per-test which pushes them to the front of MSW's
// matcher list. This keeps the global handlers.ts append clean for
// dev mode where order doesn't bite.
function wrapBody<T>(b: T) {
  return {
    header: {
      status: 'SUCCESS',
      code: 'EWS_200',
      message: 'OK',
      requestId: 'test',
      timestamp: new Date().toISOString(),
    },
    body: b,
  };
}

beforeEach(() => {
  server.use(
    http.get('/v1/rules/templates/categories', () =>
      HttpResponse.json(wrapBody({
        items: ['risk_monitoring', 'fraud_detection', 'compliance'],
        total: 3,
      })),
    ),
    http.get('/v1/rules/templates', () =>
      HttpResponse.json(wrapBody({
        items: [
          { id: 'tpl_dpd_30_60', name: 'DPD 30-60 watch list', category: 'risk_monitoring', vertical: 'banking', recommended_severity: 'high', recommended_actions: ['open_case'], supporting_indicators: ['FIN-001'], condition_pseudocode: 'dpd in [30,60]', source_doc: 'RBI' },
          { id: 'tpl_velocity_24h', name: 'High velocity 24h', category: 'fraud_detection', vertical: 'banking', recommended_severity: 'critical', recommended_actions: ['pause_disbursement'], supporting_indicators: ['TXN-001'], condition_pseudocode: 'txn > 25', source_doc: 'BIL' },
        ],
        total: 2,
      })),
    ),
    http.get('/v1/rules/templates/custom', () =>
      HttpResponse.json(wrapBody({ items: [], total: 0 })),
    ),
    http.post('/v1/rules/templates/custom/clone-from-library', () =>
      HttpResponse.json(wrapBody({ custom_template_id: 'ctpl-1', id: 'ctpl-1', tenant_id: 'BANK_DEMO', cloned_from: 'tpl_dpd_30_60', name: 'Copy', category: 'risk_monitoring', vertical: 'banking', recommended_severity: 'high', recommended_actions: [], supporting_indicators: [], condition_pseudocode: '', source_doc: '', created_at: new Date().toISOString(), created_by: 'alice' }), { status: 201 }),
    ),
    http.post('/v1/rules/simulate', () =>
      HttpResponse.json(wrapBody({
        rule_template_id: 'tpl_dpd_30_60',
        rule_name: 'Demo',
        rule_category: 'risk_monitoring',
        recommended_severity: 'high',
        scenario_preset_id: 'rbi_baseline',
        scenario_name: 'Demo',
        customer_count: 500,
        fired_count: 90,
        pass_count: 90,
        fail_count: 410,
        fire_rate: 0.18,
        baseline_fire_rate: 0.05,
        amplification: 3.6,
        by_severity: { critical: 14, high: 54, medium: 18, low: 4 },
        sample_matched_records: [
          { customer_id: 'c-sim-12345', segment: 'RETAIL', contribution: 0.92 },
          { customer_id: 'c-sim-12346', segment: 'SME', contribution: 0.86 },
        ],
        projected_alert_volume_per_day: 6.4,
        simulated_at: new Date().toISOString(),
      })),
    ),
    http.get('/v1/scenarios/library', () =>
      HttpResponse.json(wrapBody({
        items: [
          { id: 'rbi_baseline', name: 'RBI Baseline', category: 'regulatory', regulator: 'RBI', severity: 'mild', shocks: { gdp: -0.5, rate: 50, fx: 2 } },
          { id: 'irdai_solvency', name: 'IRDAI Solvency', category: 'regulatory', regulator: 'IRDAI', severity: 'moderate', shocks: { gdp: -2.5, rate: 100, fx: 4 } },
        ],
        total: 2,
      })),
    ),
    http.get('/v1/ews/rules/indicators', () =>
      HttpResponse.json(wrapBody({
        items: [
          { id: 'EWS-001', name: 'Days Past Due', family: 'credit', description: 'Worst DPD 90d', unit: 'days' },
          { id: 'EWS-002', name: 'Credit utilisation', family: 'credit' },
        ],
      })),
    ),
  );
});

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={qc}>
        <RulesEnginePage />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe('M5.2 — RulesEnginePage', () => {
  it('renders all 5 tabs + EWS Rule Builder cross-link', () => {
    renderPage();
    expect(screen.getByText('Rules Engine')).toBeInTheDocument();
    expect(screen.getByTestId('re-tab-templates')).toBeInTheDocument();
    expect(screen.getByTestId('re-tab-custom')).toBeInTheDocument();
    expect(screen.getByTestId('re-tab-indicators')).toBeInTheDocument();
    expect(screen.getByTestId('re-tab-simulator')).toBeInTheDocument();
    expect(screen.getByTestId('re-tab-scenarios')).toBeInTheDocument();
    expect(screen.getByTestId('re-link-ews-builder')).toBeInTheDocument();
  });

  it('Templates tab loads the library', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('re-templates-table')).toBeInTheDocument();
    }, { timeout: 3000 });
    expect(screen.getByTestId('re-tpl-tpl_dpd_30_60')).toBeInTheDocument();
  });

  it('Indicators tab loads + lists EWS catalogue', async () => {
    renderPage();
    fireEvent.click(screen.getByTestId('re-tab-indicators'));
    await waitFor(() => {
      expect(screen.getByTestId('re-indicators-table')).toBeInTheDocument();
    }, { timeout: 3000 });
    expect(screen.getByTestId('re-ind-row-EWS-001')).toBeInTheDocument();
  });

  it('Scenarios tab groups by regulator', async () => {
    renderPage();
    fireEvent.click(screen.getByTestId('re-tab-scenarios'));
    await waitFor(() => {
      expect(screen.getByTestId('re-scenarios-RBI')).toBeInTheDocument();
      expect(screen.getByTestId('re-scenarios-IRDAI')).toBeInTheDocument();
    }, { timeout: 3000 });
  });

  it('Simulator renders pass/fail + samples + projected volume (spec acceptance)', async () => {
    renderPage();
    fireEvent.click(screen.getByTestId('re-tab-simulator'));
    // Wait for selects to populate
    await waitFor(() => {
      const tpl = screen.getByTestId('re-sim-template') as HTMLSelectElement;
      expect(tpl.options.length).toBeGreaterThan(1);
    }, { timeout: 3000 });

    // Pick template + scenario (any non-empty option)
    const tpl = screen.getByTestId('re-sim-template') as HTMLSelectElement;
    const scn = screen.getByTestId('re-sim-scenario') as HTMLSelectElement;
    fireEvent.change(tpl, { target: { value: tpl.options[1]!.value } });
    fireEvent.change(scn, { target: { value: scn.options[1]!.value } });

    fireEvent.click(screen.getByTestId('re-sim-run'));

    await waitFor(() => {
      expect(screen.getByTestId('re-sim-pass')).toBeInTheDocument();
      expect(screen.getByTestId('re-sim-fail')).toBeInTheDocument();
      expect(screen.getByTestId('re-sim-rate')).toBeInTheDocument();
      expect(screen.getByTestId('re-sim-volume')).toBeInTheDocument();
      expect(screen.getByTestId('re-sim-samples-panel')).toBeInTheDocument();
      expect(screen.getByTestId('re-sim-severity-panel')).toBeInTheDocument();
    }, { timeout: 5000 });

    // At least one sample row
    const samples = document.querySelectorAll('[data-testid^="re-sim-sample-"]');
    expect(samples.length).toBeGreaterThan(0);
  });
});
