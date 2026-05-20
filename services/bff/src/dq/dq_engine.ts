// services/bff/src/dq/dq_engine.ts
//
// PHASE A.3 — Data Quality (DQ) Engine module (PDF §6 Ecosystem item E5).
//
// Operator-visible runtime for declarative data-quality rules. dbt
// already runs schema-shaped tests at build time; THIS is the runtime
// surface that:
//   - lets admins create + manage tenant-scoped DQ rules
//   - records every execution + per-rule pass/fail counts
//   - surfaces a dashboard view + per-execution drill-down
//   - records exceptions (sample-record-id + reason) when a rule fails
//
// Architecture (per execution rules):
//   - Additive only — independent of M3.x ingestion + M4.x indicator
//     compute. Consumers opt-in by calling DqExecutor.run().
//   - Pure in-memory store first; pg-backed swap deferred.
//   - Audit fields baked in; soft-delete + Recovery Center adapter.
//   - RBAC: audit:read (admin-only — DQ failures are compliance-sensitive).
//   - Six rule kinds: not_null / unique / range / regex / enum / freshness.

/** Canonical rule kinds — closed enum so SPA filter chips stable. */
export const ALL_DQ_RULE_KINDS = [
  'not_null',
  'unique',
  'range',
  'regex',
  'enum',
  'freshness',
] as const;
export type DqRuleKind = (typeof ALL_DQ_RULE_KINDS)[number];

export function isDqRuleKind(v: unknown): v is DqRuleKind {
  return typeof v === 'string' && (ALL_DQ_RULE_KINDS as readonly string[]).includes(v);
}

/** Severity. Closed enum, canonical worst-first. */
export const ALL_DQ_SEVERITIES = ['high', 'medium', 'low'] as const;
export type DqSeverity = (typeof ALL_DQ_SEVERITIES)[number];

export function isDqSeverity(v: unknown): v is DqSeverity {
  return typeof v === 'string' && (ALL_DQ_SEVERITIES as readonly string[]).includes(v);
}

/** Execution status. */
export const ALL_DQ_EXECUTION_STATUSES = ['running', 'passed', 'failed', 'error'] as const;
export type DqExecutionStatus = (typeof ALL_DQ_EXECUTION_STATUSES)[number];

/** Rule definition. config carries kind-specific parameters:
 *   not_null:  { } — no params; column must be non-null.
 *   unique:    { } — no params; column values must be unique.
 *   range:     { min?: number; max?: number } — at least one bound.
 *   regex:     { pattern: string } — column value matches regex.
 *   enum:      { values: string[] } — column value in set.
 *   freshness: { max_age_hours: number } — newest record within window.
 */
export interface DqRuleConfig {
  min?: number;
  max?: number;
  pattern?: string;
  values?: string[];
  max_age_hours?: number;
}

export interface DqRule {
  rule_id: string;
  tenant_id: string;
  name: string;
  description: string | null;
  table_name: string;
  column_name: string;
  kind: DqRuleKind;
  config: DqRuleConfig;
  severity: DqSeverity;
  active: boolean;
  created_at: string;
  created_by: string;
  updated_at: string;
  updated_by: string;
  deleted_at: string | null;
  deleted_by: string | null;
}

export interface DqRuleCreateInput {
  rule_id: string;
  name: string;
  description?: string | null;
  table_name: string;
  column_name: string;
  kind: DqRuleKind;
  config: DqRuleConfig;
  severity?: DqSeverity;
  active?: boolean;
}

export interface DqRuleUpdateInput {
  name?: string;
  description?: string | null;
  table_name?: string;
  column_name?: string;
  kind?: DqRuleKind;
  config?: DqRuleConfig;
  severity?: DqSeverity;
  active?: boolean;
}

