// services/bff/src/ews_rules.ts
//
// EWS rules engine — type definitions + validator (EWS-1).
//
// Adopts the brief's flat shape verbatim:
//   {
//     "rule_id": "RULE_CREDIT_001",
//     "name": "...",
//     "category": "credit",
//     "conditions": [{field, operator, value}, ...],
//     "logic": "AND",
//     "action": {alert_severity, weight, ...},
//     "is_active": true
//   }
//
// Flat now keeps authoring simple (matches the brief example exactly).
// Nested AND/OR groups can be added later as a v2 condition type
// without breaking the v1 flat shape.
//
// This module ONLY exposes types + the pure validator. The store +
// executor + routes land in EWS-2 / EWS-3.

import { randomUUID } from 'node:crypto';
import {
  EWS_INDICATOR_CATALOG,
  type EwsIndicator,
  type EwsIndicatorType,
} from './ews_indicators';

// ─── Severity vocabulary (BIL alert classification) ───────────────────

export const ALERT_SEVERITIES = ['RED', 'ORANGE', 'YELLOW', 'GREEN'] as const;
export type AlertSeverity = (typeof ALERT_SEVERITIES)[number];

export function isAlertSeverity(s: unknown): s is AlertSeverity {
  return typeof s === 'string' && (ALERT_SEVERITIES as readonly string[]).includes(s);
}

// Severity → priority weight when aggregating cumulative scores.
// Cumulative score is a sum of matched-rule `action.weight`s, capped
// at 100. The aggregate severity is then derived from the sum:
//   ≥75 → RED, ≥50 → ORANGE, ≥25 → YELLOW, else GREEN.
export const AGGREGATE_SEVERITY_THRESHOLDS = {
  RED: 75,
  ORANGE: 50,
  YELLOW: 25,
} as const;

// ─── Category enum ────────────────────────────────────────────────────

export const EWS_RULE_CATEGORIES = [
  'credit',
  'lapse',
  'fraud',
  'kyc',
  'transaction',
  'agent',
  'ops',
  'concentration',
  'behaviour',
  'score',
] as const;
export type EwsRuleCategory = (typeof EWS_RULE_CATEGORIES)[number];

export function isEwsRuleCategory(s: unknown): s is EwsRuleCategory {
  return typeof s === 'string' && (EWS_RULE_CATEGORIES as readonly string[]).includes(s);
}

// ─── Lifecycle states (4-state per RFC sign-off) ──────────────────────

export const EWS_RULE_STATES = ['draft', 'pending_review', 'active', 'deprecated'] as const;
export type EwsRuleState = (typeof EWS_RULE_STATES)[number];

export function isEwsRuleState(s: unknown): s is EwsRuleState {
  return typeof s === 'string' && (EWS_RULE_STATES as readonly string[]).includes(s);
}

// ─── Condition + logic ───────────────────────────────────────────────

export const EWS_OPERATORS = ['>', '>=', '<', '<=', '==', '!=', 'in', 'not_in', 'between'] as const;
export type EwsOperator = (typeof EWS_OPERATORS)[number];

export function isEwsOperator(s: unknown): s is EwsOperator {
  return typeof s === 'string' && (EWS_OPERATORS as readonly string[]).includes(s);
}

export interface EwsCondition {
  /** Indicator name (must exist in EWS_INDICATOR_CATALOG). */
  field: string;
  operator: EwsOperator;
  /** Scalar for `> >= < <= == !=`; required-array for `in / not_in`;
   *  ignored for `between` (uses `range`). */
  value?: number | string | (number | string)[];
  /** [min, max] inclusive — required when operator='between'. */
  range?: [number, number];
}

export type EwsLogic = 'AND' | 'OR';

// ─── Rule action ──────────────────────────────────────────────────────

export interface EwsRuleAction {
  alert_severity: AlertSeverity;
  /** Score impact when the rule matches; 1-100. */
  weight: number;
  /** Human-readable suggested follow-up (≤ 280 chars, mirrors
   *  regulatory-svc DSL alertSpec.recommended_action). */
  recommended_action?: string;
}

// ─── Rule envelope ────────────────────────────────────────────────────

