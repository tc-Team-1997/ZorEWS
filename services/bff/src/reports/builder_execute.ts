// services/bff/src/reports/builder_execute.ts
//
// T4.6.4 — Self-service reporting: execution engine.
//
// Pure function. Compiles a ReportDefinition via T4.6.2, synthesises
// deterministic rows against the T4.6.1 catalog schema, applies the
// filter tree client-side (since the prototype doesn't execute the
// compiled SQL), and returns rows + aggregates + compiled-SQL +
// params + duration_ms.
//
// Synthesis seeds: FNV-1a + Mulberry32 keyed on `(tenant, source,
// day, definition-hash)` — same input always yields the same rows
// so SPA tests + manual demos are repeatable.
//
// Production swap: replace `synthesiseRows()` with `pg.pool.query(
// compiled.sql, compiled.params)` — the result envelope shape stays
// stable.
//
// Companion to:
//   - T4.6.1 ReportDataSource catalog (declares synthesis ranges).
//   - T4.6.2 compileReportDefinition (filter compiler).
//   - T4.6.3 SavedReportStore (loads saved.definition).
//   - T4.6.6 SPA section configurator (consumes rows + aggregates).

import {
  getReportField,
  type ReportDataSource,
  type ReportField,
} from './builder_catalog';
import {
  compileReportDefinition,
  type CompiledQuery,
  type FilterNode,
  type MetricAgg,
  type ReportDefinition,
  type ReportMetric,
  type SortClause,
} from './builder_filter';

// ─── Public types ──────────────────────────────────────────────────────

export type ReportRow = Record<string, unknown>;

export interface ReportResult {
  tenant_id: string;
  generated_at: string;
  source_id: string;
  is_aggregate: boolean;
  rows: ReportRow[];
  /** Map of metric alias → cross-row aggregate (sum / count / etc).
   *  For aggregate reports, this is the grand-total over groups. */
  aggregates: Record<string, number>;
  total_rows: number;
  /** Number of synthesised "raw" rows BEFORE filter / group_by collapse —
   *  surfaces the "out of N candidates, M matched" insight. */
  candidate_rows: number;
  projection: string[];
  /** Compiled-SQL preview — only surfaced to admin callers (route layer
   *  scrubs it for non-admin to avoid information leak). */
  sql: string;
  params: Record<string, unknown>;
  duration_ms: number;
}

export class ReportExecutionError extends Error {
  constructor(
    public readonly code: 'invalid_input' | 'execution_failed',
    message: string,
  ) {
    super(message);
    this.name = 'ReportExecutionError';
  }
}

// ─── Determinism helpers ───────────────────────────────────────────────

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

function definitionHash(def: ReportDefinition): string {
  // Stable canonical hash of the relevant axes — same def always seeds
  // the same rows. Sorted keys + JSON.stringify avoids object-iteration
  // order drift.
  const stable = JSON.stringify({
    source_id: def.source_id,
    filters: def.filters ?? null,
    group_by: def.group_by ? [...def.group_by].sort() : [],
    metrics: def.metrics ? [...def.metrics].sort((a, b) =>
      (a.field + a.agg + (a.alias ?? '')).localeCompare(b.field + b.agg + (b.alias ?? '')),
    ) : [],
    sort: def.sort ?? [],
    limit: def.limit ?? null,
  });
  return fnv1a(stable).toString(16);
}

function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

// ─── Per-field synthesis ──────────────────────────────────────────────

interface SynthContext {
  rng: () => number;
  tenant_id: string;
  source: ReportDataSource;
  now: Date;
}

