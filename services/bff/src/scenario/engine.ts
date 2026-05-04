// services/bff/src/scenario/engine.ts
//
// Pure stress function. Maps macro shocks → per-account PD multipliers using
// segment-specific elasticities, then aggregates to portfolio + segment +
// top-affected views.
//
// The elasticity table below is illustrative — production would calibrate
// these from historical macro/PD time series (vector autoregression on RBI
// stress-test guidance). For the prototype the key requirement is: the
// rankings make sense (low-income + GDP shock → biggest PD shift; FX-exposed
// SMEs → most affected by KES weakening; rate hikes hit short-tenor most).

import type { Account } from './portfolio';
import type {
  AffectedCustomer,
  BandSummary,
  IfrsStage,
  ScenarioResult,
  SegmentImpact,
  SegmentRiskRow,
  ShockInputs,
  StageDistribution,
  StageMigration,
} from './types';

// ─── Elasticities ─────────────────────────────────────────────────────────────
// Each elasticity is "unit shock → fractional PD increase". For example,
// GDP_INCOME_ELASTICITY.low = 0.045 means a -1 percentage-point GDP shock
// raises PD by ~4.5% (relative) for low-income obligors.

const GDP_INCOME_ELASTICITY: Record<Account['income_band'], number> = {
  low: 0.045,
  mid: 0.028,
  high: 0.015,
};

// Per-product rate sensitivity (bps shock × short-tenor weight). Mortgages
// are mostly fixed-rate in this synthetic book → low sensitivity. Personal
// loans tend to be variable → high.
const RATE_PRODUCT_SENSITIVITY: Record<Account['product'], number> = {
  mortgage: 0.00018,
  auto: 0.00040,
  personal: 0.00075,
  sme: 0.00055,
};

// FX shock affects only fx_exposed obligors (SME with USD-linked cashflow).
const FX_EXPOSED_SENSITIVITY = 0.012;

/** Compute the stressed PD for one account given the shocks. Capped at 0.95. */
export function stressPd(account: Account, shocks: ShockInputs): number {
  // GDP: a contraction (negative gdp) raises PD; expansion lowers it.
  const gdpEffect = -shocks.gdp * GDP_INCOME_ELASTICITY[account.income_band];

  // Rate: a hike (positive rate, in bps) raises PD; cut lowers it. Tenor
  // damping — longer-remaining loans absorb more pain.
  const tenorWeight = Math.min(1, account.tenure_months / 36);
  const rateEffect = shocks.rate * RATE_PRODUCT_SENSITIVITY[account.product] * tenorWeight;

  // FX: only fx_exposed obligors care. Positive fx (KES weakens) raises PD.
  const fxEffect = account.fx_exposed ? shocks.fx * FX_EXPOSED_SENSITIVITY : 0;

  const multiplier = 1 + gdpEffect + rateEffect + fxEffect;
  // Multiplier can't go below 0 — even maximally favourable shock can't make
  // PD negative. Floor at 0.1 (a 90% reduction is the most we credit).
  const safeMultiplier = Math.max(0.1, multiplier);
  return Math.min(0.95, account.baseline_pd * safeMultiplier);
}

function bandFor(pd: number): keyof BandSummary {
  if (pd < 0.05) return 'low';
  if (pd < 0.2) return 'medium';
  return 'high';
}

function emptyBands(): BandSummary {
  return { low: 0, medium: 0, high: 0 };
}

/**
 * Map a PD value to an IFRS 9 stage for prototype purposes. The cutoffs
 * intentionally match `bandFor()` so the stage-distribution view tells
 * the same story as the risk-band view, just with regulatory nomenclature.
 *
 * Production note: the real Stage 1→2 trigger should be a *relative* PD
 * deterioration vs. origination PD (or 30-DPD), not an absolute cut-off.
 * This is documented in types.ts — swap implementations when origination
 * PDs are tracked.
 */
export function stageFromPd(pd: number): IfrsStage {
  if (pd < 0.05) return 1;
  if (pd < 0.2) return 2;
  return 3;
}

function emptyStages(): StageDistribution {
  return { stage_1: 0, stage_2: 0, stage_3: 0 };
}

function emptyMigration(): StageMigration {
  return {
    s1: { s1: 0, s2: 0, s3: 0 },
    s2: { s1: 0, s2: 0, s3: 0 },
    s3: { s1: 0, s2: 0, s3: 0 },
  };
}

