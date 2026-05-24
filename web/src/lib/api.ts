import { http } from './http';

// ── Domain types (shared with handlers + screens) ──────────────────────
//
// NOTE: These are list-row VIEW MODELS, not canonical wire events.
// The canonical alert event on Kafka is `apex.regulatory.events.v2`
// (see infra/schema-registry/) — uppercase severity, `customer_id` only,
// `raised_at` timestamp. The UI consumes a denormalised /api/alerts feed
// that joins customer name + rule name and lower-cases severity.
// The BFF/gateway that performs that mapping is tracked as T3.10
// (agent-integration, Phase 3). For the prototype, MSW handlers in
// `src/mocks/handlers.ts` produce this view shape directly.

export type Severity = 'critical' | 'high' | 'medium' | 'low';
export type RuleStatus = 'draft' | 'simulate' | 'live' | 'retired';

export interface Alert {
  id: string;                         // ← maps to v2 envelope `alert_id`
  severity: Severity;                 // ← lowercased from v2 `severity`
  customer: { id: string; name: string };  // ← joined from customer service
  rule: { id: string; name: string };      // ← joined from rule registry
  indicators: string[];               // ← maps to v2 `indicators_fired`
  age_min: number;                    // ← computed: now - raised_at
  assignee?: string | null;
  created_at: string;                 // ← maps to v2 `raised_at`

  // ─── Prioritization fields (Task 6 — alert prioritization with AI) ───
  /**
   * Model confidence in this alert (0–1). 1.0 = the rule + indicators are
   * unambiguous; lower values mean noisier signals. For the prototype this
   * is hand-tuned per alert in the seed data; production would derive it
   * from the model's prediction probability.
   */
  confidence: number;
  /** Total customer exposure in KES — joined from the customer service. */
  customer_exposure_kes: number;
  /**
   * Criticality score = severityWeight × confidence × log10(exposure / 100k) × ageBoost.
   * Authoritative formula in web/src/lib/criticality.ts (mirrored in MSW
   * /api/alerts handler and any future BFF pipeline). Used as the default
   * sort key for the queue.
   */
  criticality_score: number;
  /**
   * Other alert IDs raised on the SAME customer that have been folded
   * into this row by the dedup pass. Empty when dedup is off OR the
   * customer has only one open alert.
   */
  linked_alert_ids: string[];
}

export interface AlertListResponse {
  items: Alert[];
  total: number;
}

export interface DashboardSummary {
  customers_monitored: number;
  high_risk_customers: number;
  active_alerts: number;
  cases_open: number;
  risk_trend: { week: string; pd: number }[];
  alerts_by_severity: { severity: Severity; count: number }[];
}

/**
 * SHAP reason code — mirrors `services/ai-copilot-svc/app/main.py:ReasonCode`.
 * `direction = 'positive'` means the feature *raises* PD (more risky);
 * `'negative'` means it *lowers* PD (protective).
 */
export interface ShapReason {
  feature: string;
  value: number | string | null;
  shap_value: number;
  direction: 'positive' | 'negative';
}

export interface CustomerRisk {
  id: string;
  name: string;
  pd: number;
  level: 'Low' | 'Medium' | 'High';
  exposure: number;
  dpd: number;
  balance_trend: { month: string; balance: number }[];
  top_reasons: ShapReason[];
  model_name: string;
  model_version: string;
}

/** List-row projection of CustomerRisk — what the /customers table renders. */
export interface CustomerListRow {
  id: string;
  name: string;
  pd: number;
  level: 'Low' | 'Medium' | 'High';
  exposure: number;
  dpd: number;
}

export interface CustomerListResponse {
  items: CustomerListRow[];
  total: number;
}

export interface RuleSummary {
  id: string;
  name: string;
  family: 'Financial' | 'Behavioural' | 'Transaction' | 'Credit' | 'Fraud';
  status: RuleStatus;
  version: string;
  when: Record<string, unknown>;
  then: Record<string, unknown>;
  owner: string;
  updated_at: string;
}

// Case state names mirror the canonical regulatory-svc/cases service
// (services/regulatory-svc/cases/src/types.ts). The BFF does no rename.
export type CaseState = 'open' | 'assigned' | 'in_action' | 'monitored' | 'closed';
export type CaseOutcome = 'cured' | 'cured_temp' | 'defaulted';
export type CaseActionKind = 'call' | 'visit' | 'sms' | 'email' | 'note';

export interface CaseSummary {
  id: string;
  alert_id: string;
  customer: { id: string; name: string };
  state: CaseState;
  assignee?: string | null;
  age_min: number;
  /**
   * Joined from the SLA evaluator so the list page can show + filter
   * on SLA posture without a second round-trip. Optional because older
   * case-list payloads predate the join.
   */
  sla_status?: SlaStatus | null;
}

export interface CaseAction {
  action_id: string;
  ts: string;
  kind: CaseActionKind;
  officer_id: string;
  outcome_note?: string | null;
  gps?: { lat: number; lng: number; accuracy_m?: number | null } | null;
}

export interface CaseDetail {
  id: string;
  alert_id: string;
  customer: { id: string; name: string };
  state: CaseState;
  assignee?: string | null;
  loan_id?: string | null;
  severity: Severity;
  rule: { id: string; name: string };
  reason_summary?: string | null;
  outcome?: CaseOutcome | null;
  created_at: string;
  updated_at: string;
  closed_at?: string | null;
  actions: CaseAction[];
}

export interface LogActionInput {
  kind: CaseActionKind;
  officer_id: string;
  outcome_note?: string | null;
  gps?: { lat: number; lng: number; accuracy_m?: number | null } | null;
}

// ── Scenario engine ───────────────────────────────────────────────────
//
// Mirrors services/bff/src/scenario/types.ts. The SPA POSTs three macro
// shocks and renders the returned baseline-vs-stressed view (band counts,
// segment heatmap rows, top-affected customers, ECL delta).

export interface ShockInputs {
  gdp: number;
  rate: number;
  fx: number;
}

export interface BandSummary {
  low: number;
  medium: number;
  high: number;
}

/** IFRS 9 stages — see services/bff/src/scenario/types.ts for the
 *  prototype's PD→stage mapping caveats. */
export type IfrsStage = 1 | 2 | 3;

export interface StageDistribution {
  stage_1: number;
  stage_2: number;
  stage_3: number;
}

/** 3x3 transition matrix: outer key = baseline stage, inner = stressed. */
export interface StageMigration {
  s1: { s1: number; s2: number; s3: number };
  s2: { s1: number; s2: number; s3: number };
  s3: { s1: number; s2: number; s3: number };
}

/**
 * Segment × risk-band matrix row. Both baseline and stressed counts are
 * present per cell so the SPA can render the deterioration in one view.
 */
export interface SegmentRiskRow {
  segment: string;
  baseline: BandSummary;
  stressed: BandSummary;
}

export interface SegmentImpact {
  segment: string;
  accounts: number;
  baseline_pd: number;
  stressed_pd: number;
  pd_delta_pp: number;
  ecl_delta_kes: number;
}

export interface AffectedCustomer {
  customer_id: string;
  name: string;
  product: string;
  baseline_pd: number;
  stressed_pd: number;
  pd_delta_pp: number;
  ead_kes: number;
  ecl_delta_kes: number;
}

export interface ScenarioResult {
  inputs: ShockInputs;
  portfolio_size: number;
  total_ead_kes: number;
  baseline_ecl_kes: number;
  stressed_ecl_kes: number;
  ecl_delta_kes: number;
  baseline_bands: BandSummary;
  stressed_bands: BandSummary;
  baseline_stages: StageDistribution;
  stressed_stages: StageDistribution;
  stage_migration: StageMigration;
  segments: SegmentImpact[];
  segment_risk_matrix: SegmentRiskRow[];
  baseline_portfolio_pd: number;
  stressed_portfolio_pd: number;
  baseline_npa_pct: number;
  stressed_npa_pct: number;
  top_affected: AffectedCustomer[];
  computed_at: string;
}

// ── Reports ───────────────────────────────────────────────────────────
//
// Mirrors services/bff/src/reports/types.ts. Each report type has its own
// payload shape; the common fields are pulled into ReportMeta.

export type ReportType = 'snapshot' | 'alerts' | 'cases' | 'rbi';
export type ReportPeriod = 'week' | 'month' | 'quarter';

export interface ReportMeta {
  type: ReportType;
  period: ReportPeriod;
  generated_at: string;
  period_start: string;
  period_end: string;
}

export interface PortfolioSnapshot extends ReportMeta {
  type: 'snapshot';
  customers_monitored: number;
  high_risk_customers: number;
  high_risk_pct: number;
  total_exposure_kes: number;
  alerts_open: number;
  cases_in_progress: number;
  stage_distribution: { stage_1: number; stage_2: number; stage_3: number };
  expected_credit_loss_kes: number;
  npa_pct: number;
}

export interface AlertActivityReport extends ReportMeta {
  type: 'alerts';
  raised_by_severity: { critical: number; high: number; medium: number; low: number };
  raised_total: number;
  closed_total: number;
  avg_minutes_to_ack: number;
  avg_minutes_to_close: number;
  top_rules: { rule_id: string; rule_name: string; firings: number }[];
  open_at_end: number;
}

/**
 * Wire shape returned by `/v1/scenarios` — mirrors `app_scenario.saved_scenarios`.
 * The localStorage cache in `lib/savedScenarios.ts` uses the same shape minus
 * `saved_by` (legacy single-tenant rows might not have it).
 */
export interface SavedScenario {
  id: string;
  name: string;
  saved_by: string;
  saved_at: string;
  inputs: ShockInputs;
  result: ScenarioResult;
}

export interface CaseOutcomesReport extends ReportMeta {
  type: 'cases';
  cases_opened: number;
  cases_closed: number;
  outcomes: { cured: number; cured_temp: number; defaulted: number };
  avg_days_to_close: number;
  top_officers: { officer_id: string; cases_closed: number }[];
  product_breakdown: { product: string; cases_closed: number }[];
}

export interface RbiSummaryReport extends ReportMeta {
  type: 'rbi';
  sector_exposure: { sector: string; exposure_kes: number; share_pct: number }[];
  risk_band_distribution: {
    band: 'low' | 'medium' | 'high';
    accounts: number;
    share_pct: number;
  }[];
  ecl_kes: number;
  ecl_qoq_delta_kes: number;
  npa_pct: number;
  top_concentrations: { customer_id: string; name: string; exposure_kes: number }[];
}

export type ReportPayload =
  | PortfolioSnapshot
  | AlertActivityReport
  | CaseOutcomesReport
  | RbiSummaryReport;

// ── Cases Report (row-level detail, BAC §3.1.8) ────────────────────────

export type CasesDetailAgeBucket = '0-7d' | '8-30d' | '31-90d' | '90+d' | 'ALL';
export type CasesDetailSeverity = 'high' | 'medium' | 'low';
export type CasesDetailFormat = 'json' | 'csv' | 'xlsx' | 'pdf';
export type CasesDetailSort =
  | 'created_at'
  | 'age_days'
  | 'sla_target_days'
  | 'priority'
  | 'status'
  | 'case_number'
  | 'severity';

export interface CasesDetailFilter {
  ageBucket?: Exclude<CasesDetailAgeBucket, 'ALL'>;
  breached?: boolean;
  from?: string;
  to?: string;
  branch?: string;
  status?: string[];
  severity?: CasesDetailSeverity[];
  q?: string;
  sort?: CasesDetailSort;
  dir?: 'asc' | 'desc';
  page?: number;
  page_size?: number;
}

export interface CasesDetailRow {
  case_id: string;
  case_number: string;
  borrower: { id: string | null; name: string | null };
  product: string | null;
  case_category: string | null;
  priority: 'P1' | 'P2' | 'P3' | 'P4';
  severity: CasesDetailSeverity;
  status: string;
  created_at: string;
  age_days: number;
  age_bucket: Exclude<CasesDetailAgeBucket, 'ALL'>;
  sla_target_days: number | null;
  is_breached: boolean;
  assigned_to: string | null;
  assignee_display_name: string | null;
  branch: string | null;
  alert_id: string | null;
  tags: string[];
}

export interface CasesDetailReport {
  items: CasesDetailRow[];
  total: number;
  page: number;
  page_size: number;
  filters_applied: CasesDetailFilter;
  generated_at: string;
  tenant_id: string;
}

export interface CasesSavedFilter {
  filter_id: string;
  tenant_id: string;
  owner_id: string;
  report_type: 'cases';
  name: string;
  filters: CasesDetailFilter;
  is_shared: boolean;
  is_default: boolean;
  created_at: string;
  updated_at: string;
}

// ── Analytics Dashboard (T4.1, EWS.docx §5.5 / §8) ────────────────────

export type AnalyticsSeverityFilter =
  | 'critical' | 'high' | 'medium' | 'low' | 'all';

export interface AnalyticsFunnelStage {
  stage: 'created' | 'acked' | 'investigated' | 'closed';
  count: number;
  ratio: number;
}
export interface AnalyticsDurationStat {
  n: number;
  p50_sec: number | null;
  p95_sec: number | null;
  mean_sec: number | null;
}
export interface AnalyticsTrendBucket {
  week: string;
  created: number;
  acked: number;
  closed: number;
}
export interface AlertResolutionFilter {
  from?: string;
  to?: string;
  severity?: AnalyticsSeverityFilter;
}
export interface AlertResolutionReport {
  funnel: AnalyticsFunnelStage[];
  ack_duration: AnalyticsDurationStat;
  close_duration: AnalyticsDurationStat;
  trend: AnalyticsTrendBucket[];
  generated_at: string;
  tenant_id: string;
  filters_applied: AlertResolutionFilter;
}

// Stage migration (4d)
export type StageCode = 'stage_1' | 'stage_2' | 'stage_3';
export interface StageMatrixCell {
  from: StageCode;
  to: StageCode;
  count: number;
}
export interface StageTotal {
  stage: StageCode;
  current: number;
  prior: number;
  delta: number;
}
export interface StageMigrationFilter {
  as_of?: string;
  prior_as_of?: string;
  segment?: string;
}
export interface StageMigrationReport {
  matrix: StageMatrixCell[];
  totals: StageTotal[];
  upgrades_count: number;
  downgrades_count: number;
  stationary_count: number;
  new_customers_count: number;
  exited_customers_count: number;
  generated_at: string;
  tenant_id: string;
  filters_applied: StageMigrationFilter;
}

// PD distribution (4c)
export type PdRiskBand = 'low' | 'medium' | 'high';
export interface PdHistogramBin {
  lower: number;
  upper: number;
  label: string;
  count: number;
  prior_count: number | null;
  delta: number | null;
}
export interface PdRiskBandSlice {
  band: PdRiskBand;
  lower: number;
  upper: number;
  count: number;
}
export interface PdDistributionFilter {
  as_of?: string;
  prior_as_of?: string;
  segment?: string;
}
export interface PdDistributionReport {
  bins: PdHistogramBin[];
  bands: PdRiskBandSlice[];
  totals: {
    customer_count: number;
    prior_customer_count: number | null;
    mean_pd_proxy: number | null;
    high_band_share: number;
  };
  range: { lower: number; upper: number; bin_count: number };
  generated_at: string;
  tenant_id: string;
  filters_applied: PdDistributionFilter;
}

