// services/bff/src/indicator_threshold_effective.ts
//
// T6 M4.9 — Indicator threshold effective view.
//
// M4.3 ships the platform thresholds (per-indicator yellow/orange/red
// trip points). M4.4 ships per-tenant overrides. `effective()` on the
// store already returns the merged view, but operators auditing
// "what thresholds will fire for this tenant right now?" need to
// SEE the resolution chain — which level (library default vs tenant
// override) provides each indicator's effective thresholds.
//
// Design:
//  - Pure function over the M4.3 library + M4.4 override store.
//  - Walks every platform indicator (filtered by optional vertical),
//    looks up the tenant's override (if any), and emits a per-
//    indicator entry showing source + the library default + the
//    override (when set).
//  - Mirrors M10.10's resolution-chain shape: surface BOTH levels
//    side-by-side so an operator can see what they USED to be vs
//    what they ARE now.
//  - Sorted by indicator_id asc for deterministic output.

import {
  listThresholds,
  type IndicatorThreshold,
  type ThresholdOverrideStore,
} from './indicator_thresholds';
import { type ScoringVertical, isScoringVertical } from './bil_scoring_v2';

// ─── Public types ─────────────────────────────────────────────────────

export type ThresholdSource = 'library_default' | 'tenant_override';

export interface EffectiveThresholdEntry {
  indicator_id: string;
  name: string;
  vertical: ScoringVertical;
  /** Which level provided the effective thresholds. */
  source: ThresholdSource;
  /** The thresholds that will actually fire. */
  effective: IndicatorThreshold;
  /** Always present — the platform-static threshold. */
  library_default: IndicatorThreshold;
  /** Tenant override when set; null otherwise. */
  override: IndicatorThreshold | null;
}

export interface EffectiveThresholdsResult {
  tenant_id: string;
  /** Optional filter that was applied (null = all). */
  vertical: ScoringVertical | null;
  total: number;
  /** Indicators whose effective values come from the tenant override. */
  override_count: number;
  /** Indicators whose effective values come from the library default. */
  library_count: number;
  /** Per-indicator effective view, sorted by indicator_id asc. */
  entries: EffectiveThresholdEntry[];
}

// ─── Pure resolver ────────────────────────────────────────────────────

/**
 * Walks every platform indicator (optionally filtered by vertical)
 * and emits the effective threshold + the resolution chain (library
 * default + per-tenant override when present).
 */
export function resolveEffectiveThresholds(
  store: ThresholdOverrideStore,
  tenant_id: string,
  vertical?: ScoringVertical,
): EffectiveThresholdsResult {
  if (!tenant_id || typeof tenant_id !== 'string') {
    throw new Error('tenant_id required');
  }
  if (vertical !== undefined && !isScoringVertical(vertical)) {
    throw new Error('vertical must be banking|insurance');
  }
  const library = vertical
    ? listThresholds({ vertical })
    : listThresholds();

  const entries: EffectiveThresholdEntry[] = [];
  let override_count = 0;
  let library_count = 0;

  for (const lib of library) {
    const ov = store.getOverride(tenant_id, lib.indicator_id);
    const effective = ov ?? lib;
    const source: ThresholdSource = ov ? 'tenant_override' : 'library_default';
    if (ov) override_count += 1;
    else library_count += 1;
    entries.push({
      indicator_id: lib.indicator_id,
      name: lib.name,
      vertical: lib.vertical,
      source,
      effective,
      library_default: lib,
      override: ov,
    });
  }

  entries.sort((a, b) =>
    a.indicator_id < b.indicator_id ? -1 : a.indicator_id > b.indicator_id ? 1 : 0,
  );

  return {
    tenant_id,
    vertical: vertical ?? null,
    total: entries.length,
    override_count,
    library_count,
    entries,
  };
}