export interface EwsRuleInput {
  rule_id: string;
  name: string;
  category: EwsRuleCategory;
  description: string;
  conditions: EwsCondition[];
  logic: EwsLogic;
  action: EwsRuleAction;
  is_active?: boolean;
  /** Free-form tags. */
  tags?: string[];
}

export interface EwsRule {
  rule_id: string;
  tenant_id: string;
  name: string;
  category: EwsRuleCategory;
  description: string;
  conditions: EwsCondition[];
  logic: EwsLogic;
  action: EwsRuleAction;
  is_active: boolean;
  state: EwsRuleState;
  version: number;
  tags: string[];
  created_by: string;
  created_at: string;
  updated_at: string;
  deprecated_at: string | null;
}

// ─── Errors ───────────────────────────────────────────────────────────

export class EwsRuleError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'EwsRuleError';
  }
}

// ─── Validation ───────────────────────────────────────────────────────

const RULE_ID_RE = /^RULE_[A-Z][A-Z0-9_]{2,30}$/;
const NAME_CAP = 80;
const DESCRIPTION_CAP = 500;
const MAX_CONDITIONS = 12;
const MAX_TAGS = 10;
const TAG_CAP = 32;

const NUMERIC_TYPES: ReadonlySet<EwsIndicatorType> = new Set([
  'count',
  'percent',
  'ratio',
  'days',
  'amount',
  'flag',
]);

function checkScalarValueAgainstIndicator(
  field: string,
  ind: EwsIndicator,
  value: unknown,
): number | string {
  if (NUMERIC_TYPES.has(ind.type)) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new EwsRuleError(
        'invalid_input',
        `condition for ${field} expects a finite number (indicator type=${ind.type})`,
      );
    }
    if (ind.range && (value < ind.range.min || value > ind.range.max)) {
      throw new EwsRuleError(
        'invalid_input',
        `condition value ${value} for ${field} outside indicator range [${ind.range.min}, ${ind.range.max}]`,
      );
    }
    return value;
  }
  // enum
  if (typeof value !== 'string' || !value.trim()) {
    throw new EwsRuleError(
      'invalid_input',
      `condition for ${field} expects a string (indicator type=enum)`,
    );
  }
  if (ind.enum_values && !ind.enum_values.includes(value)) {
    throw new EwsRuleError(
      'invalid_input',
      `condition value '${value}' for ${field} not in enum [${ind.enum_values.join(', ')}]`,
    );
  }
  return value;
}

function validateCondition(c: unknown, idx: number): EwsCondition {
  if (!c || typeof c !== 'object') {
    throw new EwsRuleError('invalid_input', `conditions[${idx}] must be an object`);
  }
  const o = c as Record<string, unknown>;
  if (typeof o.field !== 'string' || !o.field.trim()) {
    throw new EwsRuleError('invalid_input', `conditions[${idx}].field required`);
  }
  const ind = EWS_INDICATOR_CATALOG[o.field];
  if (!ind) {
    throw new EwsRuleError(
      'unknown_indicator',
      `conditions[${idx}].field '${o.field}' not in EWS indicator catalog`,
    );
  }
  if (!isEwsOperator(o.operator)) {
    throw new EwsRuleError(
      'invalid_input',
      `conditions[${idx}].operator must be one of ${EWS_OPERATORS.join(', ')}`,
    );
  }
  const op = o.operator;

  // Operator/type compatibility checks.
  if (ind.type === 'enum' && op !== '==' && op !== '!=' && op !== 'in' && op !== 'not_in') {
    throw new EwsRuleError(
      'invalid_input',
      `conditions[${idx}] enum indicator ${o.field} only supports ==, !=, in, not_in`,
    );
  }

  if (op === 'between') {
    if (!Array.isArray(o.range) || o.range.length !== 2) {
      throw new EwsRuleError(
        'invalid_input',
        `conditions[${idx}] operator='between' requires range=[min, max]`,
      );
    }
    const [lo, hi] = o.range;
    if (typeof lo !== 'number' || typeof hi !== 'number' || lo > hi) {
      throw new EwsRuleError(
        'invalid_input',
        `conditions[${idx}].range must be [number, number] with min ≤ max`,
      );
    }
    if (ind.range) {
      if (lo < ind.range.min || hi > ind.range.max) {
        throw new EwsRuleError(
          'invalid_input',
          `conditions[${idx}].range [${lo}, ${hi}] outside indicator range [${ind.range.min}, ${ind.range.max}]`,
        );
      }
    }
    return { field: o.field, operator: op, range: [lo, hi] };
  }

  if (op === 'in' || op === 'not_in') {
    if (!Array.isArray(o.value) || o.value.length === 0) {
      throw new EwsRuleError(
        'invalid_input',
        `conditions[${idx}] operator='${op}' requires value=non-empty array`,
      );
    }
    const checked: (number | string)[] = [];
    for (const v of o.value) {
      checked.push(checkScalarValueAgainstIndicator(o.field, ind, v));
    }
    return { field: o.field, operator: op, value: checked };
  }

  // Scalar comparators (>, >=, <, <=, ==, !=)
  if (o.value === undefined) {
    throw new EwsRuleError(
      'invalid_input',
      `conditions[${idx}] operator='${op}' requires a value`,
    );
  }
  const value = checkScalarValueAgainstIndicator(o.field, ind, o.value);
  return { field: o.field, operator: op, value };
}

