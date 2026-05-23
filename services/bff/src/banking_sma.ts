// services/bff/src/banking_sma.ts
//
// Special Mention Account (SMA) classification per the RBI Master
// Direction on Income Recognition + Asset Classification (2015).
//
// Categories:
//   SMA-0  : 1-30 days overdue (early warning)
//   SMA-1  : 31-60 days overdue
//   SMA-2  : 61-90 days overdue
//   NPA    : 91+ days overdue (Sub-Standard, Doubtful, Loss)
//
// Distinct from IFRS9 stage classification (which uses PD bands +
// credit-impaired flags); SMA is DPD-based + regulator-mandated for
// Indian banks. RMA (Bhutan) + CBK (Kenya) use parallel categorisations.
//
// Pure-function deterministic synthesis seeded by FNV-1a + Mulberry32
// over (tenant, customer, day) — same input → same output, matches the
// established T5.5 FinOps + bil_dashboards.ts pattern.

// Inlined per-module RNG (matches finops_dashboard.ts + adoption_metrics.ts).
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 0x100000000;
  };
}
const fnv1aSeed = fnv1a;

export type SmaCategory = 'SMA-0' | 'SMA-1' | 'SMA-2' | 'NPA';
export type Framework = 'RBI' | 'RMA' | 'CBK';

export const ALL_SMA_CATEGORIES: readonly SmaCategory[] = ['SMA-0', 'SMA-1', 'SMA-2', 'NPA'];
export const ALL_FRAMEWORKS: readonly Framework[] = ['RBI', 'RMA', 'CBK'];

export function isSmaCategory(s: unknown): s is SmaCategory {
  return typeof s === 'string' && (ALL_SMA_CATEGORIES as readonly string[]).includes(s);
}
export function isFramework(s: unknown): s is Framework {
  return typeof s === 'string' && (ALL_FRAMEWORKS as readonly string[]).includes(s);
}

/** Map DPD-day count to canonical SMA category. */
export function categoryForDpd(dpd: number): SmaCategory {
  if (dpd >= 91) return 'NPA';
  if (dpd >= 61) return 'SMA-2';
  if (dpd >= 31) return 'SMA-1';
  return 'SMA-0';
}

/** Movement = one customer's category change between two dates. */
export interface SmaMovement {
  customer_id: string;
  customer_name: string;
  from_category: SmaCategory | 'CURRENT';
  to_category: SmaCategory;
  dpd: number;
  outstanding_kes: number;
  sector: string;
  framework: Framework;
  movement_at: string;
  direction: 'deterioration' | 'improvement' | 'unchanged';
}

export interface SmaMovementsReport {
  tenant_id: string;
  generated_at: string;
  date: string;
  framework: Framework;
  total_movements: number;
  by_category_count: Record<SmaCategory, number>;
  deteriorations: number;
  improvements: number;
  unchanged: number;
  total_exposure_at_risk_kes: number;
  movements: SmaMovement[];
}

export interface SmaSectorView {
  tenant_id: string;
  generated_at: string;
  framework: Framework;
  total_sectors: number;
  total_customers: number;
  total_outstanding_kes: number;
  sectors: SmaSectorRow[];
}

export interface SmaSectorRow {
  sector: string;
  total_customers: number;
  by_category: Record<SmaCategory, number>;
  total_outstanding_kes: number;
  npa_outstanding_kes: number;
  npa_ratio_pct: number;
  worst_category: SmaCategory;
}

export interface SmaTrendPoint {
  date: string;
  dpd: number;
  category: SmaCategory;
  outstanding_kes: number;
}

export interface SmaTrend {
  tenant_id: string;
  generated_at: string;
  customer_id: string;
  framework: Framework;
  point_count: number;
  series: SmaTrendPoint[];
  current_category: SmaCategory;
  worst_category: SmaCategory;
  trend_direction: 'deteriorating' | 'improving' | 'stable';
}

export interface SmaClassificationRunResult {
  tenant_id: string;
  generated_at: string;
  framework: Framework;
  triggered_by: string;
  run_id: string;
  customers_evaluated: number;
  customers_changed: number;
  by_category_count: Record<SmaCategory, number>;
  duration_ms: number;
}

export class SmaError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'SmaError';
  }
}

// ─── Sector + customer cohort (deterministic per tenant) ──────────────

const SECTORS = [
  'Retail Loans',
  'Agriculture',
  'MSME — Manufacturing',
  'MSME — Services',
  'Corporate — Infra',
  'Corporate — Power',
  'Corporate — Real Estate',
  'Corporate — Trade',
  'Personal Banking',
  'Credit Card',
] as const;

const CUSTOMER_COUNT_DEFAULT = 200;

