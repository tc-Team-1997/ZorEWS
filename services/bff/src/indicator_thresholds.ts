// services/bff/src/indicator_thresholds.ts
//
// T6 M4.3 — KRI threshold breach detection.
//
// The catalog (M6.2 STUB_CATALOG) defines 17 indicators with
// severity weights but no breach thresholds. The alert classifier
// (M8.1) consumes WireSeverity {LOW, MEDIUM, HIGH, CRITICAL} and
// maps to BIL Red/Orange/Yellow/Green — but nothing today turns
// a raw indicator VALUE into a severity. M4.3 ships that primitive:
//
//   indicator_value (0..1) → 3-zone breach class (yellow/orange/red)
//
// Drives the SPA's "live KRI dashboard" view + serves as the input
// to M8.1 classification in the future alert-ingest path.
//
// Design:
//  - Per-indicator thresholds: { yellow_at, orange_at, red_at }.
//    Monotonic: yellow_at <= orange_at <= red_at (validated).
//  - Lower-is-better indicators (e.g. login_frequency_drop): the
//    DEFAULT direction is "higher value = more risk", but we
//    surface a `direction` flag for future M4.4 inversions.
//  - Pure function checkBreach(threshold, value) returns:
//      { breach_class, threshold_crossed, headroom_to_next }
//  - 17 default thresholds — one per M6.2 STUB_CATALOG indicator.

import {
  type ScoringVertical,
  STUB_CATALOG as INDICATOR_CATALOG,
} from './bil_scoring_v2';

// ─── Public types ─────────────────────────────────────────────────────

export type BreachClass = 'green' | 'yellow' | 'orange' | 'red';

export interface IndicatorThreshold {
  indicator_id: string;
  vertical: ScoringVertical;
  /** Display name copied from the catalog for SPA convenience. */
  name: string;
  yellow_at: number;
  orange_at: number;
  red_at: number;
}

export interface BreachResult {
  indicator_id: string;
  vertical: ScoringVertical;
  name: string;
  value: number;
  breach_class: BreachClass;
  /** The threshold the value crossed into. null when green. */
  threshold_crossed: number | null;
  /** Distance to the NEXT escalation threshold. null when red (no
   *  next zone). Negative when value already exceeds next zone. */
  headroom_to_next: number | null;
}

export class ThresholdError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'ThresholdError';
  }
}

// ─── Default thresholds — one per M6.2 catalog entry ─────────────────
//
// Calibrated qualitatively from BIL §11 alert-class semantics:
//   yellow ≈ "watch this"  (typically value > 0.45)
//   orange ≈ "act soon"     (value > 0.65)
//   red    ≈ "act now"      (value > 0.85)
// Per-indicator tweaks reflect that DPD/repeat-claim are sharper
// signals (lower red threshold) than soft behavioural ones.

const DEFAULTS: IndicatorThreshold[] = [
  // Banking
  { indicator_id: 'FIN-001', vertical: 'banking', name: 'DPD ≥ 30 days', yellow_at: 0.30, orange_at: 0.55, red_at: 0.80 },
  { indicator_id: 'FIN-002', vertical: 'banking', name: 'Credit utilisation > 90%', yellow_at: 0.50, orange_at: 0.75, red_at: 0.90 },
  { indicator_id: 'FIN-003', vertical: 'banking', name: 'Income volatility — 90d', yellow_at: 0.45, orange_at: 0.65, red_at: 0.85 },
  { indicator_id: 'BEH-001', vertical: 'banking', name: 'Account-balance run-down', yellow_at: 0.45, orange_at: 0.70, red_at: 0.90 },
  { indicator_id: 'BEH-002', vertical: 'banking', name: 'Login frequency drop', yellow_at: 0.50, orange_at: 0.75, red_at: 0.90 },
  { indicator_id: 'TXN-001', vertical: 'banking', name: 'Transaction velocity spike', yellow_at: 0.45, orange_at: 0.70, red_at: 0.85 },
  { indicator_id: 'TXN-002', vertical: 'banking', name: 'Cross-border outflow', yellow_at: 0.40, orange_at: 0.65, red_at: 0.85 },
  { indicator_id: 'CRD-001', vertical: 'banking', name: 'Credit-card cash advance ratio', yellow_at: 0.40, orange_at: 0.60, red_at: 0.80 },

  // Insurance
  { indicator_id: 'POL-001', vertical: 'insurance', name: 'Policy lapse imminent', yellow_at: 0.40, orange_at: 0.65, red_at: 0.85 },
  { indicator_id: 'POL-002', vertical: 'insurance', name: 'Premium arrears 60+ days', yellow_at: 0.30, orange_at: 0.55, red_at: 0.80 },
  { indicator_id: 'CUS-INS-001', vertical: 'insurance', name: 'Customer claim history — high', yellow_at: 0.35, orange_at: 0.60, red_at: 0.80 },
  { indicator_id: 'CUS-INS-002', vertical: 'insurance', name: 'KYC nearing expiry', yellow_at: 0.50, orange_at: 0.75, red_at: 0.95 },
  { indicator_id: 'AGT-001', vertical: 'insurance', name: 'Agent persistency drop', yellow_at: 0.45, orange_at: 0.65, red_at: 0.85 },
  // Repeat-claim is the sharpest fraud signal — tighter thresholds
  { indicator_id: 'CLM-001', vertical: 'insurance', name: 'Repeat-claim 180d', yellow_at: 0.25, orange_at: 0.50, red_at: 0.75 },
  { indicator_id: 'CLM-002', vertical: 'insurance', name: 'Claim amount deviation > 30%', yellow_at: 0.30, orange_at: 0.55, red_at: 0.80 },
  { indicator_id: 'CLM-003', vertical: 'insurance', name: 'Off-template documents', yellow_at: 0.35, orange_at: 0.60, red_at: 0.85 },
  { indicator_id: 'OPS-001', vertical: 'insurance', name: 'Underwriting p95 delay breach', yellow_at: 0.50, orange_at: 0.75, red_at: 0.90 },
];

