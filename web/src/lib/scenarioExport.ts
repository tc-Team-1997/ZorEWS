// Client-side exporters for the scenario simulation results.
//
// Why client-side (not BFF + /v1/reports): the existing /v1/reports
// MSW handler at web/src/mocks/handlers.ts only produces real bytes for
// CSV — for PDF/Excel it falls back to JSON, so the existing reports
// PDF/Excel buttons are broken in MSW dev mode and only work against
// the real BFF. For scenario, doing it client-side means the dev
// experience and prod experience match.
//
// Library choices:
//   - PDF:   jspdf + jspdf-autotable (battle-tested, ~150KB total)
//   - Excel: write-excel-file        (small writer-only library, ~70KB)
//
// All three exports share the same section structure:
//   1. Inputs + portfolio totals
//   2. IFRS 9 stage migration (3x3 matrix)
//   3. Segment-wise impact
//   4. Top-affected customers

import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
// write-excel-file ships separate browser/ and node/ entrypoints; the
// browser one targets DOM APIs (Blob + URL.createObjectURL) which is
// what we want from a vite SPA. For the vitest jsdom environment the
// browser entrypoint also works because jsdom polyfills Blob.
import writeXlsxFile from 'write-excel-file/browser';
import type { ScenarioResult } from './api';

// ─── Shared formatters ────────────────────────────────────────────────

function fmtPct(n: number, digits = 2): string {
  return `${(n * 100).toFixed(digits)}%`;
}

function dateStamp(): string {
  return new Date().toISOString().slice(0, 10);
}

// ─── CSV ──────────────────────────────────────────────────────────────

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  // RFC 4180: only quote when needed (commas, quotes, newlines).
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function csvRow(cells: unknown[]): string {
  return cells.map(csvCell).join(',');
}

export function scenarioToCsv(result: ScenarioResult): string {
  const lines: string[] = [];

  lines.push('# ZorEWS — Scenario simulation result');
  lines.push(`# Computed at,${result.computed_at}`);
  lines.push(`# GDP shock (%),${result.inputs.gdp}`);
  lines.push(`# Rate shock (bps),${result.inputs.rate}`);
  lines.push(`# FX shock (%),${result.inputs.fx}`);
  lines.push('');
  lines.push(csvRow(['Metric', 'Baseline', 'Stressed']));
  lines.push(csvRow(['Portfolio size', result.portfolio_size, result.portfolio_size]));
  lines.push(csvRow(['Total EAD (KES)', result.total_ead_kes, result.total_ead_kes]));
  lines.push(csvRow(['ECL (KES)', result.baseline_ecl_kes, result.stressed_ecl_kes]));
  lines.push(csvRow(['ECL delta (KES)', '', result.ecl_delta_kes]));
  lines.push(csvRow(['Portfolio PD', result.baseline_portfolio_pd, result.stressed_portfolio_pd]));
  lines.push(csvRow(['NPA share', result.baseline_npa_pct, result.stressed_npa_pct]));
  lines.push('');

  lines.push('# IFRS 9 stage migration (counts; rows = baseline stage, cols = stressed stage)');
  lines.push(csvRow(['from \\ to', 'Stage 1', 'Stage 2', 'Stage 3']));
  lines.push(csvRow(['Stage 1', result.stage_migration.s1.s1, result.stage_migration.s1.s2, result.stage_migration.s1.s3]));
  lines.push(csvRow(['Stage 2', result.stage_migration.s2.s1, result.stage_migration.s2.s2, result.stage_migration.s2.s3]));
  lines.push(csvRow(['Stage 3', result.stage_migration.s3.s1, result.stage_migration.s3.s2, result.stage_migration.s3.s3]));
  lines.push('');

  lines.push('# Segment-wise impact');
  lines.push(csvRow(['Segment', 'Accounts', 'Baseline PD', 'Stressed PD', 'PD delta (pp)', 'ECL delta (KES)']));
  for (const s of result.segments) {
    lines.push(csvRow([s.segment, s.accounts, s.baseline_pd, s.stressed_pd, s.pd_delta_pp, s.ecl_delta_kes]));
  }
  lines.push('');

  lines.push('# Top-affected customers (ranked by absolute PD delta)');
  lines.push(csvRow(['Customer ID', 'Name', 'Product', 'Baseline PD', 'Stressed PD', 'PD delta (pp)', 'EAD (KES)', 'ECL delta (KES)']));
  for (const c of result.top_affected) {
    lines.push(csvRow([c.customer_id, c.name, c.product, c.baseline_pd, c.stressed_pd, c.pd_delta_pp, c.ead_kes, c.ecl_delta_kes]));
  }

  return lines.join('\n');
}

export function downloadScenarioCsv(result: ScenarioResult, filenameStem = 'scenario'): void {
  const csv = scenarioToCsv(result);
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  triggerDownload(blob, `${filenameStem}-${dateStamp()}.csv`);
}

