// services/bff/src/scenario/portfolio.ts
//
// Synthetic portfolio for the scenario engine. 240 accounts across 4 product
// types with realistic PD, EAD, LGD distributions. Deterministic — seeded by
// account index — so repeat scenario runs return identical results.
//
// In production this comes from the dbt mart customer_360 + loan_360 join,
// scored against the latest champion PD model. The seed here matches the
// distribution shape the SPA charts assume (left-skewed PDs, long tail).

export interface Account {
  customer_id: string;
  name: string;
  /** Product type drives the rate-shock elasticity. */
  product: 'mortgage' | 'auto' | 'personal' | 'sme';
  /** Loan tenure remaining in months — affects rate shock sensitivity. */
  tenure_months: number;
  /** Principal balance, in KES. */
  ead_kes: number;
  /** Loss-given-default fraction (0–1). */
  lgd: number;
  /** Baseline 12-month PD (0–1). */
  baseline_pd: number;
  /**
   * Income band — drives GDP-shock elasticity. Lower-income households see
   * a stronger PD response per unit of GDP contraction.
   */
  income_band: 'low' | 'mid' | 'high';
  /** Whether the obligor has USD-linked income/cashflow — drives FX sensitivity. */
  fx_exposed: boolean;
}

const PRODUCTS: Account['product'][] = ['mortgage', 'auto', 'personal', 'sme'];
const INCOME_BANDS: Account['income_band'][] = ['low', 'mid', 'high'];

// Mulberry32 — tiny deterministic PRNG so the same seed always produces the
// same portfolio. Avoids import-cycle on Math.random() across test runs.
function mulberry32(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FIRST_NAMES = [
  'Achieng', 'Brian', 'Cynthia', 'Daniel', 'Esther', 'Faisal', 'Grace', 'Hassan',
  'Irene', 'James', 'Karima', 'Leah', 'Mwangi', 'Njoroge', 'Otieno', 'Patel',
];
const LAST_NAMES = [
  'Otieno', 'Kamau', 'Mwangi', 'Wanjiku', 'Njeri', 'Hussein', 'Mutua', 'Owino',
];

function makeAccount(idx: number, rnd: () => number): Account {
  const product = PRODUCTS[idx % PRODUCTS.length];
  const income_band = INCOME_BANDS[Math.floor(rnd() * 3)];
  const fx_exposed = product === 'sme' && rnd() < 0.4;

  // EAD distribution by product (in KES). Mortgages large, personal small.
  const eadByProduct: Record<Account['product'], [number, number]> = {
    mortgage: [2_000_000, 12_000_000],
    auto: [500_000, 3_500_000],
    personal: [50_000, 800_000],
    sme: [800_000, 8_000_000],
  };
  const [eMin, eMax] = eadByProduct[product];
  const ead_kes = Math.round(eMin + rnd() * (eMax - eMin));

  // LGD by product (secured vs unsecured).
  const lgdByProduct: Record<Account['product'], number> = {
    mortgage: 0.25,
    auto: 0.35,
    personal: 0.65,
    sme: 0.5,
  };
  const lgd = lgdByProduct[product];

  // Baseline PD — left-skewed, mostly small with a long tail.
  // Beta-like via two uniform draws.
  const u = rnd() * rnd();
  const baseline_pd = Math.min(0.45, 0.005 + u * 0.5);

  const tenure_months =
    product === 'mortgage' ? 60 + Math.floor(rnd() * 240)
      : product === 'auto' ? 12 + Math.floor(rnd() * 60)
      : product === 'personal' ? 6 + Math.floor(rnd() * 36)
      : 12 + Math.floor(rnd() * 72);

  const first = FIRST_NAMES[Math.floor(rnd() * FIRST_NAMES.length)];
  const last = LAST_NAMES[Math.floor(rnd() * LAST_NAMES.length)];

  return {
    customer_id: `c-${(1000 + idx).toString()}`,
    name: `${first} ${last}`,
    product,
    tenure_months,
    ead_kes,
    lgd,
    baseline_pd,
    income_band,
    fx_exposed,
  };
}

export function makeSyntheticPortfolio(size = 240, seed = 42): Account[] {
  const rnd = mulberry32(seed);
  return Array.from({ length: size }, (_, i) => makeAccount(i, rnd));
}

/** Cached singleton — avoid recomputing 240 accounts on every request. */
let CACHED: Account[] | null = null;
export function defaultPortfolio(): Account[] {
  if (!CACHED) CACHED = makeSyntheticPortfolio();
  return CACHED;
}
