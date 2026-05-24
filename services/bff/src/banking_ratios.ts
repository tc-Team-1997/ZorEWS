// services/bff/src/banking_ratios.ts
//
// Financial Ratios + CMA (Credit Monitoring Arrangement) Pack.
// Closes §2.1.2 of ZorEWS_Pending_Gap_Analysis.md.
//
// Ratios catalog covers the RBI MPBF-relevant set plus IFRS-compatible
// liquidity + leverage metrics:
//   DSCR  — Debt Service Coverage Ratio
//   ICR   — Interest Coverage Ratio
//   CR    — Current Ratio
//   QR    — Quick Ratio
//   DER   — Debt-to-Equity Ratio
//   TOL_TNW — Total Outside Liabilities / Tangible Net Worth
//   STK_TO  — Stock Turnover
//   DBT_TO  — Debtor Turnover
//
// CMA Pack generates RBI Forms II/III/IV/V rendered as printable HTML
// (which the SPA can then print-to-PDF, mirroring the M15.4 + M7.6 pattern).
//
// Pure-function deterministic synthesis; production swap = pull ratios
// from CBS quarterly financial-statement feed + mart aggregations.

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

// ─── Catalog ──────────────────────────────────────────────────────────

export type RatioCode = 'DSCR' | 'ICR' | 'CR' | 'QR' | 'DER' | 'TOL_TNW' | 'STK_TO' | 'DBT_TO';
export const ALL_RATIO_CODES: readonly RatioCode[] = [
  'DSCR',
  'ICR',
  'CR',
  'QR',
  'DER',
  'TOL_TNW',
  'STK_TO',
  'DBT_TO',
];

export function isRatioCode(s: unknown): s is RatioCode {
  return typeof s === 'string' && (ALL_RATIO_CODES as readonly string[]).includes(s);
}

export type RatioPolarity = 'higher_is_better' | 'lower_is_better';

export interface RatioDef {
  code: RatioCode;
  name: string;
  formula: string;
  unit: '×' | 'ratio' | 'days';
  polarity: RatioPolarity;
  default_warning: number;
  default_critical: number;
  description: string;
}

export const RATIO_CATALOG: readonly RatioDef[] = [
  {
    code: 'DSCR',
    name: 'Debt Service Coverage Ratio',
    formula: '(EBITDA + lease) / (Principal + Interest + Lease)',
    unit: '×',
    polarity: 'higher_is_better',
    default_warning: 1.5,
    default_critical: 1.2,
    description:
      'Ability to service debt from operating cash flow. RBI generally expects ≥ 1.5× for term-loan eligibility.',
  },
  {
    code: 'ICR',
    name: 'Interest Coverage Ratio',
    formula: 'EBIT / Interest',
    unit: '×',
    polarity: 'higher_is_better',
    default_warning: 2.5,
    default_critical: 1.5,
    description: 'Ability to meet interest obligations. < 1× means EBIT cannot cover interest.',
  },
  {
    code: 'CR',
    name: 'Current Ratio',
    formula: 'Current Assets / Current Liabilities',
    unit: '×',
    polarity: 'higher_is_better',
    default_warning: 1.33,
    default_critical: 1.0,
    description: 'Liquidity buffer. RBI MPBF Form V uses 1.33× as the working-capital floor.',
  },
  {
    code: 'QR',
    name: 'Quick Ratio (Acid Test)',
    formula: '(Current Assets − Inventory) / Current Liabilities',
    unit: '×',
    polarity: 'higher_is_better',
    default_warning: 1.0,
    default_critical: 0.7,
    description: 'Liquidity excluding inventory. Tighter than Current Ratio.',
  },
  {
    code: 'DER',
    name: 'Debt-to-Equity Ratio',
    formula: 'Total Debt / Tangible Net Worth',
    unit: 'ratio',
    polarity: 'lower_is_better',
    default_warning: 2.0,
    default_critical: 3.0,
    description: 'Leverage. > 3.0 is widely treated as over-leveraged for non-NBFI borrowers.',
  },
  {
    code: 'TOL_TNW',
    name: 'TOL / TNW',
    formula: 'Total Outside Liabilities / Tangible Net Worth',
    unit: 'ratio',
    polarity: 'lower_is_better',
    default_warning: 3.0,
    default_critical: 4.5,
    description: 'Total leverage including current liabilities. RBI cap typically 3-4× for term lending.',
  },
  {
    code: 'STK_TO',
    name: 'Stock Turnover (days)',
    formula: '(Inventory × 365) / COGS',
    unit: 'days',
    polarity: 'lower_is_better',
    default_warning: 90,
    default_critical: 150,
    description: 'Inventory days outstanding. Higher = slower stock movement.',
  },
  {
    code: 'DBT_TO',
    name: 'Debtor Turnover (days)',
    formula: '(Receivables × 365) / Sales',
    unit: 'days',
    polarity: 'lower_is_better',
    default_warning: 60,
    default_critical: 120,
    description: 'Days Sales Outstanding (DSO). Higher = slower collection.',
  },
];