/** One execution of one rule against a record set. */
export interface DqExecution {
  execution_id: string;
  tenant_id: string;
  rule_id: string;
  rule_kind: DqRuleKind;
  rule_severity: DqSeverity;
  started_at: string;
  finished_at: string;
  status: DqExecutionStatus;
  total_records: number;
  passed_records: number;
  failed_records: number;
  error_message: string | null;
  /** Cap-50 sample of failing record ids — drill-through hook. */
  sample_failures: Array<{ record_id: string; reason: string }>;
  triggered_by: string;
}

export interface DqExecutionInput {
  rule_id: string;
  records: Array<Record<string, unknown>>;
  /** PK field on each record; defaults to 'id' when absent. */
  id_field?: string;
  triggered_by: string;
}

export class DqError extends Error {
  constructor(
    public readonly code:
      | 'invalid_input'
      | 'invalid_rule_id'
      | 'invalid_name'
      | 'invalid_kind'
      | 'invalid_severity'
      | 'invalid_config'
      | 'invalid_table_or_column'
      | 'unknown_rule'
      | 'duplicate_rule_id'
      | 'cap_reached'
      | 'rule_inactive',
    message: string,
    public readonly detail?: Record<string, unknown>,
  ) {
    super(`${code}: ${message}`);
    this.name = 'DqError';
  }
}

export const DQ_RULE_CAP_PER_TENANT = 500;
export const DQ_EXECUTION_CAP_PER_TENANT = 5000;
export const DQ_SAMPLE_FAILURES_CAP = 50;

const RULE_ID_RE = /^[a-z][a-z0-9_]{2,63}$/;
const IDENT_RE = /^[a-z][a-z0-9_]{0,63}(\.[a-z][a-z0-9_]{0,63})?$/i;

function validateRuleCreate(input: DqRuleCreateInput): void {
  if (!input || typeof input !== 'object') {
    throw new DqError('invalid_input', 'request body must be an object');
  }
  if (typeof input.rule_id !== 'string' || !RULE_ID_RE.test(input.rule_id)) {
    throw new DqError(
      'invalid_rule_id',
      'rule_id must match ^[a-z][a-z0-9_]{2,63}$',
    );
  }
  if (
    typeof input.name !== 'string' ||
    input.name.trim().length === 0 ||
    input.name.length > 200
  ) {
    throw new DqError('invalid_name', 'name must be 1..200 chars after trim');
  }
  if (typeof input.table_name !== 'string' || !IDENT_RE.test(input.table_name)) {
    throw new DqError(
      'invalid_table_or_column',
      'table_name must be a SQL identifier (e.g. mart.customer_360)',
    );
  }
  if (typeof input.column_name !== 'string' || !IDENT_RE.test(input.column_name)) {
    throw new DqError(
      'invalid_table_or_column',
      'column_name must be a SQL identifier',
    );
  }
  if (!isDqRuleKind(input.kind)) {
    throw new DqError('invalid_kind', `kind must be one of: ${ALL_DQ_RULE_KINDS.join(', ')}`);
  }
  if (input.severity !== undefined && !isDqSeverity(input.severity)) {
    throw new DqError('invalid_severity', 'severity invalid');
  }
  validateConfig(input.kind, input.config);
  if (input.description != null) {
    if (typeof input.description !== 'string' || input.description.length > 1000) {
      throw new DqError('invalid_input', 'description must be string ≤ 1000 chars');
    }
  }
}

