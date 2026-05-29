// services/bff/src/ai_hybrid_rules.ts
//
// T7 AI Rule + ML Hybrid Support — ARCHITECTURE ONLY (per spec).
//
// Lets an analyst DEFINE hybrid rules that combine a deterministic metric
// condition with an AI-score threshold, e.g.:
//   IF DPD > 90 AND AI_SCORE(pd_xgb_v3) > 0.82 THEN CREATE CRITICAL ALERT
//
// This module ships the DEFINITION + STORAGE + a pure dry-run PREVIEW
// (evaluate the conditions against a sample input and report what the rule
// WOULD fire). It deliberately does NOT wire a live orchestration engine —
// no real alert is raised here. The existing M5 rule engine + M7 scoring +
// M8.x alert engine are the production execution path; this is the hybrid
// authoring surface that a future orchestrator would consume.
//
// In-memory; the additive pg swap target is data/schema/044_ai_hybrid_rules.sql.

// ─── closed enums ────────────────────────────────────────────────────────

export type HybridConditionOp = 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'neq';
export const ALL_HYBRID_OPS: HybridConditionOp[] = ['gt', 'gte', 'lt', 'lte', 'eq', 'neq'];

export type HybridLogic = 'AND' | 'OR';
export const ALL_HYBRID_LOGIC: HybridLogic[] = ['AND', 'OR'];

export type HybridAction = 'create_alert' | 'open_case' | 'notify' | 'escalate';
export const ALL_HYBRID_ACTIONS: HybridAction[] = ['create_alert', 'open_case', 'notify', 'escalate'];

export type HybridSeverity = 'critical' | 'high' | 'medium' | 'low';
export const ALL_HYBRID_SEVERITIES: HybridSeverity[] = ['critical', 'high', 'medium', 'low'];

export type HybridDomain = 'banking' | 'insurance';
export const ALL_HYBRID_DOMAINS: HybridDomain[] = ['banking', 'insurance'];

export type HybridStatus = 'draft' | 'active' | 'disabled';
export const ALL_HYBRID_STATUSES: HybridStatus[] = ['draft', 'active', 'disabled'];

export function isHybridOp(v: unknown): v is HybridConditionOp {
  return typeof v === 'string' && (ALL_HYBRID_OPS as string[]).includes(v);
}
export function isHybridLogic(v: unknown): v is HybridLogic {
  return typeof v === 'string' && (ALL_HYBRID_LOGIC as string[]).includes(v);
}
export function isHybridAction(v: unknown): v is HybridAction {
  return typeof v === 'string' && (ALL_HYBRID_ACTIONS as string[]).includes(v);
}
export function isHybridSeverity(v: unknown): v is HybridSeverity {
  return typeof v === 'string' && (ALL_HYBRID_SEVERITIES as string[]).includes(v);
}
export function isHybridDomain(v: unknown): v is HybridDomain {
  return typeof v === 'string' && (ALL_HYBRID_DOMAINS as string[]).includes(v);
}
export function isHybridStatus(v: unknown): v is HybridStatus {
  return typeof v === 'string' && (ALL_HYBRID_STATUSES as string[]).includes(v);
}

// State machine for the config lifecycle (NOT live orchestration).
const STATUS_TRANSITIONS: Record<HybridStatus, HybridStatus[]> = {
  draft: ['active', 'disabled'],
  active: ['disabled'],
  disabled: ['active'],
};
export function canTransitionHybrid(from: HybridStatus, to: HybridStatus): boolean {
  if (from === to) return true;
  return (STATUS_TRANSITIONS[from] ?? []).includes(to);
}

// ─── shapes ──────────────────────────────────────────────────────────────

export interface MetricCondition {
  kind: 'metric';
  field: string; // e.g. 'DPD', 'utilization', 'exposure_kes'
  op: HybridConditionOp;
  value: number;
}
export interface AiScoreCondition {
  kind: 'ai_score';
  model_ref: string; // e.g. 'pd_xgb_v3'
  op: HybridConditionOp;
  threshold: number;
}
export type HybridCondition = MetricCondition | AiScoreCondition;