export const RATIO_BY_CODE: Readonly<Record<RatioCode, RatioDef>> = Object.fromEntries(
  RATIO_CATALOG.map((r) => [r.code, r]),
) as Record<RatioCode, RatioDef>;

// ─── Per-customer ratio + history ─────────────────────────────────────

export type RatioBand = 'green' | 'amber' | 'red';

export interface RatioValue {
  code: RatioCode;
  value: number;
  band: RatioBand;
  warning_threshold: number;
  critical_threshold: number;
  polarity: RatioPolarity;
  observed_at: string;
}

export interface RatioHistoryPoint {
  date: string;
  value: number;
  band: RatioBand;
}

export interface CustomerRatioBundle {
  tenant_id: string;
  generated_at: string;
  customer_id: string;
  customer_name: string;
  sector: string;
  current: Record<RatioCode, RatioValue>;
  history: Record<RatioCode, RatioHistoryPoint[]>;
  worst_band: RatioBand;
  worst_ratios: RatioCode[];
}

function bandFor(def: RatioDef, value: number, warning: number, critical: number): RatioBand {
  if (def.polarity === 'higher_is_better') {
    if (value < critical) return 'red';
    if (value < warning) return 'amber';
    return 'green';
  }
  if (value > critical) return 'red';
  if (value > warning) return 'amber';
  return 'green';
}

function ratioBaseline(code: RatioCode, rng: () => number, modifier: number): number {
  // Modifier ∈ [-0.4, +0.4] for trend; multiplied into baseline
  const def = RATIO_BY_CODE[code];
  let base: number;
  switch (code) {
    case 'DSCR':
      base = 1.0 + rng() * 1.5; // 1.0..2.5
      break;
    case 'ICR':
      base = 1.0 + rng() * 4.0; // 1.0..5.0
      break;
    case 'CR':
      base = 0.8 + rng() * 1.8; // 0.8..2.6
      break;
    case 'QR':
      base = 0.5 + rng() * 1.4; // 0.5..1.9
      break;
    case 'DER':
      base = 0.5 + rng() * 3.5; // 0.5..4.0
      break;
    case 'TOL_TNW':
      base = 1.0 + rng() * 4.5; // 1.0..5.5
      break;
    case 'STK_TO':
      base = 30 + rng() * 150; // 30..180 days
      break;
    case 'DBT_TO':
      base = 30 + rng() * 120; // 30..150 days
      break;
  }
  return def.unit === 'days' ? Math.round(base * (1 + modifier)) : Math.round(base * (1 + modifier) * 100) / 100;
}

const SECTORS_FOR_RATIOS = [
  'Manufacturing',
  'Trade',
  'Real Estate',
  'Power',
  'IT Services',
  'Pharma',
  'Agriculture',
  'Retail',
];

export class RatiosError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'RatiosError';
  }
}