function validateConfig(kind: DqRuleKind, config: DqRuleConfig | undefined): void {
  if (!config || typeof config !== 'object') {
    throw new DqError('invalid_config', 'config must be an object');
  }
  switch (kind) {
    case 'not_null':
    case 'unique':
      // No required fields.
      break;
    case 'range': {
      const { min, max } = config;
      if (min === undefined && max === undefined) {
        throw new DqError('invalid_config', 'range rule needs min and/or max');
      }
      if (min !== undefined && (typeof min !== 'number' || !Number.isFinite(min))) {
        throw new DqError('invalid_config', 'range.min must be a finite number');
      }
      if (max !== undefined && (typeof max !== 'number' || !Number.isFinite(max))) {
        throw new DqError('invalid_config', 'range.max must be a finite number');
      }
      if (min !== undefined && max !== undefined && min > max) {
        throw new DqError('invalid_config', 'range.min must be ≤ range.max');
      }
      break;
    }
    case 'regex': {
      if (typeof config.pattern !== 'string' || config.pattern.length === 0) {
        throw new DqError('invalid_config', 'regex.pattern must be a non-empty string');
      }
      try {
        new RegExp(config.pattern);
      } catch {
        throw new DqError('invalid_config', `regex.pattern is not a valid RegExp`);
      }
      break;
    }
    case 'enum': {
      if (!Array.isArray(config.values) || config.values.length === 0) {
        throw new DqError('invalid_config', 'enum.values must be a non-empty array');
      }
      if (!config.values.every((v) => typeof v === 'string')) {
        throw new DqError('invalid_config', 'enum.values must be strings');
      }
      break;
    }
    case 'freshness': {
      const h = config.max_age_hours;
      if (typeof h !== 'number' || !Number.isFinite(h) || h <= 0) {
        throw new DqError(
          'invalid_config',
          'freshness.max_age_hours must be a positive finite number',
        );
      }
      break;
    }
  }
}

function validateRuleUpdate(patch: DqRuleUpdateInput, base: DqRule): void {
  if (!patch || typeof patch !== 'object') {
    throw new DqError('invalid_input', 'patch must be an object');
  }
  if (patch.name !== undefined) {
    if (
      typeof patch.name !== 'string' ||
      patch.name.trim().length === 0 ||
      patch.name.length > 200
    ) {
      throw new DqError('invalid_name', 'name 1..200 chars');
    }
  }
  if (patch.table_name !== undefined && !IDENT_RE.test(patch.table_name)) {
    throw new DqError('invalid_table_or_column', 'invalid table_name');
  }
  if (patch.column_name !== undefined && !IDENT_RE.test(patch.column_name)) {
    throw new DqError('invalid_table_or_column', 'invalid column_name');
  }
  if (patch.kind !== undefined && !isDqRuleKind(patch.kind)) {
    throw new DqError('invalid_kind', 'kind invalid');
  }
  if (patch.severity !== undefined && !isDqSeverity(patch.severity)) {
    throw new DqError('invalid_severity', 'severity invalid');
  }
  // When kind changes OR config changes, validate the EFFECTIVE config
  // (patch.config ?? base.config) against the EFFECTIVE kind. This
  // prevents leaving a rule in a corrupt state where kind says "regex"
  // but config carries range-shaped fields.
  if (patch.config !== undefined || patch.kind !== undefined) {
    const effectiveKind = patch.kind ?? base.kind;
    const effectiveConfig = patch.config ?? base.config;
    validateConfig(effectiveKind, effectiveConfig);
  }
  if (patch.description !== undefined && patch.description !== null) {
    if (typeof patch.description !== 'string' || patch.description.length > 1000) {
      throw new DqError('invalid_input', 'description ≤ 1000 chars');
    }
  }
}

// ─── Executor ──────────────────────────────────────────────────────────

/** Pure function: evaluate a rule against a record set. Does not touch
 *  the store. Returns counts + sample failures with capped size. */