function synthesiseFieldValue(
  field: ReportField,
  row_idx: number,
  ctx: SynthContext,
): unknown {
  switch (field.type) {
    case 'string': {
      // customer_id / loan_id / alert_id / case_id / etc.
      // Convention: <prefix>-<tenant>-<padded-int>
      const prefix = field.name
        .replace(/_id$/, '')
        .replace(/^([a-z]).*/, (m) => m.toUpperCase())
        .slice(0, 4)
        .toUpperCase();
      if (field.pii && field.name === 'name') {
        const first = ['Alice', 'Bob', 'Carol', 'Dev', 'Eve', 'Faisal', 'Greta', 'Harish'];
        const last = ['Smith', 'Patel', 'Otieno', 'Kumar', 'Cherop', 'Singh'];
        return `${first[row_idx % first.length]} ${last[(row_idx * 3 + 1) % last.length]}`;
      }
      return `${prefix}-${ctx.tenant_id.slice(0, 4)}-${String(row_idx + 1).padStart(6, '0')}`;
    }
    case 'integer': {
      // Range guess from common BIL bounds.
      let lo = 0, hi = 100;
      if (field.name.includes('dpd')) { lo = 0; hi = 180; }
      else if (field.name.includes('score')) { lo = 300; hi = 900; }
      else if (field.name.includes('tenure')) { lo = 0; hi = 120; }
      else if (field.name.includes('count')) { lo = 0; hi = 50; }
      return lo + Math.floor(ctx.rng() * (hi - lo + 1));
    }
    case 'number': {
      let lo = 0, hi = 1;
      if (field.name.includes('exposure') || field.name.includes('balance') || field.name.includes('outstanding') || field.name.includes('principal') || field.name.includes('volume')) {
        lo = 0; hi = 5_000_000;
      } else if (field.name.includes('pd_score') || field.name.includes('utilization') || field.name.includes('criticality')) {
        lo = 0; hi = 1;
      } else if (field.name.includes('zscore') || field.name.includes('drop')) {
        lo = -3; hi = 3;
      } else if (field.name === 'value') {
        lo = 0; hi = 1;
      }
      return Math.round((lo + ctx.rng() * (hi - lo)) * 100) / 100;
    }
    case 'boolean':
      return ctx.rng() < 0.5;
    case 'date': {
      // Within last 365 days.
      const daysBack = Math.floor(ctx.rng() * 365);
      const d = new Date(ctx.now.getTime() - daysBack * 86_400_000);
      return d.toISOString().slice(0, 10);
    }
    case 'datetime': {
      // Within last 30 days.
      const msBack = Math.floor(ctx.rng() * 30 * 86_400_000);
      const d = new Date(ctx.now.getTime() - msBack);
      return d.toISOString();
    }
    case 'enum': {
      const vals = field.enum_values ?? [];
      if (vals.length === 0) return null;
      return vals[Math.floor(ctx.rng() * vals.length)];
    }
  }
}

function synthesiseRow(idx: number, ctx: SynthContext): ReportRow {
  const row: ReportRow = {};
  for (const field of ctx.source.fields) {
    row[field.name] = synthesiseFieldValue(field, idx, ctx);
  }
  return row;
}

function synthesiseRows(
  candidate_count: number,
  ctx: SynthContext,
): ReportRow[] {
  const rows: ReportRow[] = [];
  for (let i = 0; i < candidate_count; i++) {
    rows.push(synthesiseRow(i, ctx));
  }
  return rows;
}

// ─── Filter evaluation ────────────────────────────────────────────────

function evaluateFilter(node: FilterNode, row: ReportRow): boolean {
  switch (node.op) {
    case 'AND':
      return node.children.every((c) => evaluateFilter(c, row));
    case 'OR':
      return node.children.some((c) => evaluateFilter(c, row));
    case 'NOT':
      return !evaluateFilter(node.child, row);
    case 'is_null':
      return row[node.field] === null || row[node.field] === undefined;
    case 'is_not_null':
      return row[node.field] !== null && row[node.field] !== undefined;
    case 'eq':
      return row[node.field] === node.value;
    case 'ne':
      return row[node.field] !== node.value;
    case 'lt':
    case 'le':
    case 'gt':
    case 'ge': {
      const v = row[node.field];
      const t = node.value;
      if (v === null || v === undefined || t === null || t === undefined) return false;
      // String comparison via localeCompare for date/datetime/string;
      // numeric direct for integer + number.
      const cmp = typeof v === 'number' && typeof t === 'number'
        ? v - t
        : String(v).localeCompare(String(t));
      switch (node.op) {
        case 'lt': return cmp < 0;
        case 'le': return cmp <= 0;
        case 'gt': return cmp > 0;
        case 'ge': return cmp >= 0;
      }
    }
    // eslint-disable-next-line no-fallthrough
    case 'in':
      return Array.isArray(node.value) && node.value.includes(row[node.field]);
    case 'not_in':
      return Array.isArray(node.value) && !node.value.includes(row[node.field]);
    case 'between': {
      const v = row[node.field];
      const arr = node.value as unknown[];
      if (!Array.isArray(arr) || arr.length !== 2) return false;
      const [lo, hi] = arr;
      if (typeof v === 'number' && typeof lo === 'number' && typeof hi === 'number') {
        return v >= lo && v <= hi;
      }
      const s = String(v);
      return s >= String(lo) && s <= String(hi);
    }
    default:
      return false;
  }
}

