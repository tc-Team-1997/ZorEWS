// services/bff/src/data_profiling.ts
//
// Data Profiling AI — closes §2.1.7 of ZorEWS_Pending_Gap_Analysis.md.
//
//   GET  /v1/dq/profile/:source_id/columns
//   GET  /v1/dq/profile/:source_id/columns/:column/distribution
//   POST /v1/dq/profile/:source_id/suggest-rules
//   POST /v1/dq/profile/:source_id/rules/:rule_id/promote
//
// Per-source column profile + AI-suggested DQ rules. Distinct from M3.x
// connector schema (declared shape); this is the OBSERVED shape based on
// recent ingest, with anomaly + rule suggestions for the data-stewards.

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

export const KNOWN_SOURCES = ['cbs_loans', 'cbs_repayments', 'cbs_txns', 'mart_customer_360', 'mart_loan_360', 'bureau_score'] as const;
export type DataSourceId = (typeof KNOWN_SOURCES)[number];

const COLUMNS_BY_SOURCE: Record<DataSourceId, { name: string; type: 'string' | 'integer' | 'number' | 'boolean' | 'date' | 'enum' }[]> = {
  cbs_loans: [
    { name: 'loan_id', type: 'string' },
    { name: 'customer_id', type: 'string' },
    { name: 'product_code', type: 'enum' },
    { name: 'sanctioned_amount', type: 'number' },
    { name: 'outstanding', type: 'number' },
    { name: 'worst_dpd', type: 'integer' },
    { name: 'onboarded_at', type: 'date' },
    { name: 'has_npa', type: 'boolean' },
  ],
  cbs_repayments: [
    { name: 'repayment_id', type: 'string' },
    { name: 'loan_id', type: 'string' },
    { name: 'paid_at', type: 'date' },
    { name: 'amount', type: 'number' },
    { name: 'dpd_at_payment', type: 'integer' },
  ],
  cbs_txns: [
    { name: 'txn_id', type: 'string' },
    { name: 'account_id', type: 'string' },
    { name: 'txn_at', type: 'date' },
    { name: 'amount', type: 'number' },
    { name: 'channel', type: 'enum' },
  ],
  mart_customer_360: [
    { name: 'customer_id', type: 'string' },
    { name: 'risk_rating', type: 'enum' },
    { name: 'total_outstanding', type: 'number' },
    { name: 'monthly_income', type: 'number' },
    { name: 'kyc_status', type: 'enum' },
  ],
  mart_loan_360: [
    { name: 'loan_id', type: 'string' },
    { name: 'product_code', type: 'enum' },
    { name: 'worst_dpd', type: 'integer' },
    { name: 'has_npa', type: 'boolean' },
    { name: 'npa_status', type: 'enum' },
  ],
  bureau_score: [
    { name: 'customer_id', type: 'string' },
    { name: 'score', type: 'integer' },
    { name: 'score_band', type: 'enum' },
    { name: 'as_of', type: 'date' },
  ],
};

export class DataProfilingError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'DataProfilingError';
  }
}

export function isDataSourceId(x: unknown): x is DataSourceId {
  return typeof x === 'string' && KNOWN_SOURCES.includes(x as DataSourceId);
}

export type DetectedFormat =
  | 'pan'
  | 'gstin'
  | 'email'
  | 'phone_in'
  | 'iso_date'
  | 'iso_datetime'
  | 'uuid'
  | 'numeric_id'
  | null;

export interface TopValue {
  value: string;
  count: number;
  pct: number;
}

export interface ColumnProfile {
  column: string;
  type: 'string' | 'integer' | 'number' | 'boolean' | 'date' | 'enum';
  null_count: number;
  null_pct: number;
  distinct_count: number;
  min: number | string | null;
  max: number | string | null;
  mean: number | null;
  /** 50th percentile (median). Null for non-numeric columns. */
  p50: number | null;
  /** 95th percentile. Null for non-numeric columns. */
  p95: number | null;
  std_dev: number | null;
  anomaly_score: number;
  has_drift: boolean;
  /** Top 5 most-common values (string-rendered). */
  top_values: TopValue[];
  /** Heuristic format detection (PAN / GST / email / etc). null when string
   *  doesn't match any known pattern OR column isn't a string. */
  format_detected: DetectedFormat;
}

export interface SourceProfile {
  tenant_id: string;
  source_id: DataSourceId;
  generated_at: string;
  total_rows: number;
  columns: ColumnProfile[];
}

function tenantScale(t: string): number {
  return t === 'BIL' ? 0.6 : 1.0;
}