function validateAction(a: unknown): EwsRuleAction {
  if (!a || typeof a !== 'object') {
    throw new EwsRuleError('invalid_input', 'action required');
  }
  const o = a as Record<string, unknown>;
  if (!isAlertSeverity(o.alert_severity)) {
    throw new EwsRuleError(
      'invalid_input',
      `action.alert_severity must be one of ${ALERT_SEVERITIES.join(', ')}`,
    );
  }
  if (
    typeof o.weight !== 'number' ||
    !Number.isFinite(o.weight) ||
    !Number.isInteger(o.weight) ||
    o.weight < 1 ||
    o.weight > 100
  ) {
    throw new EwsRuleError('invalid_input', 'action.weight must be an integer in [1, 100]');
  }
  let recommended_action: string | undefined;
  if (o.recommended_action !== undefined && o.recommended_action !== null) {
    if (typeof o.recommended_action !== 'string') {
      throw new EwsRuleError('invalid_input', 'action.recommended_action must be a string');
    }
    if (o.recommended_action.length > 280) {
      throw new EwsRuleError(
        'invalid_input',
        'action.recommended_action ≤ 280 chars',
      );
    }
    recommended_action = o.recommended_action.trim();
  }
  return {
    alert_severity: o.alert_severity,
    weight: o.weight,
    ...(recommended_action !== undefined ? { recommended_action } : {}),
  };
}

/**
 * Pure-function validator. Throws EwsRuleError with one of:
 *   invalid_input  — generic shape problem
 *   unknown_indicator — condition.field not in catalog
 *
 * Returns a normalized EwsRuleInput safe to pass to the store.
 */