export function evaluateRule(
  rule: DqRule,
  records: Array<Record<string, unknown>>,
  id_field: string,
  now: Date,
): {
  total_records: number;
  passed_records: number;
  failed_records: number;
  sample_failures: Array<{ record_id: string; reason: string }>;
} {
  const sample: Array<{ record_id: string; reason: string }> = [];
  let passed = 0;
  let failed = 0;
  const total = records.length;
  const recordId = (r: Record<string, unknown>, idx: number) => {
    const v = r[id_field];
    if (typeof v === 'string' || typeof v === 'number') return String(v);
    return `idx:${idx}`;
  };
  const pushFailure = (record_id: string, reason: string) => {
    if (sample.length < DQ_SAMPLE_FAILURES_CAP) sample.push({ record_id, reason });
    failed++;
  };

  switch (rule.kind) {
    case 'not_null': {
      records.forEach((r, i) => {
        const v = r[rule.column_name];
        if (v === undefined || v === null || (typeof v === 'string' && v.trim() === '')) {
          pushFailure(recordId(r, i), `${rule.column_name} is null/empty`);
        } else {
          passed++;
        }
      });
      break;
    }
    case 'unique': {
      const seen = new Map<unknown, { record_id: string }>();
      records.forEach((r, i) => {
        const v = r[rule.column_name];
        const id = recordId(r, i);
        if (v === undefined || v === null) {
          // null doesn't violate uniqueness in SQL semantics — passes.
          passed++;
          return;
        }
        const prior = seen.get(v);
        if (prior) {
          pushFailure(id, `duplicate ${rule.column_name}=${JSON.stringify(v)} (also on ${prior.record_id})`);
        } else {
          seen.set(v, { record_id: id });
          passed++;
        }
      });
      break;
    }
    case 'range': {
      const { min, max } = rule.config;
      records.forEach((r, i) => {
        const v = r[rule.column_name];
        if (typeof v !== 'number' || !Number.isFinite(v)) {
          pushFailure(recordId(r, i), `${rule.column_name} is not a finite number`);
          return;
        }
        if (min !== undefined && v < min) {
          pushFailure(recordId(r, i), `${rule.column_name}=${v} below min ${min}`);
          return;
        }
        if (max !== undefined && v > max) {
          pushFailure(recordId(r, i), `${rule.column_name}=${v} above max ${max}`);
          return;
        }
        passed++;
      });
      break;
    }
    case 'regex': {
      const re = new RegExp(rule.config.pattern as string);
      records.forEach((r, i) => {
        const v = r[rule.column_name];
        if (typeof v !== 'string' || !re.test(v)) {
          pushFailure(recordId(r, i), `${rule.column_name} fails pattern`);
        } else {
          passed++;
        }
      });
      break;
    }
    case 'enum': {
      const valid = new Set(rule.config.values as string[]);
      records.forEach((r, i) => {
        const v = r[rule.column_name];
        if (typeof v !== 'string' || !valid.has(v)) {
          pushFailure(recordId(r, i), `${rule.column_name}=${JSON.stringify(v)} not in enum`);
        } else {
          passed++;
        }
      });
      break;
    }
    case 'freshness': {
      // Freshness checks the newest record_ts across all records.
      // Records must carry a `record_ts` field (ISO) — otherwise the
      // rule fails the whole batch with a single representative failure.
      const maxAgeMs = (rule.config.max_age_hours as number) * 3_600_000;
      const horizon = now.getTime() - maxAgeMs;
      let newest = -Infinity;
      records.forEach((r) => {
        const ts = r['record_ts'];
        if (typeof ts === 'string') {
          const t = Date.parse(ts);
          if (Number.isFinite(t) && t > newest) newest = t;
        }
      });
      if (newest === -Infinity) {
        pushFailure('aggregate', `no record_ts found across ${total} records`);
      } else if (newest < horizon) {
        const ageHrs = (now.getTime() - newest) / 3_600_000;
        pushFailure(
          'aggregate',
          `newest record is ${ageHrs.toFixed(1)}h old (> ${rule.config.max_age_hours}h)`,
        );
      } else {
        passed = total; // whole batch passes the freshness gate
        return { total_records: total, passed_records: passed, failed_records: 0, sample_failures: [] };
      }
      // When freshness fails, surface aggregate but DON'T mark every
      // record as failed — only one aggregate failure entry is added.
      passed = 0;
      failed = total; // bookkeeping: every record falls behind the gate
      break;
    }
  }
  return { total_records: total, passed_records: passed, failed_records: failed, sample_failures: sample };
}

