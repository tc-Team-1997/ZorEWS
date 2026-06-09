// services/bff/src/custom_preset_coverage_gap.ts
//
// T6 M6.21 — Custom scoring preset coverage gap analysis.
//
// Compares a tenant's custom weight presets against the 6 library
// presets (conservative/balanced/aggressive × banking/insurance) to
// surface which mode+vertical combinations have NO custom preset.
// A "gap" means ops haven't yet tailored that mode/vertical and are
// running on the library default — acceptable for some combinations,
// but a governance flag for others (e.g. a BIL banking tenant should
// usually have at least a custom conservative_banking override).

import {
  VALID_PRESET_MODES,
  type WeightPreset,
  type WeightPresetMode,
} from './scoring_presets';
import { type ScoringVertical } from './bil_scoring_v2';

// ─── Public types ──────────────────────────────────────────────────────

export interface PresetCoverageCell {
  mode: WeightPresetMode;
  vertical: ScoringVertical;
  has_library_preset: true;
  has_custom_preset: boolean;
  custom_preset_ids: string[];
  /** true when tenant has no custom preset for this mode+vertical. */
  is_gap: boolean;
}

export interface CustomPresetCoverageGapResult {
  tenant_id: string;
  generated_at: string;
  total_combinations: 6;
  gaps_count: number;
  covered_count: number;
  /** Cells where is_gap=true (no custom preset). */
  gaps: PresetCoverageCell[];
  /** Cells where is_gap=false (at least one custom preset). */
  covered: PresetCoverageCell[];
  /** 0..1 — covered_count / total_combinations. */
  coverage_rate: number;
  /** Mode with the highest number of custom presets across verticals.
   *  null when no custom presets exist. */
  most_customized_mode: WeightPresetMode | null;
}

// ─── Constants ─────────────────────────────────────────────────────────

const VERTICALS: readonly ScoringVertical[] = ['banking', 'insurance'];
const TOTAL = 6; // 3 modes × 2 verticals

// ─── Pure function ─────────────────────────────────────────────────────

export function analyzeCustomPresetCoverageGaps(
  tenant_id: string,
  customPresets: WeightPreset[],
  now: Date,
): CustomPresetCoverageGapResult {
  if (!tenant_id || typeof tenant_id !== 'string') {
    throw new Error('tenant_id is required');
  }

  const cells: PresetCoverageCell[] = [];

  for (const mode of VALID_PRESET_MODES) {
    for (const vertical of VERTICALS) {
      const matching = customPresets.filter(
        (p) => p.mode === mode && p.vertical === vertical,
      );
      const has_custom_preset = matching.length > 0;
      cells.push({
        mode,
        vertical,
        has_library_preset: true,
        has_custom_preset,
        custom_preset_ids: matching.map((p) => p.id).sort(),
        is_gap: !has_custom_preset,
      });
    }
  }

  const gaps = cells.filter((c) => c.is_gap);
  const covered = cells.filter((c) => !c.is_gap);
  const gaps_count = gaps.length;
  const covered_count = covered.length;
  const coverage_rate = covered_count / TOTAL;

  // Compute most_customized_mode: mode with highest total custom count
  let most_customized_mode: WeightPresetMode | null = null;
  if (customPresets.length > 0) {
    let bestMode: WeightPresetMode | null = null;
    let bestCount = -1;
    for (const mode of VALID_PRESET_MODES) {
      const cnt = customPresets.filter((p) => p.mode === mode).length;
      if (cnt > bestCount) {
        bestCount = cnt;
        bestMode = mode;
      }
    }
    most_customized_mode = bestMode;
  }

  return {
    tenant_id,
    generated_at: now.toISOString(),
    total_combinations: TOTAL,
    gaps_count,
    covered_count,
    gaps,
    covered,
    coverage_rate,
    most_customized_mode,
  };
}
