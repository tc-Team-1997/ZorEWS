// Generate 12 months of synthetic indicator history for ≥ 200 customers.
//
// Output: rules/sim/indicator_history.csv
//   columns: customer_id, month, defaulted_within_60d, <indicator_id_1>, ...
//
// Determinism: seeded by APEX_SIM_SEED env var or 20260426 by default.
// Defaulters are 18% of the cohort. Their indicators drift toward stress in
// the 2-3 months immediately preceding the simulated default month. The point
// is *not* to replicate real banking but to give every seed rule a labelled
// signal it can hit.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { Rng } from './rng';
import { loadCatalog } from './dsl';

const SEED = Number(process.env.APEX_SIM_SEED ?? '20260426');
const N_CUSTOMERS = Number(process.env.APEX_SIM_CUSTOMERS ?? '250');
const N_MONTHS = 12;
const DEFAULT_RATE = 0.18;
const OUT_PATH = path.resolve(__dirname, '..', '..', '..', '..', 'rules', 'sim', 'indicator_history.csv');

interface CustomerProfile {
  id: string;
  defaults: boolean;
  defaultMonth: number; // 0-indexed month at which default registers (only if defaults)
}

function makeProfiles(rng: Rng, n: number): CustomerProfile[] {
  const out: CustomerProfile[] = [];
  for (let i = 0; i < n; i++) {
    const defaults = rng.bernoulli(DEFAULT_RATE);
    // default month ∈ [3, N_MONTHS-1] so we always have ≥3 months of pre-default signal
    const defaultMonth = defaults ? 3 + Math.floor(rng.uniform(0, N_MONTHS - 3)) : -1;
    out.push({ id: `CUST-${String(i + 1).padStart(5, '0')}`, defaults, defaultMonth });
  }
  return out;
}

interface Sample {
  customer_id: string;
  month: number;
  defaulted_within_60d: 0 | 1;
  values: Record<string, number>;
}

/**
 * Sample one indicator value for a (customer, month). `stress` ∈ [0,1] —
 * how close we are to the default event (0 = healthy, 1 = at default).
 */
