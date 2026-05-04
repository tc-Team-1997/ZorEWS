// services/bff/src/scenario/types.ts

/** Macro shock inputs from the SPA scenario page. All zero = baseline. */
export interface ShockInputs {
  /** GDP growth shock in percentage points (negative = contraction). Range: -8 to +4. */
  gdp: number;
  /** Policy-rate shock in basis points (positive = hike). Range: -200 to +400. */
  rate: number;
  /** Local-currency depreciation vs USD in percent (positive = weaker KES). Range: -10 to +20. */
  fx: number;
}

export type RiskBand = 'low' | 'medium' | 'high';

export interface BandSummary {
  low: number;
  medium: number;
  high: number;
}

/**
 * IFRS 9 expected-credit-loss staging.
 *   - Stage 1 = performing, 12-month ECL
 *   - Stage 2 = significant increase in credit risk (SICR), lifetime ECL
 *   - Stage 3 = credit-impaired, lifetime ECL
 *
 * In production, Stage 1→2 is determined by *relative* PD deterioration
 * vs. origination PD (typically a 30-DPD trigger or a >2x PD increase).
 * For the prototype we use absolute PD thresholds aligned with the
 * existing risk bands — this is an intentional simplification. See
 * stageFromPd() in engine.ts for the cutoffs.
 */
export type IfrsStage = 1 | 2 | 3;

export interface StageDistribution {
  stage_1: number;
  stage_2: number;
  stage_3: number;
}

/**
 * 3x3 stage transition matrix. `from` keys = baseline stage, inner keys
 * = stressed stage. Values are account counts. The diagonal (s1→s1, s2→s2,
 * s3→s3) is "no migration". Off-diagonal upward (e.g. s1→s2) is
 * deterioration; downward is improvement.
 */
export interface StageMigration {
  s1: { s1: number; s2: number; s3: number };
  s2: { s1: number; s2: number; s3: number };
  s3: { s1: number; s2: number; s3: number };
}

/** Per-segment impact row, used to render the per-segment summary table. */
export interface SegmentImpact {
  segment: string;
  /** Account count in this segment. */
  accounts: number;
  /** Weighted-average baseline PD (0–1). */
  baseline_pd: number;
  /** Weighted-average stressed PD (0–1). */
  stressed_pd: number;
  /** Stressed minus baseline (percentage points, positive = worse). */
  pd_delta_pp: number;
  /** Expected credit loss delta in KES (stressed − baseline). */
  ecl_delta_kes: number;
}

/**
 * Segment × risk-level matrix for the SPA's true 2D heatmap.
 *   - rows = product segment (mortgage / auto / personal / sme)
 *   - cols = baseline + stressed BandSummary
 * The SPA renders cells colored by stressed count, so a single cell
 * holds two numbers (baseline → stressed) and the deterioration is
 * legible from the cell's color intensity.
 */
export interface SegmentRiskRow {
  segment: string;
  baseline: BandSummary;
  stressed: BandSummary;
}

export interface AffectedCustomer {
  customer_id: string;
  name: string;
  product: string;
  baseline_pd: number;
  stressed_pd: number;
  pd_delta_pp: number;
  ead_kes: number;
  ecl_delta_kes: number;
}

export interface ScenarioResult {
  /** Echo of the inputs so the SPA can show "as-of" context. */
  inputs: ShockInputs;
  /** Total accounts in the simulated portfolio. */
  portfolio_size: number;
  /** Total exposure-at-default in KES (constant across shock — not counting prepayment). */
  total_ead_kes: number;
  /** Baseline ECL = sum(EAD × PD × LGD) in KES. */
  baseline_ecl_kes: number;
  /** Stressed ECL in KES. */
  stressed_ecl_kes: number;
  /** Stressed − baseline (KES). Positive = worse. */
  ecl_delta_kes: number;
  /** Account counts by risk band, baseline. */
  baseline_bands: BandSummary;
  /** Account counts by risk band, stressed. */
  stressed_bands: BandSummary;
  /** IFRS 9 stage distribution, baseline. */
  baseline_stages: StageDistribution;
  /** IFRS 9 stage distribution, stressed. */
  stressed_stages: StageDistribution;
  /** Stage transition counts (baseline stage → stressed stage). */
  stage_migration: StageMigration;
  /** Per-product-type impact rows for the per-segment summary table. */
  segments: SegmentImpact[];
  /**
   * Segment × risk-level matrix (rows = segment, cols = Low/Medium/High
   * with baseline + stressed counts per cell). Used for the 2D heatmap.
   */
  segment_risk_matrix: SegmentRiskRow[];
  /**
   * EAD-weighted portfolio PD (baseline) — sum(PD × EAD) / sum(EAD).
   * Reported as 0–1, not a percentage.
   */
  baseline_portfolio_pd: number;
  /** EAD-weighted portfolio PD after the shock. */
  stressed_portfolio_pd: number;
  /**
   * NPA share = Stage 3 (credit-impaired) accounts / total accounts.
   * Production may want this weighted by EAD instead of count — flagged
   * as a prototype simplification.
   */
  baseline_npa_pct: number;
  /** NPA share after the shock. */
  stressed_npa_pct: number;
  /** Top-10 customers ranked by absolute PD delta. */
  top_affected: AffectedCustomer[];
  /** ISO timestamp when the run was computed. */
  computed_at: string;
}