function tenantScale(tenant_id: string): number {
  return tenant_id === 'BIL' ? 0.6 : 1.0;
}

function customerCountFor(tenant_id: string): number {
  return Math.floor(CUSTOMER_COUNT_DEFAULT * tenantScale(tenant_id));
}

function customerSeed(tenant_id: string, idx: number): string {
  // 6-digit numeric id for deterministic cohort
  return `c-${String(100000 + idx).slice(-6)}`;
}

function customerNameForIdx(idx: number, rng: () => number): string {
  const first = ['Alice', 'Rajesh', 'Priya', 'Mohan', 'Sunita', 'Vikram', 'Kavya', 'Arjun', 'Meera', 'Ravi'];
  const last = ['Patel', 'Kumar', 'Sharma', 'Singh', 'Reddy', 'Nair', 'Iyer', 'Chowdhury', 'Mehta', 'Joshi'];
  const fi = Math.floor(rng() * first.length);
  const li = Math.floor(rng() * last.length);
  return `${first[fi]} ${last[li]}`;
}

function sectorForIdx(idx: number, rng: () => number): string {
  return SECTORS[Math.floor(rng() * SECTORS.length)];
}

function dpdForCustomer(tenant_id: string, customer_id: string, asOf: Date): number {
  // 70% on-time (DPD 0), 12% SMA-0, 8% SMA-1, 6% SMA-2, 4% NPA
  const day = asOf.toISOString().slice(0, 10);
  const rng = mulberry32(fnv1aSeed(`${tenant_id}|${customer_id}|${day}|dpd`));
  const r = rng();
  if (r < 0.70) return 0;
  if (r < 0.82) return 1 + Math.floor(rng() * 30); // SMA-0 1-30
  if (r < 0.90) return 31 + Math.floor(rng() * 30); // SMA-1 31-60
  if (r < 0.96) return 61 + Math.floor(rng() * 30); // SMA-2 61-90
  return 91 + Math.floor(rng() * 180); // NPA 91-270
}

function outstandingForCustomer(tenant_id: string, customer_id: string, rng: () => number): number {
  // Distribution: most customers <2M, some up to 50M
  const r = rng();
  let v: number;
  if (r < 0.4) v = 100_000 + rng() * 1_900_000; // 100k - 2M
  else if (r < 0.85) v = 2_000_000 + rng() * 8_000_000; // 2M - 10M
  else v = 10_000_000 + rng() * 40_000_000; // 10M - 50M
  return Math.round(v / 1000) * 1000;
}

// ─── Public resolvers ──────────────────────────────────────────────────

/**
 * Movements between yesterday and `date`. Deterministic per (tenant, date,
 * framework).
 */
export function buildSmaMovements(
  tenant_id: string,
  date: Date,
  framework: Framework,
  now: Date,
): SmaMovementsReport {
  if (!tenant_id) throw new SmaError('invalid_input', 'tenant_id is required');

  const n = customerCountFor(tenant_id);
  const yesterday = new Date(date.getTime() - 86_400_000);
  const movements: SmaMovement[] = [];
  const byCategory: Record<SmaCategory, number> = { 'SMA-0': 0, 'SMA-1': 0, 'SMA-2': 0, NPA: 0 };
  let totalExposure = 0;
  let det = 0,
    imp = 0,
    unch = 0;

  for (let i = 0; i < n; i++) {
    const cid = customerSeed(tenant_id, i);
    const dpdYesterday = dpdForCustomer(tenant_id, cid, yesterday);
    const dpdToday = dpdForCustomer(tenant_id, cid, date);
    if (dpdToday === 0 && dpdYesterday === 0) continue; // never overdue → not a movement

    const catYesterday = dpdYesterday === 0 ? 'CURRENT' : categoryForDpd(dpdYesterday);
    const catToday = categoryForDpd(dpdToday);
    if (dpdToday === 0) continue; // moved back to CURRENT — count via improvement check
    if (catYesterday === catToday && dpdToday === dpdYesterday) continue; // no real change

    const rng = mulberry32(fnv1aSeed(`${tenant_id}|${cid}|sector`));
    const name = customerNameForIdx(i, mulberry32(fnv1aSeed(`${tenant_id}|${cid}|name`)));
    const sector = sectorForIdx(i, rng);
    const outstanding = outstandingForCustomer(
      tenant_id,
      cid,
      mulberry32(fnv1aSeed(`${tenant_id}|${cid}|exposure`)),
    );

    const direction =
      catYesterday === 'CURRENT'
        ? 'deterioration'
        : dpdToday > dpdYesterday
          ? 'deterioration'
          : dpdToday < dpdYesterday
            ? 'improvement'
            : 'unchanged';

    movements.push({
      customer_id: cid,
      customer_name: name,
      from_category: catYesterday,
      to_category: catToday,
      dpd: dpdToday,
      outstanding_kes: outstanding,
      sector,
      framework,
      movement_at: date.toISOString(),
      direction,
    });
    byCategory[catToday]++;
    totalExposure += outstanding;
    if (direction === 'deterioration') det++;
    else if (direction === 'improvement') imp++;
    else unch++;
  }

  // Sort worst-first: NPA → SMA-2 → SMA-1 → SMA-0, then exposure desc
  const catRank: Record<SmaCategory, number> = { NPA: 0, 'SMA-2': 1, 'SMA-1': 2, 'SMA-0': 3 };
  movements.sort(
    (a, b) =>
      catRank[a.to_category] - catRank[b.to_category] || b.outstanding_kes - a.outstanding_kes,
  );

  return {
    tenant_id,
    generated_at: now.toISOString(),
    date: date.toISOString().slice(0, 10),
    framework,
    total_movements: movements.length,
    by_category_count: byCategory,
    deteriorations: det,
    improvements: imp,
    unchanged: unch,
    total_exposure_at_risk_kes: totalExposure,
    movements,
  };
}