function sampleIndicator(rng: Rng, indicatorId: string, stress: number): number {
  // each indicator has a distinct healthy/stressed distribution. Distributions
  // are tuned so the seed-rule thresholds yield plausible firing patterns.
  const s = stress; // alias
  switch (indicatorId) {
    // ---- Financial ----
    case 'FIN-001': // balance_drop_30d_pct (0..1)
      return clamp(rng.normal(0.05 + 0.55 * s, 0.12), -0.2, 0.95);
    case 'FIN-002': // min_balance_breach_count_30d (0..30)
      return clamp(Math.round(rng.normal(2 + 18 * s, 3)), 0, 30);
    case 'FIN-003': // savings_to_loan_ratio (0..2+)
      return clamp(rng.normal(0.6 - 0.5 * s, 0.25), 0.01, 3);
    case 'FIN-004': // income_volatility_90d_cv (0..1+)
      return clamp(rng.normal(0.18 + 0.45 * s, 0.1), 0, 1.5);
    case 'FIN-005': // net_cashflow_30d / EMI
      return rng.normal(1.3 - 1.4 * s, 0.3);
    case 'FIN-006': // salary_inflow_skipped_months
      return clamp(Math.round(rng.normal(0 + 2.2 * s, 0.6)), 0, 6);
    case 'FIN-007': // loan_to_income_ratio
      return clamp(rng.normal(2 + 5 * s, 1.2), 0.2, 12);
    case 'FIN-008': // overdraft_utilisation_pct
      return clamp(rng.normal(0.25 + 0.55 * s, 0.15), 0, 1.1);

    // ---- Behavioural ----
    case 'BEH-001': // repayment_delay_days_avg_90d
      return clamp(rng.normal(1 + 22 * s, 3), 0, 90);
    case 'BEH-002': // repayment_delay_streak
      return clamp(Math.round(rng.normal(0 + 4 * s, 1)), 0, 12);
    case 'BEH-003': // partial_repayment_ratio_90d
      return clamp(rng.normal(0.05 + 0.55 * s, 0.12), 0, 1);
    case 'BEH-004': // channel_login_drop_30d
      return clamp(rng.normal(0 + 0.55 * s, 0.18), -0.5, 1);
    case 'BEH-005': // support_complaint_count_60d
      return clamp(Math.round(rng.normal(0 + 2.5 * s, 1)), 0, 10);
    case 'BEH-006': // kyc_doc_expiry_days (negative = stressed)
      return Math.round(rng.normal(180 - 220 * s, 60));
    case 'BEH-007': // restructure_request_flag
      return rng.bernoulli(0.005 + 0.5 * s) ? 1 : 0;
    case 'BEH-008': // unreachable_contact_count_30d
      return clamp(Math.round(rng.normal(0 + 5 * s, 1.4)), 0, 15);

    // ---- Transaction ----
    case 'TXN-001': // outflow_to_inflow_ratio_30d
      return clamp(rng.normal(0.85 + 0.55 * s, 0.15), 0.1, 3);
    case 'TXN-002': // large_outflow_anomaly (z-score)
      return rng.normal(0 + 2.2 * s, 0.7);
    case 'TXN-003': // cash_withdrawal_share_30d
      return clamp(rng.normal(0.18 + 0.4 * s, 0.12), 0, 1);
    case 'TXN-004': // merchant_diversity_drop_60d
      return clamp(rng.normal(0 + 0.45 * s, 0.18), -0.4, 1);
    case 'TXN-005': // bounced_payment_count_60d
      return clamp(Math.round(rng.normal(0 + 3 * s, 1)), 0, 12);
    case 'TXN-006': // inflow_concentration_hhi
      return clamp(rng.normal(0.35 + 0.4 * s, 0.12), 0.1, 1);
    case 'TXN-007': // p2p_outflow_spike_30d
      return clamp(rng.normal(1 + 2.5 * s, 0.6), 0.2, 8);
    case 'TXN-008': // weekend_txn_share_change_60d
      return rng.normal(0 + 0.18 * s, 0.1);

    // ---- Credit ----
    case 'CRD-001': // bureau_score_drop_60d (points)
      return clamp(Math.round(rng.normal(0 + 80 * s, 20)), -50, 250);
    case 'CRD-002': // new_credit_inquiries_90d
      return clamp(Math.round(rng.normal(0 + 4 * s, 1.2)), 0, 12);
    case 'CRD-003': // external_dpd_max_90d
      return clamp(Math.round(rng.normal(0 + 65 * s, 12)), 0, 180);
    case 'CRD-004': // total_external_exposure_growth_90d
      return rng.normal(0.05 + 0.6 * s, 0.18);
    case 'CRD-005': // ifrs9_stage_movement (rare in healthy, common late-stage)
      if (!rng.bernoulli(0.005 + 0.75 * s)) return 0;
      return rng.bernoulli(0.4 * s) ? 2 : 1;
    case 'CRD-006': // internal_dpd_current
      return clamp(Math.round(rng.normal(0 + 55 * s, 10)), 0, 180);
    case 'CRD-007': // collateral_coverage_ratio (lower = stressed)
      return clamp(rng.normal(1.4 - 0.9 * s, 0.25), 0.1, 3);
    case 'CRD-008': // guarantor_default_flag
      return rng.bernoulli(0.005 + 0.3 * s) ? 1 : 0;

    default:
      // unknown indicator id — return a neutral value so missing impl is obvious.
      return 0;
  }
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

function buildSamples(): { rows: Sample[]; indicatorIds: string[] } {
  const rng = new Rng(SEED);
  const profiles = makeProfiles(rng, N_CUSTOMERS);
  const cat = loadCatalog();
  const indicatorIds = cat.indicators.map((i) => i.id);

  const rows: Sample[] = [];
  for (const p of profiles) {
    for (let m = 0; m < N_MONTHS; m++) {
      // monthsToDefault: 0 at default month; positive = default is in the future.
      // We model the customer's *active* portfolio life: post-default the loan
      // moves to NPA / collections workflow, so we drop those rows from
      // simulation entirely (skip them). This avoids the false-positive trap
      // where a defaulted customer continues to look stressed but is no longer
      // labelled as defaulting-within-60d.
      const monthsToDefault = p.defaults ? p.defaultMonth - m : 99;
      if (p.defaults && monthsToDefault < 0) {
        continue; // skip post-default months
      }
      // Stress ramps from 0 → 1 over the 60 days preceding default
      // (monthsToDefault ∈ {0,1,2} → s ∈ {1, 0.66, 0.33}). Earlier months look
      // statistically healthy so the labelling window (`defaulted_within_60d`,
      // i.e. monthsToDefault ≤ 2) cleanly separates TPs from FPs.
      let stress = 0;
      if (p.defaults && monthsToDefault >= 0 && monthsToDefault <= 2) {
        stress = 1 - monthsToDefault / 3;
      }
      // small noise everywhere
      stress += rng.uniform(-0.05, 0.05);
      stress = clamp(stress, 0, 1);

      const values: Record<string, number> = {};
      for (const id of indicatorIds) {
        values[id] = round4(sampleIndicator(rng, id, stress));
      }

      // Label: did default occur within the next 60 days (~2 months) of this snapshot?
      const within60 = p.defaults && monthsToDefault >= 0 && monthsToDefault <= 2 ? 1 : 0;

      rows.push({
        customer_id: p.id,
        month: m,
        defaulted_within_60d: within60,
        values,
      });
    }
  }
  return { rows, indicatorIds };
}

function round4(x: number): number {
  return Math.round(x * 10000) / 10000;
}

export function writeCsv(): { path: string; rows: number } {
  const { rows, indicatorIds } = buildSamples();
  const header = ['customer_id', 'month', 'defaulted_within_60d', ...indicatorIds];
  const lines = [header.join(',')];
  for (const r of rows) {
    const cells = [
      r.customer_id,
      String(r.month),
      String(r.defaulted_within_60d),
      ...indicatorIds.map((id) => String(r.values[id])),
    ];
    lines.push(cells.join(','));
  }
  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, lines.join('\n') + '\n');
  return { path: OUT_PATH, rows: rows.length };
}

if (require.main === module) {
  const out = writeCsv();
  // eslint-disable-next-line no-console
  console.log(`wrote ${out.rows} rows to ${out.path}`);
}
