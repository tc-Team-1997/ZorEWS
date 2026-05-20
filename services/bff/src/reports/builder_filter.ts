// services/bff/src/reports/builder_filter.ts
//
// T4.6.2 — Self-service reporting: filter compiler + report definition.
//
// Pure function. Walks a FilterNode AST, validates every leaf against
// the canonical data-source catalog (T4.6.1), and emits a parameterised
// SQL WHERE clause + param bindings. 8 safety rails enforced:
//
//   1. Whitelist fields — leaf's `field` MUST be in source.fields.
//   2. Type-check values — string/number/date validated per ReportField.
//   3. Enum-check — `op: 'eq' | 'in'` on enum field rejects out-of-enum.
//   4. Parameterise — every value bound via :p0, :p1, ... — no concat.
//   5. Forbid keywords — `assertSafeSql` reuses T2.9 NL→SQL regex.
//   6. Auto-inject `tenant_id = :tenant_id` for tenant_scoped sources.
//   7. Inject hard LIMIT clamped [1, 10000] default 100.
//   8. SELECT-only — generated SQL never DDL/DML.
//
// Mirror of T2.9 NL→SQL safety pattern. The shared `assertSafeSql`
// gate ensures both surfaces reject the same set of dangerous patterns.

import {
  getReportField,
  requireReportSource,
  type ReportDataSource,
  type ReportField,
  type ReportFieldType,
} from './builder_catalog';

// ─── Public types ──────────────────────────────────────────────────────

export type FilterOp =
  | 'eq'
  | 'ne'
  | 'lt'
  | 'le'
  | 'gt'
  | 'ge'
  | 'in'
  | 'not_in'
  | 'between'
  | 'is_null'
  | 'is_not_null';

export type FilterNode =
  | { op: 'AND'; children: FilterNode[] }
  | { op: 'OR'; children: FilterNode[] }
  | { op: 'NOT'; child: FilterNode }
  | { op: FilterOp; field: string; value?: unknown };

export type MetricAgg =
  | 'COUNT'
  | 'SUM'
  | 'AVG'
  | 'MIN'
  | 'MAX'
  | 'DISTINCT_COUNT';

export interface ReportMetric {
  field: string;
  agg: MetricAgg;
  alias?: string;
}

export type SortDirection = 'ASC' | 'DESC';

export interface SortClause {
  field: string;
  direction: SortDirection;
}

export type ReportSectionType = 'chart' | 'table' | 'grid' | 'kpi';

export interface ReportSection {
  section_id: string;
  type: ReportSectionType;
  /** Section-type-specific config bag — opaque to the compiler. */
  config: Record<string, unknown>;
}

export interface ReportDefinition {
  source_id: string;
  filters?: FilterNode;
  group_by?: string[];
  metrics?: ReportMetric[];
  sort?: SortClause[];
  limit?: number;
  sections?: ReportSection[];
}

export interface CompiledQuery {
  sql: string;
  params: Record<string, unknown>;
  source: ReportDataSource;
  /** Field names projected by the SELECT (group_by + metric aliases). */
  projection: string[];
  /** Total parameter count for SPA preview. */
  param_count: number;
  /** True iff the report has group_by + metrics (vs raw row list). */
  is_aggregate: boolean;
}

export class FilterCompilerError extends Error {
  constructor(
    public readonly code:
      | 'invalid_input'
      | 'unknown_field'
      | 'invalid_op'
      | 'invalid_value'
      | 'enum_violation'
      | 'invalid_agg'
      | 'unsafe_sql',
    message: string,
  ) {
    super(message);
    this.name = 'FilterCompilerError';
  }
}

// ─── Constants ─────────────────────────────────────────────────────────

export const MAX_LIMIT = 10_000;
export const DEFAULT_LIMIT = 100;
export const MAX_PARAMS = 200; // hard cap on filter complexity

const NUMERIC_TYPES: readonly ReportFieldType[] = ['integer', 'number'];
const COMPARABLE_TYPES: readonly ReportFieldType[] = [
  'integer',
  'number',
  'date',
  'datetime',
];

const FORBIDDEN_KEYWORDS = [
  /\bINSERT\b/i,
  /\bUPDATE\b/i,
  /\bDELETE\b/i,
  /\bDROP\b/i,
  /\bALTER\b/i,
  /\bTRUNCATE\b/i,
  /\bGRANT\b/i,
  /\bREVOKE\b/i,
  /\bCREATE\b/i,
  /;\s*\w/,
];