export interface HybridRule {
  rule_id: string;
  tenant_id: string;
  name: string;
  description: string | null;
  domain: HybridDomain;
  logic: HybridLogic;
  conditions: HybridCondition[];
  action: HybridAction;
  severity: HybridSeverity;
  status: HybridStatus;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface CreateHybridRuleInput {
  name: string;
  description?: string | null;
  domain: HybridDomain;
  logic: HybridLogic;
  conditions: HybridCondition[];
  action: HybridAction;
  severity: HybridSeverity;
  created_by?: string;
}

export interface UpdateHybridRuleInput {
  name?: string;
  description?: string | null;
  logic?: HybridLogic;
  conditions?: HybridCondition[];
  action?: HybridAction;
  severity?: HybridSeverity;
  status?: HybridStatus;
}

export interface HybridRuleFilter {
  domain?: HybridDomain;
  status?: HybridStatus;
}

// ─── dry-run preview ───────────────────────────────────────────────────────

export interface HybridPreviewInput {
  metrics?: Record<string, number>;
  ai_scores?: Record<string, number>;
}
export interface ConditionResult {
  condition: HybridCondition;
  observed: number | null; // null when the input did not supply this field/model
  matched: boolean;
  detail: string;
}
export interface HybridPreviewResult {
  rule_id: string | null;
  name: string;
  logic: HybridLogic;
  condition_results: ConditionResult[];
  matched: boolean;
  /** What the rule WOULD fire if matched — a placeholder, no real alert raised. */
  would_fire: { action: HybridAction; severity: HybridSeverity } | null;
  expression: string; // human-readable, e.g. "DPD > 90 AND ai_score(pd_xgb_v3) > 0.82"
}

function applyOp(a: number, op: HybridConditionOp, b: number): boolean {
  switch (op) {
    case 'gt': return a > b;
    case 'gte': return a >= b;
    case 'lt': return a < b;
    case 'lte': return a <= b;
    case 'eq': return a === b;
    case 'neq': return a !== b;
  }
}
const OP_SYMBOL: Record<HybridConditionOp, string> = { gt: '>', gte: '>=', lt: '<', lte: '<=', eq: '==', neq: '!=' };

function conditionExpression(c: HybridCondition): string {
  return c.kind === 'metric'
    ? `${c.field} ${OP_SYMBOL[c.op]} ${c.value}`
    : `ai_score(${c.model_ref}) ${OP_SYMBOL[c.op]} ${c.threshold}`;
}

export function ruleExpression(logic: HybridLogic, conditions: HybridCondition[], action: HybridAction, severity: HybridSeverity): string {
  const lhs = conditions.map(conditionExpression).join(` ${logic} `);
  return `IF ${lhs} THEN ${action.toUpperCase()} (${severity})`;
}

/** Pure evaluation — NO side effects, NO real alert. Architecture placeholder. */
export function evaluateHybridRule(
  rule: { rule_id?: string | null; name: string; logic: HybridLogic; conditions: HybridCondition[]; action: HybridAction; severity: HybridSeverity },
  input: HybridPreviewInput,
): HybridPreviewResult {
  const metrics = input.metrics ?? {};
  const ai_scores = input.ai_scores ?? {};
  const condition_results: ConditionResult[] = rule.conditions.map((c) => {
    if (c.kind === 'metric') {
      const observed = Object.prototype.hasOwnProperty.call(metrics, c.field) ? metrics[c.field] : null;
      if (observed === null || !Number.isFinite(observed)) {
        return { condition: c, observed: null, matched: false, detail: `metric '${c.field}' not supplied` };
      }
      const matched = applyOp(observed, c.op, c.value);
      return { condition: c, observed, matched, detail: `${c.field}=${observed} ${OP_SYMBOL[c.op]} ${c.value} → ${matched}` };
    }
    const observed = Object.prototype.hasOwnProperty.call(ai_scores, c.model_ref) ? ai_scores[c.model_ref] : null;
    if (observed === null || !Number.isFinite(observed)) {
      return { condition: c, observed: null, matched: false, detail: `ai_score '${c.model_ref}' not supplied` };
    }
    const matched = applyOp(observed, c.op, c.threshold);
    return { condition: c, observed, matched, detail: `ai_score(${c.model_ref})=${observed} ${OP_SYMBOL[c.op]} ${c.threshold} → ${matched}` };
  });
  const matched = rule.logic === 'AND'
    ? condition_results.every((r) => r.matched)
    : condition_results.some((r) => r.matched);
  return {
    rule_id: rule.rule_id ?? null,
    name: rule.name,
    logic: rule.logic,
    condition_results,
    matched,
    would_fire: matched ? { action: rule.action, severity: rule.severity } : null,
    expression: ruleExpression(rule.logic, rule.conditions, rule.action, rule.severity),
  };
}

// ─── errors ──────────────────────────────────────────────────────────────

export type HybridRuleErrorCode = 'invalid_input' | 'invalid_condition' | 'invalid_transition' | 'unknown_rule';
export class HybridRuleError extends Error {
  constructor(public readonly code: HybridRuleErrorCode, message: string) {
    super(message);
    this.name = 'HybridRuleError';
  }
}

export const HYBRID_NAME_MAX = 200;
export const HYBRID_DESC_MAX = 2000;
export const HYBRID_CONDITIONS_MAX = 10;

function validateConditions(conditions: unknown): HybridCondition[] {
  if (!Array.isArray(conditions) || conditions.length === 0) {
    throw new HybridRuleError('invalid_condition', 'at least one condition is required');
  }
  if (conditions.length > HYBRID_CONDITIONS_MAX) {
    throw new HybridRuleError('invalid_condition', `at most ${HYBRID_CONDITIONS_MAX} conditions`);
  }
  return conditions.map((raw) => {
    const c = raw as Record<string, unknown>;
    if (!isHybridOp(c.op)) throw new HybridRuleError('invalid_condition', `bad op ${String(c.op)}`);
    if (c.kind === 'metric') {
      const field = String(c.field ?? '').trim();
      if (!field) throw new HybridRuleError('invalid_condition', 'metric.field required');
      if (typeof c.value !== 'number' || !Number.isFinite(c.value)) throw new HybridRuleError('invalid_condition', 'metric.value must be finite');
      return { kind: 'metric', field, op: c.op, value: c.value };
    }
    if (c.kind === 'ai_score') {
      const model_ref = String(c.model_ref ?? '').trim();
      if (!model_ref) throw new HybridRuleError('invalid_condition', 'ai_score.model_ref required');
      if (typeof c.threshold !== 'number' || !Number.isFinite(c.threshold)) throw new HybridRuleError('invalid_condition', 'ai_score.threshold must be finite');
      return { kind: 'ai_score', model_ref, op: c.op, threshold: c.threshold };
    }
    throw new HybridRuleError('invalid_condition', `unknown condition kind ${String(c.kind)}`);
  });
}

function validateCreate(input: CreateHybridRuleInput): void {
  if (!input || typeof input !== 'object') throw new HybridRuleError('invalid_input', 'body required');
  const name = (input.name ?? '').trim();
  if (!name) throw new HybridRuleError('invalid_input', 'name required');
  if (name.length > HYBRID_NAME_MAX) throw new HybridRuleError('invalid_input', `name exceeds ${HYBRID_NAME_MAX}`);
  if (input.description != null && String(input.description).length > HYBRID_DESC_MAX) throw new HybridRuleError('invalid_input', `description exceeds ${HYBRID_DESC_MAX}`);
  if (!isHybridDomain(input.domain)) throw new HybridRuleError('invalid_input', 'domain must be banking|insurance');
  if (!isHybridLogic(input.logic)) throw new HybridRuleError('invalid_input', 'logic must be AND|OR');
  if (!isHybridAction(input.action)) throw new HybridRuleError('invalid_input', 'action out of enum');
  if (!isHybridSeverity(input.severity)) throw new HybridRuleError('invalid_input', 'severity out of enum');
}

// ─── store ───────────────────────────────────────────────────────────────

export interface AiHybridRuleStore {
  create(tenant_id: string, input: CreateHybridRuleInput, now?: Date): HybridRule;
  list(tenant_id: string, filter?: HybridRuleFilter): HybridRule[];
  get(tenant_id: string, rule_id: string): HybridRule | null;
  update(tenant_id: string, rule_id: string, patch: UpdateHybridRuleInput, now?: Date): HybridRule;
  remove(tenant_id: string, rule_id: string): boolean;
}

export class InMemoryAiHybridRuleStore implements AiHybridRuleStore {
  private readonly byTenant = new Map<string, HybridRule[]>();
  private seq = 0;