// ─── Store ─────────────────────────────────────────────────────────────

export interface DqStore {
  // Rules
  listRules(
    tenant_id: string,
    opts?: { include_deleted?: boolean; kind?: DqRuleKind; severity?: DqSeverity },
  ): DqRule[];
  getRule(tenant_id: string, rule_id: string): DqRule | null;
  createRule(
    tenant_id: string,
    input: DqRuleCreateInput,
    actor: string,
    now: Date,
  ): DqRule;
  updateRule(
    tenant_id: string,
    rule_id: string,
    patch: DqRuleUpdateInput,
    actor: string,
    now: Date,
  ): DqRule;
  softDeleteRule(
    tenant_id: string,
    rule_id: string,
    actor: string,
    now: Date,
  ): DqRule;
  restoreRule(payload: DqRule): boolean;
  // Executions
  recordExecution(execution: DqExecution): DqExecution;
  listExecutions(
    tenant_id: string,
    opts?: { rule_id?: string; status?: DqExecutionStatus; limit?: number },
  ): DqExecution[];
  getExecution(tenant_id: string, execution_id: string): DqExecution | null;
}

export class InMemoryDqStore implements DqStore {
  private rules = new Map<string, Map<string, DqRule>>();
  private executions = new Map<string, DqExecution[]>(); // tenant → newest-first array

  private rulesBucket(tenant_id: string) {
    let b = this.rules.get(tenant_id);
    if (!b) {
      b = new Map();
      this.rules.set(tenant_id, b);
    }
    return b;
  }

  private execsBucket(tenant_id: string) {
    let b = this.executions.get(tenant_id);
    if (!b) {
      b = [];
      this.executions.set(tenant_id, b);
    }
    return b;
  }

  listRules(
    tenant_id: string,
    opts: { include_deleted?: boolean; kind?: DqRuleKind; severity?: DqSeverity } = {},
  ): DqRule[] {
    const b = this.rules.get(tenant_id);
    if (!b) return [];
    const out: DqRule[] = [];
    for (const r of b.values()) {
      if (!opts.include_deleted && r.deleted_at) continue;
      if (opts.kind && r.kind !== opts.kind) continue;
      if (opts.severity && r.severity !== opts.severity) continue;
      out.push({ ...r });
    }
    out.sort((a, b) => {
      const n = a.name.localeCompare(b.name);
      return n !== 0 ? n : a.rule_id.localeCompare(b.rule_id);
    });
    return out;
  }

  getRule(tenant_id: string, rule_id: string): DqRule | null {
    const r = this.rules.get(tenant_id)?.get(rule_id);
    if (!r || r.deleted_at) return null;
    return { ...r };
  }

  createRule(
    tenant_id: string,
    input: DqRuleCreateInput,
    actor: string,
    now: Date,
  ): DqRule {
    validateRuleCreate(input);
    if (typeof actor !== 'string' || actor.trim().length === 0) {
      throw new DqError('invalid_input', 'actor required');
    }
    const b = this.rulesBucket(tenant_id);
    const existing = b.get(input.rule_id);
    if (existing && !existing.deleted_at) {
      throw new DqError('duplicate_rule_id', `rule_id ${input.rule_id} already exists`, {
        rule_id: input.rule_id,
      });
    }
    const live = [...b.values()].filter((r) => !r.deleted_at).length;
    if (live >= DQ_RULE_CAP_PER_TENANT) {
      throw new DqError(
        'cap_reached',
        `dq rule cap (${DQ_RULE_CAP_PER_TENANT}) reached`,
      );
    }
    const ts = now.toISOString();
    const rule: DqRule = {
      rule_id: input.rule_id,
      tenant_id,
      name: input.name.trim(),
      description: input.description?.trim() || null,
      table_name: input.table_name,
      column_name: input.column_name,
      kind: input.kind,
      config: { ...input.config },
      severity: input.severity ?? 'medium',
      active: input.active !== undefined ? !!input.active : true,
      created_at: ts,
      created_by: actor,
      updated_at: ts,
      updated_by: actor,
      deleted_at: null,
      deleted_by: null,
    };
    b.set(rule.rule_id, rule);
    return { ...rule };
  }