// ─── PDF ──────────────────────────────────────────────────────────────

/**
 * A4-portrait PDF with the same four sections as the CSV. autoTable
 * handles page breaks automatically — long top-affected tables flow
 * across pages without manual cursor tracking.
 */
export function buildScenarioPdf(result: ScenarioResult): jsPDF {
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  const margin = 40;

  doc.setFontSize(16);
  doc.text('ZorEWS — Scenario Simulation Report', margin, margin);
  doc.setFontSize(9);
  doc.setTextColor(110);
  doc.text(`Computed at: ${result.computed_at}`, margin, margin + 16);
  doc.text(
    `Macro shocks: GDP ${result.inputs.gdp}% · Rate ${result.inputs.rate} bps · FX ${result.inputs.fx}%`,
    margin,
    margin + 30,
  );
  doc.setTextColor(0);

  // Section 1 — portfolio totals + key KPIs
  autoTable(doc, {
    startY: margin + 50,
    head: [['Metric', 'Baseline', 'Stressed']],
    body: [
      ['Portfolio size', result.portfolio_size.toLocaleString(), result.portfolio_size.toLocaleString()],
      ['Total EAD (KES)', result.total_ead_kes.toLocaleString(), result.total_ead_kes.toLocaleString()],
      ['ECL (KES)', result.baseline_ecl_kes.toLocaleString(), result.stressed_ecl_kes.toLocaleString()],
      ['ECL delta (KES)', '—', result.ecl_delta_kes.toLocaleString()],
      ['Portfolio PD', fmtPct(result.baseline_portfolio_pd), fmtPct(result.stressed_portfolio_pd)],
      ['NPA share', fmtPct(result.baseline_npa_pct), fmtPct(result.stressed_npa_pct)],
    ],
    headStyles: { fillColor: [13, 43, 106], textColor: 255, fontSize: 9 },
    bodyStyles: { fontSize: 9 },
    theme: 'grid',
  });

  // Section 2 — IFRS 9 stage migration matrix
  autoTable(doc, {
    head: [['From \\ To', 'Stage 1', 'Stage 2', 'Stage 3']],
    body: [
      ['Stage 1', String(result.stage_migration.s1.s1), String(result.stage_migration.s1.s2), String(result.stage_migration.s1.s3)],
      ['Stage 2', String(result.stage_migration.s2.s1), String(result.stage_migration.s2.s2), String(result.stage_migration.s2.s3)],
      ['Stage 3', String(result.stage_migration.s3.s1), String(result.stage_migration.s3.s2), String(result.stage_migration.s3.s3)],
    ],
    headStyles: { fillColor: [13, 43, 106], textColor: 255, fontSize: 9 },
    bodyStyles: { fontSize: 9, halign: 'right' },
    columnStyles: { 0: { halign: 'left', fontStyle: 'bold' } },
    theme: 'grid',
    didDrawPage: () => {
      doc.setFontSize(10);
      doc.setTextColor(60);
      // We can't read autoTable's previous-Y cleanly cross-version, so
      // place the section header at a fixed offset above the next table.
    },
  });

  // Section 3 — segment-wise impact
  autoTable(doc, {
    head: [['Segment', 'Accounts', 'Baseline PD', 'Stressed PD', 'PD Δ (pp)', 'ECL Δ (KES)']],
    body: result.segments.map((s) => [
      s.segment,
      String(s.accounts),
      fmtPct(s.baseline_pd),
      fmtPct(s.stressed_pd),
      s.pd_delta_pp.toFixed(2),
      s.ecl_delta_kes.toLocaleString(),
    ]),
    headStyles: { fillColor: [13, 43, 106], textColor: 255, fontSize: 9 },
    bodyStyles: { fontSize: 9 },
    theme: 'grid',
  });

  // Section 4 — top-affected customers
  autoTable(doc, {
    head: [['Customer', 'ID', 'Product', 'Baseline PD', 'Stressed PD', 'PD Δ (pp)', 'EAD', 'ECL Δ']],
    body: result.top_affected.map((c) => [
      c.name,
      c.customer_id,
      c.product,
      fmtPct(c.baseline_pd),
      fmtPct(c.stressed_pd),
      c.pd_delta_pp.toFixed(2),
      c.ead_kes.toLocaleString(),
      c.ecl_delta_kes.toLocaleString(),
    ]),
    headStyles: { fillColor: [13, 43, 106], textColor: 255, fontSize: 9 },
    bodyStyles: { fontSize: 8 },
    theme: 'grid',
  });

  return doc;
}

export function downloadScenarioPdf(result: ScenarioResult, filenameStem = 'scenario'): void {
  const doc = buildScenarioPdf(result);
  doc.save(`${filenameStem}-${dateStamp()}.pdf`);
}