const THRESHOLDS_BY_ID = new Map<string, IndicatorThreshold>(
  DEFAULTS.map((t) => [t.indicator_id, t]),
);

/** Cross-check: every M6.2 catalog indicator has a threshold. Static
 *  invariant — fails fast at test time. */
export function assertThresholdCoverage(): void {
  for (const id of Object.keys(INDICATOR_CATALOG)) {
    if (!THRESHOLDS_BY_ID.has(id)) {
      throw new ThresholdError(
        'missing_threshold',
        `indicator ${id} has no default threshold (catalog/threshold drift)`,
      );
    }
  }
}

// ─── Read API ─────────────────────────────────────────────────────────

export interface ThresholdListFilter {
  vertical?: ScoringVertical;
}

export function listThresholds(filter: ThresholdListFilter = {}): IndicatorThreshold[] {
  return DEFAULTS.filter(
    (t) => filter.vertical === undefined || t.vertical === filter.vertical,
  );
}

export function getThreshold(indicator_id: string): IndicatorThreshold | null {
  return THRESHOLDS_BY_ID.get(indicator_id) ?? null;
}

// ─── Pure-function checkBreach ────────────────────────────────────────

/**
 * Classify a value against a threshold. Pure — no I/O.
 *
 * Zones:
 *   value < yellow_at  → green
 *   yellow_at ≤ value < orange_at → yellow
 *   orange_at ≤ value < red_at → orange
 *   value ≥ red_at → red
 *
 * `headroom_to_next` is the distance to the NEXT escalation:
 *   green → distance to yellow_at
 *   yellow → distance to orange_at
 *   orange → distance to red_at
 *   red → null (no next)
 */
export function checkBreach(threshold: IndicatorThreshold, value: number): BreachResult {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ThresholdError('invalid_input', 'value must be a finite number');
  }
  if (value < 0 || value > 1) {
    throw new ThresholdError('invalid_input', 'value must be in [0, 1]');
  }

  let breach_class: BreachClass;
  let threshold_crossed: number | null;
  let headroom_to_next: number | null;

  if (value >= threshold.red_at) {
    breach_class = 'red';
    threshold_crossed = threshold.red_at;
    headroom_to_next = null;
  } else if (value >= threshold.orange_at) {
    breach_class = 'orange';
    threshold_crossed = threshold.orange_at;
    headroom_to_next = threshold.red_at - value;
  } else if (value >= threshold.yellow_at) {
    breach_class = 'yellow';
    threshold_crossed = threshold.yellow_at;
    headroom_to_next = threshold.orange_at - value;
  } else {
    breach_class = 'green';
    threshold_crossed = null;
    headroom_to_next = threshold.yellow_at - value;
  }

  return {
    indicator_id: threshold.indicator_id,
    vertical: threshold.vertical,
    name: threshold.name,
    value,
    breach_class,
    threshold_crossed,
    headroom_to_next,
  };
}

/**
 * Resolve indicator_id and check. Code-routed:
 *   - missing/blank id     → invalid_input (400)
 *   - unknown indicator    → unknown_indicator (404)
 *   - value not in [0, 1]  → invalid_input (400)
 *
 * Optional `lookup` callback (M4.4) extends resolution beyond the
 * platform defaults — e.g. server threads getEffectiveThreshold so
 * per-tenant overrides resolve too. Defaults to library-only.
 */
export type ThresholdLookup = (id: string) => IndicatorThreshold | null;