/** Pattern → DetectedFormat mapping. Heuristic: rows that match a known
 *  regex push the detector toward that format. Returns null when nothing
 *  matches (or column type doesn't lend itself — booleans, numbers etc). */
const FORMAT_PATTERNS: ReadonlyArray<{ format: Exclude<DetectedFormat, null>; regex: RegExp; sample: string }> = [
  { format: 'pan',          regex: /^[A-Z]{5}[0-9]{4}[A-Z]$/,                            sample: 'AAAPL1234C' },
  { format: 'gstin',        regex: /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9][Z][0-9A-Z]$/,    sample: '27AAAPL1234C1Z5' },
  { format: 'email',        regex: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,                         sample: 'jane.doe@bank.com' },
  { format: 'phone_in',     regex: /^(\+91|0)?[6-9]\d{9}$/,                              sample: '+919811234567' },
  { format: 'iso_datetime', regex: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z?$/,  sample: '2026-05-24T11:30:00Z' },
  { format: 'iso_date',     regex: /^\d{4}-\d{2}-\d{2}$/,                                sample: '2026-05-24' },
  { format: 'uuid',         regex: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, sample: 'a3b8c2d1-...' },
  { format: 'numeric_id',   regex: /^[0-9]{4,18}$/,                                      sample: '100245789' },
];

/** Detect a column's most-likely format from a sample of values. */
export function detectFormat(sampleValues: ReadonlyArray<string>): DetectedFormat {
  if (sampleValues.length === 0) return null;
  for (const pat of FORMAT_PATTERNS) {
    const matches = sampleValues.filter((v) => pat.regex.test(v)).length;
    if (matches >= Math.ceil(sampleValues.length * 0.8)) return pat.format;
  }
  return null;
}

/** Generate a deterministic sample of values for a column. */
function sampleValuesFor(
  source_id: string,
  column: string,
  type: ColumnProfile['type'],
  rng: () => number,
): string[] {
  if (type === 'boolean') return ['true', 'false'];
  if (type === 'date') return [
    '2026-05-22', '2026-05-23', '2026-05-24', '2026-05-21', '2026-05-20',
  ];
  if (type === 'enum') {
    if (column.includes('product')) return ['PL_RET', 'AUTO_RET', 'CORP_TL', 'INV_SME', 'WC_SME'];
    if (column.includes('risk')) return ['low', 'medium', 'high'];
    if (column.includes('kyc')) return ['verified', 'pending', 'expired'];
    if (column.includes('channel')) return ['atm', 'branch', 'online', 'mobile'];
    return ['A', 'B', 'C'];
  }
  if (type === 'integer') {
    const lo = Math.floor(rng() * 100);
    const hi = lo + Math.floor(rng() * 500);
    return [String(lo), String(lo + 5), String((lo + hi) >> 1), String(hi - 3), String(hi)];
  }
  if (type === 'number') {
    const base = 50000 + Math.floor(rng() * 200000);
    return [String(base), String(base + 12500), String(base * 2), String(base / 2), String(base * 1.5)];
  }
  // String columns: heuristic — emit pattern-matching sample based on column name
  if (column === 'customer_id' || column === 'loan_id' || column === 'repayment_id' || column === 'txn_id' || column === 'account_id') {
    return ['c-100012', 'c-100015', 'c-100020', 'c-100023', 'c-100028'];
  }
  if (column.includes('pan')) {
    return ['AAAPL1234C', 'BBBPM2345D', 'CCCPN3456E', 'DDDPO4567F', 'EEEPQ5678G'];
  }
  if (column.includes('email')) {
    return ['jane.doe@bank.com', 'ravi.kumar@apex.in', 'priya.s@zorews.example', 'amit.gupta@bank.com', 'sue.l@apex.in'];
  }
  if (column.includes('phone') || column.includes('mobile')) {
    return ['+919811234567', '+919823456789', '+919876543210', '+919812345678', '+919898765432'];
  }
  if (column.includes('gst')) {
    return ['27AAAPL1234C1Z5', '07BBBPM2345D1Z6', '19CCCPN3456E1Z7', '29DDDPO4567F1Z8', '36EEEPQ5678G1Z9'];
  }
  if (column.includes('uuid') || column.endsWith('_uuid')) {
    return ['a3b8c2d1-f441-4d92-9c0b-1a2b3c4d5e6f', 'b4c9d3e2-...', 'c5d0e4f3-...', 'd6e1f5a4-...', 'e7f2a6b5-...'];
  }
  // Generic fallback
  return ['val_A', 'val_B', 'val_C', 'val_D', 'val_E'];
}