export function validateEwsRule(input: unknown): EwsRuleInput {
  if (!input || typeof input !== 'object') {
    throw new EwsRuleError('invalid_input', 'request body required');
  }
  const i = input as Record<string, unknown>;
  if (typeof i.rule_id !== 'string' || !RULE_ID_RE.test(i.rule_id)) {
    throw new EwsRuleError(
      'invalid_input',
      `rule_id must match ${RULE_ID_RE} (e.g. RULE_CREDIT_001)`,
    );
  }
  if (typeof i.name !== 'string' || !i.name.trim()) {
    throw new EwsRuleError('invalid_input', 'name is required');
  }
  if (i.name.length > NAME_CAP) {
    throw new EwsRuleError('invalid_input', `name ≤ ${NAME_CAP} chars`);
  }
  if (!isEwsRuleCategory(i.category)) {
    throw new EwsRuleError(
      'invalid_input',
      `category must be one of ${EWS_RULE_CATEGORIES.join(', ')}`,
    );
  }
  if (typeof i.description !== 'string' || !i.description.trim()) {
    throw new EwsRuleError('invalid_input', 'description is required');
  }
  if (i.description.length > DESCRIPTION_CAP) {
    throw new EwsRuleError(
      'invalid_input',
      `description ≤ ${DESCRIPTION_CAP} chars`,
    );
  }
  if (!Array.isArray(i.conditions) || i.conditions.length === 0) {
    throw new EwsRuleError('invalid_input', 'conditions[] must be non-empty');
  }
  if (i.conditions.length > MAX_CONDITIONS) {
    throw new EwsRuleError(
      'invalid_input',
      `at most ${MAX_CONDITIONS} conditions per rule`,
    );
  }
  const conditions = i.conditions.map((c, idx) => validateCondition(c, idx));

  if (i.logic !== 'AND' && i.logic !== 'OR') {
    throw new EwsRuleError('invalid_input', "logic must be 'AND' or 'OR'");
  }

  const action = validateAction(i.action);

  if (i.is_active !== undefined && typeof i.is_active !== 'boolean') {
    throw new EwsRuleError('invalid_input', 'is_active must be a boolean');
  }
  let tags: string[] = [];
  if (i.tags !== undefined) {
    if (!Array.isArray(i.tags)) {
      throw new EwsRuleError('invalid_input', 'tags must be an array');
    }
    if (i.tags.length > MAX_TAGS) {
      throw new EwsRuleError('invalid_input', `at most ${MAX_TAGS} tags`);
    }
    for (const t of i.tags) {
      if (typeof t !== 'string' || !t.trim()) {
        throw new EwsRuleError('invalid_input', 'each tag must be a non-empty string');
      }
      if (t.length > TAG_CAP) {
        throw new EwsRuleError('invalid_input', `each tag ≤ ${TAG_CAP} chars`);
      }
    }
    tags = i.tags.map((t) => (t as string).trim());
  }

  return {
    rule_id: i.rule_id.trim(),
    name: i.name.trim(),
    category: i.category,
    description: i.description.trim(),
    conditions,
    logic: i.logic,
    action,
    is_active: i.is_active,
    tags,
  };
}

// ─── State machine ────────────────────────────────────────────────────

const ALLOWED_TRANSITIONS: Record<EwsRuleState, EwsRuleState[]> = {
  draft: ['pending_review', 'deprecated'],
  pending_review: ['active', 'draft', 'deprecated'],
  active: ['deprecated'],
  deprecated: [], // terminal
};

export function isLegalTransition(from: EwsRuleState, to: EwsRuleState): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

// ─── Per-execution telemetry record ──────────────────────────────────

export interface EwsRuleExecution {
  execution_id: string;
  /** Per-tenant monotonic counter for stable cursor semantics. */
  sequence_no: number;
  rule_id: string;
  tenant_id: string;
  entity_type: 'customer' | 'policy' | 'claim';
  entity_id: string;
  matched: boolean;
  matched_indicators: string[];
  score_impact: number;
  alert_id: string | null;
  evaluated_at: string;
  duration_us: number;
}

// ─── Store ────────────────────────────────────────────────────────────

const RULES_CAP_PER_TENANT = 2000;
const EXECUTIONS_CAP_PER_TENANT = 5000;

export interface EwsRuleStore {
  list(
    tenant_id: string,
    filters?: {
      category?: EwsRuleCategory;
      state?: EwsRuleState;
      is_active?: boolean;
    },
  ): EwsRule[];
  get(tenant_id: string, rule_id: string): EwsRule | null;
  create(
    tenant_id: string,
    input: unknown,
    created_by: string,
    now: Date,
  ): EwsRule;
  /** Replace mutable fields. The rule must NOT be `deprecated`. Bumps version. */
  replace(
    tenant_id: string,
    rule_id: string,
    input: unknown,
    updated_by: string,
    now: Date,
  ): EwsRule;
  /** Promote draft → pending_review. */
  submit(tenant_id: string, rule_id: string, now: Date): EwsRule;
  /** Activate pending_review → active. Sets is_active=true. */
  activate(tenant_id: string, rule_id: string, now: Date): EwsRule;
  /** Soft-delete: any non-deprecated state → deprecated. Sets is_active=false. */
  deprecate(tenant_id: string, rule_id: string, now: Date): EwsRule;

