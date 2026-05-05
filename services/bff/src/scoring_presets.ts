// services/bff/src/scoring_presets.ts
//
// T6 M6.3 — Scoring weight presets.
//
// M6.1 ships the Σ(W×V) scorer with explicit weights. M6.2 ships
// the catalog-lookup convenience layer (resolves weights from the
// platform-default indicator catalog). M6.3 adds a small library
// of NAMED weight bundles tenants can apply when the catalog
// defaults don't match their risk appetite:
//
//   conservative — bias TOWARD higher weights (catch more risk;
//                  more alerts, higher recall, lower precision)
//   balanced     — catalog defaults (multiplier 1.0 across the
//                  board; SPA still uses this preset for "use the
//                  platform default" UX)
//   aggressive   — bias DOWN on selected indicators (fewer false
//                  positives, accepts lower recall — useful for
//                  ops teams who can't keep up with the alert
//                  volume)
//
// Design:
//  - Pure data + 1 pure-function "score by preset" entry point.
//    No store, no AppDeps slot. Future M6.4 will land per-tenant
//    custom presets with a CRUD store.
//  - Multipliers are SPARSE — only indicators the preset wants to
//    bias appear in `weight_multipliers`. Indicators not in the map
//    use the unmodified catalog default (multiplier 1.0).
//  - Conservative preset multipliers ≥ 1 on the "bad signals"
//    (fraud history, repeat claims, DPD). Aggressive ≤ 1.

import {
  IndicatorLookupError,
  scoreFromIndicators,
  type ByIndicatorItem,
  type IndicatorWeight,
  type IndicatorWeightLookup,
  type ScoringByIndicatorsResult,
  type ScoringVertical,
} from './bil_scoring_v2';

// ─── Public types ─────────────────────────────────────────────────────

export type WeightPresetMode = 'conservative' | 'balanced' | 'aggressive';

export const VALID_PRESET_MODES: readonly WeightPresetMode[] = [
  'conservative',
  'balanced',
  'aggressive',
] as const;

export interface WeightPreset {
  id: string;
  name: string;
  description: string;
  vertical: ScoringVertical;
  mode: WeightPresetMode;
  /** Sparse map: indicator_id → multiplier. Indicators not listed
   *  default to 1.0 (catalog weight passes through unchanged). */
  weight_multipliers: Readonly<Record<string, number>>;
}

export interface ScoreByPresetInput {
  preset_id: string;
  items: ByIndicatorItem[];
}

export interface ScoreByPresetResult extends ScoringByIndicatorsResult {
  preset_id: string;
  preset_name: string;
  preset_mode: WeightPresetMode;
  /** Per-indicator details: catalog weight, applied multiplier,
   *  effective weight = catalog × multiplier. Useful for the SPA
   *  to show a "why this score?" breakdown. */
  effective_weights: Array<{
    indicator_id: string;
    catalog_weight: number;
    multiplier: number;
    effective_weight: number;
  }>;
}

export class WeightPresetError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'WeightPresetError';
  }
}

// ─── Seed library — 6 presets (3 modes × 2 verticals) ─────────────────

export const WEIGHT_PRESETS: readonly WeightPreset[] = [
  // ─── banking ──────────────────────────────────────────────────────
  {
    id: 'preset_banking_conservative',
    name: 'Banking — Conservative',
    description:
      'High-recall posture. Boosts DPD, credit utilisation, and balance run-down signals. Use when alert volume is preferable to missed risk.',
    vertical: 'banking',
    mode: 'conservative',
    weight_multipliers: {
      'FIN-001': 1.15, // DPD ≥ 30 — boost
      'FIN-002': 1.1,  // Credit utilisation
      'BEH-001': 1.2,  // Balance run-down
      'TXN-002': 1.1,  // Cross-border outflow
    },
  },
  {
    id: 'preset_banking_balanced',
    name: 'Banking — Balanced',
    description:
      'Catalog defaults pass through unchanged. Reference posture for new tenants.',
    vertical: 'banking',
    mode: 'balanced',
    weight_multipliers: {},
  },
  {
    id: 'preset_banking_aggressive',
    name: 'Banking — Aggressive',
    description:
      'Lower-volume posture. Tones down softer behavioural signals so only severe DPD + utilisation events drive alerts.',
    vertical: 'banking',
    mode: 'aggressive',
    weight_multipliers: {
      'BEH-002': 0.7,  // Login frequency drop — tone down
      'TXN-001': 0.85, // Transaction velocity spike
      'FIN-003': 0.85, // Income volatility
    },
  },

  // ─── insurance ────────────────────────────────────────────────────
  {
    id: 'preset_insurance_conservative',
    name: 'Insurance — Conservative',
    description:
      'High-recall posture for fraud-heavy environments. Boosts repeat-claim, claim-deviation, and claim-history signals.',
    vertical: 'insurance',
    mode: 'conservative',
    weight_multipliers: {
      'CLM-001': 1.2,  // Repeat-claim 180d — boost
      'CLM-002': 1.15, // Claim amount deviation > 30%
      'CUS-INS-001': 1.15, // Customer claim history — high
      'POL-002': 1.1,  // Premium arrears
    },
  },
  {
    id: 'preset_insurance_balanced',
    name: 'Insurance — Balanced',
    description:
      'Catalog defaults pass through unchanged. Reference posture for new tenants.',
    vertical: 'insurance',
    mode: 'balanced',
    weight_multipliers: {},
  },
  {
    id: 'preset_insurance_aggressive',
    name: 'Insurance — Aggressive',
    description:
      'Lower-volume posture. Tones down agent persistency + UW operational signals so only direct claim/policy events drive alerts.',
    vertical: 'insurance',
    mode: 'aggressive',
    weight_multipliers: {
      'AGT-001': 0.7,    // Agent persistency drop — tone down
      'OPS-001': 0.6,    // Underwriting p95 delay
      'CUS-INS-002': 0.85, // KYC nearing expiry
    },
  },
] as const;