// Risk-trend (4b)
export type AnalyticsAlertSeverity = 'critical' | 'high' | 'medium' | 'low';
export interface RiskTrendBucket {
  week: string;
  week_start: string;
  total: number;
  by_severity: Record<AnalyticsAlertSeverity, number>;
  avg_criticality: number | null;
  high_critical_share: number;
}
export interface RiskTrendFilter {
  from?: string;
  to?: string;
  segment?: string;
}
export interface RiskTrendReport {
  buckets: RiskTrendBucket[];
  totals: {
    alert_count: number;
    avg_criticality: number | null;
    high_critical_share: number;
  };
  generated_at: string;
  tenant_id: string;
  filters_applied: RiskTrendFilter;
}

// ── Rules v2 (banking-grade enhancements) ──────────────────────────────

export type RuleProduct =
  | 'home_loan'
  | 'auto_loan'
  | 'personal_loan'
  | 'credit_card'
  | 'msme'
  | 'agri';

export type RuleV2State =
  | 'draft'
  | 'pending_review'
  | 'approved'
  | 'active'
  | 'rejected'
  | 'deprecated';

export type RuleOperator =
  | '>' | '>=' | '<' | '<=' | '==' | '!=' | 'in' | 'not_in' | 'between';

export interface RuleCondition {
  variable_id: string;
  op: RuleOperator;
  value: number | string | (number | string)[];
  window_days?: number;
}

export type RuleConditionNode =
  | { kind: 'leaf'; condition: RuleCondition }
  | { kind: 'group'; op: 'AND' | 'OR' | 'NOT'; children: RuleConditionNode[] };

export type RuleSeverity = 'critical' | 'high' | 'medium' | 'low';
export type RuleAlertPriority = 'P1' | 'P2' | 'P3' | 'P4';
export type RuleNotifyRole =
  | 'risk_analyst' | 'supervisor' | 'collection_officer' | 'field_officer' | 'branch_manager';

export interface RuleOutcome {
  severity: RuleSeverity;
  alert_priority: RuleAlertPriority;
  notify_roles: RuleNotifyRole[];
  reason_template?: string;
}

export type RuleAuditKind =
  | 'created' | 'edited' | 'submitted' | 'approved' | 'rejected'
  | 'activated' | 'deprecated';

export interface RuleAuditEvent {
  ts: string;
  actor_id: string;
  actor_role: string;
  kind: RuleAuditKind;
  to_state: RuleV2State;
  comment?: string;
  version?: string;
}

export interface RuleV2 {
  id: string;
  name: string;
  family: 'Financial' | 'Behavioural' | 'Transaction' | 'Credit' | 'Fraud';
  applicable_products: RuleProduct[];
  state: RuleV2State;
  version: string;
  owner_id: string;
  submitted_by?: string | null;
  approved_by?: string | null;
  conditions: RuleConditionNode;
  outcome: RuleOutcome;
  regulatory_ref?: string;
  created_at: string;
  updated_at: string;
  audit: RuleAuditEvent[];
}

export type VariableCategory = 'account' | 'loan' | 'customer' | 'transaction' | 'external';
export type VariableType = 'number' | 'percent' | 'count' | 'days' | 'amount_kes' | 'flag' | 'enum';

export interface BankingVariable {
  id: string;
  category: VariableCategory;
  label: string;
  description: string;
  type: VariableType;
  enum_values?: string[];
  refresh: 'realtime' | 'daily' | 'monthly' | 'quarterly';
  unit?: string;
}

export type RuleTransition = 'submit' | 'approve' | 'reject' | 'activate' | 'deprecate' | 'edit';

export type RulePerformanceStatus = 'performing' | 'underperforming' | 'deprecated' | 'no_data';

export interface RulePerformance {
  rule_id: string;
  triggers_today: number;
  triggers_week: number;
  triggers_month: number;
  true_positive_rate: number;
  false_positive_rate: number;
  avg_days_to_default: number;
  officer_useful_pct: number;
  status: RulePerformanceStatus;
}

export interface RuleEnvelope {
  rule: RuleV2;
  performance: RulePerformance;
  legal_transitions: RuleTransition[];
}

export interface RuleListResponse {
  items: (RuleV2 & {
    performance: RulePerformance;
    legal_transitions: RuleTransition[];
  })[];
  total: number;
}

export interface BacktestResult {
  rule_id: string;
  window_start: string;
  window_end: string;
  total_alerts: number;
  true_positives: number;
  false_positives: number;
  coverage_pct: number;
  precision_pct: number;
  avg_days_to_default: number;
  monthly_volume: { month: string; count: number }[];
}

// ── SLA enforcement ─────────────────────────────────────────────────────

export type SlaStatus = 'on_track' | 'approaching' | 'breached' | 'closed';
export type SlaStage = 'ack' | 'action' | 'close';

export interface SlaEvaluation {
  case_id: string;
  severity: Severity;
  stage: SlaStage | null;
  deadline_at: string | null;
  minutes_remaining: number | null;
  status: SlaStatus;
}

export interface SlaSummaryRow {
  severity: Severity;
  on_track: number;
  approaching: number;
  breached: number;
  closed: number;
  total: number;
}

export interface SlaSummary {
  generated_at: string;
  by_severity: SlaSummaryRow[];
  totals: {
    on_track: number;
    approaching: number;
    breached: number;
    closed: number;
    total: number;
  };
  breached_cases: SlaEvaluation[];
}

// ── Integrations health ─────────────────────────────────────────────────

export type UpstreamId = 'cbs' | 'aml' | 'ifrs9' | 'collection';

export interface IntegrationStatus {
  id: UpstreamId;
  label: string;
  probe_url: string;
  latency_ms: number;
  status: 'up' | 'down';
  http_status: number;
  message?: string;
}

export interface IntegrationsHealthReport {
  base_url: string;
  generated_at: string;
  integrations: IntegrationStatus[];
}

// ── Outbound webhooks ─────────────────────────────────────────────────
//
// Mirrors services/bff/src/webhooks/types.ts. The SPA admin page lets
// admins register webhook subscriptions that receive APEX events
// (alert.created, scenario.run, etc.) over HTTP POST with an HMAC
// signature. The secret is returned ONCE at create time and never again.

export type WebhookEventType =
  | 'alert.created'
  | 'alert.updated'
  | 'case.assigned'
  | 'case.closed'
  | 'scenario.run'
  | 'webhook.test';

export interface WebhookSubscriptionView {
  id: string;
  name: string;
  url: string;
  events: WebhookEventType[];
  active: boolean;
  created_at: string;
  last_delivery_at: string | null;
  last_delivery_status: 'success' | 'failed' | null;
}

/** Returned ONLY by POST /v1/webhooks (create) — includes the secret. */
export interface WebhookSubscriptionCreated extends WebhookSubscriptionView {
  secret: string;
}

export interface WebhookDelivery {
  id: string;
  subscription_id: string;
  event_type: WebhookEventType;
  payload: unknown;
  attempts: number;
  status: 'success' | 'failed';
  response_status: number;
  response_body?: string;
  created_at: string;
  completed_at: string;
}

// ── API calls ─────────────────────────────────────────────────────────