function stageKey(stage: IfrsStage): 's1' | 's2' | 's3' {
  return `s${stage}` as 's1' | 's2' | 's3';
}

interface ScoredAccount {
  account: Account;
  baseline_pd: number;
  stressed_pd: number;
  baseline_ecl: number;
  stressed_ecl: number;
}

function scorePortfolio(portfolio: Account[], shocks: ShockInputs): ScoredAccount[] {
  return portfolio.map((account) => {
    const baseline_pd = account.baseline_pd;
    const stressed_pd = stressPd(account, shocks);
    return {
      account,
      baseline_pd,
      stressed_pd,
      baseline_ecl: account.ead_kes * baseline_pd * account.lgd,
      stressed_ecl: account.ead_kes * stressed_pd * account.lgd,
    };
  });
}

function aggregateBands(scored: ScoredAccount[]): {
  baseline: BandSummary;
  stressed: BandSummary;
} {
  const baseline = emptyBands();
  const stressed = emptyBands();
  for (const s of scored) {
    baseline[bandFor(s.baseline_pd)]++;
    stressed[bandFor(s.stressed_pd)]++;
  }
  return { baseline, stressed };
}

/**
 * Single pass over the scored portfolio that produces both the IFRS 9
 * stage *distributions* (baseline + stressed counts per stage) and the
 * stage *migration matrix* (per-account from→to transitions).
 *
 * The migration matrix is the load-bearing piece for the SPA — it answers
 * "how many accounts moved from Stage 1 to Stage 2 under this shock?",
 * which is the regulatory question. The diagonal is "no migration".
 */
function aggregateStages(scored: ScoredAccount[]): {
  baseline: StageDistribution;
  stressed: StageDistribution;
  migration: StageMigration;
} {
  const baseline = emptyStages();
  const stressed = emptyStages();
  const migration = emptyMigration();
  for (const s of scored) {
    const fromStage = stageFromPd(s.baseline_pd);
    const toStage = stageFromPd(s.stressed_pd);
    baseline[`stage_${fromStage}`]++;
    stressed[`stage_${toStage}`]++;
    migration[stageKey(fromStage)][stageKey(toStage)]++;
  }
  return { baseline, stressed, migration };
}

/**
 * Builds a (segment × risk-band) matrix with baseline + stressed account
 * counts per cell. Sister of aggregateSegments() which produces the
 * weighted-PD summary; this one is for the SPA's 2D heatmap.
 */
function aggregateSegmentRiskMatrix(scored: ScoredAccount[]): SegmentRiskRow[] {
  const buckets = new Map<string, { baseline: BandSummary; stressed: BandSummary }>();
  for (const s of scored) {
    const key = s.account.product;
    const cell = buckets.get(key) ?? { baseline: emptyBands(), stressed: emptyBands() };
    cell.baseline[bandFor(s.baseline_pd)]++;
    cell.stressed[bandFor(s.stressed_pd)]++;
    buckets.set(key, cell);
  }
  const rows: SegmentRiskRow[] = [];
  for (const [segment, { baseline, stressed }] of buckets) {
    rows.push({ segment, baseline, stressed });
  }
  // Stable order: most stressed-high first.
  rows.sort((a, b) => b.stressed.high - a.stressed.high);
  return rows;
}

function aggregateSegments(scored: ScoredAccount[]): SegmentImpact[] {
  const buckets = new Map<string, ScoredAccount[]>();
  for (const s of scored) {
    const key = s.account.product;
    const arr = buckets.get(key) ?? [];
    arr.push(s);
    buckets.set(key, arr);
  }
  const rows: SegmentImpact[] = [];
  for (const [segment, arr] of buckets) {
    const totalEad = arr.reduce((acc, s) => acc + s.account.ead_kes, 0);
    const wAvgBase =
      arr.reduce((acc, s) => acc + s.baseline_pd * s.account.ead_kes, 0) /
      Math.max(1, totalEad);
    const wAvgStressed =
      arr.reduce((acc, s) => acc + s.stressed_pd * s.account.ead_kes, 0) /
      Math.max(1, totalEad);
    const ecl_delta = arr.reduce((acc, s) => acc + (s.stressed_ecl - s.baseline_ecl), 0);
    rows.push({
      segment,
      accounts: arr.length,
      baseline_pd: round4(wAvgBase),
      stressed_pd: round4(wAvgStressed),
      pd_delta_pp: round4((wAvgStressed - wAvgBase) * 100),
      ecl_delta_kes: Math.round(ecl_delta),
    });
  }
  // Stable sort: largest absolute ECL impact first.
  rows.sort((a, b) => Math.abs(b.ecl_delta_kes) - Math.abs(a.ecl_delta_kes));
  return rows;
}