const PRESETS_BY_ID = new Map<string, WeightPreset>(
  WEIGHT_PRESETS.map((p) => [p.id, p]),
);

// ─── Type guards ──────────────────────────────────────────────────────

export function isWeightPresetMode(s: unknown): s is WeightPresetMode {
  return typeof s === 'string' && VALID_PRESET_MODES.includes(s as WeightPresetMode);
}

// ─── Read API ──────────────────────────────────────────────────────────

export interface PresetListFilter {
  vertical?: ScoringVertical;
  mode?: WeightPresetMode;
}

export function listWeightPresets(filter: PresetListFilter = {}): WeightPreset[] {
  return WEIGHT_PRESETS.filter(
    (p) =>
      (filter.vertical === undefined || p.vertical === filter.vertical) &&
      (filter.mode === undefined || p.mode === filter.mode),
  );
}

export function getWeightPreset(id: string): WeightPreset | null {
  return PRESETS_BY_ID.get(id) ?? null;
}

// ─── Score-by-preset entry ────────────────────────────────────────────

/** Wraps a base lookup, applying the preset's multiplier on top. */
class PresetScopedLookup implements IndicatorWeightLookup {
  constructor(
    private readonly base: IndicatorWeightLookup,
    private readonly preset: WeightPreset,
  ) {}

  getWeight(indicator_id: string, vertical?: ScoringVertical): IndicatorWeight | null {
    // Force vertical to the preset's vertical — a banking preset
    // shouldn't successfully resolve insurance indicators.
    const target = vertical ?? this.preset.vertical;
    if (target !== this.preset.vertical) return null;
    const base = this.base.getWeight(indicator_id, this.preset.vertical);
    if (!base) return null;
    const multiplier = this.preset.weight_multipliers[indicator_id] ?? 1;
    // Clamp to M6.1's required [0, 1] range. Conservative multipliers
    // can push the effective weight above the catalog default; the
    // upstream Σ(W×V) engine treats 1.0 as max severity so clipping
    // there preserves the contract without losing signal.
    const effective = Math.max(0, Math.min(1, base.weight * multiplier));
    return { ...base, weight: effective };
  }
}

/**
 * Score using a named preset's multipliers on top of the base
 * lookup. Code-routed:
 *   - bad input shape         → invalid_input (400)
 *   - unknown preset id       → unknown_preset (404)
 *   - lookup throws below     → bubbled with its own code
 */
export function scoreByPreset(
  input: ScoreByPresetInput,
  baseLookup: IndicatorWeightLookup,
): ScoreByPresetResult {
  if (!input || typeof input !== 'object') {
    throw new WeightPresetError('invalid_input', 'request body required');
  }
  if (typeof input.preset_id !== 'string' || !input.preset_id.trim()) {
    throw new WeightPresetError('invalid_input', 'preset_id is required');
  }
  if (!Array.isArray(input.items)) {
    throw new WeightPresetError('invalid_input', 'items must be an array');
  }
  const preset = getWeightPreset(input.preset_id);
  if (!preset) {
    throw new WeightPresetError('unknown_preset', `unknown preset: ${input.preset_id}`);
  }

  const scopedLookup = new PresetScopedLookup(baseLookup, preset);
  const inner = scoreFromIndicators(input.items, scopedLookup, {
    vertical: preset.vertical,
  });

  // Build the effective_weights breakdown — caller-friendly transparency.
  // Re-resolve catalog weights directly from the base lookup (rather
  // than reverse-engineering from r.weight, which is unreliable once
  // the [0, 1] clamp engages on conservative multipliers).
  const effective_weights = inner.resolved.map((r) => {
    const multiplier = preset.weight_multipliers[r.indicator_id] ?? 1;
    const catalog = baseLookup.getWeight(r.indicator_id, preset.vertical);
    const catalog_weight = catalog?.weight ?? r.weight;
    return {
      indicator_id: r.indicator_id,
      catalog_weight,
      multiplier,
      effective_weight: r.weight,
    };
  });

  return {
    ...inner,
    preset_id: preset.id,
    preset_name: preset.name,
    preset_mode: preset.mode,
    effective_weights,
  };
}

// Re-export so the route handler doesn't need a separate import.
export { IndicatorLookupError };