export const api = {
  dashboardSummary: () =>
    http.get<DashboardSummary>('/api/dashboard/summary').then((r) => r.data),

  /**
   * List alerts with optional filters + sort + dedup.
   *   - sort:  'criticality' (default) | 'severity' | 'age'
   *   - dedup: when true (default), groups alerts on the same customer
   *           and surfaces only the highest-criticality one with
   *           linked_alert_ids populated. Set false to see every alert
   *           individually (useful for case management deep-dives).
   */
  alerts: (
    params: {
      severity?: Severity;
      assignee?: string;
      sort?: 'criticality' | 'severity' | 'age';
      dedup?: boolean;
      /** Filter to a single customer's alerts. Used by the
       *  Customer Risk Profile page's Linked Alerts panel. */
      customer_id?: string;
    } = {},
  ) =>
    http
      .get<AlertListResponse>('/api/alerts', { params })
      .then((r) => r.data),

  customerRisk: (id: string) =>
    http.get<CustomerRisk>(`/api/customers/${id}/risk`).then((r) => r.data),

  /**
   * List of monitored customers. Filters:
   *   - level: comma-separated subset of "Low,Medium,High"
   *   - pdMin: numeric lower bound (inclusive). 0.5 ≈ "high risk" cutoff
   *            on the dashboard KPI card.
   */
  customerList: (params: { level?: string; pdMin?: number } = {}) =>
    http.get<CustomerListResponse>('/api/customers', { params }).then((r) => r.data),

  rules: () => http.get<{ items: RuleSummary[] }>('/api/rules').then((r) => r.data),

  /**
   * List of cases. Filters:
   *   - state:        comma-separated CaseState subset (e.g. "open,assigned")
   *   - sla:          comma-separated SLA bucket (e.g. "breached,approaching")
   *   - customer_id:  filter to a single customer (used by Customer Risk Profile)
   * All optional; omitting all returns the full case list.
   */
  cases: (params: { state?: string; sla?: string; customer_id?: string } = {}) =>
    http.get<{ items: CaseSummary[] }>('/api/cases', { params }).then((r) => r.data),

  case: (id: string) => http.get<CaseDetail>(`/api/cases/${id}`).then((r) => r.data),

  assignCase: (id: string, user_id: string) =>
    http.post<CaseDetail>(`/api/cases/${id}/assign`, { user_id }).then((r) => r.data),

  logAction: (id: string, input: LogActionInput) =>
    http.post<CaseDetail>(`/api/cases/${id}/actions`, input).then((r) => r.data),

  monitorCase: (id: string) =>
    http.post<CaseDetail>(`/api/cases/${id}/monitor`, {}).then((r) => r.data),

  closeCase: (id: string, body: { outcome: CaseOutcome; note?: string | null }) =>
    http.post<CaseDetail>(`/api/cases/${id}/close`, body).then((r) => r.data),

  runScenario: (shocks: ShockInputs) =>
    http.post<ScenarioResult>('/v1/scenario/run', shocks).then((r) => r.data),

  // Saved scenarios — `app_scenario.saved_scenarios` (T4.18). Replaces
  // the prior localStorage-only persistence in `lib/savedScenarios.ts`.
  // `lib/savedScenarios.ts` is now a thin write-through cache so saved
  // scenarios survive a transient API outage AND a browser cache clear.
  listScenarios: () =>
    http
      .get<{ items: SavedScenario[]; total: number }>('/v1/scenarios')
      .then((r) => r.data.items),

  saveScenarioApi: (input: {
    id?: string;
    name: string;
    inputs: ShockInputs;
    result: ScenarioResult;
  }) => http.post<SavedScenario>('/v1/scenarios', input).then((r) => r.data),

  deleteScenarioApi: (id: string) =>
    http.delete<void>(`/v1/scenarios/${id}`).then((r) => r.data),

  getReport: (type: ReportType, period: ReportPeriod) =>
    http
      .get<ReportPayload>(`/v1/reports/${type}`, { params: { period } })
      .then((r) => r.data),

  /**
   * Triggers a CSV download in the browser. Uses a hidden anchor so we can
   * keep the auth headers (axios) — the alternative `window.open()` skips
   * the interceptor and would 401.
   */
  integrationsHealth: () =>
    http.get<IntegrationsHealthReport>('/v1/integrations/health').then((r) => r.data),

  slaSummary: () =>
    http.get<SlaSummary>('/v1/cases/sla-summary').then((r) => r.data),

  ruleVariables: () =>
    http
      .get<{ categories: Record<string, BankingVariable[]> }>('/v1/rules/variables')
      .then((r) => r.data),

  rulesV2: (params: { state?: RuleV2State; product?: RuleProduct } = {}) =>
    http.get<RuleListResponse>('/v1/rules', { params }).then((r) => r.data),

  ruleV2: (id: string) =>
    http.get<RuleEnvelope>(`/v1/rules/${id}`).then((r) => r.data),

  ruleTransition: (id: string, transition: RuleTransition, comment?: string) =>
    http
      .post<RuleEnvelope>(`/v1/rules/${id}/transition`, { transition, comment })
      .then((r) => r.data),

  ruleBacktest: (id: string) =>
    http.post<BacktestResult>(`/v1/rules/${id}/backtest`).then((r) => r.data),

  downloadReport: async (
    type: ReportType,
    period: ReportPeriod,
    format: 'csv' | 'pdf' | 'xlsx',
  ) => {
    if (format === 'pdf' || format === 'xlsx') {
      // Client-side render — fetches the JSON payload and builds the file
      // in the browser. The MSW handler at /v1/reports/:type only produces
      // real bytes for CSV, so this path keeps PDF/Excel downloads valid
      // in dev mode + still works against the real BFF (it just ignores
      // the server's bytes for those formats).
      const payload = await api.getReport(type, period);
      // Lazy-load the heavy export deps so the main bundle stays light.
      const ex = await import('./reportsExport');
      if (format === 'pdf') ex.downloadReportPdf(payload);
      else await ex.downloadReportXlsx(payload);
      return;
    }
    const r = await http.get<Blob>(`/v1/reports/${type}`, {
      params: { period, format },
      responseType: 'blob',
    });
    const url = URL.createObjectURL(r.data);
    const a = document.createElement('a');
    a.href = url;
    // Filename suffix is the date so two pulls of the same report don't
    // overwrite each other in the user's Downloads folder.
    const stamp = new Date().toISOString().slice(0, 10);
    a.download = `${type}-${period}-${stamp}.${format}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  },
  /** @deprecated — use downloadReport(type, period, 'csv'). Kept for any
   *  call site that hasn't migrated yet. */
  downloadReportCsv: async (type: ReportType, period: ReportPeriod) =>
    api.downloadReport(type, period, 'csv'),

  // ── Outbound webhooks (admin only) ──────────────────────────────────

  webhookList: () =>
    http
      .get<{ items: WebhookSubscriptionView[] }>('/v1/webhooks')
      .then((r) => r.data),

  webhookCreate: (input: { name: string; url: string; events: WebhookEventType[] }) =>
    http
      .post<WebhookSubscriptionCreated>('/v1/webhooks', input)
      .then((r) => r.data),

  webhookDelete: (id: string) =>
    http.delete(`/v1/webhooks/${id}`).then(() => undefined),

  webhookTestFire: (id: string) =>
    http
      .post<WebhookDelivery>(`/v1/webhooks/${id}/test`, {})
      .then((r) => r.data),

  webhookDeliveries: (id: string) =>
    http
      .get<{ items: WebhookDelivery[] }>(`/v1/webhooks/${id}/deliveries`)
      .then((r) => r.data),

  // ── Tenants (T4.24 Phase 12) ────────────────────────────────────────
  //
  // These endpoints use the bank-grade envelope: `{header, body}` for
  // success and `{header, error}` for errors. The api wrappers unwrap
  // `body` and surface only the inner shape to callers — the SPA pages
  // never have to know about the envelope.

  tenantList: () =>
    http
      .get<EnvelopeBody<{ items: Tenant[]; total: number }>>('/v1/tenants')
      .then((r) => r.data),

  tenantMe: () =>
    http
      .get<EnvelopeBody<Tenant>>('/v1/tenants/me')
      .then((r) => r.data),

  tenantCreate: (input: TenantCreateInput) =>
    http
      .post<EnvelopeBody<Tenant>>('/v1/tenants', input)
      .then((r) => r.data),

  tenantPatch: (tenant_id: string, patch: TenantPatch) =>
    http
      .patch<EnvelopeBody<Tenant>>(`/v1/tenants/${encodeURIComponent(tenant_id)}`, patch)
      .then((r) => r.data),

  tenantDelete: (tenant_id: string) =>
    http.delete(`/v1/tenants/${encodeURIComponent(tenant_id)}`).then(() => undefined),

  // ── Recovery Center (centralised soft-delete archive) ─────────────

  recoveryList: (params: RecoveryListParams = {}) =>
    http
      .get<EnvelopeBody<{ items: DeletedRecord[]; total: number }>>(
        '/v1/recovery',
        { params },
      )
      .then((r) => r.data),

  recoveryStats: () =>
    http
      .get<EnvelopeBody<RecoveryStats>>('/v1/recovery/stats')
      .then((r) => r.data),

  recoveryAnalytics: (days = 30) =>
    http
      .get<EnvelopeBody<RecoveryAnalytics>>('/v1/recovery/analytics', {
        params: { days },
      })
      .then((r) => r.data),

  recoveryGet: (recovery_id: string) =>
    http
      .get<EnvelopeBody<DeletedRecord>>(`/v1/recovery/${encodeURIComponent(recovery_id)}`)
      .then((r) => r.data),

  recoveryRestore: (recovery_id: string) =>
    http
      .post<EnvelopeBody<DeletedRecord>>(`/v1/recovery/${encodeURIComponent(recovery_id)}/restore`)
      .then((r) => r.data),

  recoveryPurge: (recovery_id: string) =>
    http
      .delete(`/v1/recovery/${encodeURIComponent(recovery_id)}`)
      .then(() => undefined),

  // ── User Access Override (BAC §3.1.6/§3.1.7) ──────────────────────

  uaoList: (params: {
    user_id?: string;
    status?: string;
    module_path?: string;
    page?: number;
    page_size?: number;
  } = {}) =>
    http
      .get<{ items: UserAccessOverride[]; total: number; page: number; page_size: number }>(
        '/v1/admin/user-access-overrides',
        { params },
      )
      .then((r) => r.data),

  uaoGet: (id: string) =>
    http
      .get<UserAccessOverride>(`/v1/admin/user-access-overrides/${encodeURIComponent(id)}`)
      .then((r) => r.data),

  uaoCreate: (input: CreateOverrideInput) =>
    http
      .post<{ overrides: UserAccessOverride[]; created: number }>(
        '/v1/admin/user-access-overrides',
        input,
      )
      .then((r) => r.data),

  uaoUpdate: (id: string, patch: UpdateOverrideInput) =>
    http
      .put<UserAccessOverride>(`/v1/admin/user-access-overrides/${encodeURIComponent(id)}`, patch)
      .then((r) => r.data),

  uaoApprove: (id: string, approval_note?: string) =>
    http
      .post<UserAccessOverride>(
        `/v1/admin/user-access-overrides/${encodeURIComponent(id)}/approve`,
        { approval_note },
      )
      .then((r) => r.data),

  uaoReject: (id: string, rejection_reason: string) =>
    http
      .post<UserAccessOverride>(
        `/v1/admin/user-access-overrides/${encodeURIComponent(id)}/reject`,
        { rejection_reason },
      )
      .then((r) => r.data),

  uaoRevoke: (id: string, revocation_reason: string) =>
    http
      .post<UserAccessOverride>(
        `/v1/admin/user-access-overrides/${encodeURIComponent(id)}/revoke`,
        { revocation_reason },
      )
      .then((r) => r.data),

  uaoBulkRevoke: (user_id: string, revocation_reason: string) =>
    http
      .post<{ revoked: UserAccessOverride[]; count: number }>(
        '/v1/admin/user-access-overrides/bulk-revoke',
        { user_id, revocation_reason },
      )
      .then((r) => r.data),

  uaoEffectiveAccess: (user_id: string) =>
    http
      .get<EffectiveAccess>(
        `/v1/admin/users/${encodeURIComponent(user_id)}/effective-access`,
      )
      .then((r) => r.data),

  uaoAuditLog: (
    params: {
      entity_id?: string;
      actor_id?: string;
      entity_type?: AdminAuditEntityType;
      from?: string;
      to?: string;
      page?: number;
      page_size?: number;
    } = {},
  ) =>
    http
      .get<{ items: AdminAuditLogRow[]; total: number; page: number; page_size: number }>(
        '/v1/admin/admin-audit-log',
        { params },
      )
      .then((r) => r.data),

  // ── Dashboard SLA Breach Matrix (BAC §3.1.6 / §3.1.9.1.4) ─────────

  slaBreachMatrix: (
    params: { branch?: string; business_unit?: string; as_of?: string } = {},
  ) =>
    http
      .get<SlaBreachMatrix>('/v1/dashboard/sla-breach-matrix', { params })
      .then((r) => r.data),

  slaBreachMatrixPreview: (patches: SlaConfigPatch[]) =>
    http
      .post<SlaBreachMatrixPreview>(
        '/v1/dashboard/sla-breach-matrix/preview',
        { patches },
      )
      .then((r) => r.data),

  // ── SLA config admin (BAC §3.1.6) ─────────────────────────────────

  slaConfigList: (
    params: {
      case_category?: string;
      priority?: SlaConfigPriority;
      business_unit?: string;
      status?: string;
      page?: number;
      page_size?: number;
    } = {},
  ) =>
    http
      .get<{ items: SlaConfigRow[]; total: number; page: number; page_size: number }>(
        '/v1/admin/sla-config',
        { params },
      )
      .then((r) => r.data),

  slaConfigCreate: (input: SlaConfigCreateInput) =>
    http.post<SlaConfigRow>('/v1/admin/sla-config', input).then((r) => r.data),

  slaConfigUpdate: (id: string, patch: SlaConfigUpdateInput) =>
    http
      .put<SlaConfigRow>(`/v1/admin/sla-config/${encodeURIComponent(id)}`, patch)
      .then((r) => r.data),

  slaConfigArchive: (id: string) =>
    http
      .delete<SlaConfigRow>(`/v1/admin/sla-config/${encodeURIComponent(id)}`)
      .then((r) => r.data),

  // ── Notification Templates admin (T6 M14.16) ────────────────────────

  notificationTemplatesList: (
    params: {
      channel?: NotificationChannel;
      status?: string;
      include_deleted?: boolean;
      page?: number;
      page_size?: number;
    } = {},
  ) =>
    http
      .get<{ items: NotificationTemplateRow[]; total: number; page: number; page_size: number }>(
        '/v1/admin/notification-templates',
        { params },
      )
      .then((r) => r.data),

  notificationTemplateCreate: (input: NotificationTemplateCreateInput) =>
    http
      .post<NotificationTemplateRow>('/v1/admin/notification-templates', input)
      .then((r) => r.data),

  notificationTemplateUpdate: (id: string, patch: NotificationTemplateUpdateInput) =>
    http
      .patch<NotificationTemplateRow>(
        `/v1/admin/notification-templates/${encodeURIComponent(id)}`,
        patch,
      )
      .then((r) => r.data),

  notificationTemplateActivate: (id: string) =>
    http
      .post<NotificationTemplateRow>(
        `/v1/admin/notification-templates/${encodeURIComponent(id)}/activate`,
        {},
      )
      .then((r) => r.data),

  notificationTemplateArchive: (id: string) =>
    http
      .delete<NotificationTemplateRow>(
        `/v1/admin/notification-templates/${encodeURIComponent(id)}`,
      )
      .then((r) => r.data),

  // ── M14.24 — preview + test-fire + dispatches log ─────────────────

  notificationTemplatePreview: (
    id: string,
    vars: Record<string, unknown>,
  ) =>
    http
      .post<NotificationRenderResult>(
        `/v1/admin/notification-templates/${encodeURIComponent(id)}/preview`,
        { vars },
      )
      .then((r) => r.data),

  notificationTemplateTestFire: (
    id: string,
    input: NotificationTestFireInput,
  ) =>
    http
      .post<{ rendered: NotificationRenderResult; dispatch: NotificationDispatchEntry }>(
        `/v1/admin/notification-templates/${encodeURIComponent(id)}/test-fire`,
        input,
      )
      .then((r) => r.data),

  notificationDispatchesList: (
    params: {
      template_id?: string;
      reference?: string;
      trigger?: NotificationDispatchTrigger;
      status?: string;
      since?: string;
      page?: number;
      page_size?: number;
    } = {},
  ) =>
    http
      .get<{
        items: NotificationDispatchEntry[];
        total: number;
        page: number;
        page_size: number;
      }>('/v1/admin/notification-templates/dispatches', { params })
      .then((r) => r.data),

  // ── Escalation worker (T6 M14.25/M14.25c) ─────────────────────────

  escalationsPreview: (open_cases: EscalationOpenCase[]) =>
    http
      .post<EscalationPreviewResult>('/v1/admin/escalations/preview', { open_cases })
      .then((r) => r.data),

  escalationsTick: (open_cases: EscalationOpenCase[]) =>
    http
      .post<EscalationTickResult>('/v1/admin/escalations/tick', { open_cases })
      .then((r) => r.data),

  escalationsWorkerStatus: () =>
    http
      .get<EscalationWorkerStatus>('/v1/admin/escalations/worker/status')
      .then((r) => r.data),

  // ── Escalation Matrix admin (T6 M14.17/M14.20) ─────────────────────

  escalationMatrixList: (
    params: {
      case_category?: string;
      priority?: EscalationPriority;
      status?: string;
      page?: number;
      page_size?: number;
    } = {},
  ) =>
    http
      .get<{ items: EscalationMatrixRuleRow[]; total: number; page: number; page_size: number }>(
        '/v1/admin/escalation-matrix',
        { params },
      )
      .then((r) => r.data),

  escalationMatrixResolve: (case_category: string, priority: EscalationPriority) =>
    http
      .get<{ rule: EscalationMatrixRuleRow | null }>('/v1/admin/escalation-matrix/resolve', {
        params: { case_category, priority },
      })
      .then((r) => r.data),

  escalationMatrixCreate: (input: EscalationMatrixCreateInput) =>
    http
      .post<EscalationMatrixRuleRow>('/v1/admin/escalation-matrix', input)
      .then((r) => r.data),

  escalationMatrixUpdate: (id: string, patch: EscalationMatrixUpdateInput) =>
    http
      .patch<EscalationMatrixRuleRow>(
        `/v1/admin/escalation-matrix/${encodeURIComponent(id)}`,
        patch,
      )
      .then((r) => r.data),

  escalationMatrixArchive: (id: string) =>
    http
      .delete<EscalationMatrixRuleRow>(
        `/v1/admin/escalation-matrix/${encodeURIComponent(id)}`,
      )
      .then((r) => r.data),

  // ── Case Scenarios admin (T6 M14.18/M14.21) ────────────────────────

  caseScenariosList: (
    params: {
      status?: string;
      case_category?: string;
      priority?: CaseScenarioPriority;
      trigger_indicator_id?: string;
      include_deleted?: boolean;
      page?: number;
      page_size?: number;
    } = {},
  ) =>
    http
      .get<{ items: CaseScenarioRow[]; total: number; page: number; page_size: number }>(
        '/v1/admin/case-scenarios',
        { params },
      )
      .then((r) => r.data),

  caseScenarioGet: (id: string) =>
    http
      .get<CaseScenarioRow>(`/v1/admin/case-scenarios/${encodeURIComponent(id)}`)
      .then((r) => r.data),

  caseScenarioCreate: (input: CaseScenarioCreateInput) =>
    http
      .post<CaseScenarioRow>('/v1/admin/case-scenarios', input)
      .then((r) => r.data),

  caseScenarioUpdate: (id: string, patch: CaseScenarioUpdateInput) =>
    http
      .patch<CaseScenarioRow>(
        `/v1/admin/case-scenarios/${encodeURIComponent(id)}`,
        patch,
      )
      .then((r) => r.data),

  caseScenarioActivate: (id: string) =>
    http
      .post<CaseScenarioRow>(
        `/v1/admin/case-scenarios/${encodeURIComponent(id)}/activate`,
        {},
      )
      .then((r) => r.data),

  caseScenarioArchive: (id: string) =>
    http
      .delete<CaseScenarioRow>(`/v1/admin/case-scenarios/${encodeURIComponent(id)}`)
      .then((r) => r.data),

  caseScenarioRestore: (id: string) =>
    http
      .post<CaseScenarioRow>(
        `/v1/admin/case-scenarios/${encodeURIComponent(id)}/restore`,
        {},
      )
      .then((r) => r.data),

  caseScenarioHistory: (
    id: string,
    params: { page?: number; page_size?: number } = {},
  ) =>
    http
      .get<{ items: CaseScenarioHistoryEntry[]; total: number; page: number; page_size: number }>(
        `/v1/admin/case-scenarios/${encodeURIComponent(id)}/history`,
        { params },
      )
      .then((r) => r.data),

  // ── Cases Report — row-level detail (BAC §3.1.8) ──────────────────────

  casesDetailReport: (filter: CasesDetailFilter) =>
    http
      .get<CasesDetailReport>('/v1/reports/cases/detail', {
        params: encodeCasesDetailParams(filter, 'json'),
      })
      .then((r) => r.data),

  /**
   * Triggers a CSV/XLSX/PDF download in the browser. Uses an anchor +
   * Blob so the axios interceptor still attaches auth/tenant headers.
   * Returns void on success; throws on 4xx.
   */
  downloadCasesDetailReport: async (
    filter: CasesDetailFilter,
    format: Exclude<CasesDetailFormat, 'json'>,
  ) => {
    const r = await http.get<Blob>('/v1/reports/cases/detail', {
      params: encodeCasesDetailParams(filter, format),
      responseType: 'blob',
    });
    const url = URL.createObjectURL(r.data);
    const a = document.createElement('a');
    a.href = url;
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:.]/g, '-');
    a.download = `cases-report-${stamp}.${format}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  },

  // Saved filter presets — server-side, per-user, optionally shared.
  listCasesSavedFilters: () =>
    http
      .get<{ items: CasesSavedFilter[]; total: number }>('/v1/reports/cases/filters')
      .then((r) => r.data.items),

  createCasesSavedFilter: (input: {
    name: string;
    filters: CasesDetailFilter;
    is_shared?: boolean;
    is_default?: boolean;
  }) =>
    http
      .post<CasesSavedFilter>('/v1/reports/cases/filters', input)
      .then((r) => r.data),

  updateCasesSavedFilter: (
    id: string,
    patch: Partial<{ name: string; filters: CasesDetailFilter; is_shared: boolean; is_default: boolean }>,
  ) =>
    http
      .put<CasesSavedFilter>(`/v1/reports/cases/filters/${encodeURIComponent(id)}`, patch)
      .then((r) => r.data),

  deleteCasesSavedFilter: (id: string) =>
    http
      .delete<{ deleted: boolean }>(`/v1/reports/cases/filters/${encodeURIComponent(id)}`)
      .then((r) => r.data),

  // ── Analytics Dashboard (T4.1, EWS.docx §5.5 / §8) ────────────────────

  alertResolution: (filter: AlertResolutionFilter = {}) =>
    http
      .get<AlertResolutionReport>('/v1/analytics/alert-resolution', {
        params: {
          from: filter.from,
          to: filter.to,
          severity: filter.severity && filter.severity !== 'all' ? filter.severity : undefined,
        },
      })
      .then((r) => r.data),

  riskTrend: (filter: RiskTrendFilter = {}) =>
    http
      .get<RiskTrendReport>('/v1/analytics/risk-trend', {
        params: {
          from: filter.from,
          to: filter.to,
          segment: filter.segment,
        },
      })
      .then((r) => r.data),

  pdDistribution: (filter: PdDistributionFilter = {}) =>
    http
      .get<PdDistributionReport>('/v1/analytics/pd-distribution', {
        params: filter,
      })
      .then((r) => r.data),

  stageMigration: (filter: StageMigrationFilter = {}) =>
    http
      .get<StageMigrationReport>('/v1/analytics/stage-migration', {
        params: filter,
      })
      .then((r) => r.data),

  // ── AML ↔ EWS bidirectional correlation (T3.3) ──────────────────────
  //
  // Forward: given an AML match, return same-customer alerts/cases/
  //          investigations + recommended_action.
  // Reverse: given an EWS alert, return same-customer AML matches +
  //          recommended_action.

  amlMatchesForCustomer: (customer_id: string) =>
    http
      .get<EnvelopeBody<{ customer_id: string; matches: AmlMatch[] }>>(
        '/v1/integrations/aml/matches',
        { params: { customer_id } },
      )
      .then((r) => r.data),

  amlCorrelateForward: (match_id: string) =>
    http
      .post<EnvelopeBody<AmlEwsCorrelation>>(
        `/v1/aml/correlate/${encodeURIComponent(match_id)}`,
        {},
      )
      .then((r) => r.data),

  amlCorrelateReverse: (alert_id: string) =>
    http
      .post<EnvelopeBody<EwsAmlCorrelation>>(
        `/v1/aml/correlate/by-alert/${encodeURIComponent(alert_id)}`,
        {},
      )
      .then((r) => r.data),

  // ── Demo-prep §2.1 modules — NPA / Explainability / SMA / Sector ──
  npaHighRisk: (horizon: 30 | 60 | 90 | 180 = 90) =>
    http
      .get<EnvelopeBody<NpaHighRiskReport>>(`/v1/banking/npa/high-risk?horizon=${horizon}`)
      .then((r) => r.data),

  npaWhy: (prediction_id: string) =>
    http
      .get<EnvelopeBody<NpaPredictionExplanation>>(
        `/v1/banking/npa/predictions/${encodeURIComponent(prediction_id)}/why`,
      )
      .then((r) => r.data),

  npaBacktest: () =>
    http.get<EnvelopeBody<NpaBacktestSummary>>('/v1/banking/npa/backtest/latest').then((r) => r.data),

  npaPortfolioDrivers: (horizon: 30 | 60 | 90 | 180 = 90) =>
    http
      .get<EnvelopeBody<PortfolioDriverReport>>(
        `/v1/banking/npa/portfolio-drivers?horizon=${horizon}`,
      )
      .then((r) => r.data),

  // G2 — M15.1 audit trail surface (Monday Playbook H9)
  auditEvents: (params: AuditEventQuery = {}) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
    }
    const q = qs.toString();
    return http
      .get<EnvelopeBody<AuditEventsPage>>(`/v1/audit/events${q ? `?${q}` : ''}`)
      .then((r) => r.data);
  },

  auditEvent: (event_id: string) =>
    http
      .get<EnvelopeBody<AuditEventFull>>(`/v1/audit/events/${encodeURIComponent(event_id)}`)
      .then((r) => r.data),

  auditSummary: (days: number = 30) =>
    http
      .get<EnvelopeBody<AuditSummary>>(`/v1/audit/summary?days=${days}`)
      .then((r) => r.data),

  auditIntegrity: () =>
    http.get<EnvelopeBody<AuditIntegrity>>('/v1/audit/integrity').then((r) => r.data),

  aiExplanation: (prediction_id: string) =>
    http
      .get<EnvelopeBody<PredictionExplanation>>(
        `/v1/ai/predictions/${encodeURIComponent(prediction_id)}/explanation`,
      )
      .then((r) => r.data),

  aiTrustSignals: (prediction_id: string) =>
    http
      .get<EnvelopeBody<TrustSignalReport>>(
        `/v1/ai/predictions/${encodeURIComponent(prediction_id)}/trust-signals`,
      )
      .then((r) => r.data),

  smaMovements: (date?: string) =>
    http
      .get<EnvelopeBody<SmaMovementsReport>>(`/v1/banking/sma/movements${date ? `?date=${date}` : ''}`)
      .then((r) => r.data),

  sectorHeatmap: () =>
    http.get<EnvelopeBody<SectorHeatmapReport>>('/v1/banking/sectors/heatmap').then((r) => r.data),

  // G3 — Dashboard portfolio-insights widgets (Monday Playbook H2)
  ingestionHealth: () =>
    http.get<EnvelopeBody<IngestionHealthReport>>('/v1/ingestion/health').then((r) => r.data),

  aiModels: (type?: string) =>
    http
      .get<EnvelopeBody<AiModelListPage>>(`/v1/ai/models${type ? `?type=${encodeURIComponent(type)}` : ''}`)
      .then((r) => r.data),

  // Module 1.1 — Data Ingestion (Source Feeds management)
  ingestionConnectors: () =>
    http.get<EnvelopeBody<{ items: IngestionConnector[]; total: number }>>('/v1/ingestion/connectors').then((r) => r.data),

  ingestionCreateConnector: (input: IngestionConnectorCreateInput) =>
    http.post<EnvelopeBody<IngestionConnector>>('/v1/ingestion/connectors', input).then((r) => r.data),

  ingestionUpdateConnector: (id: string, patch: IngestionConnectorUpdateInput) =>
    http.patch<EnvelopeBody<IngestionConnector>>(`/v1/ingestion/connectors/${encodeURIComponent(id)}`, patch).then((r) => r.data),

  ingestionConnectorRuns: (id: string, limit = 50) =>
    http
      .get<EnvelopeBody<{ items: IngestionConnectorRun[]; total: number; connector_id: string; limit: number }>>(
        `/v1/ingestion/connectors/${encodeURIComponent(id)}/runs?limit=${limit}`,
      )
      .then((r) => r.data),

  ingestionRunNow: (id: string) =>
    http.post<EnvelopeBody<IngestionConnectorRun>>(`/v1/ingestion/connectors/${encodeURIComponent(id)}/run`).then((r) => r.data),

  ingestionPause: (id: string) =>
    http.post<EnvelopeBody<IngestionConnector>>(`/v1/ingestion/connectors/${encodeURIComponent(id)}/pause`).then((r) => r.data),

  ingestionResume: (id: string) =>
    http.post<EnvelopeBody<IngestionConnector>>(`/v1/ingestion/connectors/${encodeURIComponent(id)}/resume`).then((r) => r.data),

  ingestionSchemaDrift: () =>
    http
      .get<EnvelopeBody<IngestionSchemaDriftReport>>('/v1/ingestion/connectors/schema-drift')
      .then((r) => r.data),

  // Module 1.2 — Data Profiling (AI)
  dqProfileColumns: (source_id: string) =>
    http
      .get<EnvelopeBody<DqSourceProfile>>(`/v1/dq/profile/${encodeURIComponent(source_id)}/columns`)
      .then((r) => r.data),

  dqProfileColumn: (source_id: string, column: string) =>
    http
      .get<EnvelopeBody<DqColumnDetail>>(
        `/v1/dq/profile/${encodeURIComponent(source_id)}/column/${encodeURIComponent(column)}`,
      )
      .then((r) => r.data),

  dqColumnDistribution: (source_id: string, column: string, buckets?: number) => {
    const q = buckets ? `?buckets=${buckets}` : '';
    return http
      .get<EnvelopeBody<DqColumnDistribution>>(
        `/v1/dq/profile/${encodeURIComponent(source_id)}/columns/${encodeURIComponent(column)}/distribution${q}`,
      )
      .then((r) => r.data);
  },

  dqSuggestRules: (source_id: string) =>
    http
      .post<EnvelopeBody<DqSuggestionsEnvelope>>(`/v1/dq/profile/${encodeURIComponent(source_id)}/suggest-rules`)
      .then((r) => r.data),

  dqPromoteRule: (rule_id: string) =>
    http
      .post<EnvelopeBody<DqSuggestedRule>>('/v1/dq/profile/promote-rule', { rule_id })
      .then((r) => r.data),

  // ── Module 1.5 — Anomaly Detection (AI) ────────────────────────────
  anomaliesList: (q: { window?: string; source_id?: string; severity?: string; min_score?: number; pattern?: string; status?: string } = {}) => {
    const sp = new URLSearchParams();
    if (q.window) sp.set('window', q.window);
    if (q.source_id) sp.set('source_id', q.source_id);
    if (q.severity) sp.set('severity', q.severity);
    if (q.pattern) sp.set('pattern', q.pattern);
    if (q.status) sp.set('status', q.status);
    if (q.min_score !== undefined) sp.set('min_score', String(q.min_score));
    const qs = sp.toString();
    return http
      .get<EnvelopeBody<AnomalyListReport>>(`/v1/anomalies${qs ? `?${qs}` : ''}`)
      .then((r) => r.data);
  },

  anomalyGet: (id: string) =>
    http
      .get<EnvelopeBody<AnomalyDetail>>(`/v1/anomalies/${encodeURIComponent(id)}`)
      .then((r) => r.data),

  anomalyPatternsConfigGet: () =>
    http
      .get<EnvelopeBody<AnomalyPatternsConfigEnvelope>>('/v1/anomalies/patterns/config')
      .then((r) => r.data),

  anomalyPatternsConfigSet: (updates: AnomalyPatternConfigUpdate[]) =>
    http
      .post<EnvelopeBody<AnomalyPatternsConfigEnvelope>>('/v1/anomalies/patterns/config', { updates })
      .then((r) => r.data),

  anomalyRerun: () =>
    http
      .post<EnvelopeBody<AnomalyRerunSummary>>('/v1/anomalies/rerun', {})
      .then((r) => r.data),

  anomalyInjectSpike: (body: { source_id?: string; multiplier?: number; pattern?: string } = {}) =>
    http
      .post<EnvelopeBody<AnomalySummary>>('/v1/anomalies/inject-spike', body)
      .then((r) => r.data),

  anomalyInvestigate: (id: string, body: { case_id?: string; notes?: string } = {}) =>
    http
      .post<EnvelopeBody<AnomalySummary>>(`/v1/anomalies/${encodeURIComponent(id)}/investigate`, body)
      .then((r) => r.data),

  anomalyDismiss: (id: string, reason: string) =>
    http
      .post<EnvelopeBody<AnomalySummary>>(`/v1/anomalies/${encodeURIComponent(id)}/dismiss`, { reason })
      .then((r) => r.data),

  // ── Module 1.6 — Reconciliation ─────────────────────────────────────
  reconDefList: () =>
    http
      .get<EnvelopeBody<{ items: ReconDefinitionShape[]; total: number }>>('/v1/recon/definitions')
      .then((r) => r.data),

  reconDefGet: (id: string) =>
    http
      .get<EnvelopeBody<ReconDefinitionShape>>(`/v1/recon/definitions/${encodeURIComponent(id)}`)
      .then((r) => r.data),

  reconDefCreate: (body: Partial<ReconDefinitionShape>) =>
    http
      .post<EnvelopeBody<ReconDefinitionShape>>('/v1/recon/definitions', body)
      .then((r) => r.data),

  reconDefUpdate: (id: string, patch: Partial<ReconDefinitionShape>) =>
    http
      .patch<EnvelopeBody<ReconDefinitionShape>>(`/v1/recon/definitions/${encodeURIComponent(id)}`, patch)
      .then((r) => r.data),

  reconDefDelete: (id: string) =>
    http
      .delete<EnvelopeBody<ReconDefinitionShape>>(`/v1/recon/definitions/${encodeURIComponent(id)}`)
      .then((r) => r.data),

  reconDefRun: (id: string, body: { source_records?: Array<Record<string, unknown>>; target_records?: Array<Record<string, unknown>> } = {}) =>
    http
      .post<EnvelopeBody<ReconRunShape>>(`/v1/recon/definitions/${encodeURIComponent(id)}/run`, body)
      .then((r) => r.data),

  reconRunsList: (q: { recon_id?: string; status?: ReconRunStatus; limit?: number } = {}) => {
    const sp = new URLSearchParams();
    if (q.recon_id) sp.set('recon_id', q.recon_id);
    if (q.status) sp.set('status', q.status);
    if (q.limit !== undefined) sp.set('limit', String(q.limit));
    const qs = sp.toString();
    return http
      .get<EnvelopeBody<{ items: ReconRunShape[]; total: number; tenant_id: string; generated_at: string }>>(`/v1/recon/runs${qs ? `?${qs}` : ''}`)
      .then((r) => r.data);
  },

  reconRunGet: (id: string) =>
    http
      .get<EnvelopeBody<ReconRunShape>>(`/v1/recon/runs/${encodeURIComponent(id)}`)
      .then((r) => r.data),

  reconRunAccept: (id: string, reason: string) =>
    http
      .post<EnvelopeBody<ReconRunShape>>(`/v1/recon/runs/${encodeURIComponent(id)}/accept`, { reason })
      .then((r) => r.data),

  reconInjectDrop: (recon_id: string, row_key: string, leg: 'staging' | 'warehouse' = 'staging') =>
    http
      .post<EnvelopeBody<{ recon_id: string; row_key: string; leg: string; staging_dropped: string[]; warehouse_dropped: string[] }>>(
        `/v1/recon/definitions/${encodeURIComponent(recon_id)}/inject-drop`,
        { row_key, leg },
      )
      .then((r) => r.data),

  reconDashboard: () =>
    http
      .get<EnvelopeBody<ReconDashboardRollupShape>>('/v1/recon/dashboard')
      .then((r) => r.data),

  // ── Module 1.7 — Data Quality Score ─────────────────────────────────
  dqScoreDashboard: () =>
    http
      .get<EnvelopeBody<DqScoreDashboardShape>>('/v1/dq/dashboard')
      .then((r) => r.data),

  dqBySource: (source_id: string, window: number = 30) =>
    http
      .get<EnvelopeBody<DqBySourceShape>>(`/v1/dq/by-source/${encodeURIComponent(source_id)}?window=${window}`)
      .then((r) => r.data),

  dqByAttribute: (source_id: string, attribute?: string) => {
    const sp = new URLSearchParams({ source_id });
    if (attribute) sp.set('attribute', attribute);
    return http
      .get<EnvelopeBody<DqByAttributeShape>>(`/v1/dq/by-attribute?${sp.toString()}`)
      .then((r) => r.data);
  },

  dqExecutionsList: (q: { rule_id?: string; status?: string; limit?: number } = {}) => {
    const sp = new URLSearchParams();
    if (q.rule_id) sp.set('rule_id', q.rule_id);
    if (q.status) sp.set('status', q.status);
    if (q.limit !== undefined) sp.set('limit', String(q.limit));
    const qs = sp.toString();
    return http
      .get<EnvelopeBody<{ items: DqExecutionShape[]; total: number; tenant_id: string; generated_at: string }>>(`/v1/dq/executions${qs ? `?${qs}` : ''}`)
      .then((r) => r.data);
  },

  dqExecutionGet: (id: string) =>
    http
      .get<EnvelopeBody<DqExecutionShape>>(`/v1/dq/executions/${encodeURIComponent(id)}`)
      .then((r) => r.data),

  // ── Module 2.1 — Borrower Watch ─────────────────────────────────────
  borrowerWatchList: (q: {
    mode?: 'stressed' | 'all';
    sector?: string;
    segment?: string;
    region?: string;
    severity?: string;
    watchlist_only?: boolean;
    min_ews?: number;
    max_ews?: number;
    search?: string;
    sort?: string;
    order?: 'asc' | 'desc';
  } = {}) => {
    const sp = new URLSearchParams();
    if (q.mode) sp.set('mode', q.mode);
    if (q.sector) sp.set('sector', q.sector);
    if (q.segment) sp.set('segment', q.segment);
    if (q.region) sp.set('region', q.region);
    if (q.severity) sp.set('severity', q.severity);
    if (q.watchlist_only) sp.set('watchlist_only', 'true');
    if (q.min_ews !== undefined) sp.set('min_ews', String(q.min_ews));
    if (q.max_ews !== undefined) sp.set('max_ews', String(q.max_ews));
    if (q.search) sp.set('search', q.search);
    if (q.sort) sp.set('sort', q.sort);
    if (q.order) sp.set('order', q.order);
    const qs = sp.toString();
    return http
      .get<EnvelopeBody<BorrowerListReportShape>>(`/v1/customers${qs ? `?${qs}` : ''}`)
      .then((r) => r.data);
  },

  cohortCmaPack: (cohort_ids: string[]) =>
    http
      .post<EnvelopeBody<CohortCmaPackShape>>('/v1/banking/cohort/cma-pack', { cohort_ids })
      .then((r) => r.data),

  // ── Module 2.1 helpers — wrapping pre-existing /v1 routes ───────────
  riskProfile: (customer_id: string) =>
    http
      .get<EnvelopeBody<RiskProfileShape>>(`/v1/risk-profile/${encodeURIComponent(customer_id)}`)
      .then((r) => r.data),

  watchlistList: () =>
    http
      .get<EnvelopeBody<{ items: WatchlistEntryShape[]; total: number }>>('/v1/watchlist')
      .then((r) => r.data),

  watchlistAdd: (body: { customer_id: string; reason: string; vertical?: 'banking' | 'insurance' }) =>
    http
      .post<EnvelopeBody<WatchlistEntryShape>>('/v1/watchlist', body)
      .then((r) => r.data),

  watchlistRemove: (customer_id: string) =>
    http
      .delete<EnvelopeBody<void>>(`/v1/watchlist/${encodeURIComponent(customer_id)}`)
      .then((r) => r.data),

  // ── M2.2 — Account Behaviour ────────────────────────────────────────
  accountSignals: (q: { customer_id?: string; watchlist_only?: boolean; status?: 'new' | 'reviewed' | 'dismissed' } = {}) => {
    const params = new URLSearchParams();
    if (q.customer_id) params.set('customer_id', q.customer_id);
    if (q.watchlist_only) params.set('watchlist_only', 'true');
    if (q.status) params.set('status', q.status);
    const qs = params.toString();
    return http
      .get<EnvelopeBody<AccountSignalsReportShape>>(`/v1/banking/accounts/signals${qs ? '?' + qs : ''}`)
      .then((r) => r.data);
  },
  accountPatterns: (account_id: string) =>
    http
      .get<EnvelopeBody<AccountPatternsReportShape>>(
        `/v1/banking/accounts/${encodeURIComponent(account_id)}/patterns`,
      )
      .then((r) => r.data),
  accountTransactions: (account_id: string, q: { since?: string; until?: string; page?: number; page_size?: number } = {}) => {
    const params = new URLSearchParams();
    if (q.since) params.set('since', q.since);
    if (q.until) params.set('until', q.until);
    if (q.page) params.set('page', String(q.page));
    if (q.page_size) params.set('page_size', String(q.page_size));
    const qs = params.toString();
    return http
      .get<EnvelopeBody<AccountTransactionsShape>>(
        `/v1/banking/accounts/${encodeURIComponent(account_id)}/transactions${qs ? '?' + qs : ''}`,
      )
      .then((r) => r.data);
  },
  accountSignalDismiss: (signal_id: string) =>
    http
      .post<EnvelopeBody<SignalStatusUpdateShape>>(
        `/v1/banking/accounts/signals/${encodeURIComponent(signal_id)}/dismiss`,
        {},
      )
      .then((r) => r.data),
  accountSignalReview: (signal_id: string) =>
    http
      .post<EnvelopeBody<SignalStatusUpdateShape>>(
        `/v1/banking/accounts/signals/${encodeURIComponent(signal_id)}/review`,
        {},
      )
      .then((r) => r.data),
  accountBlockPropose: (account_id: string, reason: string) =>
    http
      .post<EnvelopeBody<AccountBlockRequestShape>>(
        `/v1/banking/accounts/${encodeURIComponent(account_id)}/block`,
        { reason },
      )
      .then((r) => r.data),
  accountBlockReview: (account_id: string, request_id: string, decision: 'approve' | 'reject') =>
    http
      .post<EnvelopeBody<AccountBlockRequestShape>>(
        `/v1/banking/accounts/${encodeURIComponent(account_id)}/block`,
        { request_id, decision },
      )
      .then((r) => r.data),

  // ── M2.3 — Financial Ratios ─────────────────────────────────────────
  ratiosMaster: () =>
    http
      .get<EnvelopeBody<RatioMasterShape>>('/v1/banking/ratios/master')
      .then((r) => r.data),
  ratiosThresholds: () =>
    http
      .get<EnvelopeBody<RatioThresholdsListShape>>('/v1/banking/ratios/thresholds')
      .then((r) => r.data),
  ratiosSetThreshold: (code: string, warning: number, critical: number) =>
    http
      .put<EnvelopeBody<RatioThresholdEntryShape>>(
        `/v1/banking/ratios/thresholds/${encodeURIComponent(code)}`,
        { warning, critical },
      )
      .then((r) => r.data),
  ratiosClearThreshold: (code: string) =>
    http
      .delete<EnvelopeBody<RatioThresholdEntryShape>>(
        `/v1/banking/ratios/thresholds/${encodeURIComponent(code)}`,
      )
      .then((r) => r.data),
  ratiosByCustomer: (customer_id: string) =>
    http
      .get<EnvelopeBody<CustomerRatioBundleShape>>(
        `/v1/banking/ratios/customer/${encodeURIComponent(customer_id)}`,
      )
      .then((r) => r.data),
  ratiosHistory: (customer_id: string, ratio_code: string) =>
    http
      .get<EnvelopeBody<RatioHistorySliceShape>>(
        `/v1/banking/ratios/customer/${encodeURIComponent(customer_id)}/history?ratio_code=${encodeURIComponent(ratio_code)}`,
      )
      .then((r) => r.data),
  ratiosSectorBenchmark: (sector: string) =>
    http
      .get<EnvelopeBody<SectorBenchmarkShape>>(
        `/v1/banking/ratios/sector-benchmark?sector=${encodeURIComponent(sector)}`,
      )
      .then((r) => r.data),
  ratiosNotesList: (q: { customer_id?: string; ratio_code?: string } = {}) => {
    const p = new URLSearchParams();
    if (q.customer_id) p.set('customer_id', q.customer_id);
    if (q.ratio_code) p.set('ratio_code', q.ratio_code);
    const qs = p.toString();
    return http
      .get<EnvelopeBody<RatioNotesListShape>>(`/v1/banking/ratios/notes${qs ? '?' + qs : ''}`)
      .then((r) => r.data);
  },
  ratiosNotesAdd: (customer_id: string, ratio_code: string, body: string) =>
    http
      .post<EnvelopeBody<RatioNoteShape>>('/v1/banking/ratios/notes', {
        customer_id,
        ratio_code,
        body,
      })
      .then((r) => r.data),
  buildCmaPack: (cohort: string[], forms: ('II' | 'III' | 'IV' | 'V')[]) =>
    http
      .post<EnvelopeBody<CmaPackResultShape>>('/v1/banking/cma/pack', { cohort, forms })
      .then((r) => r.data),
};