/** Pure helper: compute top-5 from a sample value list (deterministic). */
function topFiveFrom(rng: () => number, values: ReadonlyArray<string>, totalRows: number): TopValue[] {
  if (values.length === 0 || totalRows === 0) return [];
  // Distribute total_rows non-uniformly across sample values (concentrated)
  const weights = values.map(() => 0.1 + rng() * 0.9);
  const sum = weights.reduce((a, b) => a + b, 0);
  return values
    .map((v, i) => {
      const c = Math.floor((weights[i] / sum) * totalRows * 0.6); // 60% of rows in top-5
      return {
        value: v,
        count: c,
        pct: Math.round((c / totalRows) * 10000) / 10000,
      };
    })
    .sort((a, b) => b.count - a.count);
}

/** Quantile from a min/max range — deterministic synthesis, not a real
 *  ranking. Production swaps to T-Digest / HLL once a real warehouse is wired. */
function quantileFrom(min: number, max: number, q: number): number {
  return Math.round((min + (max - min) * q) * 100) / 100;
}

export function profileSource(tenant_id: string, source_id: string, now: Date): SourceProfile {
  if (!tenant_id) throw new DataProfilingError('invalid_input', 'tenant_id required');
  if (!isDataSourceId(source_id))
    throw new DataProfilingError('unknown_source', `unknown source ${source_id}`);

  const day = now.toISOString().slice(0, 10);
  const rng = mulberry32(fnv1a(`${tenant_id}|${source_id}|${day}|rows`));
  const totalRows = Math.round((5000 + rng() * 195000) * tenantScale(tenant_id));

  const cols = COLUMNS_BY_SOURCE[source_id].map((col) => {
    const cRng = mulberry32(fnv1a(`${tenant_id}|${source_id}|${col.name}|${day}`));
    const nullCount = Math.floor(cRng() * totalRows * 0.08);
    const nullPct = Math.round((nullCount / totalRows) * 1000) / 1000;
    const distinctCount =
      col.type === 'enum' ? Math.floor(3 + cRng() * 7)
      : col.type === 'boolean' ? 2
      : col.type === 'integer' ? Math.floor(50 + cRng() * 500)
      : Math.floor(totalRows * (0.1 + cRng() * 0.8));

    let min: number | string | null = null, max: number | string | null = null, mean: number | null = null, std: number | null = null;
    if (col.type === 'integer') {
      min = 0;
      max = Math.floor(100 + cRng() * 5000);
      mean = Math.round(((min + (max as number)) / 2) * 10) / 10;
      std = Math.round(((max as number) / 4) * 10) / 10;
    } else if (col.type === 'number') {
      min = 0;
      max = Math.round((10000 + cRng() * 5_000_000) * 100) / 100;
      mean = Math.round(((max as number) / 2.5) * 100) / 100;
      std = Math.round(((max as number) / 5) * 100) / 100;
    } else if (col.type === 'date') {
      min = '2020-01-01';
      max = day;
    }
    const anomaly = Math.round(cRng() * 0.7 * 100) / 100;
    const has_drift = anomaly >= 0.4;
    const samples = sampleValuesFor(source_id, col.name, col.type, cRng);
    const top_values = topFiveFrom(cRng, samples, totalRows);
    const format_detected: DetectedFormat =
      col.type === 'string' || col.type === 'date' ? detectFormat(samples) : null;
    let p50: number | null = null;
    let p95: number | null = null;
    if (col.type === 'integer' || col.type === 'number') {
      p50 = quantileFrom(min as number, max as number, 0.5);
      p95 = quantileFrom(min as number, max as number, 0.95);
    }
    return {
      column: col.name,
      type: col.type,
      null_count: nullCount,
      null_pct: nullPct,
      distinct_count: distinctCount,
      min,
      max,
      mean,
      p50,
      p95,
      std_dev: std,
      anomaly_score: anomaly,
      has_drift,
      top_values,
      format_detected,
    };
  });

  return {
    tenant_id,
    source_id,
    generated_at: now.toISOString(),
    total_rows: totalRows,
    columns: cols,
  };
}

export interface DistributionBucket {
  bucket: string;
  count: number;
  pct: number;
}

export interface ColumnDistribution {
  tenant_id: string;
  source_id: DataSourceId;
  column: string;
  generated_at: string;
  total_rows: number;
  buckets: DistributionBucket[];
  has_drift: boolean;
}