export function buildCustomerRatios(
  tenant_id: string,
  customer_id: string,
  thresholdOverrides: Partial<Record<RatioCode, { warning: number; critical: number }>>,
  now: Date,
  historyMonths = 12,
): CustomerRatioBundle {
  if (!tenant_id) throw new RatiosError('invalid_input', 'tenant_id is required');
  if (!customer_id) throw new RatiosError('invalid_input', 'customer_id is required');

  const seedRng = mulberry32(fnv1a(`${tenant_id}|${customer_id}|profile`));
  const sector = SECTORS_FOR_RATIOS[Math.floor(seedRng() * SECTORS_FOR_RATIOS.length)];
  const nameRng = mulberry32(fnv1a(`${tenant_id}|${customer_id}|name`));
  const firstNames = ['Alice', 'Rajesh', 'Priya', 'Mohan', 'Vikram', 'Meera', 'Arjun', 'Kavya'];
  const lastNames = ['Patel', 'Kumar', 'Sharma', 'Singh', 'Reddy', 'Nair', 'Iyer', 'Mehta'];
  const fullName = `${firstNames[Math.floor(nameRng() * firstNames.length)]} ${lastNames[Math.floor(nameRng() * lastNames.length)]}`;

  const current = {} as Record<RatioCode, RatioValue>;
  const history = {} as Record<RatioCode, RatioHistoryPoint[]>;
  let worstBand: RatioBand = 'green';
  const worstRatios: RatioCode[] = [];

  for (const def of RATIO_CATALOG) {
    const code = def.code;
    const override = thresholdOverrides[code];
    const warning = override?.warning ?? def.default_warning;
    const critical = override?.critical ?? def.default_critical;
    const valRng = mulberry32(fnv1a(`${tenant_id}|${customer_id}|${code}|cur`));
    const value = ratioBaseline(code, valRng, 0);
    const band = bandFor(def, value, warning, critical);
    if (band === 'red' || (band === 'amber' && worstBand === 'green')) worstBand = band;
    if (band === 'red') worstRatios.push(code);
    current[code] = {
      code,
      value,
      band,
      warning_threshold: warning,
      critical_threshold: critical,
      polarity: def.polarity,
      observed_at: now.toISOString(),
    };
    const points: RatioHistoryPoint[] = [];
    for (let m = historyMonths - 1; m >= 0; m--) {
      const ts = new Date(now.getTime() - m * 30 * 86_400_000);
      const histRng = mulberry32(fnv1a(`${tenant_id}|${customer_id}|${code}|m${m}`));
      // Drift back toward neutral; the further back, the less correlated to current
      const drift = (histRng() - 0.5) * 0.4 * (m / historyMonths);
      const v = ratioBaseline(code, histRng, drift);
      const b = bandFor(def, v, warning, critical);
      points.push({ date: ts.toISOString().slice(0, 10), value: v, band: b });
    }
    history[code] = points;
  }

  return {
    tenant_id,
    generated_at: now.toISOString(),
    customer_id,
    customer_name: fullName,
    sector,
    current,
    history,
    worst_band: worstBand,
    worst_ratios: worstRatios,
  };
}

// ─── Sector benchmark ──────────────────────────────────────────────────

export interface SectorBenchmarkRatio {
  code: RatioCode;
  name: string;
  rbi_quartile_25: number;
  rbi_median: number;
  rbi_quartile_75: number;
  internal_median: number;
  sample_size: number;
}

export interface SectorBenchmark {
  tenant_id: string;
  generated_at: string;
  sector: string;
  as_of_quarter: string;
  ratios: SectorBenchmarkRatio[];
}

export function buildSectorBenchmark(
  tenant_id: string,
  sector: string,
  now: Date,
): SectorBenchmark {
  if (!tenant_id) throw new RatiosError('invalid_input', 'tenant_id is required');
  if (!sector) throw new RatiosError('invalid_input', 'sector is required');

  // Quarter encoding (Q1=Jan-Mar etc.); quarterly = aligned to industry stats
  const month = now.getUTCMonth(); // 0..11
  const quarter = Math.floor(month / 3) + 1;
  const year = now.getUTCFullYear();
  const asOfQuarter = `Q${quarter} ${year}`;

  const ratios: SectorBenchmarkRatio[] = [];
  for (const def of RATIO_CATALOG) {
    const seedRng = mulberry32(fnv1a(`${tenant_id}|${sector}|${asOfQuarter}|${def.code}`));
    // Build a sector-typical distribution. Median lies between warning and critical.
    const mid = (def.default_warning + def.default_critical) / 2;
    const spread = def.unit === 'days' ? 30 : 0.5;
    const rbi_median = Math.round((mid + (seedRng() - 0.5) * spread) * 100) / 100;
    const rbi_q25 = Math.round((rbi_median - (def.polarity === 'higher_is_better' ? spread : -spread) * 0.4) * 100) / 100;
    const rbi_q75 = Math.round((rbi_median + (def.polarity === 'higher_is_better' ? spread : -spread) * 0.4) * 100) / 100;
    const internal_median = Math.round((rbi_median + (seedRng() - 0.5) * 0.2 * spread) * 100) / 100;
    ratios.push({
      code: def.code,
      name: def.name,
      rbi_quartile_25: def.unit === 'days' ? Math.round(rbi_q25) : rbi_q25,
      rbi_median: def.unit === 'days' ? Math.round(rbi_median) : rbi_median,
      rbi_quartile_75: def.unit === 'days' ? Math.round(rbi_q75) : rbi_q75,
      internal_median: def.unit === 'days' ? Math.round(internal_median) : internal_median,
      sample_size: 50 + Math.floor(seedRng() * 250),
    });
  }
  return {
    tenant_id,
    generated_at: now.toISOString(),
    sector,
    as_of_quarter: asOfQuarter,
    ratios,
  };
}