// ── M2.3 — Financial Ratios shapes ─────────────────────────────────────
export type RatioCode = 'DSCR' | 'ICR' | 'CR' | 'QR' | 'DER' | 'TOL_TNW' | 'STK_TO' | 'DBT_TO';
export type RatioBand = 'green' | 'amber' | 'red';
export type RatioPolarity = 'higher_is_better' | 'lower_is_better';

export interface RatioDefShape {
  code: RatioCode;
  name: string;
  formula: string;
  unit: '×' | 'ratio' | 'days';
  polarity: RatioPolarity;
  default_warning: number;
  default_critical: number;
  description: string;
}
export interface RatioValueShape {
  code: RatioCode;
  value: number;
  band: RatioBand;
  warning_threshold: number;
  critical_threshold: number;
  polarity: RatioPolarity;
  observed_at: string;
}
export interface RatioHistoryPointShape {
  date: string;
  value: number;
  band: RatioBand;
}
export interface CustomerRatioBundleShape {
  tenant_id: string;
  generated_at: string;
  customer_id: string;
  customer_name: string;
  sector: string;
  current: Record<RatioCode, RatioValueShape>;
  history: Record<RatioCode, RatioHistoryPointShape[]>;
  worst_band: RatioBand;
  worst_ratios: RatioCode[];
}
export interface RatioMasterShape {
  total: number;
  ratios: RatioDefShape[];
}
export interface RatioThresholdEntryShape {
  tenant_id: string;
  code: RatioCode;
  warning: number;
  critical: number;
  source: 'tenant_override' | 'platform_default';
  updated_by: string | null;
  updated_at: string | null;
}
export interface RatioThresholdsListShape {
  tenant_id: string;
  total: number;
  entries: RatioThresholdEntryShape[];
}
export interface RatioHistorySliceShape {
  tenant_id: string;
  generated_at: string;
  customer_id: string;
  customer_name: string;
  sector: string;
  ratio_code: RatioCode;
  ratio_def: RatioDefShape;
  current: RatioValueShape;
  history: RatioHistoryPointShape[];
  sector_benchmark: { p25: number; median: number; p75: number; internal_median: number };
  trend_vs_sector: 'better' | 'worse' | 'on_par';
  threshold: { warning: number; critical: number; source: 'tenant_override' | 'platform_default' };
}
export interface SectorBenchmarkRowShape {
  code: RatioCode;
  name: string;
  rbi_quartile_25: number;
  rbi_median: number;
  rbi_quartile_75: number;
  internal_median: number;
  sample_size: number;
}
export interface SectorBenchmarkShape {
  tenant_id: string;
  generated_at: string;
  sector: string;
  as_of_quarter: string;
  ratios: SectorBenchmarkRowShape[];
}
export interface RatioNoteShape {
  note_id: string;
  tenant_id: string;
  customer_id: string;
  ratio_code: RatioCode;
  body: string;
  author: string;
  created_at: string;
}
export interface RatioNotesListShape {
  tenant_id: string;
  total: number;
  notes: RatioNoteShape[];
}
export interface CmaPackResultShape {
  pack_id: string;
  tenant_id: string;
  generated_at: string;
  generated_by: string;
  cohort_size: number;
  cohort: string[];
  forms: ('II' | 'III' | 'IV' | 'V')[];
  html: string;
  size_bytes: number;
}

