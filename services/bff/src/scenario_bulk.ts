// services/bff/src/scenario_bulk.ts
//
// T6 M16.2 — Scenario bulk-run + comparison.
//
// M16.1 ships the named scenario library (10 preset shocks across
// regulatory / business / black_swan / baseline). M16.2 lets ops fire
// many of them in one call and ranks them by |ECL delta| so the SPA
// can render a comparison table directly.
//
// Caller supplies EITHER:
//   - preset_ids[]: explicit list of preset ids to run
//   - category:    run every preset in that category
// Exactly one — both supplied → 400; neither supplied → 400.
//
// The bulk runner re-uses the existing runScenario from scenario/engine
// (T4.2), so the math + portfolio + ECL aggregation stay shared with
// the single-scenario `/v1/scenario/run` endpoint.

import { runScenario } from './scenario/engine';
import type { Account } from './scenario/portfolio';
import {
  getScenarioPreset,
  isScenarioCategory,
  listScenarioPresets,
  type ScenarioCategory,
  type ScenarioPreset,
} from './scenario_library';

// ─── Public types ──────────────────────────────────────────────────────

export interface BulkRunInput {
  preset_ids?: string[];
  category?: ScenarioCategory;
}

export interface BulkRunResultRow {
  preset_id: string;
  name: string;
  category: ScenarioCategory;
  severity: ScenarioPreset['severity'];
  shocks: ScenarioPreset['shocks'];
  baseline_ecl_kes: number;
  stressed_ecl_kes: number;
  ecl_delta_kes: number;
  /** Rank 1 = largest |ECL delta|. Stable for ties via id sort. */
  rank: number;
}

export interface BulkRunResult {
  tenant_id: string;
  generated_at: string;
  /** Echo of the resolved selection. */
  selection: { mode: 'by_ids'; preset_ids: string[] } | { mode: 'by_category'; category: ScenarioCategory };
  preset_count: number;
  /** Aggregate across all presets in this run. */
  totals: {
    /** Largest |stressed - baseline| in absolute KES across the run. */
    worst_ecl_delta_kes: number;
    /** Mean ECL delta. */
    mean_ecl_delta_kes: number;
    /** Number of presets that produced an *adverse* (positive) delta. */
    adverse_count: number;
    /** Number of presets that produced a *benign* (≤ 0) delta. */
    benign_count: number;
  };
  results: BulkRunResultRow[];
}

export class BulkRunError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'BulkRunError';
  }
}

// ─── Resolution ────────────────────────────────────────────────────────

/**
 * Resolve the input into a list of presets. Throws BulkRunError on
 * invalid combinations. Exactly one of `preset_ids` / `category` must
 * be supplied.
 */
/**
 * Optional lookup callback to extend resolution beyond the M16.1
 * platform library — e.g. M16.5 wires the customPresetStore so
 * tenant-authored ids resolve. Defaults to library-only.
 */
export type PresetLookup = (id: string) => ScenarioPreset | null;

export function resolveBulkInput(
  input: BulkRunInput,
  lookup: PresetLookup = getScenarioPreset,
): {
  presets: ScenarioPreset[];
  selection: BulkRunResult['selection'];
} {
  if (!input || typeof input !== 'object') {
    throw new BulkRunError('invalid_input', 'request body required');
  }
  const hasIds = Array.isArray(input.preset_ids) && input.preset_ids.length > 0;
  const hasCat = typeof input.category === 'string' && input.category.length > 0;

  if (hasIds && hasCat) {
    throw new BulkRunError(
      'invalid_input',
      'supply only one of preset_ids / category, not both',
    );
  }
  if (!hasIds && !hasCat) {
    throw new BulkRunError(
      'invalid_input',
      'one of preset_ids[] / category is required',
    );
  }

  if (hasIds) {
    const ids = input.preset_ids!;
    if (ids.length > 20) {
      throw new BulkRunError('invalid_input', 'at most 20 preset_ids per call');
    }
    const presets: ScenarioPreset[] = [];
    for (const id of ids) {
      if (typeof id !== 'string' || !id.trim()) {
        throw new BulkRunError('invalid_input', 'every preset_id must be a non-empty string');
      }
      const p = lookup(id);
      if (!p) {
        throw new BulkRunError('unknown_preset', `unknown preset: ${id}`);
      }
      presets.push(p);
    }
    return {
      presets,
      selection: { mode: 'by_ids', preset_ids: ids },
    };
  }

  // category mode
  if (!isScenarioCategory(input.category)) {
    throw new BulkRunError(
      'invalid_category',
      `category must be one of regulatory|business|black_swan|baseline (got '${input.category}')`,
    );
  }
  const presets = listScenarioPresets({ category: input.category });
  if (presets.length === 0) {
    throw new BulkRunError(
      'empty_category',
      `category '${input.category}' has no presets — should not happen with seeded data`,
    );
  }
  return {
    presets,
    selection: { mode: 'by_category', category: input.category },
  };
}

// ─── Runner ────────────────────────────────────────────────────────────

/**
 * Run every preset against the portfolio, rank by |ECL delta| desc,
 * and return the comparison payload.
 *
 * Uses the existing runScenario from scenario/engine (T4.2) so the
 * math + ECL semantics stay consistent with /v1/scenario/run.
 */
export function runBulkScenarios(
  tenant_id: string,
  presets: ScenarioPreset[],
  selection: BulkRunResult['selection'],
  portfolio: Account[],
  now: () => Date,
): BulkRunResult {
  const rows: BulkRunResultRow[] = presets.map((p) => {
    const r = runScenario(portfolio, p.shocks, now);
    return {
      preset_id: p.id,
      name: p.name,
      category: p.category,
      severity: p.severity,
      shocks: p.shocks,
      baseline_ecl_kes: r.baseline_ecl_kes,
      stressed_ecl_kes: r.stressed_ecl_kes,
      ecl_delta_kes: r.ecl_delta_kes,
      rank: 0, // assigned below
    };
  });

  // Sort by |delta| desc, stable on preset_id.
  rows.sort((a, b) => {
    const d = Math.abs(b.ecl_delta_kes) - Math.abs(a.ecl_delta_kes);
    if (d !== 0) return d;
    return a.preset_id.localeCompare(b.preset_id);
  });
  rows.forEach((row, i) => {
    row.rank = i + 1;
  });

  // Aggregate.
  const adverse_count = rows.filter((r) => r.ecl_delta_kes > 0).length;
  const benign_count = rows.length - adverse_count;
  const worst_ecl_delta_kes = rows.length > 0 ? rows[0]!.ecl_delta_kes : 0;
  const sumDelta = rows.reduce((s, r) => s + r.ecl_delta_kes, 0);
  const mean_ecl_delta_kes = rows.length > 0 ? Math.round(sumDelta / rows.length) : 0;

  return {
    tenant_id,
    generated_at: now().toISOString(),
    selection,
    preset_count: rows.length,
    totals: { worst_ecl_delta_kes, mean_ecl_delta_kes, adverse_count, benign_count },
    results: rows,
  };
}
