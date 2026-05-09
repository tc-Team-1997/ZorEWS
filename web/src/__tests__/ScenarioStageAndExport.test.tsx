// Coverage for the new scenario surface:
//   - IFRS 9 stage distribution chart + 3x3 migration matrix render
//   - Save scenario → surfaces in the saved-scenarios list → loadable
//   - Export CSV button triggers a Blob download
//
// The original ScenarioPage.test.tsx covers the slider + run-button +
// existing results panels. This file is additive so the legacy test
// stays focused on the original contract.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ScenarioPage } from '@/modules/scenario/ScenarioPage';
import { renderWithProviders } from './utils';
import { scenarioToCsv } from '@/lib/scenarioExport';
import type { ScenarioResult } from '@/lib/api';

beforeEach(() => {
  // Clean slate so the saved-scenarios list starts empty for every test.
  localStorage.removeItem('apex.ews.saved_scenarios');
});

describe('ScenarioPage — IFRS 9 stage panels', () => {
  it('renders the stage distribution chart + 3x3 migration matrix after a run', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ScenarioPage />);
    await user.click(screen.getByRole('button', { name: /run scenario/i }));

    expect(await screen.findByTestId('ifrs-stage-chart')).toBeInTheDocument();
    expect(await screen.findByTestId('stage-migration-matrix')).toBeInTheDocument();

    // Diagonal cells (s1→s1, s2→s2, s3→s3) must always be present.
    expect(screen.getByTestId('stage-cell-1-1')).toBeInTheDocument();
    expect(screen.getByTestId('stage-cell-2-2')).toBeInTheDocument();
    expect(screen.getByTestId('stage-cell-3-3')).toBeInTheDocument();
  });

  it('zero-shock baseline keeps everyone on the diagonal (no migration)', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ScenarioPage />);
    await user.click(screen.getByRole('button', { name: /run scenario/i }));

    await screen.findByTestId('stage-migration-matrix');
    // Off-diagonal cells should all read 0 when no shock is applied.
    for (const [from, to] of [
      [1, 2], [1, 3], [2, 1], [2, 3], [3, 1], [3, 2],
    ] as const) {
      expect(screen.getByTestId(`stage-cell-${from}-${to}`).textContent).toBe('0');
    }
  });
});

describe('ScenarioPage — save / load saved scenarios', () => {
  beforeEach(() => {
    vi.spyOn(window, 'prompt').mockReturnValue('Q2 stress test');
    vi.spyOn(window, 'confirm').mockReturnValue(true);
  });
  afterEach(() => vi.restoreAllMocks());

  it('Save button is disabled until a result exists', async () => {
    renderWithProviders(<ScenarioPage />);
    expect(screen.getByTestId('scenario-save')).toBeDisabled();
  });

  it('saving a result surfaces it in the saved-scenarios list', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ScenarioPage />);
    await user.click(screen.getByRole('button', { name: /run scenario/i }));
    await screen.findByTestId('scenario-results');

    await user.click(screen.getByTestId('scenario-save'));

    const list = await screen.findByTestId('saved-scenarios-list');
    expect(within(list).getByText('Q2 stress test')).toBeInTheDocument();
    // Inputs summary line shows the zero shocks we ran with.
    expect(list.textContent).toMatch(/GDP 0% · Rate 0 bps · FX 0%/);
  });

  it('deleting a saved scenario removes it from the list', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ScenarioPage />);
    await user.click(screen.getByRole('button', { name: /run scenario/i }));
    await screen.findByTestId('scenario-results');
    await user.click(screen.getByTestId('scenario-save'));

    const list = await screen.findByTestId('saved-scenarios-list');
    const deleteBtn = within(list).getByLabelText(/Delete saved scenario: Q2 stress test/i);
    await user.click(deleteBtn);

    await waitFor(() => {
      // Once the last entry is deleted the panel itself unmounts.
      expect(screen.queryByTestId('saved-scenarios-list')).not.toBeInTheDocument();
    });
  });
});

describe('Export menu trigger', () => {
  it('trigger is disabled until a result exists', () => {
    renderWithProviders(<ScenarioPage />);
    expect(screen.getByTestId('scenario-export-trigger')).toBeDisabled();
  });

  it('trigger is enabled after a successful run', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ScenarioPage />);
    await user.click(screen.getByRole('button', { name: /run scenario/i }));
    await screen.findByTestId('scenario-results');
    expect(screen.getByTestId('scenario-export-trigger')).toBeEnabled();
  });
});

describe('scenarioToCsv() shape', () => {
  // Synthetic ScenarioResult — small enough to assert on.
  const sample: ScenarioResult = {
    inputs: { gdp: -2, rate: 100, fx: 5 },
    portfolio_size: 8,
    total_ead_kes: 10_000_000,
    baseline_ecl_kes: 200_000,
    stressed_ecl_kes: 240_000,
    ecl_delta_kes: 40_000,
    baseline_bands: { low: 4, medium: 3, high: 1 },
    stressed_bands: { low: 3, medium: 3, high: 2 },
    baseline_stages: { stage_1: 4, stage_2: 3, stage_3: 1 },
    stressed_stages: { stage_1: 3, stage_2: 3, stage_3: 2 },
    stage_migration: {
      s1: { s1: 3, s2: 1, s3: 0 },
      s2: { s1: 0, s2: 2, s3: 1 },
      s3: { s1: 0, s2: 0, s3: 1 },
    },
    segments: [
      { segment: 'mortgage', accounts: 4, baseline_pd: 0.04, stressed_pd: 0.05, pd_delta_pp: 1, ecl_delta_kes: 10_000 },
    ],
    segment_risk_matrix: [
      {
        segment: 'mortgage',
        baseline: { low: 4, medium: 0, high: 0 },
        stressed: { low: 3, medium: 1, high: 0 },
      },
    ],
    baseline_portfolio_pd: 0.05,
    stressed_portfolio_pd: 0.08,
    baseline_npa_pct: 0.125,
    stressed_npa_pct: 0.25,
    top_affected: [
      { customer_id: 'c-101', name: 'Test, Customer', product: 'mortgage', baseline_pd: 0.04, stressed_pd: 0.07, pd_delta_pp: 3, ead_kes: 5_000_000, ecl_delta_kes: 30_000 },
    ],
    computed_at: '2026-05-02T12:00:00.000Z',
  };

  it('contains all four sections with the expected header rows', () => {
    const csv = scenarioToCsv(sample);
    expect(csv).toContain('# ZorEWS — Scenario simulation result');
    expect(csv).toContain('# IFRS 9 stage migration');
    expect(csv).toContain('# Segment-wise impact');
    expect(csv).toContain('# Top-affected customers');
  });

  it('quotes cells with commas (RFC 4180)', () => {
    const csv = scenarioToCsv(sample);
    // The customer name "Test, Customer" must be quoted because of the comma.
    expect(csv).toContain('"Test, Customer"');
  });

  it('serialises the migration matrix correctly', () => {
    const csv = scenarioToCsv(sample);
    // s1→s1 = 3, s1→s2 = 1, s1→s3 = 0
    expect(csv).toContain('Stage 1,3,1,0');
  });
});