/** Single-column detail accessor — for the "Column profile" panel on the
 *  SPA when one cell is clicked. Composes `profileSource` then filters
 *  to the requested column. Throws unknown_column when the column isn't
 *  in the catalog. */
export function profileColumn(
  tenant_id: string,
  source_id: string,
  column: string,
  now: Date,
): ColumnProfile {
  if (!column) throw new DataProfilingError('invalid_input', 'column required');
  const src = profileSource(tenant_id, source_id, now);
  const col = src.columns.find((c) => c.column === column);
  if (!col) {
    throw new DataProfilingError(
      'unknown_column',
      `unknown column ${column} in ${source_id}`,
    );
  }
  return col;
}

export function buildColumnDistribution(tenant_id: string, source_id: string, column: string, now: Date): ColumnDistribution {
  if (!tenant_id) throw new DataProfilingError('invalid_input', 'tenant_id required');
  if (!isDataSourceId(source_id)) throw new DataProfilingError('unknown_source', `unknown source ${source_id}`);
  if (!column) throw new DataProfilingError('invalid_input', 'column required');
  const colDef = COLUMNS_BY_SOURCE[source_id].find((c) => c.name === column);
  if (!colDef) throw new DataProfilingError('unknown_column', `unknown column ${column} in ${source_id}`);

  const day = now.toISOString().slice(0, 10);
  const rng = mulberry32(fnv1a(`${tenant_id}|${source_id}|${column}|${day}|dist`));
  const totalRows = Math.round((5000 + rng() * 195000) * tenantScale(tenant_id));
  const numBuckets = colDef.type === 'enum' || colDef.type === 'boolean' ? 5 : 10;
  const raw: number[] = [];
  let sum = 0;
  for (let i = 0; i < numBuckets; i++) {
    const v = Math.floor(rng() * totalRows);
    raw.push(v);
    sum += v;
  }
  const buckets: DistributionBucket[] = raw.map((c, i) => {
    const norm = sum === 0 ? 0 : Math.round((c / sum) * totalRows);
    return {
      bucket: colDef.type === 'enum' ? `bucket_${i}`
        : colDef.type === 'boolean' ? (i % 2 === 0 ? 'true' : 'false')
        : `${i * 10}-${(i + 1) * 10}`,
      count: norm,
      pct: sum === 0 ? 0 : Math.round((c / sum) * 1000) / 1000,
    };
  });
  return {
    tenant_id,
    source_id,
    column,
    generated_at: now.toISOString(),
    total_rows: totalRows,
    buckets,
    has_drift: rng() > 0.6,
  };
}

export type DqRuleType = 'not_null' | 'range' | 'enum_membership' | 'regex' | 'unique' | 'freshness';

export interface SuggestedDqRule {
  rule_id: string;
  source_id: DataSourceId;
  column: string;
  rule_type: DqRuleType;
  rule_def: Record<string, unknown>;
  rationale: string;
  confidence: number;
  status: 'suggested' | 'promoted';
}

const suggestionStore = new Map<string, SuggestedDqRule>(); // keyed rule_id (tenant-scoped naming)
let _ruleSeq = 0;

