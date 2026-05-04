// services/regulatory-svc/alerts/src/types.ts
//
// Internal type contracts for the alert producer + smart-queue.
//
// Wire formats (Kafka):
//   - input  : apex.rule.firings        (schema: infra/schema-registry/apex.rule.firings.v1.json)
//   - output : apex.regulatory.events   (schema: infra/schema-registry/apex.regulatory.events.v2.json)
//
// We deliberately mirror the JSON Schema field names so that AJV validation
// against the schemas is a no-op coercion check.

/** Severity scale used everywhere internally. Lowercase is the rule DSL convention. */
export type Severity = 'low' | 'medium' | 'high' | 'critical';

/** Smart-queue priority bucket. */
export type Bucket = 'critical' | 'medium' | 'low';

/** ai-copilot-svc PD-band level (proper case, mirrors /score response). */
export type RiskLevel = 'Low' | 'Medium' | 'High';

/** Wire-level severity used in the canonical alert envelope (UPPERCASE per v1 schema). */
export type WireSeverity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

/** Rule firing as produced by agent-rule on apex.rule.firings. */
export interface RuleFiring {
  firing_id: string;
  rule_id: string;
  rule_version: string | number;
  customer_id: string;
  loan_id?: string | null;
  indicators_fired: string[];
  rule_severity: Severity;
  reason?: string;
  recommended_action?: string;
  ts: string;
  evidence?: Record<string, number | string | boolean | null>;
  trace_id?: string;
}

/** Top SHAP reason from ai-copilot-svc /score. */
export interface TopReason {
  feature: string;
  value: number | string | boolean;
  shap_value: number;
  direction: 'positive' | 'negative';
}

/** Score response surface we consume from ai-copilot-svc. */
export interface ScoreResponse {
  customer_id?: string | null;
  pd: number;
  level: RiskLevel;
  top_reasons: TopReason[];
  model_name?: string;
  model_version?: string;
}

/**
 * Canonical alert envelope written to apex.regulatory.events (v2).
 * Required v1 fields (alert_id, raised_at, customer_id, severity, rule_firings,
 * scoring) are kept exactly so v1 consumers still validate.
 */
export interface CanonicalAlert {
  alert_id: string;
  raised_at: string;
  ts: string;
  customer_id: string;
  loan_id?: string | null;
  severity: WireSeverity;
  rule_id: string;
  indicators_fired: string[];
  pd: number | null;
  risk_level: RiskLevel | null;
  top_reasons: TopReason[];
  reason_summary: string;
  rule_firings: Array<{
    rule_id: string;
    rule_version: string | number;
    matched_at: string;
    indicator_value_ids?: string[];
  }>;
  scoring: {
    pd: number | null;
    risk_band: WireSeverity | null;
    shap_top: Array<{ feature: string; value: number }>;
  };
  trace_id?: string;
}
