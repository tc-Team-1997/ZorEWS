// services/bff/src/scenario_regulator_severity_matrix.ts
//
// T6 M16.21 — Scenario library regulator × severity cross-tab matrix.
//
// M16.17 ships the category × regulator coverage matrix (which
// (category, regulator) combinations are populated). M16.21 ships
// the orthogonal regulator × SEVERITY matrix — answers "do we have
// a SEVERE-level RBI scenario? a MILD-level IRDAI scenario? where
// are the gaps in stress-test severity coverage per regulator?".
//
// 3 ScenarioRegulator rows (canonical RBI → IRDAI → INTERNAL) × 3
// ScenarioSeverity cols (canonical mild → moderate → severe) = 9
// cells. Each preset lives in exactly one cell.
//
// Per-row {regulator, total, by_severity (every severity at 0 when
//   absent — stable 3-key grid), severities_without[] canonical}.
// Per-col {severity, total, by_regulator (every regulator at 0),
//   regulators_without[] canonical}.
// Envelope: peak_cell (canonical iteration tie-break: rows in canonical
//   regulator order × cols in canonical severity order — earliest pair
//   wins at tied) + empty_cells[] (canonical row-major order) +
//   most_severe_regulator (regulator with most SEVERE-bucket presets;
//   canonical-order tie-break) + most_diverse_regulator (regulator
//   with most distinct non-zero by_severity entries; canonical tie-
//   break) + most_universal_severity (severity with most distinct
//   non-zero by_regulator entries; canonical tie-break).
//
// Mirror of M16.17 / M14.28 / M12.14 / M3.14 / M15.14 matrix pattern
// for the scenario library — both axes CLOSED.
//
// Platform-static.

import {
  listScenarioPresets,
  type ScenarioRegulator,
  type ScenarioSeverity,
} from './scenario_library';

const ALL_REGULATORS: readonly ScenarioRegulator[] = [
  'RBI',
  'IRDAI',
  'INTERNAL',
];
const ALL_SEVERITIES: readonly ScenarioSeverity[] = [
  'mild',
  'moderate',
  'severe',
];

// ─── Public types ──────────────────────────────────────────────────────

export interface RegSevRow {
  regulator: ScenarioRegulator;
  total: number;
  by_severity: Record<ScenarioSeverity, number>;
  severities_without: ScenarioSeverity[];
  preset_ids: string[];
}

export interface RegSevCol {
  severity: ScenarioSeverity;
  total: number;
  by_regulator: Record<ScenarioRegulator, number>;
  regulators_without: ScenarioRegulator[];
  preset_ids: string[];
}

export interface PeakCell {
  regulator: ScenarioRegulator;
  severity: ScenarioSeverity;
  count: number;
  preset_ids: string[];
}

export interface ScenarioRegulatorSeverityMatrix {
  generated_at: string;
  total_presets: number;
  total_regulators: number;
  total_severities: number;
  rows: RegSevRow[];
  columns: RegSevCol[];
  /** Highest-count cell; null when zero presets. Canonical iteration
   *  tie-break: rows in canonical ALL_REGULATORS order × cols in
   *  ALL_SEVERITIES order — earliest pair wins at tied. */
  peak_cell: PeakCell | null;
  /** Cells with count=0 in canonical row-major (regulator outer,
   *  severity inner) order — coverage-gap list. */
  empty_cells: Array<{ regulator: ScenarioRegulator; severity: ScenarioSeverity }>;
  /** Regulator with most severe-bucket presets; canonical
   *  ALL_REGULATORS order tie-break; null when no severe presets. */
  most_severe_regulator: ScenarioRegulator | null;
  /** Regulator with most distinct non-zero by_severity entries;
   *  canonical-order tie-break; null on empty library. */
  most_diverse_regulator: ScenarioRegulator | null;
  /** Severity with most distinct non-zero by_regulator entries;
   *  canonical-order tie-break; null on empty library. */
  most_universal_severity: ScenarioSeverity | null;
}

// ─── Helpers ───────────────────────────────────────────────────────────

function emptyBySeverity(): Record<ScenarioSeverity, number> {
  const out = {} as Record<ScenarioSeverity, number>;
  for (const s of ALL_SEVERITIES) out[s] = 0;
  return out;
}

function emptyByRegulator(): Record<ScenarioRegulator, number> {
  const out = {} as Record<ScenarioRegulator, number>;
  for (const r of ALL_REGULATORS) out[r] = 0;
  return out;
}

// ─── Pure resolver ─────────────────────────────────────────────────────