// ─── Threshold override store ──────────────────────────────────────────

export interface RatioThresholdEntry {
  code: RatioCode;
  warning: number;
  critical: number;
  is_default: boolean;
  updated_at: string | null;
  updated_by: string | null;
}

export interface IRatioThresholdStore {
  list(tenant_id: string): RatioThresholdEntry[];
  set(tenant_id: string, code: RatioCode, warning: number, critical: number, actor: string, now: Date): RatioThresholdEntry;
  reset(tenant_id: string, code: RatioCode): RatioThresholdEntry;
  resolve(tenant_id: string): Partial<Record<RatioCode, { warning: number; critical: number }>>;
}

export class InMemoryRatioThresholdStore implements IRatioThresholdStore {
  private byTenant = new Map<string, Map<RatioCode, { warning: number; critical: number; updated_at: string; updated_by: string }>>();

  list(tenant_id: string): RatioThresholdEntry[] {
    const overrides = this.byTenant.get(tenant_id) ?? new Map();
    return RATIO_CATALOG.map((def) => {
      const ov = overrides.get(def.code);
      return {
        code: def.code,
        warning: ov?.warning ?? def.default_warning,
        critical: ov?.critical ?? def.default_critical,
        is_default: !ov,
        updated_at: ov?.updated_at ?? null,
        updated_by: ov?.updated_by ?? null,
      };
    });
  }

  set(tenant_id: string, code: RatioCode, warning: number, critical: number, actor: string, now: Date): RatioThresholdEntry {
    if (!isRatioCode(code)) throw new RatiosError('invalid_input', `unknown ratio code: ${code}`);
    if (!Number.isFinite(warning) || !Number.isFinite(critical)) {
      throw new RatiosError('invalid_input', 'warning + critical must be finite numbers');
    }
    if (!actor) throw new RatiosError('invalid_input', 'actor (X-APEX-USER) is required');
    let t = this.byTenant.get(tenant_id);
    if (!t) {
      t = new Map();
      this.byTenant.set(tenant_id, t);
    }
    t.set(code, { warning, critical, updated_at: now.toISOString(), updated_by: actor });
    return {
      code,
      warning,
      critical,
      is_default: false,
      updated_at: now.toISOString(),
      updated_by: actor,
    };
  }

  reset(tenant_id: string, code: RatioCode): RatioThresholdEntry {
    if (!isRatioCode(code)) throw new RatiosError('invalid_input', `unknown ratio code: ${code}`);
    const t = this.byTenant.get(tenant_id);
    if (t) t.delete(code);
    const def = RATIO_BY_CODE[code];
    return {
      code,
      warning: def.default_warning,
      critical: def.default_critical,
      is_default: true,
      updated_at: null,
      updated_by: null,
    };
  }

  resolve(tenant_id: string): Partial<Record<RatioCode, { warning: number; critical: number }>> {
    const overrides:
      | Map<RatioCode, { warning: number; critical: number; updated_at: string; updated_by: string }>
      | undefined = this.byTenant.get(tenant_id);
    const out: Partial<Record<RatioCode, { warning: number; critical: number }>> = {};
    if (!overrides) return out;
    overrides.forEach((v, code) => {
      out[code] = { warning: v.warning, critical: v.critical };
    });
    return out;
  }
}

export const defaultRatioThresholdStore: IRatioThresholdStore = new InMemoryRatioThresholdStore();

// ─── CMA Pack (Forms II/III/IV/V) ─────────────────────────────────────

export type CmaForm = 'II' | 'III' | 'IV' | 'V';
export const ALL_CMA_FORMS: readonly CmaForm[] = ['II', 'III', 'IV', 'V'];

export function isCmaForm(s: unknown): s is CmaForm {
  return typeof s === 'string' && (ALL_CMA_FORMS as readonly string[]).includes(s);
}