function topAffected(scored: ScoredAccount[], k = 10): AffectedCustomer[] {
  const ranked = [...scored].sort(
    (a, b) => Math.abs(b.stressed_pd - b.baseline_pd) - Math.abs(a.stressed_pd - a.baseline_pd),
  );
  return ranked.slice(0, k).map((s) => ({
    customer_id: s.account.customer_id,
    name: s.account.name,
    product: s.account.product,
    baseline_pd: round4(s.baseline_pd),
    stressed_pd: round4(s.stressed_pd),
    pd_delta_pp: round4((s.stressed_pd - s.baseline_pd) * 100),
    ead_kes: s.account.ead_kes,
    ecl_delta_kes: Math.round(s.stressed_ecl - s.baseline_ecl),
  }));
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

/** Validate shocks against the SPA's slider ranges. Throws on out-of-bounds. */
export function validateShocks(s: unknown): ShockInputs {
  if (!s || typeof s !== 'object') {
    throw new Error('shocks payload must be an object with gdp, rate, fx');
  }
  const o = s as Record<string, unknown>;
  const gdp = numberOrThrow(o.gdp, 'gdp');
  const rate = numberOrThrow(o.rate, 'rate');
  const fx = numberOrThrow(o.fx, 'fx');
  if (gdp < -8 || gdp > 4) throw new Error('gdp must be between -8 and 4');
  if (rate < -200 || rate > 400) throw new Error('rate must be between -200 and 400');
  if (fx < -10 || fx > 20) throw new Error('fx must be between -10 and 20');
  return { gdp, rate, fx };
}

function numberOrThrow(v: unknown, name: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new Error(`${name} must be a finite number`);
  }
  return v;
}

export function runScenario(
  portfolio: Account[],
  shocks: ShockInputs,
  now: () => Date = () => new Date(),
): ScenarioResult {
  const scored = scorePortfolio(portfolio, shocks);
  const { baseline, stressed } = aggregateBands(scored);
  const stages = aggregateStages(scored);
  const total_ead = scored.reduce((acc, s) => acc + s.account.ead_kes, 0);
  const baseline_ecl = scored.reduce((acc, s) => acc + s.baseline_ecl, 0);
  const stressed_ecl = scored.reduce((acc, s) => acc + s.stressed_ecl, 0);

  // EAD-weighted portfolio PD — the headline number a CRO would quote
  // ("our portfolio PD moved from 4.2% to 6.7% under this shock").
  const safeEad = Math.max(1, total_ead);
  const baseline_portfolio_pd =
    scored.reduce((acc, s) => acc + s.baseline_pd * s.account.ead_kes, 0) / safeEad;
  const stressed_portfolio_pd =
    scored.reduce((acc, s) => acc + s.stressed_pd * s.account.ead_kes, 0) / safeEad;

  // NPA share = Stage 3 (credit-impaired) accounts / total accounts. Counts
  // not weighted by EAD — production may want EAD-weighted; flagged in
  // types.ts.
  const baseline_npa_pct = stages.baseline.stage_3 / Math.max(1, portfolio.length);
  const stressed_npa_pct = stages.stressed.stage_3 / Math.max(1, portfolio.length);

  return {
    inputs: shocks,
    portfolio_size: portfolio.length,
    total_ead_kes: Math.round(total_ead),
    baseline_ecl_kes: Math.round(baseline_ecl),
    stressed_ecl_kes: Math.round(stressed_ecl),
    ecl_delta_kes: Math.round(stressed_ecl - baseline_ecl),
    baseline_bands: baseline,
    stressed_bands: stressed,
    baseline_stages: stages.baseline,
    stressed_stages: stages.stressed,
    stage_migration: stages.migration,
    segments: aggregateSegments(scored),
    segment_risk_matrix: aggregateSegmentRiskMatrix(scored),
    baseline_portfolio_pd: round4(baseline_portfolio_pd),
    stressed_portfolio_pd: round4(stressed_portfolio_pd),
    baseline_npa_pct: round4(baseline_npa_pct),
    stressed_npa_pct: round4(stressed_npa_pct),
    top_affected: topAffected(scored),
    computed_at: now().toISOString(),
  };
}