// ─── Aggregation ──────────────────────────────────────────────────────

function metricAlias(m: ReportMetric): string {
  return m.alias ?? `${m.agg.toLowerCase()}_${m.field}`;
}

function applyAggregation(
  rows: ReportRow[],
  group_by: string[],
  metrics: ReportMetric[],
): ReportRow[] {
  if (group_by.length === 0 && metrics.length === 0) return rows;
  // Group rows by composite key of group_by fields.
  const groups = new Map<string, ReportRow[]>();
  for (const row of rows) {
    const key = JSON.stringify(group_by.map((g) => row[g] ?? null));
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(row);
  }
  const out: ReportRow[] = [];
  for (const [, group] of groups) {
    const r: ReportRow = {};
    if (group_by.length > 0) {
      for (const g of group_by) r[g] = group[0][g];
    }
    for (const m of metrics) {
      r[metricAlias(m)] = aggOne(m, group);
    }
    out.push(r);
  }
  return out;
}

function aggOne(m: ReportMetric, group: ReportRow[]): number {
  const values = group.map((r) => r[m.field]);
  const numeric = values.filter((v): v is number => typeof v === 'number');
  switch (m.agg as MetricAgg) {
    case 'COUNT':
      return values.filter((v) => v !== null && v !== undefined).length;
    case 'DISTINCT_COUNT': {
      const set = new Set<unknown>();
      for (const v of values) {
        if (v !== null && v !== undefined) set.add(v);
      }
      return set.size;
    }
    case 'SUM':
      return Math.round(numeric.reduce((a, b) => a + b, 0) * 100) / 100;
    case 'AVG':
      if (numeric.length === 0) return 0;
      return Math.round((numeric.reduce((a, b) => a + b, 0) / numeric.length) * 100) / 100;
    case 'MIN':
      if (values.length === 0) return 0;
      if (numeric.length === values.length) {
        return Math.min(...numeric);
      }
      // For string/enum MIN we compare lexicographically — return is opaque
      // to the SPA + only used for display.
      return values.reduce((a, b) => (String(a) < String(b) ? a : b)) as number;
    case 'MAX':
      if (values.length === 0) return 0;
      if (numeric.length === values.length) {
        return Math.max(...numeric);
      }
      return values.reduce((a, b) => (String(a) > String(b) ? a : b)) as number;
    default:
      return 0;
  }
}

// ─── Sort ─────────────────────────────────────────────────────────────

function applySort(rows: ReportRow[], sort: SortClause[]): ReportRow[] {
  if (sort.length === 0) return rows;
  const sorted = [...rows];
  sorted.sort((a, b) => {
    for (const s of sort) {
      const av = a[s.field];
      const bv = b[s.field];
      let cmp = 0;
      if (typeof av === 'number' && typeof bv === 'number') {
        cmp = av - bv;
      } else {
        cmp = String(av ?? '').localeCompare(String(bv ?? ''));
      }
      if (cmp !== 0) return s.direction === 'ASC' ? cmp : -cmp;
    }
    return 0;
  });
  return sorted;
}

// ─── Grand totals across rows ──────────────────────────────────────────

function computeGrandTotals(
  rows: ReportRow[],
  metrics: ReportMetric[],
): Record<string, number> {
  const out: Record<string, number> = {};
  if (metrics.length === 0) return out;
  for (const m of metrics) {
    const alias = metricAlias(m);
    const values = rows.map((r) => r[alias]);
    const numeric = values.filter((v): v is number => typeof v === 'number');
    if (m.agg === 'COUNT' || m.agg === 'DISTINCT_COUNT') {
      // For grand-total of count-style: sum across groups.
      out[alias] = numeric.reduce((a, b) => a + b, 0);
    } else if (m.agg === 'SUM') {
      out[alias] = Math.round(numeric.reduce((a, b) => a + b, 0) * 100) / 100;
    } else if (m.agg === 'AVG') {
      out[alias] = numeric.length > 0
        ? Math.round((numeric.reduce((a, b) => a + b, 0) / numeric.length) * 100) / 100
        : 0;
    } else if (m.agg === 'MIN') {
      out[alias] = numeric.length > 0 ? Math.min(...numeric) : 0;
    } else if (m.agg === 'MAX') {
      out[alias] = numeric.length > 0 ? Math.max(...numeric) : 0;
    }
  }
  return out;
}