export function checkBreachById(
  indicator_id: unknown,
  value: unknown,
  lookup: ThresholdLookup = getThreshold,
): BreachResult {
  if (typeof indicator_id !== 'string' || !indicator_id.trim()) {
    throw new ThresholdError('invalid_input', 'indicator_id required');
  }
  if (typeof value !== 'number') {
    throw new ThresholdError('invalid_input', 'value must be a number');
  }
  const t = lookup(indicator_id);
  if (!t) {
    throw new ThresholdError('unknown_indicator', `unknown indicator: ${indicator_id}`);
  }
  return checkBreach(t, value);
}

// ─── M4.4 — Per-tenant override store ─────────────────────────────────

export interface ThresholdOverrideInput {
  yellow_at: number;
  orange_at: number;
  red_at: number;
}

function validateOverride(input: unknown): ThresholdOverrideInput {
  if (!input || typeof input !== 'object') {
    throw new ThresholdError('invalid_input', 'request body required');
  }
  const i = input as Record<string, unknown>;
  for (const k of ['yellow_at', 'orange_at', 'red_at'] as const) {
    if (typeof i[k] !== 'number' || !Number.isFinite(i[k])) {
      throw new ThresholdError('invalid_input', `${k} must be a finite number`);
    }
    const v = i[k] as number;
    if (v < 0 || v > 1) {
      throw new ThresholdError('invalid_input', `${k} must be in [0, 1]`);
    }
  }
  const ya = i.yellow_at as number;
  const oa = i.orange_at as number;
  const ra = i.red_at as number;
  if (!(ya <= oa && oa <= ra)) {
    throw new ThresholdError(
      'invalid_input',
      'thresholds must be monotonic: yellow_at ≤ orange_at ≤ red_at',
    );
  }
  return { yellow_at: ya, orange_at: oa, red_at: ra };
}

export interface ThresholdOverrideStore {
  /** Returns the override (if any) merged with library defaults to
   *  produce a complete IndicatorThreshold. Falls through to the
   *  library when no override exists. Null when the indicator_id
   *  isn't even in the platform catalog. */
  effective(tenant_id: string, indicator_id: string): IndicatorThreshold | null;
  /** Returns just the override entry (or null). */
  getOverride(tenant_id: string, indicator_id: string): IndicatorThreshold | null;
  /** List all overrides for a tenant. */
  listOverrides(tenant_id: string): IndicatorThreshold[];
  /** Set an override. Throws on bad shape, missing indicator id, or
   *  monotonicity violation. */
  setOverride(
    tenant_id: string,
    indicator_id: string,
    input: unknown,
  ): IndicatorThreshold;
  /** Delete an override. Returns true on hit, false on miss. */
  deleteOverride(tenant_id: string, indicator_id: string): boolean;
}

export class InMemoryThresholdOverrideStore implements ThresholdOverrideStore {
  // (tenant, indicator) → override
  private readonly map = new Map<string, IndicatorThreshold>();

  private k(tenant: string, indicator: string): string {
    return `${tenant}::${indicator}`;
  }

  effective(tenant_id: string, indicator_id: string): IndicatorThreshold | null {
    const lib = getThreshold(indicator_id);
    if (!lib) return null;
    const ov = this.map.get(this.k(tenant_id, indicator_id));
    return ov ?? lib;
  }

  getOverride(tenant_id: string, indicator_id: string): IndicatorThreshold | null {
    return this.map.get(this.k(tenant_id, indicator_id)) ?? null;
  }

  listOverrides(tenant_id: string): IndicatorThreshold[] {
    const out: IndicatorThreshold[] = [];
    const prefix = `${tenant_id}::`;
    for (const [k, v] of this.map.entries()) {
      if (k.startsWith(prefix)) out.push(v);
    }
    return out;
  }

  setOverride(
    tenant_id: string,
    indicator_id: string,
    input: unknown,
  ): IndicatorThreshold {
    const lib = getThreshold(indicator_id);
    if (!lib) {
      throw new ThresholdError('unknown_indicator', `unknown indicator: ${indicator_id}`);
    }
    const valid = validateOverride(input);
    const next: IndicatorThreshold = {
      indicator_id,
      vertical: lib.vertical,
      name: lib.name,
      yellow_at: valid.yellow_at,
      orange_at: valid.orange_at,
      red_at: valid.red_at,
    };
    this.map.set(this.k(tenant_id, indicator_id), next);
    return next;
  }

  deleteOverride(tenant_id: string, indicator_id: string): boolean {
    return this.map.delete(this.k(tenant_id, indicator_id));
  }
}

export const defaultThresholdOverrideStore: ThresholdOverrideStore =
  new InMemoryThresholdOverrideStore();

/** Helper for downstream consumers (mirrors getEffectivePreset
 *  pattern from M16.5 / M5.7 / M6.5). */
export function getEffectiveThreshold(
  store: ThresholdOverrideStore,
  tenant_id: string,
  indicator_id: string,
): IndicatorThreshold | null {
  return store.effective(tenant_id, indicator_id);
}