// ── M2.2 — Account Behaviour shapes ───────────────────────────────────
export type AccountSignalSeverity = 'low' | 'medium' | 'high' | 'critical';
export type AccountSignalStatus = 'new' | 'reviewed' | 'dismissed';
export interface AccountSignalShape {
  signal_id: string;
  account_id: string;
  customer_id: string;
  customer_name: string;
  signal_type: string;
  severity: AccountSignalSeverity;
  score: number;
  observed_at: string;
  description: string;
  is_watchlisted: boolean;
  status: AccountSignalStatus;
  reviewed_by: string | null;
  reviewed_at: string | null;
}
export interface AccountSignalsReportShape {
  tenant_id: string;
  generated_at: string;
  customer_id: string | null;
  watchlist_only: boolean;
  status_filter: AccountSignalStatus | null;
  total: number;
  by_severity: Record<AccountSignalSeverity, number>;
  by_status: Record<AccountSignalStatus, number>;
  by_type: Record<string, number>;
  signals: AccountSignalShape[];
}
export interface AccountPatternShape {
  pattern_type: 'monthly_balance' | 'channel_mix' | 'txn_velocity' | 'cheque_returns';
  label: string;
  series: { date: string; value: number }[];
  anomaly_score: number;
}
export interface AccountPatternsReportShape {
  tenant_id: string;
  generated_at: string;
  account_id: string;
  customer_id: string;
  patterns: AccountPatternShape[];
}
export interface LedgerEntryShape {
  entry_id: string;
  account_id: string;
  type: 'credit' | 'debit';
  amount_kes: number;
  currency: string;
  narrative: string;
  posted_at: string;
  balance_kes_after: number;
}
export interface AccountTransactionsShape {
  // Re-uses the M14.7 finance adapter ledger shape: items[] not entries[].
  account_id: string;
  total: number;
  page: number;
  page_size: number;
  since?: string;
  until?: string;
  items: LedgerEntryShape[];
}
export interface SignalStatusUpdateShape {
  signal_id: string;
  tenant_id: string;
  status: AccountSignalStatus;
  reviewed_by: string;
  reviewed_at: string;
}
export interface AccountBlockRequestShape {
  request_id: string;
  tenant_id: string;
  account_id: string;
  customer_id: string;
  reason: string;
  status: 'pending' | 'approved' | 'rejected';
  requested_by: string;
  requested_at: string;
  reviewed_by: string | null;
  reviewed_at: string | null;
}