  /** Record a per-rule execution telemetry row. */
  recordExecution(
    tenant_id: string,
    input: Omit<EwsRuleExecution, 'execution_id' | 'sequence_no' | 'tenant_id'>,
  ): EwsRuleExecution;
  /** List executions for a single rule, newest-first. */
  listExecutionsForRule(
    tenant_id: string,
    rule_id: string,
    limit: number,
  ): EwsRuleExecution[];
}

function cloneRule(r: EwsRule): EwsRule {
  return {
    ...r,
    conditions: r.conditions.map((c) => ({
      ...c,
      ...(Array.isArray(c.value) ? { value: [...c.value] } : {}),
      ...(c.range ? { range: [c.range[0], c.range[1]] as [number, number] } : {}),
    })),
    action: { ...r.action },
    tags: [...r.tags],
  };
}

export class InMemoryEwsRuleStore implements EwsRuleStore {
  /** tenant_id → rule_id → rule. */
  private readonly rulesByTenant = new Map<string, Map<string, EwsRule>>();
  /** tenant_id → executions[] (newest at end). */
  private readonly executionsByTenant = new Map<string, EwsRuleExecution[]>();
  private readonly executionSeqByTenant = new Map<string, number>();

  private rulesBucket(tenant_id: string): Map<string, EwsRule> {
    let m = this.rulesByTenant.get(tenant_id);
    if (!m) {
      m = new Map();
      this.rulesByTenant.set(tenant_id, m);
    }
    return m;
  }

  private execBucket(tenant_id: string): EwsRuleExecution[] {
    let arr = this.executionsByTenant.get(tenant_id);
    if (!arr) {
      arr = [];
      this.executionsByTenant.set(tenant_id, arr);
    }
    return arr;
  }

