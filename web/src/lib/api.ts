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
};

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