function assertSafeSql(sql: string): void {
  for (const re of FORBIDDEN_KEYWORDS) {
    if (re.test(sql)) {
      throw new FilterCompilerError(
        'unsafe_sql',
        `compiled SQL contains forbidden pattern: ${re}`,
      );
    }
  }
}

// ─── Value validation per field type ───────────────────────────────────

function isIsoDate(s: unknown): s is string {
  if (typeof s !== 'string') return false;
  return /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function isIsoDateTime(s: unknown): s is string {
  if (typeof s !== 'string') return false;
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/.test(s);
}

function validateValue(field: ReportField, value: unknown): void {
  if (value === null || value === undefined) {
    throw new FilterCompilerError(
      'invalid_value',
      `null/undefined not allowed in comparison filter (use is_null op)`,
    );
  }

  switch (field.type) {
    case 'string':
      if (typeof value !== 'string') {
        throw new FilterCompilerError(
          'invalid_value',
          `field ${field.name} expects string, got ${typeof value}`,
        );
      }
      break;
    case 'integer':
      if (typeof value !== 'number' || !Number.isInteger(value) || !Number.isFinite(value)) {
        throw new FilterCompilerError(
          'invalid_value',
          `field ${field.name} expects integer, got ${value}`,
        );
      }
      break;
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new FilterCompilerError(
          'invalid_value',
          `field ${field.name} expects number, got ${value}`,
        );
      }
      break;
    case 'boolean':
      if (typeof value !== 'boolean') {
        throw new FilterCompilerError(
          'invalid_value',
          `field ${field.name} expects boolean, got ${value}`,
        );
      }
      break;
    case 'date':
      if (!isIsoDate(value)) {
        throw new FilterCompilerError(
          'invalid_value',
          `field ${field.name} expects ISO date YYYY-MM-DD, got ${value}`,
        );
      }
      break;
    case 'datetime':
      if (!isIsoDateTime(value)) {
        throw new FilterCompilerError(
          'invalid_value',
          `field ${field.name} expects ISO datetime, got ${value}`,
        );
      }
      break;
    case 'enum':
      if (typeof value !== 'string' || !field.enum_values?.includes(value)) {
        throw new FilterCompilerError(
          'enum_violation',
          `field ${field.name} expects one of ${(field.enum_values ?? []).join(', ')}, got ${value}`,
        );
      }
      break;
  }
}

// ─── Filter walker ─────────────────────────────────────────────────────

interface ParamBag {
  values: Record<string, unknown>;
  count: number;
}

function nextParam(bag: ParamBag, value: unknown): string {
  if (bag.count >= MAX_PARAMS) {
    throw new FilterCompilerError(
      'invalid_input',
      `filter complexity exceeds ${MAX_PARAMS} parameters`,
    );
  }
  const name = `p${bag.count}`;
  bag.values[name] = value;
  bag.count++;
  return `:${name}`;
}

function compileLeaf(
  node: FilterNode & { op: FilterOp },
  source: ReportDataSource,
  bag: ParamBag,
): string {
  const field = getReportField(source.source_id, node.field);
  if (!field) {
    throw new FilterCompilerError(
      'unknown_field',
      `field '${node.field}' not on source ${source.source_id}`,
    );
  }
  if (!field.filterable) {
    throw new FilterCompilerError(
      'unknown_field',
      `field '${node.field}' not filterable on source ${source.source_id}`,
    );
  }

  // Backtick-free, quoted-identifier-free output — column names whitelisted
  // by the catalog so this is safe to interpolate directly.
  const col = node.field;

  switch (node.op) {
    case 'is_null':
      return `${col} IS NULL`;
    case 'is_not_null':
      return `${col} IS NOT NULL`;
    case 'eq':
    case 'ne':
    case 'lt':
    case 'le':
    case 'gt':
    case 'ge': {
      validateValue(field, node.value);
      if (node.op !== 'eq' && node.op !== 'ne' && !COMPARABLE_TYPES.includes(field.type)) {
        // <, <=, >, >= only valid on comparable types.
        // string + enum + boolean only support eq/ne/in/not_in.
        throw new FilterCompilerError(
          'invalid_op',
          `op ${node.op} not valid on field ${node.field} (type ${field.type})`,
        );
      }
      const opMap: Record<string, string> = {
        eq: '=', ne: '!=', lt: '<', le: '<=', gt: '>', ge: '>=',
      };
      const p = nextParam(bag, node.value);
      return `${col} ${opMap[node.op]} ${p}`;
    }
    case 'in':
    case 'not_in': {
      if (!Array.isArray(node.value)) {
        throw new FilterCompilerError(
          'invalid_value',
          `${node.op} requires an array value`,
        );
      }
      if (node.value.length === 0) {
        throw new FilterCompilerError(
          'invalid_value',
          `${node.op} requires a non-empty array`,
        );
      }
      if (node.value.length > 100) {
        throw new FilterCompilerError(
          'invalid_value',
          `${node.op} array exceeds 100 elements`,
        );
      }
      for (const v of node.value) validateValue(field, v);
      const placeholders = (node.value as unknown[]).map((v) => nextParam(bag, v)).join(', ');
      return `${col} ${node.op === 'in' ? 'IN' : 'NOT IN'} (${placeholders})`;
    }
    case 'between': {
      if (!Array.isArray(node.value) || node.value.length !== 2) {
        throw new FilterCompilerError(
          'invalid_value',
          `between requires a 2-element array [low, high]`,
        );
      }
      if (!COMPARABLE_TYPES.includes(field.type)) {
        throw new FilterCompilerError(
          'invalid_op',
          `between not valid on field ${node.field} (type ${field.type})`,
        );
      }
      validateValue(field, node.value[0]);
      validateValue(field, node.value[1]);
      const lo = nextParam(bag, node.value[0]);
      const hi = nextParam(bag, node.value[1]);
      return `${col} BETWEEN ${lo} AND ${hi}`;
    }
    default:
      throw new FilterCompilerError(
        'invalid_op',
        `unknown filter op: ${(node as { op: string }).op}`,
      );
  }
}