  create(tenant_id: string, input: CreateHybridRuleInput, now: Date = new Date()): HybridRule {
    if (!tenant_id) throw new HybridRuleError('invalid_input', 'tenant_id required');
    validateCreate(input);
    const conditions = validateConditions(input.conditions);
    const ts = now.toISOString();
    const row: HybridRule = {
      rule_id: `hyb-${tenant_id}-${ts.slice(0, 10)}-${String(++this.seq).padStart(4, '0')}`,
      tenant_id,
      name: input.name.trim(),
      description: input.description != null ? String(input.description).trim() : null,
      domain: input.domain,
      logic: input.logic,
      conditions,
      action: input.action,
      severity: input.severity,
      status: 'draft',
      created_by: (input.created_by ?? 'analyst').trim() || 'analyst',
      created_at: ts,
      updated_at: ts,
    };
    let arr = this.byTenant.get(tenant_id);
    if (!arr) {
      arr = [];
      this.byTenant.set(tenant_id, arr);
    }
    arr.unshift(row);
    return structuredClone(row);
  }

  list(tenant_id: string, filter: HybridRuleFilter = {}): HybridRule[] {
    let arr = this.byTenant.get(tenant_id) ?? [];
    if (filter.domain) arr = arr.filter((r) => r.domain === filter.domain);
    if (filter.status) arr = arr.filter((r) => r.status === filter.status);
    return arr.map((r) => structuredClone(r));
  }