export function buildScenarioRegulatorSeverityMatrix(
  now: Date,
): ScenarioRegulatorSeverityMatrix {
  // Initialise rows + cols in canonical order.
  const rowsByReg = new Map<ScenarioRegulator, RegSevRow>();
  for (const r of ALL_REGULATORS) {
    rowsByReg.set(r, {
      regulator: r,
      total: 0,
      by_severity: emptyBySeverity(),
      severities_without: [],
      preset_ids: [],
    });
  }
  const colsBySev = new Map<ScenarioSeverity, RegSevCol>();
  for (const s of ALL_SEVERITIES) {
    colsBySev.set(s, {
      severity: s,
      total: 0,
      by_regulator: emptyByRegulator(),
      regulators_without: [],
      preset_ids: [],
    });
  }

  const cellPresetIds = new Map<string, string[]>(); // `${reg}|${sev}` → ids
  let total_presets = 0;

  for (const preset of listScenarioPresets()) {
    if (!ALL_REGULATORS.includes(preset.regulator)) continue;
    if (!ALL_SEVERITIES.includes(preset.severity)) continue;

    total_presets++;
    const row = rowsByReg.get(preset.regulator)!;
    const col = colsBySev.get(preset.severity)!;

    row.total++;
    row.by_severity[preset.severity]++;
    row.preset_ids.push(preset.id);

    col.total++;
    col.by_regulator[preset.regulator]++;
    col.preset_ids.push(preset.id);

    const cellKey = `${preset.regulator}|${preset.severity}`;
    if (!cellPresetIds.has(cellKey)) cellPresetIds.set(cellKey, []);
    cellPresetIds.get(cellKey)!.push(preset.id);
  }

  // Sort preset_ids ascending per row/col for deterministic SPA render.
  for (const row of rowsByReg.values()) row.preset_ids.sort();
  for (const col of colsBySev.values()) col.preset_ids.sort();

  // Fill severities_without / regulators_without in canonical order.
  for (const row of rowsByReg.values()) {
    row.severities_without = ALL_SEVERITIES.filter(
      (s) => row.by_severity[s] === 0,
    );
  }
  for (const col of colsBySev.values()) {
    col.regulators_without = ALL_REGULATORS.filter(
      (r) => col.by_regulator[r] === 0,
    );
  }

  // peak_cell — iterate canonical row × col order, strict `>` tie-break.
  let peak_cell: PeakCell | null = null;
  for (const r of ALL_REGULATORS) {
    for (const s of ALL_SEVERITIES) {
      const cellKey = `${r}|${s}`;
      const ids = cellPresetIds.get(cellKey) ?? [];
      const count = ids.length;
      if (!peak_cell || count > peak_cell.count) {
        if (count > 0) {
          peak_cell = {
            regulator: r,
            severity: s,
            count,
            preset_ids: [...ids].sort(),
          };
        }
      }
    }
  }

  // empty_cells — canonical row-major (regulator outer, severity inner).
  const empty_cells: Array<{
    regulator: ScenarioRegulator;
    severity: ScenarioSeverity;
  }> = [];
  for (const r of ALL_REGULATORS) {
    for (const s of ALL_SEVERITIES) {
      if (rowsByReg.get(r)!.by_severity[s] === 0) {
        empty_cells.push({ regulator: r, severity: s });
      }
    }
  }

  // most_severe_regulator — most severe-bucket presets; canonical tie-break.
  let most_severe_regulator: ScenarioRegulator | null = null;
  let bestSevereCount = 0;
  for (const r of ALL_REGULATORS) {
    const row = rowsByReg.get(r)!;
    if (row.by_severity.severe > bestSevereCount) {
      bestSevereCount = row.by_severity.severe;
      most_severe_regulator = r;
    }
  }

  // most_diverse_regulator — most distinct non-zero by_severity entries.
  let most_diverse_regulator: ScenarioRegulator | null = null;
  let bestRowSpan = 0;
  for (const r of ALL_REGULATORS) {
    const row = rowsByReg.get(r)!;
    const span = ALL_SEVERITIES.filter((s) => row.by_severity[s] > 0).length;
    if (span > bestRowSpan) {
      bestRowSpan = span;
      most_diverse_regulator = r;
    }
  }

  // most_universal_severity — most distinct non-zero by_regulator entries.
  let most_universal_severity: ScenarioSeverity | null = null;
  let bestColSpan = 0;
  for (const s of ALL_SEVERITIES) {
    const col = colsBySev.get(s)!;
    const span = ALL_REGULATORS.filter((r) => col.by_regulator[r] > 0).length;
    if (span > bestColSpan) {
      bestColSpan = span;
      most_universal_severity = s;
    }
  }

  return {
    generated_at: now.toISOString(),
    total_presets,
    total_regulators: ALL_REGULATORS.length,
    total_severities: ALL_SEVERITIES.length,
    rows: ALL_REGULATORS.map((r) => rowsByReg.get(r)!),
    columns: ALL_SEVERITIES.map((s) => colsBySev.get(s)!),
    peak_cell,
    empty_cells,
    most_severe_regulator,
    most_diverse_regulator,
    most_universal_severity,
  };
}