// ── Demo §2.1 response shapes ──
export interface NpaHighRiskRow {
  prediction_id: string;
  customer_id: string;
  customer_name: string;
  pd: number;
  band: 'high' | 'critical';
  predicted_at: string;
  horizon_days: number;
  outstanding_kes: number;
  sector: string;
  current_dpd: number;
}

export interface NpaHighRiskReport {
  tenant_id: string;
  generated_at: string;
  horizon_days: number;
  total_high_risk: number;
  total_critical: number;
  total_exposure_kes: number;
  rows: NpaHighRiskRow[];
}

export interface NpaPredictionExplanation {
  tenant_id: string;
  account_id: string;
  customer_id: string;
  generated_at: string;
  pd: number;
  band: 'low' | 'medium' | 'high' | 'critical';
  model_id: string;
  model_version: string;
  top_features: {
    feature_name: string;
    weight: number;
    direction: 'up' | 'down';
    value: string;
  }[];
  comparable_customers: { customer_id: string; pd: number; outcome: 'cured' | 'npa' | 'pending' }[];
  recommended_actions: string[];
}

export interface NpaBacktestSummary {
  tenant_id: string;
  generated_at: string;
  model_id: string;
  model_version: string;
  back_to: string;
  cohort_size: number;
  auc: number;
  ks: number;
  precision_at_top_decile: number;
  recall_at_top_decile: number;
  confusion: { tp: number; fp: number; tn: number; fn: number };
  by_segment: { segment: string; auc: number; cohort_size: number }[];
}

// M7.19 — Portfolio-level NPA driver aggregation
export interface PortfolioDriverRow {
  feature_name: string;
  total_contribution: number;
  affected_predictions: number;
  avg_weight: number;
  direction_split: { up: number; down: number };
  by_sector: Record<string, number>;
  pct_of_total: number;
}

export interface PortfolioDriverReport {
  tenant_id: string;
  generated_at: string;
  horizon_days: number;
  total_predictions_analyzed: number;
  total_drivers: number;
  drivers: PortfolioDriverRow[];
  most_universal_driver: { feature_name: string; affected_predictions: number } | null;
}

// G2 — M15.1 audit trail types
export type AuditOutcome = 'success' | 'failure' | 'denied';
export type AuditSeverity = 'info' | 'warning' | 'critical';
export type AuditResourceType =
  | 'user'
  | 'session'
  | 'config'
  | 'case'
  | 'alert'
  | 'report'
  | 'scenario'
  | 'rule'
  | 'integration'
  | 'system';

export interface AuditEventQuery {
  actor_username?: string;
  action?: string;
  resource_type?: AuditResourceType;
  resource_id?: string;
  correlation_id?: string;
  outcome?: AuditOutcome;
  severity?: AuditSeverity;
  since?: string;
  until?: string;
  page?: number;
  page_size?: number;
}

