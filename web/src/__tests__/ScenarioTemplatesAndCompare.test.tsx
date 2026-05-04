// Coverage for the next batch of scenario-page features:
//   - Pre-defined templates apply their inputs to the sliders
//   - Top-affected customer rows are clickable links to /customers/:id
//   - Segments × Risk Level heatmap renders one cell per segment+band
//   - Portfolio PD + NPA % KPI cards appear in the results
//   - Compare-2 selection from saved list renders the comparison panel
//
// Earlier files (ScenarioPage.test.tsx, ScenarioStageAndExport.test.tsx)
// cover sliders, output panel, IFRS 9 stage panels, save/load round-trip,
// CSV export. This file is additive.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ScenarioPage } from '@/modules/scenario/ScenarioPage';
import { renderWithProviders } from './utils';
import { saveScenario } from '@/lib/savedScenarios';
import type { ScenarioResult, ShockInputs } from '@/lib/api';

beforeEach(() => {
  localStorage.removeItem('apex.ews.saved_scenarios');
});

describe('ScenarioPage — pre-defined templates', () => {
  it('renders a button per template with the baseline pre-selected', () => {
    renderWithProviders(<ScenarioPage />);
    const row = screen.getByTestId('scenario-templates');
    expect(within(row).getByTestId('scenario-template-baseline')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(within(row).getByTestId('scenario-template-mild')).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    expect(within(row).getByTestId('scenario-template-severe')).toBeInTheDocument();
    expect(within(row).getByTestId('scenario-template-covid')).toBeInTheDocument();
    expect(within(row).getByTestId('scenario-template-rbi')).toBeInTheDocument();
  });

  it('clicking a template applies its inputs to the sliders', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ScenarioPage />);

    await user.click(screen.getByTestId('scenario-template-severe'));

    // After applying "Severe": GDP -5%, Rate +200 bps, FX +8%.
    // The slider value is shown next to its label in the form
    // "{value > 0 ? '+' : ''}{value} {unit}".
    expect(screen.getByText(/-5 %/)).toBeInTheDocument();
    expect(screen.getByText(/\+200 bps/)).toBeInTheDocument();
    expect(screen.getByText(/\+8 %/)).toBeInTheDocument();

    // Active state moves with the selection.
    expect(screen.getByTestId('scenario-template-severe')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByTestId('scenario-template-baseline')).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });
});

describe('ScenarioPage — Portfolio PD + NPA % KPI cards', () => {
  it('renders the new KPI cards after a run', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ScenarioPage />);
    await user.click(screen.getByRole('button', { name: /run scenario/i }));

    expect(await screen.findByTestId('kpi-portfolio-pd')).toBeInTheDocument();
    expect(await screen.findByTestId('kpi-npa-pct')).toBeInTheDocument();

    // Cards expose both baseline + stressed in the sub-text.
    expect(screen.getByTestId('kpi-portfolio-pd').textContent).toMatch(/Baseline/);
    expect(screen.getByTestId('kpi-npa-pct').textContent).toMatch(/Baseline/);
  });
});

describe('ScenarioPage — Segments × Risk Level heatmap', () => {
  it('renders cells for every (segment, band) pair after a run', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ScenarioPage />);
    await user.click(screen.getByRole('button', { name: /run scenario/i }));

    const heatmap = await screen.findByTestId('segment-risk-heatmap');
    // The mock portfolio has 4 product segments (mortgage, auto, personal, sme).
    // Each must produce 3 cells (low / medium / high).
    for (const seg of ['mortgage', 'auto', 'personal', 'sme'] as const) {
      for (const band of ['low', 'medium', 'high'] as const) {
        expect(within(heatmap).getByTestId(`heatmap-cell-${seg}-${band}`)).toBeInTheDocument();
      }
    }
  });
});

describe('ScenarioPage — top-affected drill-down', () => {
  it('each top-affected row links to /customers/:id', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ScenarioPage />);
    await user.click(screen.getByRole('button', { name: /run scenario/i }));

    await screen.findByTestId('top-affected');
    // Mock seed includes c-101 (Achieng Otieno) — biggest baseline_pd.
    const link = await screen.findByTestId('top-affected-link-c-101');
    expect(link.getAttribute('href')).toBe('/customers/c-101');
  });
});