  updateRule(
    tenant_id: string,
    rule_id: string,
    patch: DqRuleUpdateInput,
    actor: string,
    now: Date,
  ): DqRule {
    const b = this.rulesBucket(tenant_id);
    const r = b.get(rule_id);
    if (!r || r.deleted_at) {
      throw new DqError('unknown_rule', `rule_id ${rule_id} not found`, { rule_id });
    }
    validateRuleUpdate(patch, r);
    if (typeof actor !== 'string' || actor.trim().length === 0) {
      throw new DqError('invalid_input', 'actor required');
    }
    const next: DqRule = { ...r };
    if (patch.name !== undefined) next.name = patch.name.trim();
    if (patch.description !== undefined) {
      next.description = patch.description === null ? null : patch.description.trim() || null;
    }
    if (patch.table_name !== undefined) next.table_name = patch.table_name;
    if (patch.column_name !== undefined) next.column_name = patch.column_name;
    if (patch.kind !== undefined) next.kind = patch.kind;
    if (patch.config !== undefined) next.config = { ...patch.config };
    if (patch.severity !== undefined) next.severity = patch.severity;
    if (patch.active !== undefined) next.active = !!patch.active;
    next.updated_at = now.toISOString();
    next.updated_by = actor;
    b.set(rule_id, next);
    return { ...next };
  }

  softDeleteRule(
    tenant_id: string,
    rule_id: string,
    actor: string,
    now: Date,
  ): DqRule {
    if (typeof actor !== 'string' || actor.trim().length === 0) {
      throw new DqError('invalid_input', 'actor required');
    }
    const b = this.rulesBucket(tenant_id);
    const r = b.get(rule_id);
    if (!r || r.deleted_at) {
      throw new DqError('unknown_rule', `rule_id ${rule_id} not found`, { rule_id });
    }
    const ts = now.toISOString();
    const t: DqRule = { ...r, deleted_at: ts, deleted_by: actor, updated_at: ts, updated_by: actor };
    b.set(rule_id, t);
    return { ...t };
  }

  restoreRule(payload: DqRule): boolean {
    if (!payload || typeof payload !== 'object') return false;
    if (typeof payload.rule_id !== 'string' || typeof payload.tenant_id !== 'string') {
      return false;
    }
    const b = this.rulesBucket(payload.tenant_id);
    const existing = b.get(payload.rule_id);
    if (existing && !existing.deleted_at) return false;
    b.set(payload.rule_id, { ...payload, deleted_at: null, deleted_by: null });
    return true;
  }

  recordExecution(execution: DqExecution): DqExecution {
    const b = this.execsBucket(execution.tenant_id);
    b.unshift({ ...execution });
    // FIFO cap: keep newest DQ_EXECUTION_CAP_PER_TENANT.
    if (b.length > DQ_EXECUTION_CAP_PER_TENANT) {
      b.length = DQ_EXECUTION_CAP_PER_TENANT;
    }
    return { ...execution };
  }

  listExecutions(
    tenant_id: string,
    opts: { rule_id?: string; status?: DqExecutionStatus; limit?: number } = {},
  ): DqExecution[] {
    const b = this.executions.get(tenant_id) ?? [];
    let out: DqExecution[] = [];
    for (const e of b) {
      if (opts.rule_id && e.rule_id !== opts.rule_id) continue;
      if (opts.status && e.status !== opts.status) continue;
      out.push({ ...e });
    }
    const limit = Math.max(1, Math.min(opts.limit ?? 100, 500));
    if (out.length > limit) out = out.slice(0, limit);
    return out;
  }