export interface AuditEventRow {
  event_id: string;
  ts: string;
  tenant_id: string;
  actor_username: string;
  actor_role: string;
  action: string;
  resource_type: AuditResourceType;
  resource_id: string;
  outcome: AuditOutcome;
  severity: AuditSeverity;
  correlation_id: string | null;
  ip_address?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface AuditEventFull extends AuditEventRow {
  prev_hash: string;
  hash: string;
}

export interface AuditEventsPage {
  items: AuditEventRow[];
  page: number;
  page_size: number;
  total: number;
}

export interface AuditSummary {
  since: string;
  until: string;
  total: number;
  by_outcome: Record<AuditOutcome, number>;
  by_severity: Record<AuditSeverity, number>;
  by_action: { action: string; count: number }[];
  by_resource_type: { resource_type: AuditResourceType; count: number }[];
}

export interface AuditIntegrity {
  tenant_id: string;
  generated_at: string;
  total_events: number;
  valid: boolean;
  last_hash: string;
  broken_at?: { index: number; event_id: string; reason: string };
}

// G3 — Portfolio Insights row (Monday Playbook H2)
export type IngestionStatus = 'healthy' | 'degraded' | 'failing' | 'paused';

export interface IngestionAttentionConnector {
  id: string;
  name: string;
  source_system: string;
  type: string;
  schedule: string;
  status: IngestionStatus;
  last_run_at: string | null;
  last_run_status: string | null;
  last_run_records: number;
  average_lag_seconds: number;
  paused_at: string | null;
  default_status?: string;
  description?: string;
}

export interface IngestionHealthReport {
  total_connectors: number;
  by_status: Record<IngestionStatus, number>;
  attention_required: IngestionAttentionConnector[];
  fleet_records_last_run: number;
}

export interface AiModelRow {
  model_id: string;
  name?: string;
  version: string;
  type: string;
  framework?: string;
  status: 'experimental' | 'staging' | 'shadow' | 'production' | 'retired';
  metrics?: { auc?: number; ks?: number; brier?: number } | null;
  trained_at?: string;
  deployed_at?: string | null;
}

export interface AiModelListPage {
  items: AiModelRow[];
  total: number;
}

// Module 1.1 — Data Ingestion types
export type IngestionConnectorType =
  | 'kafka_stream'
  | 'batch_csv'
  | 'rest_api'
  | 'soap_api'
  | 'sftp_drop';

export type IngestionRunStatus = 'success' | 'failure' | 'partial' | 'running';

export interface IngestionConnector {
  id: string;
  name: string;
  source_system: string;
  type: IngestionConnectorType;
  schedule: string;
  description: string;
  default_status: IngestionStatus;
  status: IngestionStatus;
  last_run_at: string | null;
  last_run_status: IngestionRunStatus | null;
  last_run_records: number;
  average_lag_seconds: number;
  paused_at: string | null;
  owner_user_id?: string | null;
  is_custom?: boolean;
}

export interface IngestionConnectorRun {
  run_id: string;
  connector_id: string;
  started_at: string;
  finished_at: string | null;
  status: IngestionRunStatus;
  records_processed: number;
  records_failed: number;
  error_message: string | null;
  triggered_manually: boolean;
}

export interface IngestionConnectorCreateInput {
  id: string;
  name: string;
  source_system: string;
  type: IngestionConnectorType;
  schedule: string;
  description?: string;
  default_status?: IngestionStatus;
  owner_user_id?: string | null;
}

export interface IngestionConnectorUpdateInput {
  name?: string;
  source_system?: string;
  type?: IngestionConnectorType;
  schedule?: string;
  description?: string;
  default_status?: IngestionStatus;
  owner_user_id?: string | null;
}

export interface IngestionSchemaDriftRow {
  connector_id: string;
  name: string;
  source_system: string;
  type: IngestionConnectorType;
  status: IngestionStatus;
  schema_version: string | null;
  platform_fields_count: number;
  tenant_added_fields: string[];
  overrides_count: number;
  has_drift: boolean;
}

export interface IngestionSchemaDriftReport {
  tenant_id: string;
  generated_at: string;
  total_connectors: number;
  drifted_count: number;
  clean_count: number;
  rows: IngestionSchemaDriftRow[];
  drifted_rows: IngestionSchemaDriftRow[];
}

// Module 1.2 — Data Profiling types
export type DqColumnType = 'string' | 'integer' | 'number' | 'boolean' | 'date' | 'enum';
export type DqDetectedFormat =
  | 'pan' | 'gstin' | 'email' | 'phone_in' | 'iso_date' | 'iso_datetime' | 'uuid' | 'numeric_id' | null;
export type DqRuleType =
  | 'not_null' | 'range' | 'enum_membership' | 'regex' | 'unique' | 'freshness';

export interface DqTopValue {
  value: string;
  count: number;
  pct: number;
}

export interface DqColumnProfile {
  column: string;
  type: DqColumnType;
  null_count: number;
  null_pct: number;
  distinct_count: number;
  min: number | string | null;
  max: number | string | null;
  mean: number | null;
  p50: number | null;
  p95: number | null;
  std_dev: number | null;
  anomaly_score: number;
  has_drift: boolean;
  top_values: DqTopValue[];
  format_detected: DqDetectedFormat;
}

export interface DqSourceProfile {
  tenant_id: string;
  source_id: string;
  generated_at: string;
  total_rows: number;
  columns: DqColumnProfile[];
}

export interface DqColumnDetail {
  tenant_id: string;
  source_id: string;
  generated_at: string;
  column: DqColumnProfile;
}

export interface DqDistributionBucket {
  bucket: string;
  count: number;
  pct: number;
}

export interface DqColumnDistribution {
  tenant_id: string;
  source_id: string;
  column: string;
  generated_at: string;
  total_rows: number;
  buckets: DqDistributionBucket[];
  has_drift: boolean;
}

export interface DqSuggestedRule {
  rule_id: string;
  source_id: string;
  column: string;
  rule_type: DqRuleType;
  rule_def: Record<string, unknown>;
  rationale: string;
  confidence: number;
  status: 'suggested' | 'promoted';
}

export interface DqSuggestionsEnvelope {
  tenant_id: string;
  source_id: string;
  count: number;
  rules: DqSuggestedRule[];
}

export interface PredictionExplanation {
  tenant_id: string;
  prediction_id: string;
  generated_at: string;
  model_id: string;
  model_version: string;
  pd: number;
  band: 'low' | 'medium' | 'high' | 'critical';
  base_pd_population: number;
  top_features: {
    feature_name: string;
    display_name: string;
    weight: number;
    base_value: number;
    observed_value: string;
    direction: 'up' | 'down';
    group: 'credit' | 'behavioural' | 'transaction' | 'collateral' | 'macro';
  }[];
  counterfactual: {
    description: string;
    change_feature: string;
    required_value: string;
    resulting_pd: number;
    resulting_band: 'low' | 'medium' | 'high' | 'critical';
  };
  feature_group_summary: { group: string; contribution: number; pct_of_total: number }[];
}

export interface TrustSignalReport {
  tenant_id: string;
  prediction_id: string;
  generated_at: string;
  overall: 'green' | 'amber' | 'red';
  signals: {
    signal: string;
    status: 'green' | 'amber' | 'red';
    value: string;
    threshold: string;
    description: string;
  }[];
}

export interface SmaMovementsReport {
  tenant_id: string;
  generated_at: string;
  framework: string;
  date: string;
  total_movements: number;
  deteriorations: number;
  improvements: number;
  unchanged: number;
  total_exposure_at_risk_kes: number;
  by_category_count: Record<string, number>;
  movements: {
    customer_id: string;
    customer_name: string;
    loan_id: string;
    from_category: string;
    to_category: string;
    dpd: number;
    outstanding_kes: number;
    sector: string;
  }[];
}

export interface SectorHeatmapReport {
  tenant_id: string;
  generated_at: string;
  total_sectors: number;
  by_heat_level: Record<string, number>;
  cells: {
    sector: string;
    npa_ratio_pct: number;
    total_customers: number;
    total_outstanding_kes: number;
    delta_30d_pct: number;
    heat_level: 'low' | 'medium' | 'high' | 'critical';
    is_watchlisted: boolean;
  }[];
}

// ── T3.3 correlation response shapes (mirror BFF aml_alert_correlation.ts) ──

export type AmlMatchSeverity = 'high' | 'medium' | 'low';
export type AmlMatchStatus = 'open' | 'cleared' | 'escalated' | 'false_positive';
export type AmlMatchType = 'sanctions' | 'pep' | 'adverse_media' | 'internal';

export interface AmlMatch {
  match_id: string;
  customer_id: string;
  match_type: AmlMatchType;
  severity: AmlMatchSeverity;
  list_name: string;
  list_entity_id: string;
  list_entity_name: string;
  confidence_score: number;
  status: AmlMatchStatus;
  status_changed_at: string | null;
  status_changed_by: string | null;
  detected_at: string;
}

export interface CorrelatedAlertLite {
  id: string;
  customer_id: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  created_at: string;
  rule_id?: string;
  rule_name?: string;
  status?: string;
}

export interface CorrelatedCaseLite {
  case_id: string;
  customer_id: string;
  state: string;
  created_at: string;
  assignee_username?: string | null;
}

export interface CorrelatedInvestigationLite {
  investigation_id: string;
  customer_id: string;
  status: string;
  case_id?: string;
  opened_at: string;
}

export interface AmlEwsCorrelation {
  tenant_id: string;
  generated_at: string;
  aml_match: AmlMatch;
  linked_alerts: CorrelatedAlertLite[];
  linked_cases: CorrelatedCaseLite[];
  linked_investigations: CorrelatedInvestigationLite[];
  peak_alert_severity: CorrelatedAlertLite['severity'] | null;
  bidirectional_high_flag: boolean;
  recommended_action: 'escalate_case' | 'open_investigation' | 'monitor' | 'no_action';
}

export interface EwsAmlCorrelation {
  tenant_id: string;
  generated_at: string;
  alert: CorrelatedAlertLite;
  aml_matches: AmlMatch[];
  peak_aml_severity: AmlMatchSeverity | null;
  open_aml_high_flag: boolean;
  recommended_action: 'sanctions_review' | 'kyc_refresh' | 'monitor' | 'no_action';
}

// CSV-encode array filters so the BFF can split with .split(',')
function encodeCasesDetailParams(
  filter: CasesDetailFilter,
  format: CasesDetailFormat,
): Record<string, string | number | boolean | undefined> {
  return {
    format,
    ageBucket: filter.ageBucket,
    breached: filter.breached,
    from: filter.from,
    to: filter.to,
    branch: filter.branch,
    status: filter.status?.length ? filter.status.join(',') : undefined,
    severity: filter.severity?.length ? filter.severity.join(',') : undefined,
    q: filter.q,
    sort: filter.sort,
    dir: filter.dir,
    page: filter.page,
    page_size: filter.page_size,
  };
}

// ── SLA Breach Matrix types ─────────────────────────────────────────

export type SlaBucketLabel = '0-7 days' | '8-30 days' | '31-90 days' | '90+ days';
/** Compact slug for URL params + tile keys. Mapped 1:1 to SlaBucketLabel. */
export type SlaBucketSlug = '0-7d' | '8-30d' | '31-90d' | '90+d';

export const SLA_BUCKET_SLUG: Record<SlaBucketLabel, SlaBucketSlug> = {
  '0-7 days':   '0-7d',
  '8-30 days':  '8-30d',
  '31-90 days': '31-90d',
  '90+ days':   '90+d',
};
export const SLA_BUCKET_LABEL: Record<SlaBucketSlug, SlaBucketLabel> = {
  '0-7d':   '0-7 days',
  '8-30d':  '8-30 days',
  '31-90d': '31-90 days',
  '90+d':   '90+ days',
};

export interface SlaBucket {
  label: SlaBucketLabel;
  min_days: number;
  max_days: number | null;
  total_open: number;
  breached: number;
  breach_pct: number;
  severity_split: { high: number; medium: number; low: number };
}

export interface SlaBreachMatrix {
  buckets: SlaBucket[];
  generatedAt: string;
  filters: {
    tenant_id: string;
    branch?: string;
    business_unit?: string;
    as_of?: string;
  };
  uncategorised_count: number;
  unresolved_count: number;
}

export interface SlaConfigPatch {
  case_category: string;
  priority: 'P1' | 'P2' | 'P3' | 'P4';
  business_unit?: string | null;
  sla_target_days: number;
}

export interface SlaBreachMatrixPreview {
  current: SlaBreachMatrix;
  patched: SlaBreachMatrix;
  delta: {
    breached_total: number;
    by_bucket: Array<{
      label: SlaBucketLabel;
      current_breached: number;
      patched_breached: number;
      delta: number;
    }>;
  };
  patches: SlaConfigPatch[];
}

// ── SLA Config admin types ─────────────────────────────────────────

export type SlaConfigPriority = 'P1' | 'P2' | 'P3' | 'P4';
export type SlaConfigStatus = 'ACTIVE' | 'SUPERSEDED' | 'ARCHIVED';

export interface SlaConfigRow {
  sla_config_id: string;
  tenant_id: string;
  case_category: string;
  priority: SlaConfigPriority;
  business_unit: string | null;
  sla_target_days: number;
  status: SlaConfigStatus;
  effective_from: string;
  effective_till: string | null;
  notes: string | null;
  created_by: string;
  updated_by: string | null;
  superseded_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface SlaConfigCreateInput {
  case_category: string;
  priority: SlaConfigPriority;
  business_unit?: string | null;
  sla_target_days: number;
  notes?: string | null;
}

export interface SlaConfigUpdateInput {
  sla_target_days?: number;
  notes?: string | null;
}

// ── Notification Templates types (T6 M14.16) ───────────────────────

export type NotificationChannel = 'EMAIL' | 'SMS' | 'IN_APP';
export type NotificationTemplateStatus = 'DRAFT' | 'ACTIVE' | 'ARCHIVED';

export interface NotificationTemplateRow {
  template_id: string;
  tenant_id: string;
  name: string;
  channel: NotificationChannel;
  /** NULL for SMS, NON-NULL for EMAIL/IN_APP. */
  subject: string | null;
  body: string;
  locale: string;
  status: NotificationTemplateStatus;
  created_by: string;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface NotificationTemplateCreateInput {
  name: string;
  channel: NotificationChannel;
  subject?: string | null;
  body: string;
  locale?: string;
}

export interface NotificationTemplateUpdateInput {
  name?: string;
  subject?: string | null;
  body?: string;
  locale?: string;
}

// ── Notification render + dispatch (T6 M14.24) ─────────────────────

export interface NotificationRenderResult {
  channel: NotificationChannel;
  subject: string | null;
  body: string;
  /** Vars referenced in the template that were not provided AND have
   *  no `| default:` clause. Empty if the render was complete. */
  missing_vars: string[];
  /** Vars actually referenced by the template (distinct from
   *  Object.keys(vars) — only the ones used). */
  used_vars: string[];
}

export type NotificationDispatchTrigger =
  | 'admin_test_fire'
  | 'case_create_pipeline'
  | 'escalation_worker';

export type NotificationDispatchStatus = 'sent' | 'preview' | 'failed';

export interface NotificationDispatchEntry {
  dispatch_id: string;
  tenant_id: string;
  template_id: string;
  template_name: string;
  channel: NotificationChannel;
  recipient: string;
  trigger: NotificationDispatchTrigger;
  reference: string | null;
  rendered_subject: string | null;
  rendered_body: string;
  missing_vars: string[];
  status: NotificationDispatchStatus;
  status_reason: string | null;
  performed_by: string;
  performed_at: string;
}

export interface NotificationTestFireInput {
  vars: Record<string, unknown>;
  recipient: string;
  reference?: string | null;
  refuse_when_missing?: boolean;
}

// ── Escalation worker (T6 M14.25) ──────────────────────────────────

export interface EscalationOpenCase {
  case_id: string;
  case_category: string;
  priority: 'P1' | 'P2' | 'P3' | 'P4';
  opened_at: string;
  context_vars?: Record<string, unknown>;
}

export interface EscalationDueRow {
  case_id: string;
  case_category: string;
  priority: 'P1' | 'P2' | 'P3' | 'P4';
  level: 1 | 2 | 3;
  role: string;
  after_minutes: number;
  case_age_minutes: number;
  scenario_id: string;
  escalation_id: string;
  template_id: string | null;
  template_name: string;
  channel: NotificationChannel;
  rendered_subject: string | null;
  rendered_body: string;
  missing_vars: string[];
}

export interface EscalationPreviewResult {
  due: EscalationDueRow[];
  cases_inspected: number;
  cases_with_no_scenario: number;
  cases_with_archived_escalation: number;
  /** Number of (case, level) pairs that were due but already
   *  dispatched in a prior tick (filtered out before returning). */
  already_dispatched_count: number;
}

export interface EscalationTickResult extends EscalationPreviewResult {
  dispatched: NotificationDispatchEntry[];
}

/** Snapshot of the M14.25b cron's last-run state. When the cron isn't
 *  wired (default), `cron_wired=false` and the rest are zeros — same
 *  shape so the SPA renders uniformly. */
export interface EscalationWorkerStatus {
  running: boolean;
  interval_ms: number;
  tenants: readonly string[];
  total_runs: number;
  last_run_at: string | null;
  last_run_dispatched: number;
  last_run_inspected: number;
  last_error: string | null;
  cron_wired: boolean;
}

// ── Escalation Matrix types (T6 M14.17) ────────────────────────────

export const ESCALATION_ROLES = [
  'admin',
  'risk_analyst',
  'supervisor',
  'collection_officer',
  'field_officer',
] as const;
export type EscalationRole = (typeof ESCALATION_ROLES)[number];
export type EscalationStatus = 'ACTIVE' | 'ARCHIVED';
export type EscalationPriority = 'P1' | 'P2' | 'P3' | 'P4';

export interface EscalationMatrixRuleRow {
  escalation_id: string;
  tenant_id: string;
  name: string;
  case_category: string;
  priority: EscalationPriority;
  level_1_after_minutes: number;
  level_1_role: EscalationRole;
  level_2_after_minutes: number | null;
  level_2_role: EscalationRole | null;
  level_3_after_minutes: number | null;
  level_3_role: EscalationRole | null;
  status: EscalationStatus;
  created_by: string;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface EscalationMatrixCreateInput {
  name: string;
  case_category: string;
  priority: EscalationPriority;
  level_1_after_minutes: number;
  level_1_role: EscalationRole;
  level_2_after_minutes?: number | null;
  level_2_role?: EscalationRole | null;
  level_3_after_minutes?: number | null;
  level_3_role?: EscalationRole | null;
}

export interface EscalationMatrixUpdateInput {
  name?: string;
  level_1_after_minutes?: number;
  level_1_role?: EscalationRole;
  level_2_after_minutes?: number | null;
  level_2_role?: EscalationRole | null;
  level_3_after_minutes?: number | null;
  level_3_role?: EscalationRole | null;
}

// ── Case Scenarios types (T6 M14.18) ───────────────────────────────

export type CaseScenarioStatus = 'DRAFT' | 'ACTIVE' | 'ARCHIVED';
export type CaseScenarioPriority = 'P1' | 'P2' | 'P3' | 'P4';

export interface CaseScenarioChecklistItem {
  title: string;
  required: boolean;
}

export interface CaseScenarioRow {
  scenario_id: string;
  tenant_id: string;
  name: string;
  case_category: string;
  priority: CaseScenarioPriority;
  trigger_indicator_id: string | null;
  trigger_threshold: number | null;
  default_escalation_id: string;
  notification_template_id: string | null;
  checklist: CaseScenarioChecklistItem[];
  status: CaseScenarioStatus;
  created_by: string;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface CaseScenarioCreateInput {
  name: string;
  case_category: string;
  priority: CaseScenarioPriority;
  trigger_indicator_id?: string | null;
  trigger_threshold?: number | null;
  default_escalation_id: string;
  notification_template_id?: string | null;
  checklist?: CaseScenarioChecklistItem[];
}

export interface CaseScenarioUpdateInput {
  name?: string;
  case_category?: string;
  priority?: CaseScenarioPriority;
  trigger_indicator_id?: string | null;
  trigger_threshold?: number | null;
  default_escalation_id?: string;
  notification_template_id?: string | null;
  checklist?: CaseScenarioChecklistItem[];
}

export type CaseScenarioHistoryAction =
  | 'create'
  | 'update'
  | 'activate'
  | 'archive'
  | 'restore';

export type CaseScenarioDiffOp =
  | { op: 'add'; path: string; value: unknown }
  | { op: 'remove'; path: string }
  | { op: 'replace'; path: string; value: unknown };

export interface CaseScenarioHistoryEntry {
  history_id: number;
  scenario_id: string;
  tenant_id: string;
  action: CaseScenarioHistoryAction;
  diff: CaseScenarioDiffOp[];
  after_state: Record<string, unknown>;
  performed_by: string;
  performed_at: string;
}

// ── User Access Override types ──────────────────────────────────────

export type OverrideType = 'GRANT' | 'REVOKE';
export type PermissionType = 'VIEW' | 'EDIT' | 'APPROVE' | 'FULL';
export type OverrideStatus =
  | 'PENDING_APPROVAL'
  | 'ACTIVE'
  | 'REJECTED'
  | 'REVOKED'
  | 'EXPIRED';

/** Server-allowlisted SPA module identifiers — keep in sync with
 *  services/bff/src/admin/types.ts MODULE_PATH_ALLOWLIST. */
export const MODULE_PATH_TREE: ReadonlyArray<{ group: string; paths: ReadonlyArray<{ value: string; label: string }> }> = [
  {
    group: 'Dashboard',
    paths: [{ value: 'dashboard', label: 'Dashboard' }],
  },
  {
    group: 'Alerts',
    paths: [
      { value: 'alerts', label: 'Alert list' },
      { value: 'alerts.detail', label: 'Alert detail' },
    ],
  },
  {
    group: 'Customers',
    paths: [
      { value: 'customers', label: 'Customer list' },
      { value: 'customers.detail', label: 'Customer 360' },
    ],
  },
  {
    group: 'Rules',
    paths: [
      { value: 'rules', label: 'Rule list' },
      { value: 'rules.detail', label: 'Rule detail' },
      { value: 'rules.builder', label: 'Rule builder' },
      { value: 'rules.ews', label: 'EWS rules' },
    ],
  },
  {
    group: 'Cases',
    paths: [
      { value: 'cases', label: 'Case list' },
      { value: 'cases.detail', label: 'Case detail' },
      { value: 'cases.cms', label: 'CMS case list' },
      { value: 'cases.cms.detail', label: 'CMS case detail' },
    ],
  },
  {
    group: 'Scenarios',
    paths: [
      { value: 'scenarios', label: 'Scenario list' },
      { value: 'scenarios.detail', label: 'Scenario detail' },
    ],
  },
  {
    group: 'Reports',
    paths: [
      { value: 'reports', label: 'Reports landing' },
      { value: 'reports.snapshot', label: 'Snapshot report' },
      { value: 'reports.alerts', label: 'Alerts report' },
      { value: 'reports.cases', label: 'Cases report' },
      { value: 'reports.rbi', label: 'RBI report' },
    ],
  },
  {
    group: 'Admin',
    paths: [
      { value: 'admin.users', label: 'User management' },
      { value: 'admin.audit-log', label: 'Audit log' },
      { value: 'admin.integrations', label: 'Integrations' },
      { value: 'admin.webhooks', label: 'Webhooks' },
      { value: 'admin.tenants', label: 'Tenants' },
      { value: 'admin.user-access-override', label: 'User access override' },
      { value: 'integrations.health', label: 'Integration health' },
    ],
  },
  {
    group: 'Profile',
    paths: [
      { value: 'profile.sessions', label: 'My sessions' },
      { value: 'profile.activity', label: 'Login activity' },
    ],
  },
] as const;

export interface UserAccessOverride {
  override_id: string;
  tenant_id: string;
  user_id: string;
  module_path: string;
  override_type: OverrideType;
  permission_type: PermissionType;
  effective_from: string;
  effective_till: string | null;
  reason: string;
  requires_approval: boolean;
  status: OverrideStatus;
  created_by: string;
  approved_by: string | null;
  rejected_by: string | null;
  revoked_by: string | null;
  rejection_reason: string | null;
  revocation_reason: string | null;
  approval_note: string | null;
  created_at: string;
  updated_at: string;
  approved_at: string | null;
  rejected_at: string | null;
  revoked_at: string | null;
}

export interface CreateOverrideInput {
  user_id: string;
  module_paths: string[];
  override_type: OverrideType;
  permission_type: PermissionType;
  effective_from: string;
  effective_till: string | null;
  reason: string;
  requires_approval: boolean;
}

export interface UpdateOverrideInput {
  module_paths?: string[];
  override_type?: OverrideType;
  permission_type?: PermissionType;
  effective_from?: string;
  effective_till?: string | null;
  reason?: string;
}

export interface EffectiveAccessRow {
  module_path: string;
  permissions: PermissionType[];
  source: string;
}

export interface EffectiveAccess {
  user_id: string;
  computed_at: string;
  role_access: { roles: string[]; modules: EffectiveAccessRow[] };
  overrides_applied: UserAccessOverride[];
  effective: EffectiveAccessRow[];
}

/**
 * Branch + department lookup keyed by user_id. Mirrors the seeds in
 * 017_user_branch_department.sql for the 5 demo accounts. The SPA list
 * page joins this client-side for filter dropdowns until a real
 * users-with-branch endpoint lands.
 */
export const USER_BRANCH_MAP: Record<string, { branch: string; department: string }> = {
  'u-001': { branch: 'BR-NRB-01', department: 'Risk Operations' },
  'u-002': { branch: 'BR-NRB-02', department: 'Risk Analytics' },
  'u-003': { branch: 'BR-NRB-01', department: 'Risk Operations' },
  'u-004': { branch: 'BR-MSA-01', department: 'Collections' },
  'u-005': { branch: 'BR-MSA-02', department: 'Field Ops' },
};

export type AdminAuditEntityType =
  | 'user_access_override'
  | 'report_export'
  | 'ews_rule_version';

export type AdminAuditAction =
  | 'create'
  | 'update'
  | 'approve'
  | 'reject'
  | 'revoke'
  | 'expire'
  | 'export'
  | 'view'
  | 'revert';

export interface AdminAuditLogRow {
  audit_id: string;
  tenant_id: string;
  entity_type: AdminAuditEntityType;
  entity_id: string;
  action: AdminAuditAction;
  actor_id: string;
  actor_role: string;
  before_state: unknown | null;
  after_state: unknown | null;
  reason: string | null;
  request_id: string | null;
  ip_address: string | null;
  user_agent: string | null;
  created_at: string;
}

// ── Envelope helper + tenant types (T4.24 Phase 12) ──────────────────

/** Bank-grade envelope shape returned by /v1/* JSON endpoints (Phase 8).
 *  http.ts now auto-unwraps the {header, body} envelope at the interceptor
 *  level, so callers see `body` directly. This type is a transparent alias
 *  preserved so existing call-site type annotations stay valid. */
export type EnvelopeBody<T> = T;
/** Original raw envelope shape — kept for any code that still needs to
 *  introspect the full {header, body}. Most call sites should NOT use this. */
export interface RawEnvelope<T> {
  header: {
    status: 'SUCCESS' | 'FAILURE';
    code: string;
    message: string;
    requestId: string;
    timestamp: string;
  };
  body: T;
}

export type TenantVertical = 'banking' | 'insurance';

export interface Tenant {
  tenant_id: string;
  name: string;
  vertical: TenantVertical;
  channels_allowed: string[];
  active: boolean;
}

export interface TenantCreateInput {
  tenant_id: string;
  name: string;
  vertical: TenantVertical;
  channels_allowed: string[];
  active?: boolean;
}

export interface TenantPatch {
  name?: string;
  channels_allowed?: string[];
  active?: boolean;
}

// ── Recovery Center types ─────────────────────────────────────────────

export type RecoveryStatus = 'archived' | 'restored' | 'purged';
export type RecoveryModule =
  | 'bff'
  | 'auth-svc'
  | 'cases-svc'
  | 'alerts-svc'
  | 'rules-svc';

export interface DeletedRecord {
  recovery_id: string;
  tenant_id: string;
  module: RecoveryModule;
  entity_type: string;
  original_id: string;
  original_table: string;
  payload: Record<string, unknown>;
  deleted_by: string;
  deleted_at: string;
  deletion_reason: string | null;
  source_action: string | null;
  prior_status: string | null;
  restored_at: string | null;
  restored_by: string | null;
  purged_at: string | null;
  purged_by: string | null;
  status: RecoveryStatus;
}

export interface RecoveryListParams {
  module?: RecoveryModule;
  entity_type?: string;
  deleted_by?: string;
  status?: RecoveryStatus;
  since?: string;
  until?: string;
  page?: number;
  page_size?: number;
}

export interface RecoveryStats {
  total: number;
  by_status: Record<RecoveryStatus, number>;
  by_module: Record<string, number>;
  by_entity_type: Record<string, number>;
  most_recent_at: string | null;
  adapters: Array<{
    entity_type: string;
    display_name: string;
    module: RecoveryModule;
  }>;
}

// ── Phase 3 analytics endpoint ────────────────────────────────────

export interface RecoveryDayBucket {
  date: string; // YYYY-MM-DD UTC
  total: number;
  by_status: Record<RecoveryStatus, number>;
}

export interface RecoveryActorRow {
  actor_username: string;
  total_archives: number;
  total_restores: number;
  total_purges: number;
  most_recent_at: string;
}

export interface RecoveryEntityRow {
  entity_type: string;
  total_archives: number;
  total_restores: number;
  total_purges: number;
  outstanding_delta: number;
}

export interface RecoveryModuleRow {
  module: string;
  total_archives: number;
  total_restores: number;
  total_purges: number;
}

export interface RecoveryAnalytics {
  tenant_id: string;
  generated_at: string;
  days: number;
  window_start: string;
  window_end: string;
  total_archives_in_window: number;
  total_restores_in_window: number;
  total_purges_in_window: number;
  by_day: RecoveryDayBucket[];
  top_actors: RecoveryActorRow[];
  by_entity_type: RecoveryEntityRow[];
  by_module: RecoveryModuleRow[];
  restore_rate: number | null;
  purge_rate: number | null;
  mean_time_to_restore_hours: number | null;
  p50_time_to_restore_hours: number | null;
  p95_time_to_restore_hours: number | null;
}

// ── Module 1.5 — Anomaly Detection response shapes ────────────────────
export type AnomalyPattern =
  | 'txn_volume_spike'
  | 'geo_velocity'
  | 'channel_shift'
  | 'amount_outlier'
  | 'frequency_outlier'
  | 'schema_drift'
  | 'pipeline_lag'
  | 'duplicate_burst';

export type AnomalySeverity = 'low' | 'medium' | 'high' | 'critical';
export type AnomalyStatus = 'open' | 'acknowledged' | 'investigating' | 'resolved' | 'false_positive';

export interface AnomalyStatusUpdate {
  status: AnomalyStatus;
  actor_username: string;
  notes: string | null;
  changed_at: string;
}

export interface AnomalySummary {
  anomaly_id: string;
  tenant_id: string;
  pattern: AnomalyPattern;
  severity: AnomalySeverity;
  status: AnomalyStatus;
  source_id: string;
  detected_at: string;
  anomaly_score: number;
  affected_records: number;
  description: string;
  customer_id: string | null;
  metadata: Record<string, unknown>;
  case_id?: string | null;
  status_updates?: AnomalyStatusUpdate[];
  injected?: boolean;
}

export interface AnomalyListReport {
  tenant_id: string;
  generated_at: string;
  total: number;
  by_severity: Record<AnomalySeverity, number>;
  by_pattern: Partial<Record<AnomalyPattern, number>>;
  by_status: Record<AnomalyStatus, number>;
  anomalies: AnomalySummary[];
}

export interface AnomalyTimeSeriesPoint {
  ts: string;
  value: number;
  is_outlier: boolean;
}

export interface AnomalyDetail extends AnomalySummary {
  time_series: AnomalyTimeSeriesPoint[];
  score_100: number;
}

export interface AnomalyPatternConfigRow {
  pattern: AnomalyPattern;
  enabled: boolean;
  threshold: number;
}

export interface AnomalyPatternsConfigEnvelope {
  tenant_id: string;
  patterns: AnomalyPatternConfigRow[];
}

export interface AnomalyPatternConfigUpdate {
  pattern: AnomalyPattern;
  enabled?: boolean;
  threshold?: number;
}

export interface AnomalyRerunSummary {
  tenant_id: string;
  run_id: string;
  triggered_by: string;
  triggered_at: string;
  scanned_records: number;
  patterns_evaluated: number;
  new_anomalies: number;
  duration_ms: number;
}

// ── Module 1.6 — Reconciliation response shapes ───────────────────────
export type ReconKind = 'count_only' | 'amount_match' | 'set_diff';
export type ReconSeverity = 'high' | 'medium' | 'low';
export type ReconRunStatus = 'running' | 'balanced' | 'breaks_found' | 'error';

export interface ReconDefinitionShape {
  recon_id: string;
  tenant_id: string;
  name: string;
  description: string | null;
  source_label: string;
  target_label: string;
  kind: ReconKind;
  key_field: string;
  amount_field: string | null;
  amount_tolerance: number;
  severity: ReconSeverity;
  active: boolean;
  created_at: string;
  created_by: string;
  updated_at: string;
  updated_by: string;
  deleted_at: string | null;
  deleted_by: string | null;
}

export interface ReconBreakShape {
  key: string;
  kind: 'source_only' | 'target_only' | 'amount_mismatch';
  source_amount: number | null;
  target_amount: number | null;
  delta: number | null;
}

export interface ReconRunShape {
  run_id: string;
  tenant_id: string;
  recon_id: string;
  recon_kind: ReconKind;
  recon_severity: ReconSeverity;
  source_label: string;
  target_label: string;
  started_at: string;
  finished_at: string;
  status: ReconRunStatus;
  source_count: number;
  target_count: number;
  matched_count: number;
  source_only_count: number;
  target_only_count: number;
  amount_mismatch_count: number;
  source_total: number | null;
  target_total: number | null;
  difference: number | null;
  sample_breaks: ReconBreakShape[];
  error_message: string | null;
  triggered_by: string;
  accepted_at?: string | null;
  accepted_by?: string | null;
  accepted_reason?: string | null;
}

export interface ReconDashboardRollupShape {
  tenant_id: string;
  generated_at: string;
  total_definitions: number;
  active_definitions: number;
  total_runs: number;
  total_balanced: number;
  total_breaks_found: number;
  total_error: number;
  total_breaks_24h: number;
  by_severity: Record<ReconSeverity, { definitions: number; runs: number; breaks_24h: number }>;
  by_kind: Record<ReconKind, { definitions: number; runs: number }>;
  definitions_status: Array<{
    recon_id: string;
    name: string;
    kind: ReconKind;
    severity: ReconSeverity;
    latest_status: ReconRunStatus | null;
    latest_breaks: number | null;
    latest_difference: number | null;
    latest_at: string | null;
    runs_total: number;
    breaks_24h: number;
  }>;
}

// ── Module 1.7 — Data Quality Score response shapes ────────────────────
export type DqDimension = 'completeness' | 'validity' | 'consistency' | 'uniqueness' | 'timeliness';
export type DqScoreSource =
  | 'cbs_loans' | 'cbs_repayments' | 'cbs_txns'
  | 'mart_customer_360' | 'mart_loan_360' | 'bureau_score';
export type DimensionWeights = Record<DqDimension, number>;

export interface DqDimensionScoreShape {
  dimension: DqDimension;
  score: number;
  weight: number;
  samples: number;
}

export interface DqSourceScoreShape {
  source_id: DqScoreSource;
  composite_score: number;
  dimensions: DqDimensionScoreShape[];
  attributes: number;
  last_evaluated_at: string;
  rows_evaluated: number;
}

export interface DqAttributeScoreShape {
  source_id: DqScoreSource;
  attribute: string;
  composite_score: number;
  dimensions: DqDimensionScoreShape[];
  last_evaluated_at: string;
  format_detected?: string | null;
}

export interface DqTrendPointShape {
  date: string;
  composite_score: number;
  dimensions: Record<DqDimension, number>;
}

export interface DqSourceTrendShape {
  source_id: DqScoreSource;
  window_days: number;
  trend: DqTrendPointShape[];
  start_date: string;
  end_date: string;
}

export interface DqBySourceShape {
  tenant_id: string;
  generated_at: string;
  weights: DimensionWeights;
  score: DqSourceScoreShape;
  trend: DqSourceTrendShape;
}

export interface DqByAttributeShape {
  tenant_id: string;
  source_id: DqScoreSource;
  attribute: string | null;
  generated_at: string;
  weights: DimensionWeights;
  total: number;
  items: DqAttributeScoreShape[];
}

export interface DqScoreDashboardShape {
  tenant_id: string;
  generated_at: string;
  total_rules: number;
  active_rules: number;
  total_executions: number;
  total_passed: number;
  total_failed: number;
  total_error: number;
  rules_status: Array<{
    rule_id: string;
    name: string;
    kind: string;
    severity: string;
    latest_status: string | null;
    latest_pass_rate: number | null;
    latest_at: string | null;
    executions_total: number;
    failures_24h: number;
  }>;
  score_overlay: {
    tenant_id: string;
    generated_at: string;
    weights: DimensionWeights;
    by_source: DqSourceScoreShape[];
    fleet_composite_score: number;
    worst_source: { source_id: DqScoreSource; composite_score: number } | null;
    best_source: { source_id: DqScoreSource; composite_score: number } | null;
  };
}

export interface DqExecutionShape {
  execution_id: string;
  rule_id: string;
  rule_name: string;
  rule_kind: string;
  rule_severity: string;
  started_at: string;
  finished_at: string;
  status: string;
  total_records: number;
  passed_records: number;
  failed_records: number;
  sample_failures?: Array<Record<string, unknown>>;
  error_message?: string | null;
  triggered_by: string;
}

// ── Module 2.1 — Borrower Watch response shapes ───────────────────────
export type BorrowerSeverity = 'S1' | 'S2' | 'S3';
export type BorrowerSector =
  | 'manufacturing' | 'services' | 'retail' | 'agriculture'
  | 'real_estate' | 'msme' | 'corporate' | 'consumer';
export type BorrowerSegment = 'retail' | 'sme' | 'corporate' | 'priority_sector';
export type BorrowerRegion = 'north' | 'south' | 'east' | 'west' | 'central' | 'northeast';
export type BorrowerSortKey = 'ews_score' | 'exposure_inr' | 'dpd' | 'last_alert_at' | 'name';

export interface BorrowerWatchRowShape {
  borrower_id: string;
  name: string;
  sector: BorrowerSector;
  segment: BorrowerSegment;
  region: BorrowerRegion;
  exposure_inr: number;
  pd: number;
  ews_score: number;
  severity: BorrowerSeverity;
  top_signal: string;
  last_alert_at: string | null;
  watchlist_tag: string | null;
  dpd: number;
}

export interface BorrowerListReportShape {
  tenant_id: string;
  generated_at: string;
  mode: 'stressed' | 'all';
  total: number;
  total_unfiltered: number;
  sort: { key: BorrowerSortKey; order: 'desc' | 'asc' };
  by_severity: Record<BorrowerSeverity, number>;
  by_sector: Partial<Record<BorrowerSector, number>>;
  items: BorrowerWatchRowShape[];
}

export interface CohortCmaPackShape {
  pack_id: string;
  tenant_id: string;
  generated_at: string;
  generated_by: string;
  cohort_size: number;
  borrowers: Array<{
    borrower_id: string;
    name: string;
    sector: BorrowerSector;
    exposure_inr: number;
    ews_score: number;
    severity: BorrowerSeverity;
  }>;
  totals: {
    exposure_inr: number;
    mean_ews_score: number;
    by_severity: Record<BorrowerSeverity, number>;
    by_sector: Partial<Record<BorrowerSector, number>>;
  };
  download_filename: string;
}

// ── Module 2.1 helpers — response shapes ───────────────────────────────
export interface RiskProfileShape {
  id: string;
  name?: string;
  pd: number;
  level: 'Low' | 'Medium' | 'High';
  exposure: number;
  dpd: number;
  top_reasons?: Array<{ feature: string; value: unknown; shap_value: number; direction: 'positive' | 'negative' }>;
  model_name?: string;
  model_version?: string;
}

export interface WatchlistEntryShape {
  customer_id: string;
  tenant_id: string;
  reason: string;
  vertical: 'banking' | 'insurance' | null;
  added_by: string;
  added_at: string;
}
