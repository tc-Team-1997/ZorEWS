// services/bff/src/scenario_ecl_comparison.ts
//
// T6 M16.24 — Scenario ECL impact comparison.
//
// Runs a specified list of scenario presets (1-15) against the
// standard portfolio and ranks them by ECL delta. Provides a
// comprehensive comparison view with stage migration and segment
// insights for each preset.
//
// Distinct from M16.2 (bulk-run): M16.2 takes preset_ids or category
// and returns a simplified ranked list. M16.24 returns richer per-preset
// insights including stage migration totals and worst-performing segment.
//
// Re-uses runScenario from scenario/engine (T4.2) so ECL math is
// consistent with /v1/scenario/run and /v1/scenarios/bulk-run.

import { runScenario } from './scenario/engine';
import { defaultPortfolio } from './scenario/portfolio';
import {
  getScenarioPreset,
  type ScenarioPreset,
} from './scenario_library';
import type { StageMigration } from './scenario/types';

// ─── Constants ─────────────────────────────────────────────────────────

const MAX_PRESETS = 15;
const MIN_PRESETS = 1;

// ─── Public types ──────────────────────────────────────────────────────

export interface ScenarioEclResult {
  preset_id: string;
  name: string;
  category: string;
  severity: string;
  /** stressed_ecl_kes - baseline_ecl_kes */
  ecl_delta_kes: number;
  /** ecl_delta_kes / baseline_ecl_kes; null when baseline=0 */
  ecl_pct_change: number | null;
  /** Sum of all off-diagonal entries in the stage migration matrix */
  stage_migrations_total: number;
  /** Segment with the highest stressed PD */
  worst_segment: string;
  /** 1 = most stressed (highest ecl_delta_kes) */
  rank: number;
}

export interface ScenarioEclComparison {
  tenant_id: string;
  generated_at: string;
  total_presets: number;
  /** Sorted by ecl_delta_kes desc (most stressed first) */
  results: ScenarioEclResult[];
  max_ecl_delta_kes: number;
  min_ecl_delta_kes: number;
  spread_kes: number;
  most_resilient_preset: { preset_id: string; name: string; ecl_delta_kes: number } | null;
  most_stressed_preset: { preset_id: string; name: string; ecl_delta_kes: number } | null;
}

export class ScenarioEclComparisonError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ScenarioEclComparisonError';
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────

/** Count total off-diagonal migrations in the 3×3 stage transition matrix. */
function countStageMigrations(migration: StageMigration): number {
  return (
    migration.s1.s2 + migration.s1.s3 +
    migration.s2.s1 + migration.s2.s3 +
    migration.s3.s1 + migration.s3.s2
  );
}

/** Find segment with highest stressed PD from segments[]. */
function findWorstSegment(
  segments: Array<{ segment: string; stressed_pd: number }>,
): string {
  if (segments.length === 0) return 'unknown';
  let best = segments[0]!;
  for (const s of segments) {
    if (s.stressed_pd > best.stressed_pd) best = s;
  }
  return best.segment;
}

// ─── Implementation ─────────────────────────────────────────────────────

export function buildScenarioEclComparison(
  tenant_id: string,
  preset_ids: string[],
  now: Date,
): ScenarioEclComparison {
  if (!tenant_id || tenant_id.trim() === '') {
    throw new ScenarioEclComparisonError('invalid_input', 'tenant_id is required');
  }

  if (!Array.isArray(preset_ids) || preset_ids.length < MIN_PRESETS) {
    throw new ScenarioEclComparisonError(
      'invalid_input',
      `preset_ids must be an array with at least ${MIN_PRESETS} item`,
    );
  }
  if (preset_ids.length > MAX_PRESETS) {
    throw new ScenarioEclComparisonError(
      'invalid_input',
      `preset_ids exceeds maximum of ${MAX_PRESETS}`,
    );
  }

  // Resolve presets
  const resolvedPresets: ScenarioPreset[] = [];
  for (const id of preset_ids) {
    if (typeof id !== 'string' || !id.trim()) {
      throw new ScenarioEclComparisonError('invalid_input', 'every preset_id must be a non-empty string');
    }
    const p = getScenarioPreset(id);
    if (!p) {
      throw new ScenarioEclComparisonError('unknown_preset', `unknown preset: ${id}`);
    }
    resolvedPresets.push(p);
  }

  // Run each preset
  const portfolio = defaultPortfolio();
  const nowFn = () => now;

  const rows: ScenarioEclResult[] = resolvedPresets.map((p) => {
    const r = runScenario(portfolio, p.shocks, nowFn);
    const ecl_pct_change =
      r.baseline_ecl_kes !== 0
        ? Math.round((r.ecl_delta_kes / r.baseline_ecl_kes) * 10_000) / 10_000
        : null;
    return {
      preset_id: p.id,
      name: p.name,
      category: p.category as string,
      severity: p.severity as string,
      ecl_delta_kes: r.ecl_delta_kes,
      ecl_pct_change,
      stage_migrations_total: countStageMigrations(r.stage_migration),
      worst_segment: findWorstSegment(r.segments ?? []),
      rank: 0, // assigned after sort
    };
  });

  // Sort by ecl_delta_kes desc, stable by preset_id
  rows.sort((a, b) => {
    if (b.ecl_delta_kes !== a.ecl_delta_kes) return b.ecl_delta_kes - a.ecl_delta_kes;
    return a.preset_id.localeCompare(b.preset_id);
  });
  rows.forEach((r, i) => {
    r.rank = i + 1;
  });

  const max_ecl_delta_kes = rows.length > 0 ? rows[0]!.ecl_delta_kes : 0;
  const min_ecl_delta_kes = rows.length > 0 ? rows[rows.length - 1]!.ecl_delta_kes : 0;
  const spread_kes = max_ecl_delta_kes - min_ecl_delta_kes;

  const most_stressed_preset =
    rows.length > 0
      ? { preset_id: rows[0]!.preset_id, name: rows[0]!.name, ecl_delta_kes: rows[0]!.ecl_delta_kes }
      : null;
  const most_resilient_preset =
    rows.length > 0
      ? {
          preset_id: rows[rows.length - 1]!.preset_id,
          name: rows[rows.length - 1]!.name,
          ecl_delta_kes: rows[rows.length - 1]!.ecl_delta_kes,
        }
      : null;

  return {
    tenant_id,
    generated_at: now.toISOString(),
    total_presets: rows.length,
    results: rows,
    max_ecl_delta_kes,
    min_ecl_delta_kes,
    spread_kes,
    most_resilient_preset,
    most_stressed_preset,
  };
}
