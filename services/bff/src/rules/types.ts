// services/bff/src/rules/types.ts
//
// Extended rule model for the v2 rule configuration screen — maker-checker
// states, product scoping, conditions-tree DSL, audit trail. The original
// rule shape (`when` / `then` JSON) lives at /api/rules and is left
// untouched so existing screens keep working.

export type RuleProduct =
  | 'home_loan'
  | 'auto_loan'
  | 'personal_loan'
  | 'credit_card'
  | 'msme'
  | 'agri';

/**
 * Lifecycle state — extends the simpler {draft|simulate|live|retired}
 * with the four-eye review steps RBI compliance requires.
 */
export type RuleState =
  | 'draft' // maker is still editing
  | 'pending_review' // submitted, waiting on checker
  | 'approved' // checker signed off, not yet active
  | 'active' // currently firing in production
  | 'rejected' // checker bounced it back; reverts to draft on next edit
  | 'deprecated'; // retired; no longer firing

export type Operator = '>' | '>=' | '<' | '<=' | '==' | '!=' | 'in' | 'not_in' | 'between';

/** A single condition row — { variable_id, op, value }. */
export interface Condition {
  variable_id: string;
  op: Operator;
  value: number | string | (number | string)[];
  /** Optional rolling-window suffix in days. */
  window_days?: number;
}

/** A node in the conditions tree — either a leaf or a logical group. */
export type ConditionNode =
  | { kind: 'leaf'; condition: Condition }
  | { kind: 'group'; op: 'AND' | 'OR' | 'NOT'; children: ConditionNode[] };

export type Severity = 'critical' | 'high' | 'medium' | 'low';
export type AlertPriority = 'P1' | 'P2' | 'P3' | 'P4';
export type NotifyRole =
  | 'risk_analyst'
  | 'supervisor'
  | 'collection_officer'
  | 'field_officer'
  | 'branch_manager';

export interface RuleOutcome {
  severity: Severity;
  alert_priority: AlertPriority;
  notify_roles: NotifyRole[];
  /** Free-text note shown in the alert envelope. */
  reason_template?: string;
}

export type AuditEventKind =
  | 'created'
  | 'edited'
  | 'submitted'
  | 'approved'
  | 'rejected'
  | 'activated'
  | 'deprecated';

export interface AuditEvent {
  ts: string;
  actor_id: string;
  actor_role: string;
  kind: AuditEventKind;
  /** State after this event. */
  to_state: RuleState;
  /** Required on rejection — checker's reason. */
  comment?: string;
  /** Optional version stamp the change advanced to. */
  version?: string;
}

export interface RuleV2 {
  id: string;
  name: string;
  family: 'Financial' | 'Behavioural' | 'Transaction' | 'Credit';
  /** Empty array = applies to every product. */
  applicable_products: RuleProduct[];
  state: RuleState;
  version: string;
  owner_id: string;
  /** Set on submit; cleared on rejection. */
  submitted_by?: string | null;
  /** Set on approve. */
  approved_by?: string | null;
  conditions: ConditionNode;
  outcome: RuleOutcome;
  /** Optional regulatory pointer — "RBI Master Circular dated 2024-04-12". */
  regulatory_ref?: string;
  created_at: string;
  updated_at: string;
  audit: AuditEvent[];
}

// ── Banking variable library ──────────────────────────────────────────

export type VariableCategory = 'account' | 'loan' | 'customer' | 'transaction' | 'external';
export type VariableType = 'number' | 'percent' | 'count' | 'days' | 'amount_kes' | 'flag' | 'enum';

export interface BankingVariable {
  id: string;
  category: VariableCategory;
  label: string;
  description: string;
  /** Determines the input UI in the builder (slider vs dropdown vs free number). */
  type: VariableType;
  /** For enum/flag types — the allowed values. */
  enum_values?: string[];
  /** For numeric types — refresh frequency hint shown in the tooltip. */
  refresh: 'realtime' | 'daily' | 'monthly' | 'quarterly';
  /** Example expressions to seed the rule preview. */
  unit?: string;
}

// ── Backtest + performance ────────────────────────────────────────────

export interface BacktestResult {
  rule_id: string;
  /** ISO date — start of the historical window. */
  window_start: string;
  /** ISO date — end of the historical window. */
  window_end: string;
  total_alerts: number;
  /** True positives — alerts that were followed by an actual NPA event. */
  true_positives: number;
  /** False positives — alerts on customers that did NOT default. */
  false_positives: number;
  /** Coverage — share of NPAs caught by this rule. */
  coverage_pct: number;
  /** Precision — share of alerts that were correct. */
  precision_pct: number;
  /** Average days from alert → actual NPA event. */
  avg_days_to_default: number;
  /** Per-month alert volume (12 buckets). */
  monthly_volume: { month: string; count: number }[];
}

export type RulePerformanceStatus = 'performing' | 'underperforming' | 'deprecated' | 'no_data';

export interface RulePerformance {
  rule_id: string;
  triggers_today: number;
  triggers_week: number;
  triggers_month: number;
  true_positive_rate: number;
  false_positive_rate: number;
  avg_days_to_default: number;
  /** Officer feedback — share of alerts marked "useful" by triagers. */
  officer_useful_pct: number;
  status: RulePerformanceStatus;
}