  list(
    tenant_id: string,
    filters: {
      category?: EwsRuleCategory;
      state?: EwsRuleState;
      is_active?: boolean;
    } = {},
  ): EwsRule[] {
    const bucket = this.rulesByTenant.get(tenant_id);
    if (!bucket) return [];
    return [...bucket.values()]
      .filter((r) => !filters.category || r.category === filters.category)
      .filter((r) => !filters.state || r.state === filters.state)
      .filter((r) => filters.is_active === undefined || r.is_active === filters.is_active)
      .sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1))
      .map(cloneRule);
  }

  get(tenant_id: string, rule_id: string): EwsRule | null {
    const r = this.rulesByTenant.get(tenant_id)?.get(rule_id);
    return r ? cloneRule(r) : null;
  }

  create(
    tenant_id: string,
    input: unknown,
    created_by: string,
    now: Date,
  ): EwsRule {
    if (!created_by || !created_by.trim()) {
      throw new EwsRuleError('invalid_input', 'created_by required');
    }
    const valid = validateEwsRule(input);
    const bucket = this.rulesBucket(tenant_id);
    if (bucket.has(valid.rule_id)) {
      throw new EwsRuleError(
        'duplicate_rule_id',
        `rule_id ${valid.rule_id} already exists in tenant ${tenant_id}`,
      );
    }
    if (bucket.size >= RULES_CAP_PER_TENANT) {
      throw new EwsRuleError(
        'cap_reached',
        `tenant ${tenant_id} already has ${RULES_CAP_PER_TENANT} rules`,
      );
    }
    const rule: EwsRule = {
      rule_id: valid.rule_id,
      tenant_id,
      name: valid.name,
      category: valid.category,
      description: valid.description,
      conditions: valid.conditions,
      logic: valid.logic,
      action: valid.action,
      is_active: false, // newly-created rules are NOT active until activated
      state: 'draft',
      version: 1,
      tags: valid.tags ?? [],
      created_by: created_by.trim(),
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
      deprecated_at: null,
    };
    bucket.set(rule.rule_id, rule);
    return cloneRule(rule);
  }

  replace(
    tenant_id: string,
    rule_id: string,
    input: unknown,
    updated_by: string,
    now: Date,
  ): EwsRule {
    if (!updated_by || !updated_by.trim()) {
      throw new EwsRuleError('invalid_input', 'updated_by required');
    }
    const bucket = this.rulesBucket(tenant_id);
    const cur = bucket.get(rule_id);
    if (!cur) {
      throw new EwsRuleError('unknown_rule', `rule ${rule_id} not found`);
    }
    if (cur.state === 'deprecated') {
      throw new EwsRuleError(
        'illegal_state',
        `rule ${rule_id} is deprecated and cannot be edited`,
      );
    }
    const inputObj = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
    const valid = validateEwsRule({ ...inputObj, rule_id: cur.rule_id });
    const next: EwsRule = {
      ...cur,
      name: valid.name,
      category: valid.category,
      description: valid.description,
      conditions: valid.conditions,
      logic: valid.logic,
      action: valid.action,
      tags: valid.tags ?? cur.tags,
      version: cur.version + 1,
      updated_at: now.toISOString(),
    };
    bucket.set(rule_id, next);
    return cloneRule(next);
  }

  private transition(
    tenant_id: string,
    rule_id: string,
    target: EwsRuleState,
    now: Date,
  ): EwsRule {
    const bucket = this.rulesBucket(tenant_id);
    const cur = bucket.get(rule_id);
    if (!cur) {
      throw new EwsRuleError('unknown_rule', `rule ${rule_id} not found`);
    }
    if (!isLegalTransition(cur.state, target)) {
      throw new EwsRuleError(
        'illegal_transition',
        `cannot transition rule from ${cur.state} → ${target}`,
      );
    }
    const next: EwsRule = {
      ...cur,
      state: target,
      is_active: target === 'active',
      deprecated_at: target === 'deprecated' ? now.toISOString() : cur.deprecated_at,
      updated_at: now.toISOString(),
    };
    bucket.set(rule_id, next);
    return cloneRule(next);
  }

  submit(tenant_id: string, rule_id: string, now: Date): EwsRule {
    return this.transition(tenant_id, rule_id, 'pending_review', now);
  }

  activate(tenant_id: string, rule_id: string, now: Date): EwsRule {
    return this.transition(tenant_id, rule_id, 'active', now);
  }

  deprecate(tenant_id: string, rule_id: string, now: Date): EwsRule {
    return this.transition(tenant_id, rule_id, 'deprecated', now);
  }

  // ── Executions ──────────────────────────────────────────────────────

  recordExecution(
    tenant_id: string,
    input: Omit<EwsRuleExecution, 'execution_id' | 'sequence_no' | 'tenant_id'>,
  ): EwsRuleExecution {
    const arr = this.execBucket(tenant_id);
    const nextSeq = (this.executionSeqByTenant.get(tenant_id) ?? 0) + 1;
    this.executionSeqByTenant.set(tenant_id, nextSeq);
    const exec: EwsRuleExecution = {
      execution_id: `exe-${randomUUID()}`,
      sequence_no: nextSeq,
      tenant_id,
      ...input,
      matched_indicators: [...input.matched_indicators],
    };
    arr.push(exec);
    if (arr.length > EXECUTIONS_CAP_PER_TENANT) {
      arr.splice(0, arr.length - EXECUTIONS_CAP_PER_TENANT);
    }
    return { ...exec, matched_indicators: [...exec.matched_indicators] };
  }

  listExecutionsForRule(
    tenant_id: string,
    rule_id: string,
    limit: number,
  ): EwsRuleExecution[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
      throw new EwsRuleError('invalid_input', 'limit must be 1..1000');
    }
    const arr = this.executionsByTenant.get(tenant_id) ?? [];
    return arr
      .filter((e) => e.rule_id === rule_id)
      .sort((a, b) => b.sequence_no - a.sequence_no)
      .slice(0, limit)
      .map((e) => ({ ...e, matched_indicators: [...e.matched_indicators] }));
  }
}

export const defaultEwsRuleStore: EwsRuleStore = new InMemoryEwsRuleStore();

export {
  RULES_CAP_PER_TENANT as EWS_RULES_CAP_PER_TENANT,
  EXECUTIONS_CAP_PER_TENANT as EWS_EXECUTIONS_CAP_PER_TENANT,
};
