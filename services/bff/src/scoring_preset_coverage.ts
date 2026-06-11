// services/bff/src/scoring_preset_coverage.ts
//
// T6 M6.26 — Custom preset coverage ratio.
//
// For each library preset (6 total, 3 modes × 2 verticals),
// check if the tenant has a corresponding custom preset
// (same mode + vertical).
//
// coverage_ratio = matching_customs / total_library_presets
//
// Route: GET /v1/scoring/presets/coverage-ratio
//   RBAC: customers:read_risk_profile

import { WEIGHT_PRESETS } from './scoring_presets';
import {
  defaultCustomWeightPresetStore,
  type CustomWeightPresetStore,
} from './scoring_presets_custom';

// ─── Public types ─────────────────────────────────────────────────────

export interface PresetCoverageCell {
  mode: string;
  vertical: string;
  has_library: true;
  has_custom: boolean;
}

export interface PresetCoverageReport {
  tenant_id: string;
  generated_at: string;
  coverage_ratio: number;
  total_library: number;
  covered_count: number;
  covered_cells: PresetCoverageCell[];
  uncovered_cells: PresetCoverageCell[];
  most_common_custom_mode: string | null;
}

// ─── Pure resolver ────────────────────────────────────────────────────

export function buildPresetCoverageRatio(
  tenant_id: string,
  customStore: CustomWeightPresetStore,
  now: Date,
): PresetCoverageReport {
  if (!tenant_id) throw new Error('tenant_id is required');

  const customPresets = customStore.list(tenant_id);

  // Build a set of (mode, vertical) from custom presets
  const customKeys = new Set<string>(
    customPresets.map((p) => `${p.mode}::${p.vertical}`),
  );

  const cells: PresetCoverageCell[] = [];
  for (const preset of WEIGHT_PRESETS) {
    const key = `${preset.mode}::${preset.vertical}`;
    cells.push({
      mode: preset.mode,
      vertical: preset.vertical,
      has_library: true,
      has_custom: customKeys.has(key),
    });
  }

  const covered_cells = cells.filter((c) => c.has_custom);
  const uncovered_cells = cells.filter((c) => !c.has_custom);

  const coverage_ratio =
    cells.length === 0
      ? 0
      : Math.round((covered_cells.length / cells.length) * 10000) / 10000;

  // Most common mode among custom presets
  let most_common_custom_mode: string | null = null;
  if (customPresets.length > 0) {
    const modeCounts = new Map<string, number>();
    for (const p of customPresets) {
      modeCounts.set(p.mode, (modeCounts.get(p.mode) ?? 0) + 1);
    }
    let maxCount = 0;
    let maxMode = '';
    for (const [mode, count] of modeCounts) {
      if (count > maxCount || (count === maxCount && mode < maxMode)) {
        maxCount = count;
        maxMode = mode;
      }
    }
    most_common_custom_mode = maxMode;
  }

  return {
    tenant_id,
    generated_at: now.toISOString(),
    coverage_ratio,
    total_library: cells.length,
    covered_count: covered_cells.length,
    covered_cells,
    uncovered_cells,
    most_common_custom_mode,
  };
}