  getExecution(tenant_id: string, execution_id: string): DqExecution | null {
    const b = this.executions.get(tenant_id);
    if (!b) return null;
    const e = b.find((x) => x.execution_id === execution_id);
    return e ? { ...e } : null;
  }
}

export const defaultDqStore: DqStore = new InMemoryDqStore();

// ─── Run-now helper ────────────────────────────────────────────────────

/** Compose: fetch rule → evaluate → record execution. Returns the
 *  recorded DqExecution. Throws DqError on unknown / inactive rule. */
export function runDqRule(
  store: DqStore,
  tenant_id: string,
  input: DqExecutionInput,
  now: Date,
): DqExecution {
  if (!input || typeof input !== 'object') {
    throw new DqError('invalid_input', 'request body must be an object');
  }
  if (typeof input.rule_id !== 'string' || input.rule_id.length === 0) {
    throw new DqError('invalid_input', 'rule_id required');
  }
  if (!Array.isArray(input.records)) {
    throw new DqError('invalid_input', 'records must be an array');
  }
  if (typeof input.triggered_by !== 'string' || input.triggered_by.trim().length === 0) {
    throw new DqError('invalid_input', 'triggered_by required');
  }
  const rule = store.getRule(tenant_id, input.rule_id);
  if (!rule) {
    throw new DqError('unknown_rule', `rule_id ${input.rule_id} not found`);
  }
  if (!rule.active) {
    throw new DqError('rule_inactive', `rule_id ${input.rule_id} is inactive`);
  }
  const started = now;
  let status: DqExecutionStatus;
  let result: ReturnType<typeof evaluateRule>;
  let errorMessage: string | null = null;
  try {
    result = evaluateRule(rule, input.records, input.id_field ?? 'id', started);
    status = result.failed_records === 0 ? 'passed' : 'failed';
  } catch (e) {
    status = 'error';
    errorMessage = e instanceof Error ? e.message : 'unknown error';
    result = { total_records: input.records.length, passed_records: 0, failed_records: 0, sample_failures: [] };
  }
  const finished = new Date(started.getTime() + 1); // measurable Δt
  const execution: DqExecution = {
    execution_id: `dqe-${started.getTime()}-${Math.random().toString(36).slice(2, 10)}`,
    tenant_id,
    rule_id: rule.rule_id,
    rule_kind: rule.kind,
    rule_severity: rule.severity,
    started_at: started.toISOString(),
    finished_at: finished.toISOString(),
    status,
    total_records: result.total_records,
    passed_records: result.passed_records,
    failed_records: result.failed_records,
    error_message: errorMessage,
    sample_failures: result.sample_failures,
    triggered_by: input.triggered_by,
  };
  return store.recordExecution(execution);
}

// ─── Dashboard rollup ──────────────────────────────────────────────────

export interface DqDashboardRollup {
  tenant_id: string;
  generated_at: string;
  total_rules: number;
  active_rules: number;
  total_executions: number;
  total_passed: number;
  total_failed: number;
  total_error: number;
  by_severity: Record<DqSeverity, { rules: number; failures_24h: number }>;
  by_kind: Record<DqRuleKind, { rules: number; executions: number }>;
  /** Per-rule rollup of latest execution, sorted by worst pass rate. */
  rules_status: Array<{
    rule_id: string;
    name: string;
    kind: DqRuleKind;
    severity: DqSeverity;
    latest_status: DqExecutionStatus | null;
    latest_pass_rate: number | null; // null when no exec
    latest_at: string | null;
    executions_total: number;
    failures_24h: number;
  }>;
}

/** Pure dashboard composer. Snapshot of current rules + execution
 *  history, no I/O. */