  private find(tenant_id: string, rule_id: string): HybridRule | undefined {
    return (this.byTenant.get(tenant_id) ?? []).find((r) => r.rule_id === rule_id);
  }

  get(tenant_id: string, rule_id: string): HybridRule | null {
    const r = this.find(tenant_id, rule_id);
    return r ? structuredClone(r) : null;
  }

  update(tenant_id: string, rule_id: string, patch: UpdateHybridRuleInput, now: Date = new Date()): HybridRule {
    const row = this.find(tenant_id, rule_id);
    if (!row) throw new HybridRuleError('unknown_rule', `unknown rule ${rule_id}`);
    if (patch.name !== undefined) {
      const n = String(patch.name).trim();
      if (!n) throw new HybridRuleError('invalid_input', 'name cannot be empty');
      if (n.length > HYBRID_NAME_MAX) throw new HybridRuleError('invalid_input', `name exceeds ${HYBRID_NAME_MAX}`);
      row.name = n;
    }
    if (patch.description !== undefined) {
      if (patch.description != null && String(patch.description).length > HYBRID_DESC_MAX) throw new HybridRuleError('invalid_input', `description exceeds ${HYBRID_DESC_MAX}`);
      row.description = patch.description != null ? String(patch.description).trim() : null;
    }
    if (patch.logic !== undefined) {
      if (!isHybridLogic(patch.logic)) throw new HybridRuleError('invalid_input', 'logic must be AND|OR');
      row.logic = patch.logic;
    }
    if (patch.action !== undefined) {
      if (!isHybridAction(patch.action)) throw new HybridRuleError('invalid_input', 'action out of enum');
      row.action = patch.action;
    }
    if (patch.severity !== undefined) {
      if (!isHybridSeverity(patch.severity)) throw new HybridRuleError('invalid_input', 'severity out of enum');
      row.severity = patch.severity;
    }
    if (patch.conditions !== undefined) {
      row.conditions = validateConditions(patch.conditions);
    }
    if (patch.status !== undefined) {
      if (!isHybridStatus(patch.status)) throw new HybridRuleError('invalid_input', `unknown status ${patch.status}`);
      if (!canTransitionHybrid(row.status, patch.status)) {
        throw new HybridRuleError('invalid_transition', `cannot move ${row.status} → ${patch.status}`);
      }
      row.status = patch.status;
    }
    row.updated_at = now.toISOString();
    return structuredClone(row);
  }

  remove(tenant_id: string, rule_id: string): boolean {
    const arr = this.byTenant.get(tenant_id);
    if (!arr) return false;
    const i = arr.findIndex((r) => r.rule_id === rule_id);
    if (i < 0) return false;
    arr.splice(i, 1);
    return true;
  }
}

// ─── singleton + reset ─────────────────────────────────────────────────────

export const defaultAiHybridRuleStore: AiHybridRuleStore = new InMemoryAiHybridRuleStore();

export function _resetAiHybridRuleStore(): void {
  const s = defaultAiHybridRuleStore as unknown as { byTenant: Map<string, unknown>; seq: number };
  s.byTenant.clear();
  s.seq = 0;
}