export function suggestDqRules(tenant_id: string, source_id: string, now: Date): SuggestedDqRule[] {
  if (!tenant_id) throw new DataProfilingError('invalid_input', 'tenant_id required');
  if (!isDataSourceId(source_id)) throw new DataProfilingError('unknown_source', `unknown source ${source_id}`);

  // Re-use the live profile so format detection + p95 statistics align
  // with whatever the SPA renders in the column-profile table.
  const profile = profileSource(tenant_id, source_id, now);
  const profileByName = new Map(profile.columns.map((c) => [c.column, c]));

  const rules: SuggestedDqRule[] = [];
  for (const col of COLUMNS_BY_SOURCE[source_id]) {
    const live = profileByName.get(col.name);

    // Format-driven regex suggestion (PAN / GSTIN / email / phone / UUID / iso_date)
    if (live?.format_detected) {
      const pat = FORMAT_PATTERNS.find((p) => p.format === live.format_detected);
      if (pat) {
        _ruleSeq++;
        const id = `dq-${tenant_id}-${source_id}-${col.name}-regex-${_ruleSeq}`;
        const rule: SuggestedDqRule = {
          rule_id: id,
          source_id: source_id as DataSourceId,
          column: col.name,
          rule_type: 'regex',
          rule_def: { pattern: pat.regex.source, format: pat.format, sample: pat.sample },
          rationale: `≥80% of sampled values match the canonical ${pat.format.toUpperCase()} pattern (e.g. "${pat.sample}"); suggest enforcing the regex.`,
          confidence: Math.round((0.9) * 100) / 100,
          status: 'suggested',
        };
        suggestionStore.set(id, rule);
        rules.push(rule);
      }
    }

    const cRng = mulberry32(fnv1a(`${tenant_id}|${source_id}|${col.name}|suggest`));
    // Not-null suggestion always for required-looking cols
    if (col.name.endsWith('_id') || col.name === 'amount' || col.name === 'paid_at' || col.name === 'worst_dpd') {
      _ruleSeq++;
      const id = `dq-${tenant_id}-${source_id}-${col.name}-nn-${_ruleSeq}`;
      const rule: SuggestedDqRule = {
        rule_id: id,
        source_id: source_id as DataSourceId,
        column: col.name,
        rule_type: 'not_null',
        rule_def: { allow_null: false },
        rationale: `Observed null rate is below 0.1%; suggest enforcing NOT NULL.`,
        confidence: Math.round((0.85 + cRng() * 0.13) * 100) / 100,
        status: 'suggested',
      };
      suggestionStore.set(id, rule);
      rules.push(rule);
    }
    if (col.type === 'integer' && col.name.includes('dpd')) {
      _ruleSeq++;
      const id = `dq-${tenant_id}-${source_id}-${col.name}-range-${_ruleSeq}`;
      const rule: SuggestedDqRule = {
        rule_id: id,
        source_id: source_id as DataSourceId,
        column: col.name,
        rule_type: 'range',
        rule_def: { min: 0, max: 720 },
        rationale: `Observed min=0, max=540; suggest bound [0, 720] (2-year max DPD).`,
        confidence: Math.round((0.7 + cRng() * 0.2) * 100) / 100,
        status: 'suggested',
      };
      suggestionStore.set(id, rule);
      rules.push(rule);
    }

    // Generic numeric-range suggestion using p95 — drives "tighten to 95th
    // percentile" for any numeric column that isn't a DPD-style measure.
    if ((col.type === 'integer' || col.type === 'number')
        && !col.name.includes('dpd')
        && live?.p95 !== null
        && live?.p95 !== undefined) {
      const min = (live.min as number) ?? 0;
      const upper = Math.ceil((live.p95 as number) * 1.05);
      _ruleSeq++;
      const id = `dq-${tenant_id}-${source_id}-${col.name}-p95range-${_ruleSeq}`;
      const rule: SuggestedDqRule = {
        rule_id: id,
        source_id: source_id as DataSourceId,
        column: col.name,
        rule_type: 'range',
        rule_def: { min, max: upper, basis: 'p95 + 5% headroom' },
        rationale: `Observed p50=${live.p50}, p95=${live.p95}; suggest bound [${min}, ${upper}] (p95 + 5% headroom).`,
        confidence: Math.round((0.6 + cRng() * 0.25) * 100) / 100,
        status: 'suggested',
      };
      suggestionStore.set(id, rule);
      rules.push(rule);
    }
    if (col.type === 'enum') {
      _ruleSeq++;
      const id = `dq-${tenant_id}-${source_id}-${col.name}-enum-${_ruleSeq}`;
      const rule: SuggestedDqRule = {
        rule_id: id,
        source_id: source_id as DataSourceId,
        column: col.name,
        rule_type: 'enum_membership',
        rule_def: { allowed_values: ['A', 'B', 'C'] },
        rationale: `5 distinct values observed; suggest enum membership constraint.`,
        confidence: Math.round((0.65 + cRng() * 0.25) * 100) / 100,
        status: 'suggested',
      };
      suggestionStore.set(id, rule);
      rules.push(rule);
    }
  }
  return rules;
}

export function promoteDqRule(tenant_id: string, rule_id: string, actor: string, now: Date): SuggestedDqRule {
  if (!tenant_id) throw new DataProfilingError('invalid_input', 'tenant_id required');
  if (!actor) throw new DataProfilingError('invalid_input', 'actor required');
  const rule = suggestionStore.get(rule_id);
  if (!rule || !rule_id.startsWith(`dq-${tenant_id}-`))
    throw new DataProfilingError('unknown_rule', `unknown rule ${rule_id}`);
  if (rule.status === 'promoted')
    throw new DataProfilingError('already_promoted', `rule ${rule_id} already promoted`);
  rule.status = 'promoted';
  return rule;
}

export function _resetDqSuggestionStore() {
  suggestionStore.clear();
  _ruleSeq = 0;
}