// ─── Excel ────────────────────────────────────────────────────────────

/**
 * write-excel-file accepts data as a 2D array of cell objects:
 *   [{ value, type, fontWeight, ... }]
 * For multi-sheet workbooks, pass arrays of arrays + a `sheets` option.
 */

type Cell = {
  value?: string | number;
  type?: typeof String | typeof Number;
  fontWeight?: 'bold';
  backgroundColor?: string;
  color?: string;
  align?: 'left' | 'right';
  format?: string;
};

const HEADER: Partial<Cell> = {
  fontWeight: 'bold',
  backgroundColor: '#0d2b6a',
  color: '#ffffff',
};

function headerRow(labels: string[]): Cell[] {
  return labels.map((l) => ({ value: l, type: String, ...HEADER }));
}

function row(cells: Array<string | number>): Cell[] {
  return cells.map((c) =>
    typeof c === 'number'
      ? { value: c, type: Number }
      : { value: c, type: String },
  );
}

export async function downloadScenarioXlsx(
  result: ScenarioResult,
  filenameStem = 'scenario',
): Promise<void> {
  const summarySheet: Cell[][] = [
    [{ value: 'ZorEWS — Scenario Simulation Report', fontWeight: 'bold' }],
    [{ value: 'Computed at', fontWeight: 'bold' }, { value: result.computed_at, type: String }],
    [
      { value: 'GDP shock (%)', fontWeight: 'bold' },
      { value: result.inputs.gdp, type: Number },
    ],
    [
      { value: 'Rate shock (bps)', fontWeight: 'bold' },
      { value: result.inputs.rate, type: Number },
    ],
    [
      { value: 'FX shock (%)', fontWeight: 'bold' },
      { value: result.inputs.fx, type: Number },
    ],
    [],
    headerRow(['Metric', 'Baseline', 'Stressed']),
    row(['Portfolio size', result.portfolio_size, result.portfolio_size]),
    row(['Total EAD (KES)', result.total_ead_kes, result.total_ead_kes]),
    row(['ECL (KES)', result.baseline_ecl_kes, result.stressed_ecl_kes]),
    row(['ECL delta (KES)', '—', result.ecl_delta_kes]),
    row(['Portfolio PD', result.baseline_portfolio_pd, result.stressed_portfolio_pd]),
    row(['NPA share', result.baseline_npa_pct, result.stressed_npa_pct]),
  ];

  const migrationSheet: Cell[][] = [
    [{ value: 'IFRS 9 stage migration', fontWeight: 'bold' }],
    [{ value: 'Rows = baseline stage, cols = stressed stage' }],
    [],
    headerRow(['From \\ To', 'Stage 1', 'Stage 2', 'Stage 3']),
    row(['Stage 1', result.stage_migration.s1.s1, result.stage_migration.s1.s2, result.stage_migration.s1.s3]),
    row(['Stage 2', result.stage_migration.s2.s1, result.stage_migration.s2.s2, result.stage_migration.s2.s3]),
    row(['Stage 3', result.stage_migration.s3.s1, result.stage_migration.s3.s2, result.stage_migration.s3.s3]),
  ];

  const segmentsSheet: Cell[][] = [
    headerRow(['Segment', 'Accounts', 'Baseline PD', 'Stressed PD', 'PD delta (pp)', 'ECL delta (KES)']),
    ...result.segments.map((s) =>
      row([s.segment, s.accounts, s.baseline_pd, s.stressed_pd, s.pd_delta_pp, s.ecl_delta_kes]),
    ),
  ];

  const topAffectedSheet: Cell[][] = [
    headerRow([
      'Customer ID',
      'Name',
      'Product',
      'Baseline PD',
      'Stressed PD',
      'PD delta (pp)',
      'EAD (KES)',
      'ECL delta (KES)',
    ]),
    ...result.top_affected.map((c) =>
      row([
        c.customer_id,
        c.name,
        c.product,
        c.baseline_pd,
        c.stressed_pd,
        c.pd_delta_pp,
        c.ead_kes,
        c.ecl_delta_kes,
      ]),
    ),
  ];

  // Multi-sheet API: each sheet is { data, sheet: <name> }; the writer
  // returns { toFile, toBlob } — call .toFile() to trigger the browser
  // download. No `fileName` option in the writer call itself.
  await writeXlsxFile([
    { data: summarySheet, sheet: 'Summary' },
    { data: migrationSheet, sheet: 'Stage migration' },
    { data: segmentsSheet, sheet: 'Segments' },
    { data: topAffectedSheet, sheet: 'Top affected' },
  ]).toFile(`${filenameStem}-${dateStamp()}.xlsx`);
}

// ─── Shared download trigger ──────────────────────────────────────────

function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