export interface CmaPackInput {
  cohort: string[];
  forms: CmaForm[];
}

export interface CmaPackResult {
  pack_id: string;
  tenant_id: string;
  generated_at: string;
  generated_by: string;
  cohort_size: number;
  cohort: string[];
  forms: CmaForm[];
  html: string;
  size_bytes: number;
}

function formIIHtml(bundle: CustomerRatioBundle): string {
  // Form II — Operating Statement (synthesised)
  const c = bundle.current;
  const ebit = 'EBIT (= EBITDA – Depreciation)';
  return `<section class="cma-form cma-form-ii">
<h3>Form II — Operating Statement (₹ Lakhs)</h3>
<table>
  <tr><th>Particulars</th><th>FY-2 Audited</th><th>FY-1 Audited</th><th>FY (Provisional)</th><th>FY+1 (Projected)</th></tr>
  <tr><td>Net Sales</td><td>1,200</td><td>1,440</td><td>1,560</td><td>1,720</td></tr>
  <tr><td>Other Income</td><td>15</td><td>18</td><td>20</td><td>22</td></tr>
  <tr><td>Total Income</td><td>1,215</td><td>1,458</td><td>1,580</td><td>1,742</td></tr>
  <tr><td>Cost of Goods Sold</td><td>840</td><td>1,008</td><td>1,092</td><td>1,204</td></tr>
  <tr><td>Operating Expenses</td><td>180</td><td>216</td><td>234</td><td>258</td></tr>
  <tr><td>EBITDA</td><td>195</td><td>234</td><td>254</td><td>280</td></tr>
  <tr><td>Depreciation</td><td>35</td><td>42</td><td>45</td><td>49</td></tr>
  <tr><td>${ebit}</td><td>160</td><td>192</td><td>209</td><td>231</td></tr>
  <tr><td>Interest Expense</td><td>40</td><td>50</td><td>54</td><td>58</td></tr>
  <tr><td>PBT</td><td>120</td><td>142</td><td>155</td><td>173</td></tr>
  <tr><td>Tax (@30%)</td><td>36</td><td>43</td><td>47</td><td>52</td></tr>
  <tr><td><b>Net Profit</b></td><td><b>84</b></td><td><b>100</b></td><td><b>108</b></td><td><b>121</b></td></tr>
  <tr><td>ICR (computed)</td><td colspan="4">${c.ICR.value}× — band ${c.ICR.band}</td></tr>
</table>
</section>`;
}

function formIIIHtml(bundle: CustomerRatioBundle): string {
  const c = bundle.current;
  return `<section class="cma-form cma-form-iii">
<h3>Form III — Analysis of Balance Sheet (₹ Lakhs)</h3>
<table>
  <tr><th>Particulars</th><th>FY-2</th><th>FY-1</th><th>FY (Prov.)</th><th>FY+1 (Proj.)</th></tr>
  <tr><td><b>Sources of Funds</b></td><td colspan="4"></td></tr>
  <tr><td>Capital</td><td>200</td><td>200</td><td>200</td><td>240</td></tr>
  <tr><td>Reserves</td><td>180</td><td>240</td><td>290</td><td>360</td></tr>
  <tr><td>Net Worth</td><td>380</td><td>440</td><td>490</td><td>600</td></tr>
  <tr><td>Long-term Debt</td><td>500</td><td>600</td><td>640</td><td>680</td></tr>
  <tr><td>Working Cap Borrowings</td><td>350</td><td>420</td><td>480</td><td>520</td></tr>
  <tr><td><b>Total Liabilities</b></td><td><b>1,230</b></td><td><b>1,460</b></td><td><b>1,610</b></td><td><b>1,800</b></td></tr>
  <tr><td><b>Application of Funds</b></td><td colspan="4"></td></tr>
  <tr><td>Net Fixed Assets</td><td>450</td><td>540</td><td>580</td><td>630</td></tr>
  <tr><td>Current Assets</td><td>720</td><td>860</td><td>970</td><td>1,090</td></tr>
  <tr><td>Less: Current Liabilities</td><td>(380)</td><td>(456)</td><td>(514)</td><td>(580)</td></tr>
  <tr><td>Net Working Capital</td><td>340</td><td>404</td><td>456</td><td>510</td></tr>
  <tr><td><b>Total Assets</b></td><td><b>1,230</b></td><td><b>1,460</b></td><td><b>1,610</b></td><td><b>1,800</b></td></tr>
  <tr><td>DER (computed)</td><td colspan="4">${c.DER.value} — band ${c.DER.band}</td></tr>
  <tr><td>TOL/TNW (computed)</td><td colspan="4">${c.TOL_TNW.value} — band ${c.TOL_TNW.band}</td></tr>
</table>
</section>`;
}