export function buildSmaSectorView(
  tenant_id: string,
  framework: Framework,
  now: Date,
): SmaSectorView {
  if (!tenant_id) throw new SmaError('invalid_input', 'tenant_id is required');
  const n = customerCountFor(tenant_id);
  const bySector = new Map<string, SmaSectorRow>();
  let totalCustomers = 0;
  let totalOutstanding = 0;

  for (let i = 0; i < n; i++) {
    const cid = customerSeed(tenant_id, i);
    const dpd = dpdForCustomer(tenant_id, cid, now);
    if (dpd === 0) continue; // only at-risk customers in the sector view
    const sector = sectorForIdx(i, mulberry32(fnv1aSeed(`${tenant_id}|${cid}|sector`)));
    const outstanding = outstandingForCustomer(
      tenant_id,
      cid,
      mulberry32(fnv1aSeed(`${tenant_id}|${cid}|exposure`)),
    );
    const cat = categoryForDpd(dpd);

    if (!bySector.has(sector)) {
      bySector.set(sector, {
        sector,
        total_customers: 0,
        by_category: { 'SMA-0': 0, 'SMA-1': 0, 'SMA-2': 0, NPA: 0 },
        total_outstanding_kes: 0,
        npa_outstanding_kes: 0,
        npa_ratio_pct: 0,
        worst_category: 'SMA-0',
      });
    }
    const row = bySector.get(sector)!;
    row.total_customers++;
    row.by_category[cat]++;
    row.total_outstanding_kes += outstanding;
    if (cat === 'NPA') row.npa_outstanding_kes += outstanding;
    const catRank: Record<SmaCategory, number> = { NPA: 0, 'SMA-2': 1, 'SMA-1': 2, 'SMA-0': 3 };
    if (catRank[cat] < catRank[row.worst_category]) row.worst_category = cat;
    totalCustomers++;
    totalOutstanding += outstanding;
  }

  // Compute npa_ratio_pct + sort sectors by worst+exposure desc
  for (const row of bySector.values()) {
    row.npa_ratio_pct =
      row.total_outstanding_kes > 0
        ? Math.round((row.npa_outstanding_kes / row.total_outstanding_kes) * 10000) / 100
        : 0;
  }
  const sectors = [...bySector.values()].sort((a, b) => {
    const catRank: Record<SmaCategory, number> = { NPA: 0, 'SMA-2': 1, 'SMA-1': 2, 'SMA-0': 3 };
    const c = catRank[a.worst_category] - catRank[b.worst_category];
    if (c !== 0) return c;
    return b.total_outstanding_kes - a.total_outstanding_kes;
  });

  return {
    tenant_id,
    generated_at: now.toISOString(),
    framework,
    total_sectors: sectors.length,
    total_customers: totalCustomers,
    total_outstanding_kes: totalOutstanding,
    sectors,
  };
}