export function buildDqDashboard(
  store: DqStore,
  tenant_id: string,
  now: Date,
): DqDashboardRollup {
  const rules = store.listRules(tenant_id);
  const allRules = store.listRules(tenant_id, { include_deleted: false });
  const executions = store.listExecutions(tenant_id, { limit: 500 });
  const twentyFourHoursAgo = now.getTime() - 24 * 3_600_000;

  const total_rules = allRules.length;
  const active_rules = allRules.filter((r) => r.active).length;
  const total_executions = executions.length;
  const total_passed = executions.filter((e) => e.status === 'passed').length;
  const total_failed = executions.filter((e) => e.status === 'failed').length;
  const total_error = executions.filter((e) => e.status === 'error').length;

  const by_severity: Record<DqSeverity, { rules: number; failures_24h: number }> = {
    high: { rules: 0, failures_24h: 0 },
    medium: { rules: 0, failures_24h: 0 },
    low: { rules: 0, failures_24h: 0 },
  };
  for (const r of allRules) by_severity[r.severity].rules++;
  for (const e of executions) {
    if (e.status === 'failed' && Date.parse(e.started_at) >= twentyFourHoursAgo) {
      by_severity[e.rule_severity].failures_24h++;
    }
  }

  const by_kind: Record<DqRuleKind, { rules: number; executions: number }> = {
    not_null: { rules: 0, executions: 0 },
    unique: { rules: 0, executions: 0 },
    range: { rules: 0, executions: 0 },
    regex: { rules: 0, executions: 0 },
    enum: { rules: 0, executions: 0 },
    freshness: { rules: 0, executions: 0 },
  };
  for (const r of allRules) by_kind[r.kind].rules++;
  for (const e of executions) by_kind[e.rule_kind].executions++;

  const latestByRule = new Map<string, DqExecution>();
  const execCountByRule = new Map<string, number>();
  const failures24hByRule = new Map<string, number>();
  for (const e of executions) {
    if (!latestByRule.has(e.rule_id)) latestByRule.set(e.rule_id, e);
    execCountByRule.set(e.rule_id, (execCountByRule.get(e.rule_id) ?? 0) + 1);
    if (e.status === 'failed' && Date.parse(e.started_at) >= twentyFourHoursAgo) {
      failures24hByRule.set(e.rule_id, (failures24hByRule.get(e.rule_id) ?? 0) + 1);
    }
  }

  const rules_status = rules.map((r) => {
    const latest = latestByRule.get(r.rule_id);
    const latest_pass_rate =
      latest && latest.total_records > 0
        ? Number((latest.passed_records / latest.total_records).toFixed(4))
        : latest
          ? 0
          : null;
    return {
      rule_id: r.rule_id,
      name: r.name,
      kind: r.kind,
      severity: r.severity,
      latest_status: latest?.status ?? null,
      latest_pass_rate,
      latest_at: latest?.finished_at ?? null,
      executions_total: execCountByRule.get(r.rule_id) ?? 0,
      failures_24h: failures24hByRule.get(r.rule_id) ?? 0,
    };
  });
  // Worst pass rate first (null pass rate = no exec = sorted last);
  // tie-break by severity (high first) then rule_id.
  const sevOrder: Record<DqSeverity, number> = { high: 0, medium: 1, low: 2 };
  rules_status.sort((a, b) => {
    const ap = a.latest_pass_rate ?? Number.POSITIVE_INFINITY;
    const bp = b.latest_pass_rate ?? Number.POSITIVE_INFINITY;
    if (ap !== bp) return ap - bp;
    const sa = sevOrder[a.severity];
    const sb = sevOrder[b.severity];
    if (sa !== sb) return sa - sb;
    return a.rule_id.localeCompare(b.rule_id);
  });

  return {
    tenant_id,
    generated_at: now.toISOString(),
    total_rules,
    active_rules,
    total_executions,
    total_passed,
    total_failed,
    total_error,
    by_severity,
    by_kind,
    rules_status,
  };
}