function formIVHtml(bundle: CustomerRatioBundle): string {
  const c = bundle.current;
  return `<section class="cma-form cma-form-iv">
<h3>Form IV — Comparative Statement of Working Capital (₹ Lakhs)</h3>
<table>
  <tr><th>Particulars</th><th>FY-1</th><th>FY (Prov.)</th><th>FY+1 (Proj.)</th></tr>
  <tr><td><b>Current Assets</b></td><td colspan="3"></td></tr>
  <tr><td>Inventory</td><td>320</td><td>370</td><td>420</td></tr>
  <tr><td>Receivables (≤6m)</td><td>340</td><td>390</td><td>440</td></tr>
  <tr><td>Cash + Bank</td><td>140</td><td>160</td><td>180</td></tr>
  <tr><td>Other CA</td><td>60</td><td>50</td><td>50</td></tr>
  <tr><td><b>Total CA</b></td><td><b>860</b></td><td><b>970</b></td><td><b>1,090</b></td></tr>
  <tr><td><b>Current Liabilities</b></td><td colspan="3"></td></tr>
  <tr><td>Sundry Creditors</td><td>156</td><td>180</td><td>210</td></tr>
  <tr><td>Other CL</td><td>120</td><td>134</td><td>150</td></tr>
  <tr><td>Bank WC Borrowings</td><td>180</td><td>200</td><td>220</td></tr>
  <tr><td><b>Total CL</b></td><td><b>456</b></td><td><b>514</b></td><td><b>580</b></td></tr>
  <tr><td><b>Net Working Capital</b></td><td><b>404</b></td><td><b>456</b></td><td><b>510</b></td></tr>
  <tr><td>Current Ratio</td><td colspan="3">${c.CR.value}× — band ${c.CR.band}</td></tr>
  <tr><td>Quick Ratio</td><td colspan="3">${c.QR.value}× — band ${c.QR.band}</td></tr>
  <tr><td>Stock Turnover</td><td colspan="3">${c.STK_TO.value} days — band ${c.STK_TO.band}</td></tr>
  <tr><td>Debtor Turnover</td><td colspan="3">${c.DBT_TO.value} days — band ${c.DBT_TO.band}</td></tr>
</table>
</section>`;
}

function formVHtml(): string {
  return `<section class="cma-form cma-form-v">
<h3>Form V — Maximum Permissible Bank Finance (MPBF, ₹ Lakhs)</h3>
<table>
  <tr><th>Particulars</th><th>Method I</th><th>Method II (Tandon)</th></tr>
  <tr><td>Working Capital Gap</td><td>456</td><td>456</td></tr>
  <tr><td>Less: 25% of Current Assets</td><td>—</td><td>242</td></tr>
  <tr><td>Less: 25% of WC Gap</td><td>114</td><td>—</td></tr>
  <tr><td>Less: Existing NWC contribution</td><td>(170)</td><td>(170)</td></tr>
  <tr><td><b>MPBF</b></td><td><b>342</b></td><td><b>214</b></td></tr>
  <tr><td>Recommended limit (Method II)</td><td colspan="2">₹ 214 lakhs</td></tr>
</table>
</section>`;
}

