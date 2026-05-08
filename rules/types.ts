// rules/types.ts
// TypeScript types mirroring rules/dsl.schema.json.
// Keep in sync with the JSON Schema. Both are authoritative; the schema is the
// runtime validator (AJV) and these types are for compile-time consumers.

export type RuleStatus = 'draft' | 'simulate' | 'live' | 'retired';
export type Severity = 'low' | 'medium' | 'high' | 'critical';
export type Comparator = 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'between';

export type IndicatorFamily = 'FIN' | 'BEH' | 'TXN' | 'CRD' | 'FRD';
export type IndicatorId = `${IndicatorFamily}-${string}`; // e.g. "FIN-001"

export interface CmpExpr {
  indicator: IndicatorId | string;
  op: Comparator;
  /** required for gt | gte | lt | lte | eq */
  value?: number | string | boolean;
  /** required for `between`, inclusive [min, max] */
  range?: [number, number];
}

export interface AndExpr {
  and: Expr[];
}
export interface OrExpr {
  or: Expr[];
}
export interface NotExpr {
  not: Expr;
}

export type Expr = CmpExpr | AndExpr | OrExpr | NotExpr;

export interface AlertSpec {
  title: string;
  severity_override?: Severity;
  recommended_action: string;
  tags?: string[];
}

export interface Rule {
  id: string; // RULE-NNN
  version: number;
  status: RuleStatus;
  severity: Severity;
  description: string;
  owner?: string;
  tags?: string[];
  when: Expr;
  then: AlertSpec;
}

// ---- Indicator catalog types ----

export interface IndicatorDef {
  id: string;
  family: 'Financial' | 'Behavioural' | 'Transaction' | 'Credit' | 'Fraud';
  name: string;
  description: string;
  formula_pseudocode: string;
  window_days: number;
  severity_weight: number;
  inputs: string[];
}

export interface IndicatorCatalog {
  version: string;
  generated_at: string;
  owner_agent: string;
  indicators: IndicatorDef[];
}

// ---- Alert payload (shape contract handed off to agent-alert) ----

export interface AlertEvent {
  rule_id: string;
  severity: Severity;
  customer_id: string;
  indicators_fired: string[];
  reason: string;
  ts: string; // ISO-8601
}

// ---- Type guards ----

export function isCmp(e: Expr): e is CmpExpr {
  return (e as CmpExpr).indicator !== undefined && (e as CmpExpr).op !== undefined;
}
export function isAnd(e: Expr): e is AndExpr {
  return Array.isArray((e as AndExpr).and);
}
export function isOr(e: Expr): e is OrExpr {
  return Array.isArray((e as OrExpr).or);
}
export function isNot(e: Expr): e is NotExpr {
  return (e as NotExpr).not !== undefined && !isAnd(e) && !isOr(e);
}
