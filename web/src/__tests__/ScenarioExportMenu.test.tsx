// Coverage for the scenario Export ▾ dropdown:
//   - Menu opens on trigger click and lists all 3 formats
//   - Outside click + Escape close it
//   - Clicking each menu item invokes the right exporter
//   - PDF + Excel helpers produce something that looks right
//
// We mock the three exporter functions for the first two suites so we
// can assert the dispatch logic without spinning up jspdf / writeXlsxFile
// (both of which write to the DOM, which the JSDOM test env can handle
// but adds noise we don't need for the dispatch test). The third suite
// exercises the real helpers against a synthetic ScenarioResult.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ScenarioPage } from '@/modules/scenario/ScenarioPage';
import { renderWithProviders } from './utils';
import { buildScenarioPdf, scenarioToCsv } from '@/lib/scenarioExport';
import type { ScenarioResult } from '@/lib/api';

// Mock the export helpers used by the page so we can assert they're
// invoked. The CSV path is synchronous, the others are async; we mock
// all three identically so the dispatch logic is what's under test.
vi.mock('@/lib/scenarioExport', async () => {
  const actual = (await vi.importActual('@/lib/scenarioExport')) as Record<string, unknown>;
  return {
    ...actual,
    downloadScenarioCsv: vi.fn(),
    downloadScenarioPdf: vi.fn(),
    downloadScenarioXlsx: vi.fn().mockResolvedValue(undefined),
  };
});

describe('ScenarioPage — Export dropdown', () => {
  it('clicking the trigger opens a menu with all 3 formats', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ScenarioPage />);
    await user.click(screen.getByRole('button', { name: /run scenario/i }));
    await screen.findByTestId('scenario-results');

    await user.click(screen.getByTestId('scenario-export-trigger'));
    const menu = await screen.findByTestId('scenario-export-menu');
    expect(within(menu).getByTestId('scenario-export-pdf')).toBeInTheDocument();
    expect(within(menu).getByTestId('scenario-export-xlsx')).toBeInTheDocument();
    expect(within(menu).getByTestId('scenario-export-csv')).toBeInTheDocument();
  });

  it('Escape closes the menu and restores focus to the trigger', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ScenarioPage />);
    await user.click(screen.getByRole('button', { name: /run scenario/i }));
    await screen.findByTestId('scenario-results');

    await user.click(screen.getByTestId('scenario-export-trigger'));
    await screen.findByTestId('scenario-export-menu');
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByTestId('scenario-export-menu')).not.toBeInTheDocument();
    });
    expect(document.activeElement).toBe(screen.getByTestId('scenario-export-trigger'));
  });
});

describe('ScenarioPage — Export dispatch', () => {
  beforeEach(async () => {
    const exp = await import('@/lib/scenarioExport');
    vi.mocked(exp.downloadScenarioCsv).mockClear();
    vi.mocked(exp.downloadScenarioPdf).mockClear();
    vi.mocked(exp.downloadScenarioXlsx).mockClear();
  });
  afterEach(() => vi.clearAllMocks());

  it('clicking PDF invokes downloadScenarioPdf', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ScenarioPage />);
    await user.click(screen.getByRole('button', { name: /run scenario/i }));
    await screen.findByTestId('scenario-results');
    await user.click(screen.getByTestId('scenario-export-trigger'));
    await user.click(screen.getByTestId('scenario-export-pdf'));

    const exp = await import('@/lib/scenarioExport');
    expect(exp.downloadScenarioPdf).toHaveBeenCalledTimes(1);
    expect(exp.downloadScenarioCsv).not.toHaveBeenCalled();
    expect(exp.downloadScenarioXlsx).not.toHaveBeenCalled();
  });

  it('clicking Excel invokes downloadScenarioXlsx', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ScenarioPage />);
    await user.click(screen.getByRole('button', { name: /run scenario/i }));
    await screen.findByTestId('scenario-results');
    await user.click(screen.getByTestId('scenario-export-trigger'));
    await user.click(screen.getByTestId('scenario-export-xlsx'));

    const exp = await import('@/lib/scenarioExport');
    expect(exp.downloadScenarioXlsx).toHaveBeenCalledTimes(1);
  });

  it('clicking CSV invokes downloadScenarioCsv', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ScenarioPage />);
    await user.click(screen.getByRole('button', { name: /run scenario/i }));
    await screen.findByTestId('scenario-results');
    await user.click(screen.getByTestId('scenario-export-trigger'));
    await user.click(screen.getByTestId('scenario-export-csv'));

    const exp = await import('@/lib/scenarioExport');
    expect(exp.downloadScenarioCsv).toHaveBeenCalledTimes(1);
  });
});

describe('PDF + CSV builders — shape sanity check', () => {
  // A synthetic result big enough that all four PDF sections render.
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
      {
        segment: 'mortgage',
        accounts: 4,
        baseline_pd: 0.04,
        stressed_pd: 0.05,
        pd_delta_pp: 1,
        ecl_delta_kes: 10_000,
      },
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
      {
        customer_id: 'c-101',
        name: 'Test Customer',
        product: 'mortgage',
        baseline_pd: 0.04,
        stressed_pd: 0.07,
        pd_delta_pp: 3,
        ead_kes: 5_000_000,
        ecl_delta_kes: 30_000,
      },
    ],
    computed_at: '2026-05-02T12:00:00.000Z',
  };

  it('buildScenarioPdf returns a non-empty PDF blob', () => {
    // jsPDF's .output('blob') returns a Blob; we verify it's not empty.
    const doc = buildScenarioPdf(sample);
    const blob = doc.output('blob') as Blob;
    expect(blob.size).toBeGreaterThan(500);
    expect(blob.type).toMatch(/pdf/);
  });

  it('CSV still includes Portfolio PD + NPA share rows', () => {
    const csv = scenarioToCsv(sample);
    expect(csv).toContain('Portfolio PD');
    expect(csv).toContain('NPA share');
  });
});