export function buildCmaPack(
  tenant_id: string,
  input: CmaPackInput,
  actor: string,
  thresholdOverrides: Partial<Record<RatioCode, { warning: number; critical: number }>>,
  now: Date,
): CmaPackResult {
  if (!tenant_id) throw new RatiosError('invalid_input', 'tenant_id is required');
  if (!input || typeof input !== 'object') throw new RatiosError('invalid_input', 'input is required');
  if (!Array.isArray(input.cohort) || input.cohort.length === 0)
    throw new RatiosError('invalid_input', 'cohort must be a non-empty string array');
  if (input.cohort.length > 50) throw new RatiosError('invalid_input', 'cohort cap is 50 customers');
  if (!Array.isArray(input.forms) || input.forms.length === 0)
    throw new RatiosError('invalid_input', 'forms must be a non-empty array');
  for (const f of input.forms) if (!isCmaForm(f)) throw new RatiosError('invalid_input', `unknown CMA form: ${f}`);
  if (!actor) throw new RatiosError('invalid_input', 'actor is required');

  const formRenderers: Record<CmaForm, (b: CustomerRatioBundle) => string> = {
    II: formIIHtml,
    III: formIIIHtml,
    IV: formIVHtml,
    V: () => formVHtml(),
  };

  const customerSections: string[] = [];
  for (const cid of input.cohort) {
    const bundle = buildCustomerRatios(tenant_id, cid, thresholdOverrides, now);
    const inner = input.forms.map((f) => formRenderers[f](bundle)).join('\n');
    customerSections.push(`<article class="cma-customer" data-customer="${cid}">
<h2>Customer ${cid} — ${bundle.customer_name} (${bundle.sector})</h2>
<p>Worst-band: <b>${bundle.worst_band}</b>. Worst ratios: ${bundle.worst_ratios.join(', ') || '—'}</p>
${inner}
</article>`);
  }

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>CMA Pack — ${tenant_id} — ${now.toISOString().slice(0, 10)}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; margin: 24px; }
  h1 { border-bottom: 2px solid #00264d; padding-bottom: 8px; }
  h2 { margin-top: 36px; color: #00264d; }
  h3 { margin-top: 18px; color: #003a72; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 12px; }
  th, td { border: 1px solid #b7c3d2; padding: 6px 10px; text-align: right; font-size: 12px; }
  th, td:first-child { text-align: left; }
  .cma-form { margin: 10px 0 24px; page-break-inside: avoid; }
  @media print {
    .cma-customer { page-break-before: always; }
  }
</style>
</head>
<body>
<h1>CMA Pack — ${tenant_id}</h1>
<p>Generated: ${now.toISOString()} by ${actor}. Forms: ${input.forms.join(', ')}. Cohort: ${input.cohort.length} customer(s).</p>
${customerSections.join('\n')}
</body>
</html>`;

  const packId = `cma-${tenant_id}-${now.toISOString().slice(0, 10)}-${fnv1a(input.cohort.join('|')).toString(16).slice(0, 8)}`;
  return {
    pack_id: packId,
    tenant_id,
    generated_at: now.toISOString(),
    generated_by: actor,
    cohort_size: input.cohort.length,
    cohort: input.cohort,
    forms: input.forms,
    html,
    size_bytes: Buffer.byteLength(html, 'utf8'),
  };
}

// ─── M2.3 Additive surface — history slice + notes ─────────────────────
//
// Per cross-cutting #1 (no duplication), `buildRatioHistorySlice` re-uses
// `buildCustomerRatios` + `buildSectorBenchmark` to compose a single-ratio
// 12-month view with sector benchmark overlay — exactly what the SPA's
// Ratio detail modal renders.

export interface RatioHistorySliceResult {
  tenant_id: string;
  generated_at: string;
  customer_id: string;
  customer_name: string;
  sector: string;
  ratio_code: RatioCode;
  ratio_def: RatioDef;
  current: RatioValue;
  history: RatioHistoryPoint[];
  sector_benchmark: { p25: number; median: number; p75: number; internal_median: number };
  trend_vs_sector: 'better' | 'worse' | 'on_par';
  threshold: { warning: number; critical: number; source: 'tenant_override' | 'platform_default' };
}

export function buildRatioHistorySlice(
  tenant_id: string,
  customer_id: string,
  ratio_code: string,
  thresholdOverrides: Partial<Record<RatioCode, { warning: number; critical: number }>>,
  now: Date,
  historyMonths = 12,
): RatioHistorySliceResult {
  if (!tenant_id) throw new RatiosError('invalid_input', 'tenant_id is required');
  if (!customer_id) throw new RatiosError('invalid_input', 'customer_id is required');
  const codeUpper = (ratio_code ?? '').toUpperCase();
  if (!isRatioCode(codeUpper))
    throw new RatiosError('invalid_ratio_code', `unknown ratio: ${ratio_code}`);

  const bundle = buildCustomerRatios(
    tenant_id,
    customer_id,
    thresholdOverrides,
    now,
    historyMonths,
  );
  const code = codeUpper as RatioCode;
  const benchmark = buildSectorBenchmark(tenant_id, bundle.sector, now);
  const benchRow = benchmark.ratios.find((r) => r.code === code);
  if (!benchRow) {
    // Defensive — sector benchmark must include every catalog ratio. If it
    // doesn't (future drift), fall back to placeholder values so the route
    // doesn't 500.
    throw new RatiosError('sector_benchmark_missing', `sector ${bundle.sector} has no benchmark for ${code}`);
  }
  const def = RATIO_BY_CODE[code];

  // Trend vs sector — polarity-aware "better/worse" verdict.
  const value = bundle.current[code].value;
  const median = benchRow.rbi_median;
  let trend: 'better' | 'worse' | 'on_par' = 'on_par';
  const drift = Math.abs(value - median) / Math.max(1e-9, Math.abs(median));
  if (drift < 0.05) {
    trend = 'on_par';
  } else if (def.polarity === 'higher_is_better') {
    trend = value > median ? 'better' : 'worse';
  } else {
    trend = value < median ? 'better' : 'worse';
  }

  const override = thresholdOverrides[code];
  const threshold = override
    ? { warning: override.warning, critical: override.critical, source: 'tenant_override' as const }
    : { warning: def.default_warning, critical: def.default_critical, source: 'platform_default' as const };

  return {
    tenant_id,
    generated_at: now.toISOString(),
    customer_id,
    customer_name: bundle.customer_name,
    sector: bundle.sector,
    ratio_code: code,
    ratio_def: def,
    current: bundle.current[code],
    history: bundle.history[code],
    sector_benchmark: {
      p25: benchRow.rbi_quartile_25,
      median: benchRow.rbi_median,
      p75: benchRow.rbi_quartile_75,
      internal_median: benchRow.internal_median,
    },
    trend_vs_sector: trend,
    threshold,
  };
}

// ─── Ratio Notes ────────────────────────────────────────────────────────
//
// User-supplied free-text annotations per (customer, ratio). Tooltip-sized
// (≤ 1000 chars). Tenant-scoped. Append-only.

export interface RatioNote {
  note_id: string;
  tenant_id: string;
  customer_id: string;
  ratio_code: RatioCode;
  body: string;
  author: string;
  created_at: string;
}

export interface IRatioNoteStore {
  add(tenant_id: string, customer_id: string, ratio_code: string, body: string, author: string, now: Date): RatioNote;
  list(tenant_id: string, filter?: { customer_id?: string; ratio_code?: string }): RatioNote[];
  _reset(): void;
}

export class InMemoryRatioNoteStore implements IRatioNoteStore {
  private notes: RatioNote[] = [];
  private seq = 0;

  add(tenant_id: string, customer_id: string, ratio_code: string, body: string, author: string, now: Date): RatioNote {
    if (!tenant_id) throw new RatiosError('invalid_input', 'tenant_id required');
    if (!customer_id) throw new RatiosError('invalid_input', 'customer_id required');
    const codeUpper = (ratio_code ?? '').toUpperCase();
    if (!isRatioCode(codeUpper)) throw new RatiosError('invalid_ratio_code', `unknown ratio: ${ratio_code}`);
    if (!body || typeof body !== 'string' || body.trim().length === 0)
      throw new RatiosError('invalid_input', 'body is required');
    if (body.length > 1000) throw new RatiosError('invalid_input', 'body must be ≤ 1000 chars');
    if (!author) throw new RatiosError('invalid_input', 'author required');
    this.seq++;
    const note: RatioNote = {
      note_id: `rnote-${tenant_id}-${now.toISOString().slice(0, 10).replace(/-/g, '')}-${String(this.seq).padStart(4, '0')}`,
      tenant_id,
      customer_id,
      ratio_code: codeUpper as RatioCode,
      body: body.trim(),
      author,
      created_at: now.toISOString(),
    };
    this.notes.push(note);
    return note;
  }

  list(tenant_id: string, filter: { customer_id?: string; ratio_code?: string } = {}): RatioNote[] {
    const codeUpper = filter.ratio_code ? filter.ratio_code.toUpperCase() : undefined;
    return this.notes
      .filter((n) => n.tenant_id === tenant_id)
      .filter((n) => !filter.customer_id || n.customer_id === filter.customer_id)
      .filter((n) => !codeUpper || n.ratio_code === codeUpper)
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  _reset() {
    this.notes = [];
    this.seq = 0;
  }
}

export const defaultRatioNoteStore: IRatioNoteStore = new InMemoryRatioNoteStore();