// ─── Public entrypoint ────────────────────────────────────────────────

export interface ExecuteOptions {
  tenant_id: string;
  /** Caller's role — used by the route to decide whether to surface
   *  compiled SQL to the response (admin only). */
  role?: string;
  /** Defaults to now(). Test injection point. */
  now?: Date;
  /** Override the candidate-row count synthesis target. Defaults to
   *  a per-source size from CANDIDATE_DEFAULTS. */
  candidate_target?: number;
}

const CANDIDATE_DEFAULTS: Record<string, number> = {
  'mart.customer_360': 2000,
  'mart.loan_360': 5000,
  'mart.txn_features': 2000,
  'mart.indicator_values': 8000,
  'app_alerts.alerts': 800,
  'app_cases.cases': 250,
  'app_audit.approvals': 400,
  'audit.event_log': 5000,
};

export function executeReport(
  def: ReportDefinition,
  opts: ExecuteOptions,
): ReportResult {
  if (!def || typeof def !== 'object') {
    throw new ReportExecutionError('invalid_input', 'definition required');
  }
  if (typeof opts.tenant_id !== 'string' || !opts.tenant_id.trim()) {
    throw new ReportExecutionError('invalid_input', 'tenant_id required');
  }
  const now = opts.now ?? new Date();
  const t0 = Date.now();

  // 1. Compile (also validates source + filter shape).
  let compiled: CompiledQuery;
  try {
    compiled = compileReportDefinition(def, { tenant_id: opts.tenant_id });
  } catch (err) {
    const e = err as { code?: string; message?: string };
    throw new ReportExecutionError(
      e.code === 'unknown_source' ? 'invalid_input' : 'invalid_input',
      e.message ?? 'definition compile failed',
    );
  }

  // 2. Synthesise candidate rows seeded by (tenant, source, day, def-hash).
  const candidate_count = Math.min(
    opts.candidate_target ?? CANDIDATE_DEFAULTS[def.source_id] ?? 1000,
    10000, // hard ceiling to keep the synthesis deterministic-fast
  );
  const seed = fnv1a(
    `report-execute|${opts.tenant_id}|${def.source_id}|${utcDay(now)}|${definitionHash(def)}`,
  );
  const ctx: SynthContext = {
    rng: mulberry32(seed),
    tenant_id: opts.tenant_id,
    source: compiled.source,
    now,
  };
  let rows = synthesiseRows(candidate_count, ctx);

  // 3. Apply filter tree client-side.
  if (def.filters) {
    rows = rows.filter((r) => evaluateFilter(def.filters!, r));
  }

  // 4. Aggregate.
  const group_by = def.group_by ?? [];
  const metrics = def.metrics ?? [];
  let resultRows = applyAggregation(rows, group_by, metrics);

  // 5. Sort.
  const sort = def.sort ?? [];
  resultRows = applySort(resultRows, sort);

  // 6. Limit. compiled.params.limit already clamped by the compiler.
  const limit = Number(compiled.params.limit ?? 100);
  const truncated = resultRows.slice(0, limit);

  // 7. Grand totals.
  const aggregates = computeGrandTotals(truncated, metrics);

  const duration_ms = Date.now() - t0;

  return {
    tenant_id: opts.tenant_id,
    generated_at: now.toISOString(),
    source_id: compiled.source.source_id,
    is_aggregate: compiled.is_aggregate,
    rows: truncated,
    aggregates,
    total_rows: truncated.length,
    candidate_rows: candidate_count,
    projection: compiled.projection,
    sql: compiled.sql,
    params: compiled.params,
    duration_ms,
  };
}

// ─── CSV export ───────────────────────────────────────────────────────

/** RFC 4180 escaping — quote a cell if it contains comma, quote, or
 *  newline. Doubled quote inside the quoted string. */
function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  if (/[,"\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/** Convert ReportResult to RFC 4180 CSV string. Column order = projection.
 *  Production swap: streaming variant via Node Readable for large result
 *  sets — the route layer can wrap this and pipe to res.write() chunks. */
export function reportResultToCsv(result: ReportResult): string {
  const header = result.projection.map(csvCell).join(',');
  const body = result.rows
    .map((row) => result.projection.map((col) => csvCell(row[col])).join(','))
    .join('\r\n');
  return body.length > 0 ? `${header}\r\n${body}\r\n` : `${header}\r\n`;
}