export function buildSmaTrend(
  tenant_id: string,
  customer_id: string,
  framework: Framework,
  fromDate: Date,
  untilDate: Date,
  now: Date,
): SmaTrend {
  if (!tenant_id) throw new SmaError('invalid_input', 'tenant_id is required');
  if (!customer_id) throw new SmaError('invalid_input', 'customer_id is required');
  if (fromDate > untilDate) throw new SmaError('invalid_input', 'from must be <= until');

  const series: SmaTrendPoint[] = [];
  const dayMs = 86_400_000;
  let cur = new Date(fromDate.getTime());
  while (cur.getTime() <= untilDate.getTime()) {
    const dpd = dpdForCustomer(tenant_id, customer_id, cur);
    const cat = dpd === 0 ? 'SMA-0' : categoryForDpd(dpd); // CURRENT still classified as SMA-0 base
    const outstanding = outstandingForCustomer(
      tenant_id,
      customer_id,
      mulberry32(fnv1aSeed(`${tenant_id}|${customer_id}|exposure`)),
    );
    series.push({
      date: cur.toISOString().slice(0, 10),
      dpd,
      category: cat,
      outstanding_kes: outstanding,
    });
    cur = new Date(cur.getTime() + dayMs);
  }

  const catRank: Record<SmaCategory, number> = { NPA: 0, 'SMA-2': 1, 'SMA-1': 2, 'SMA-0': 3 };
  const current = series[series.length - 1].category;
  let worst: SmaCategory = 'SMA-0';
  for (const p of series) if (catRank[p.category] < catRank[worst]) worst = p.category;

  // Direction: compare first vs last DPD
  const firstDpd = series[0]?.dpd ?? 0;
  const lastDpd = series[series.length - 1]?.dpd ?? 0;
  const dir = lastDpd > firstDpd + 5 ? 'deteriorating' : lastDpd < firstDpd - 5 ? 'improving' : 'stable';

  return {
    tenant_id,
    generated_at: now.toISOString(),
    customer_id,
    framework,
    point_count: series.length,
    series,
    current_category: current,
    worst_category: worst,
    trend_direction: dir,
  };
}

let _runSeq = 0;
export function runSmaClassification(
  tenant_id: string,
  framework: Framework,
  triggered_by: string,
  now: Date,
): SmaClassificationRunResult {
  if (!tenant_id) throw new SmaError('invalid_input', 'tenant_id is required');
  if (!triggered_by) throw new SmaError('invalid_input', 'triggered_by is required');

  const start = Date.now();
  const n = customerCountFor(tenant_id);
  const yesterday = new Date(now.getTime() - 86_400_000);
  const byCategory: Record<SmaCategory, number> = { 'SMA-0': 0, 'SMA-1': 0, 'SMA-2': 0, NPA: 0 };
  let changed = 0;
  for (let i = 0; i < n; i++) {
    const cid = customerSeed(tenant_id, i);
    const dpdNow = dpdForCustomer(tenant_id, cid, now);
    const dpdYesterday = dpdForCustomer(tenant_id, cid, yesterday);
    if (dpdNow !== dpdYesterday) changed++;
    if (dpdNow > 0) byCategory[categoryForDpd(dpdNow)]++;
  }
  _runSeq++;
  const runId = `sma-${tenant_id}-${now.toISOString().slice(0, 10)}-${String(_runSeq).padStart(4, '0')}`;
  return {
    tenant_id,
    generated_at: now.toISOString(),
    framework,
    triggered_by,
    run_id: runId,
    customers_evaluated: n,
    customers_changed: changed,
    by_category_count: byCategory,
    duration_ms: Date.now() - start,
  };
}

/**
 * SMA drill — movements within an explicit date window with movement
 * reason classifier.
 */
export interface SmaDrillRow extends SmaMovement {
  reason: string;
}

export function buildSmaDrill(
  tenant_id: string,
  fromDate: Date,
  untilDate: Date,
  framework: Framework,
  now: Date,
): { tenant_id: string; generated_at: string; from: string; until: string; framework: Framework; total: number; rows: SmaDrillRow[] } {
  if (!tenant_id) throw new SmaError('invalid_input', 'tenant_id is required');
  if (fromDate > untilDate) throw new SmaError('invalid_input', 'from must be <= until');

  const rows: SmaDrillRow[] = [];
  const dayMs = 86_400_000;
  let cur = new Date(fromDate.getTime());
  while (cur.getTime() <= untilDate.getTime()) {
    const day = buildSmaMovements(tenant_id, cur, framework, now);
    for (const m of day.movements) {
      const reason =
        m.direction === 'deterioration'
          ? m.from_category === 'CURRENT'
            ? 'New overdue'
            : 'DPD increased past bucket'
          : m.direction === 'improvement'
            ? 'Repayment partial — DPD reduced'
            : 'Stable in bucket';
      rows.push({ ...m, reason });
    }
    cur = new Date(cur.getTime() + dayMs);
  }
  return {
    tenant_id,
    generated_at: now.toISOString(),
    from: fromDate.toISOString().slice(0, 10),
    until: untilDate.toISOString().slice(0, 10),
    framework,
    total: rows.length,
    rows,
  };
}