describe('ScenarioPage — side-by-side comparison', () => {
  // Helper to seed two saved scenarios so we can test the compare flow
  // without having to drive two full Run cycles through the UI.
  const baselineRes: ScenarioResult = {
    inputs: { gdp: 0, rate: 0, fx: 0 },
    portfolio_size: 8,
    total_ead_kes: 10_000_000,
    baseline_ecl_kes: 200_000,
    stressed_ecl_kes: 200_000,
    ecl_delta_kes: 0,
    baseline_bands: { low: 5, medium: 2, high: 1 },
    stressed_bands: { low: 5, medium: 2, high: 1 },
    baseline_stages: { stage_1: 5, stage_2: 2, stage_3: 1 },
    stressed_stages: { stage_1: 5, stage_2: 2, stage_3: 1 },
    stage_migration: {
      s1: { s1: 5, s2: 0, s3: 0 },
      s2: { s1: 0, s2: 2, s3: 0 },
      s3: { s1: 0, s2: 0, s3: 1 },
    },
    segments: [],
    segment_risk_matrix: [],
    baseline_portfolio_pd: 0.04,
    stressed_portfolio_pd: 0.04,
    baseline_npa_pct: 0.125,
    stressed_npa_pct: 0.125,
    top_affected: [],
    computed_at: '2026-05-02T12:00:00.000Z',
  };
  const adverseRes: ScenarioResult = {
    ...baselineRes,
    inputs: { gdp: -4, rate: 200, fx: 5 },
    stressed_ecl_kes: 320_000,
    ecl_delta_kes: 120_000,
    stressed_bands: { low: 3, medium: 3, high: 2 },
    stressed_stages: { stage_1: 3, stage_2: 3, stage_3: 2 },
    stage_migration: {
      s1: { s1: 3, s2: 2, s3: 0 },
      s2: { s1: 0, s2: 1, s3: 1 },
      s3: { s1: 0, s2: 0, s3: 1 },
    },
    stressed_portfolio_pd: 0.075,
    stressed_npa_pct: 0.25,
  };

  const seedTwoScenarios = (): { baselineId: string; adverseId: string } => {
    const baseline = saveScenario('Baseline', { gdp: 0, rate: 0, fx: 0 } as ShockInputs, baselineRes);
    const adverse = saveScenario('Severe Q3', { gdp: -4, rate: 200, fx: 5 } as ShockInputs, adverseRes);
    return { baselineId: baseline.id, adverseId: adverse.id };
  };

  beforeEach(() => {
    vi.spyOn(window, 'prompt').mockReturnValue('Q2 stress test');
    vi.spyOn(window, 'confirm').mockReturnValue(true);
  });
  afterEach(() => vi.restoreAllMocks());

  it('renders a comparison panel when 2 saved scenarios are checked', async () => {
    const { baselineId, adverseId } = seedTwoScenarios();
    const user = userEvent.setup();
    renderWithProviders(<ScenarioPage />);

    await user.click(screen.getByTestId(`scenario-compare-toggle-${baselineId}`));
    await user.click(screen.getByTestId(`scenario-compare-toggle-${adverseId}`));

    const table = await screen.findByTestId('compare-table');
    expect(within(table).getByTestId('compare-left-name').textContent).toBe('Baseline');
    expect(within(table).getByTestId('compare-right-name').textContent).toBe('Severe Q3');
    // The "Stressed ECL" row must show both values.
    expect(table.textContent).toMatch(/Stressed ECL/);
  });

  it('checking a third selection pushes the oldest out (caps at 2)', async () => {
    const { baselineId, adverseId } = seedTwoScenarios();
    const third = saveScenario(
      'COVID test',
      { gdp: -7, rate: -75, fx: 5 } as ShockInputs,
      adverseRes,
    );

    const user = userEvent.setup();
    renderWithProviders(<ScenarioPage />);
    await user.click(screen.getByTestId(`scenario-compare-toggle-${baselineId}`));
    await user.click(screen.getByTestId(`scenario-compare-toggle-${adverseId}`));
    await user.click(screen.getByTestId(`scenario-compare-toggle-${third.id}`));

    // The newest pair is (adverse, third). baseline should no longer be checked.
    await waitFor(() => {
      const baselineCheckbox = screen.getByTestId(
        `scenario-compare-toggle-${baselineId}`,
      ) as HTMLInputElement;
      expect(baselineCheckbox.checked).toBe(false);
    });
    const adverseCheckbox = screen.getByTestId(
      `scenario-compare-toggle-${adverseId}`,
    ) as HTMLInputElement;
    const thirdCheckbox = screen.getByTestId(
      `scenario-compare-toggle-${third.id}`,
    ) as HTMLInputElement;
    expect(adverseCheckbox.checked).toBe(true);
    expect(thirdCheckbox.checked).toBe(true);
  });

  it('Close button in the compare panel clears the selection', async () => {
    const { baselineId, adverseId } = seedTwoScenarios();
    const user = userEvent.setup();
    renderWithProviders(<ScenarioPage />);
    await user.click(screen.getByTestId(`scenario-compare-toggle-${baselineId}`));
    await user.click(screen.getByTestId(`scenario-compare-toggle-${adverseId}`));
    await screen.findByTestId('compare-table');

    await user.click(screen.getByTestId('compare-close'));
    await waitFor(() => {
      expect(screen.queryByTestId('compare-table')).not.toBeInTheDocument();
    });
  });
});