function compileNode(
  node: FilterNode,
  source: ReportDataSource,
  bag: ParamBag,
): string {
  if (!node || typeof node !== 'object') {
    throw new FilterCompilerError('invalid_input', 'filter node must be an object');
  }
  switch (node.op) {
    case 'AND':
    case 'OR': {
      if (!Array.isArray(node.children) || node.children.length === 0) {
        throw new FilterCompilerError(
          'invalid_input',
          `${node.op} requires non-empty children[]`,
        );
      }
      if (node.children.length > 20) {
        throw new FilterCompilerError(
          'invalid_input',
          `${node.op} has > 20 children (limit to keep query plans tractable)`,
        );
      }
      const parts = node.children.map((c) => compileNode(c, source, bag));
      return `(${parts.join(node.op === 'AND' ? ' AND ' : ' OR ')})`;
    }
    case 'NOT': {
      const inner = compileNode(node.child, source, bag);
      return `(NOT ${inner})`;
    }
    default:
      return compileLeaf(node, source, bag);
  }
}

// ─── Validation helpers ────────────────────────────────────────────────

function validateMetric(metric: ReportMetric, source: ReportDataSource): void {
  const field = getReportField(source.source_id, metric.field);
  if (!field) {
    throw new FilterCompilerError(
      'unknown_field',
      `metric field '${metric.field}' not on source ${source.source_id}`,
    );
  }
  // COUNT works on any field; DISTINCT_COUNT same. SUM/AVG/MIN/MAX require
  // aggregatable (numeric in this catalog).
  if (metric.agg === 'SUM' || metric.agg === 'AVG') {
    if (!NUMERIC_TYPES.includes(field.type) || !field.aggregatable) {
      throw new FilterCompilerError(
        'invalid_agg',
        `${metric.agg} requires numeric aggregatable field; ${field.name} is ${field.type}`,
      );
    }
  }
  if (metric.agg === 'MIN' || metric.agg === 'MAX') {
    if (!COMPARABLE_TYPES.includes(field.type) && field.type !== 'enum' && field.type !== 'string') {
      throw new FilterCompilerError(
        'invalid_agg',
        `${metric.agg} not valid on field ${field.name} (type ${field.type})`,
      );
    }
  }
}

function validateGroupByField(field_name: string, source: ReportDataSource): void {
  const field = getReportField(source.source_id, field_name);
  if (!field) {
    throw new FilterCompilerError(
      'unknown_field',
      `group_by field '${field_name}' not on source ${source.source_id}`,
    );
  }
  if (!field.groupable) {
    throw new FilterCompilerError(
      'invalid_input',
      `field ${field_name} is not groupable`,
    );
  }
}

function metricExpr(m: ReportMetric): string {
  const alias = m.alias ?? `${m.agg.toLowerCase()}_${m.field}`;
  if (m.agg === 'DISTINCT_COUNT') {
    return `COUNT(DISTINCT ${m.field}) AS ${alias}`;
  }
  if (m.agg === 'COUNT') {
    return `COUNT(${m.field}) AS ${alias}`;
  }
  return `${m.agg}(${m.field}) AS ${alias}`;
}

