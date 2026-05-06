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