// ─── Pure compiler entrypoint ─────────────────────────────────────────

export interface CompileOptions {
  tenant_id: string;
}

export function compileReportDefinition(
  def: ReportDefinition,
  opts: CompileOptions,
): CompiledQuery {
  if (!def || typeof def !== 'object') {
    throw new FilterCompilerError('invalid_input', 'definition required');
  }
  if (typeof def.source_id !== 'string' || !def.source_id) {
    throw new FilterCompilerError('invalid_input', 'source_id required');
  }
  if (typeof opts.tenant_id !== 'string' || !opts.tenant_id) {
    throw new FilterCompilerError('invalid_input', 'tenant_id required');
  }

  const source = requireReportSource(def.source_id);

  // Limit clamp.
  let limit = def.limit ?? DEFAULT_LIMIT;
  if (typeof limit !== 'number' || !Number.isFinite(limit) || !Number.isInteger(limit)) {
    throw new FilterCompilerError('invalid_input', 'limit must be an integer');
  }
  limit = Math.max(1, Math.min(MAX_LIMIT, limit));

  // Validate group_by + metrics.
  const group_by = def.group_by ?? [];
  for (const f of group_by) validateGroupByField(f, source);
  const metrics = def.metrics ?? [];
  for (const m of metrics) validateMetric(m, source);

  const is_aggregate = group_by.length > 0 || metrics.length > 0;

  // Projection.
  let projection: string[];
  if (is_aggregate) {
    if (metrics.length === 0) {
      throw new FilterCompilerError(
        'invalid_input',
        'aggregate report requires at least one metric',
      );
    }
    const metricAliases = metrics.map((m) => m.alias ?? `${m.agg.toLowerCase()}_${m.field}`);
    projection = [...group_by, ...metricAliases];
  } else {
    // Raw row list — project every catalog field by default.
    projection = source.fields.map((f) => f.name);
  }

  // SELECT clause.
  let selectClause: string;
  if (is_aggregate) {
    const groupCols = group_by.join(', ');
    const metricCols = metrics.map(metricExpr).join(', ');
    selectClause = group_by.length > 0
      ? `SELECT ${groupCols}${metricCols ? ', ' + metricCols : ''}`
      : `SELECT ${metricCols}`;
  } else {
    selectClause = `SELECT ${projection.join(', ')}`;
  }

  const fromClause = `FROM ${source.schema}.${source.table}`;

  // WHERE clause — auto-inject tenant_id for tenant-scoped sources.
  const bag: ParamBag = { values: {}, count: 0 };
  const whereParts: string[] = [];
  if (source.tenant_scoped) {
    bag.values.tenant_id = opts.tenant_id;
    whereParts.push('tenant_id = :tenant_id');
  }
  if (def.filters) {
    const userFilter = compileNode(def.filters, source, bag);
    whereParts.push(userFilter);
  }
  const whereClause = whereParts.length > 0 ? `WHERE ${whereParts.join(' AND ')}` : '';

  // GROUP BY.
  const groupByClause = group_by.length > 0 ? `GROUP BY ${group_by.join(', ')}` : '';

  // ORDER BY.
  const sort = def.sort ?? [];
  for (const s of sort) {
    if (s.direction !== 'ASC' && s.direction !== 'DESC') {
      throw new FilterCompilerError('invalid_input', `sort.direction must be ASC|DESC, got ${s.direction}`);
    }
    // sort.field must be either in projection (aggregate) or in source fields.
    if (is_aggregate) {
      if (!projection.includes(s.field)) {
        throw new FilterCompilerError(
          'unknown_field',
          `sort field '${s.field}' must be in group_by or be a metric alias`,
        );
      }
    } else {
      if (!getReportField(source.source_id, s.field)) {
        throw new FilterCompilerError(
          'unknown_field',
          `sort field '${s.field}' not on source ${source.source_id}`,
        );
      }
    }
  }
  const orderByClause = sort.length > 0
    ? `ORDER BY ${sort.map((s) => `${s.field} ${s.direction}`).join(', ')}`
    : '';

  // Param for LIMIT.
  bag.values.limit = limit;

  const sql = [
    selectClause,
    fromClause,
    whereClause,
    groupByClause,
    orderByClause,
    `LIMIT :limit`,
  ]
    .filter((s) => s.length > 0)
    .join('\n');

  assertSafeSql(sql);

  return {
    sql,
    params: bag.values,
    source,
    projection,
    param_count: bag.count + 1, // +1 for the limit parameter
    is_aggregate,
  };
}
