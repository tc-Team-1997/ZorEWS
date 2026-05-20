// services/bff/src/reports/builder_catalog.ts
//
// T4.6.1 — Self-service reporting: canonical data source catalog.
//
// Closed enum of every queryable surface in the mart + app_* layers.
// Each entry declares its field schema + drill-targets + tenant
// scoping + minimum RBAC role to query. Used by:
//   - T4.6.2 filter compiler (whitelist fields + type-check values).
//   - T4.6.3 saved-report store (validate definition references).
//   - T4.6.4 execution engine (route to correct underlying table).
//   - SPA T4.6.5 (drop-down + form builder).
//
// Adding a new data source requires a code change here — intentional,
// not a runtime configuration surface. Schema additions to mart/app_*
// must be reflected manually for correctness.
//
// Pure data + getters. No I/O.

// ─── Public types ──────────────────────────────────────────────────────

export type ReportFieldType =
  | 'string'
  | 'integer'
  | 'number'
  | 'boolean'
  | 'date'
  | 'datetime'
  | 'enum';

export interface ReportField {
  name: string;
  display_name: string;
  type: ReportFieldType;
  /** Required for type='enum'. */
  enum_values?: readonly string[];
  /** Caller may filter on this field. */
  filterable: boolean;
  /** Caller may GROUP BY this field. */
  groupable: boolean;
  /** Caller may apply SUM/AVG/MIN/MAX (subset depends on type). */
  aggregatable: boolean;
  /** SPA masks the value unless caller has `customers:read_pii` scope. */
  pii: boolean;
  /** Free-text hint shown next to the field in the SPA builder. */
  description?: string;
}

export interface DrillTarget {
  to_source_id: string;
  via_field: string;
  display_name: string;
}

export type ReportDataSourceSchema =
  | 'mart'
  | 'app_alerts'
  | 'app_cases'
  | 'app_audit'
  | 'audit';

export interface ReportDataSource {
  source_id: string;
  display_name: string;
  description: string;
  schema: ReportDataSourceSchema;
  /** Underlying table name within the schema. Resolver builds `<schema>.<table>`. */
  table: string;
  fields: readonly ReportField[];
  /** Field names the SPA pre-populates as filters when the user picks this source. */
  default_filter_fields: readonly string[];
  drill_targets: readonly DrillTarget[];
  tenant_scoped: boolean;
  /** Minimum RBAC scope required to query. */
  required_role:
    | 'customers:read_risk_profile'
    | 'cases:list'
    | 'alerts:list'
    | 'audit:read';
}

export class ReportCatalogError extends Error {
  constructor(
    public readonly code: 'unknown_source' | 'unknown_field',
    message: string,
  ) {
    super(message);
    this.name = 'ReportCatalogError';
  }
}

// ─── Field-set shorthand helpers ──────────────────────────────────────

function f(
  name: string,
  display_name: string,
  type: ReportFieldType,
  opts: Partial<Omit<ReportField, 'name' | 'display_name' | 'type'>> = {},
): ReportField {
  return {
    name,
    display_name,
    type,
    filterable: opts.filterable ?? true,
    groupable: opts.groupable ?? (type !== 'number'),
    aggregatable: opts.aggregatable ?? (type === 'integer' || type === 'number'),
    pii: opts.pii ?? false,
    enum_values: opts.enum_values,
    description: opts.description,
  };
}

// ─── Catalog ──────────────────────────────────────────────────────────

const SOURCES: readonly ReportDataSource[] = [
  // ── mart.customer_360 ─────────────────────────────────────────────
  {
    source_id: 'mart.customer_360',
    display_name: 'Customer 360',
    description:
      'One row per customer with risk band, PD score, utilization, exposure, KYC + bureau snapshot.',
    schema: 'mart',
    table: 'customer_360',
    fields: [
      f('customer_id', 'Customer ID', 'string', { aggregatable: false, pii: true }),
      f('name', 'Name', 'string', { aggregatable: false, groupable: false, pii: true }),
      f('vertical', 'Vertical', 'enum', { enum_values: ['banking', 'insurance'] }),
      f('risk_level', 'Risk Level', 'enum', {
        enum_values: ['Low', 'Medium', 'High'],
      }),
      f('pd_score', 'PD Score', 'number'),
      f('utilization', 'Utilization', 'number'),
      f('exposure_kes', 'Exposure (KES)', 'number'),
      f('dpd_max_90d', 'Max DPD (90d)', 'integer'),
      f('bureau_score', 'Bureau Score', 'integer'),
      f('tenure_months', 'Tenure (months)', 'integer'),
      f('has_npa', 'Has NPA', 'boolean'),
      f('kyc_status', 'KYC Status', 'enum', {
        enum_values: ['pending', 'verified', 'rejected', 'expired'],
      }),
      f('onboarded_at', 'Onboarded', 'date'),
      f('as_of', 'Snapshot', 'datetime', { filterable: true, groupable: false }),
    ],
    default_filter_fields: ['risk_level', 'has_npa', 'utilization'],
    drill_targets: [
      { to_source_id: 'mart.loan_360', via_field: 'customer_id', display_name: 'Loans' },
      { to_source_id: 'mart.indicator_values', via_field: 'customer_id', display_name: 'Indicator history' },
      { to_source_id: 'app_alerts.alerts', via_field: 'customer_id', display_name: 'Alerts' },
      { to_source_id: 'app_cases.cases', via_field: 'customer_id', display_name: 'Cases' },
    ],
    tenant_scoped: true,
    required_role: 'customers:read_risk_profile',
  },

  // ── mart.loan_360 ─────────────────────────────────────────────────
  {
    source_id: 'mart.loan_360',
    display_name: 'Loan 360',
    description:
      'Loan-level facts joined to repayment aggregates: outstanding balance, worst DPD, NPA flag.',
    schema: 'mart',
    table: 'loan_360',
    fields: [
      f('loan_id', 'Loan ID', 'string', { aggregatable: false }),
      f('customer_id', 'Customer ID', 'string', { aggregatable: false, pii: true }),
      f('product_code', 'Product', 'enum', {
        enum_values: ['PL_RET', 'AUTO_RET', 'INV_SME', 'WC_SME', 'CORP_TL'],
      }),
      f('outstanding_balance', 'Outstanding (KES)', 'number'),
      f('original_principal', 'Original Principal', 'number'),
      f('worst_dpd', 'Worst DPD', 'integer'),
      f('repayment_count', 'Repayments', 'integer'),
      f('has_npa', 'Is NPA', 'boolean'),
      f('npa_status', 'NPA Status', 'enum', {
        enum_values: ['STANDARD', 'SPECIAL_MENTION', 'SUBSTANDARD', 'DOUBTFUL', 'LOSS'],
      }),
      f('disbursed_at', 'Disbursed', 'date'),
      f('maturity_at', 'Maturity', 'date'),
    ],
    default_filter_fields: ['product_code', 'has_npa', 'worst_dpd'],
    drill_targets: [
      { to_source_id: 'mart.customer_360', via_field: 'customer_id', display_name: 'Customer' },
    ],
    tenant_scoped: true,
    required_role: 'customers:read_risk_profile',
  },

  // ── mart.txn_features ─────────────────────────────────────────────
  {
    source_id: 'mart.txn_features',
    display_name: 'Transaction Features',
    description:
      'Per-customer transaction aggregates over 30/60/90 day windows with z-scores.',
    schema: 'mart',
    table: 'txn_features',
    fields: [
      f('customer_id', 'Customer ID', 'string', { aggregatable: false, pii: true }),
      f('txn_count_30d', 'Txn count 30d', 'integer'),
      f('txn_count_90d', 'Txn count 90d', 'integer'),
      f('txn_volume_30d', 'Txn volume 30d', 'number'),
      f('txn_volume_90d', 'Txn volume 90d', 'number'),
      f('txn_volume_zscore_90d', 'Z-score 90d', 'number'),
      f('avg_balance_30d', 'Avg balance 30d', 'number'),
      f('balance_drop_30d_pct', 'Balance drop 30d %', 'number'),
      f('as_of', 'Snapshot', 'datetime', { filterable: true, groupable: false }),
    ],
    default_filter_fields: ['txn_volume_zscore_90d'],
    drill_targets: [
      { to_source_id: 'mart.customer_360', via_field: 'customer_id', display_name: 'Customer' },
    ],
    tenant_scoped: true,
    required_role: 'customers:read_risk_profile',
  },

  // ── mart.indicator_values ────────────────────────────────────────
  {
    source_id: 'mart.indicator_values',
    display_name: 'Indicator Values',
    description:
      'Computed indicator values per customer per indicator id with breach severity.',
    schema: 'mart',
    table: 'indicator_values',
    fields: [
      f('customer_id', 'Customer ID', 'string', { aggregatable: false, pii: true }),
      f('indicator_id', 'Indicator', 'string', { aggregatable: false }),
      f('value', 'Value', 'number'),
      f('breach_severity', 'Severity', 'enum', {
        enum_values: ['yellow', 'orange', 'red'],
      }),
      f('as_of', 'Computed', 'datetime', { filterable: true, groupable: false }),
    ],
    default_filter_fields: ['indicator_id', 'breach_severity'],
    drill_targets: [
      { to_source_id: 'mart.customer_360', via_field: 'customer_id', display_name: 'Customer' },
    ],
    tenant_scoped: true,
    required_role: 'customers:read_risk_profile',
  },

  // ── app_alerts.alerts ─────────────────────────────────────────────
  {
    source_id: 'app_alerts.alerts',
    display_name: 'Alerts',
    description:
      'Alert ledger with severity, status, assignee, criticality score, customer exposure.',
    schema: 'app_alerts',
    table: 'alerts',
    fields: [
      f('alert_id', 'Alert ID', 'string', { aggregatable: false }),
      f('customer_id', 'Customer ID', 'string', { aggregatable: false, pii: true }),
      f('rule_id', 'Rule', 'string', { aggregatable: false }),
      f('severity', 'Severity', 'enum', {
        enum_values: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'],
      }),
      f('status', 'Status', 'enum', {
        enum_values: ['open', 'acked', 'closed'],
      }),
      f('assignee', 'Assignee', 'string', { aggregatable: false, pii: true }),
      f('criticality_score', 'Criticality', 'number'),
      f('customer_exposure_kes', 'Exposure (KES)', 'number'),
      f('raised_at', 'Raised', 'datetime'),
      f('acked_at', 'Acked', 'datetime'),
      f('closed_at', 'Closed', 'datetime'),
    ],
    default_filter_fields: ['severity', 'status', 'criticality_score'],
    drill_targets: [
      { to_source_id: 'mart.customer_360', via_field: 'customer_id', display_name: 'Customer' },
      { to_source_id: 'app_cases.cases', via_field: 'alert_id', display_name: 'Linked case' },
    ],
    tenant_scoped: true,
    required_role: 'alerts:list',
  },

  // ── app_cases.cases ───────────────────────────────────────────────
  {
    source_id: 'app_cases.cases',
    display_name: 'Cases',
    description:
      'Investigation cases — state, outcome, assignee, SLA status, owning officer.',
    schema: 'app_cases',
    table: 'cases',
    fields: [
      f('case_id', 'Case ID', 'string', { aggregatable: false }),
      f('alert_id', 'Origin Alert', 'string', { aggregatable: false }),
      f('customer_id', 'Customer ID', 'string', { aggregatable: false, pii: true }),
      f('state', 'State', 'enum', {
        enum_values: ['open', 'assigned', 'in_action', 'monitored', 'closed'],
      }),
      f('outcome', 'Outcome', 'enum', {
        enum_values: ['cured', 'cured_temp', 'defaulted'],
      }),
      f('assignee', 'Assignee', 'string', { aggregatable: false, pii: true }),
      f('sla_status', 'SLA Status', 'enum', {
        enum_values: ['on_track', 'approaching', 'breached', 'closed'],
      }),
      f('severity', 'Severity', 'enum', {
        enum_values: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'],
      }),
      f('opened_at', 'Opened', 'datetime'),
      f('closed_at', 'Closed', 'datetime'),
    ],
    default_filter_fields: ['state', 'sla_status', 'severity'],
    drill_targets: [
      { to_source_id: 'mart.customer_360', via_field: 'customer_id', display_name: 'Customer' },
      { to_source_id: 'app_alerts.alerts', via_field: 'alert_id', display_name: 'Origin alert' },
    ],
    tenant_scoped: true,
    required_role: 'cases:list',
  },

  // ── app_audit.approvals ───────────────────────────────────────────
  {
    source_id: 'app_audit.approvals',
    display_name: 'Maker-Checker Approvals',
    description:
      'Cross-cutting approval ledger — CAS submission/review + CAP propose/approve (T4.20).',
    schema: 'app_audit',
    table: 'approvals',
    fields: [
      f('approval_id', 'Approval ID', 'string', { aggregatable: false }),
      f('subject_type', 'Subject', 'enum', {
        enum_values: ['case', 'cas', 'cap', 'rule', 'config'],
      }),
      f('subject_id', 'Subject ID', 'string', { aggregatable: false }),
      f('action', 'Action', 'string', { aggregatable: false }),
      f('status', 'Status', 'enum', {
        enum_values: ['pending', 'approved', 'rejected', 'cancelled'],
      }),
      f('maker', 'Maker', 'string', { aggregatable: false, pii: true }),
      f('checker', 'Checker', 'string', { aggregatable: false, pii: true }),
      f('proposed_at', 'Proposed', 'datetime'),
      f('reviewed_at', 'Reviewed', 'datetime'),
      f('sla_due_at', 'SLA Due', 'datetime'),
    ],
    default_filter_fields: ['subject_type', 'status', 'proposed_at'],
    drill_targets: [],
    tenant_scoped: true,
    required_role: 'audit:read',
  },

  // ── audit.event_log ───────────────────────────────────────────────
  {
    source_id: 'audit.event_log',
    display_name: 'Audit Chain Events',
    description:
      'Hash-chained event log — every audit event with prev_hash + event_hash. WORM-backed via S3 Object Lock.',
    schema: 'audit',
    table: 'event_log',
    fields: [
      f('event_id', 'Event ID', 'string', { aggregatable: false }),
      f('actor_username', 'Actor', 'string', { aggregatable: false, pii: true }),
      f('actor_role', 'Role', 'enum', {
        enum_values: ['admin', 'risk_analyst', 'supervisor', 'collection_officer', 'field_officer'],
      }),
      f('action', 'Action', 'string', { aggregatable: false }),
      f('resource_type', 'Resource', 'enum', {
        enum_values: ['user', 'session', 'config', 'case', 'alert', 'report', 'scenario', 'rule', 'integration', 'system'],
      }),
      f('resource_id', 'Resource ID', 'string', { aggregatable: false }),
      f('outcome', 'Outcome', 'enum', {
        enum_values: ['success', 'failure', 'denied'],
      }),
      f('severity', 'Severity', 'enum', {
        enum_values: ['info', 'warning', 'critical'],
      }),
      f('ts', 'Timestamp', 'datetime'),
    ],
    default_filter_fields: ['resource_type', 'outcome', 'severity', 'ts'],
    drill_targets: [],
    tenant_scoped: true,
    required_role: 'audit:read',
  },
];

// ─── Accessors ─────────────────────────────────────────────────────────

export function listReportSources(): readonly ReportDataSource[] {
  return SOURCES;
}

export function getReportSource(source_id: string): ReportDataSource | null {
  return SOURCES.find((s) => s.source_id === source_id) ?? null;
}

export function getReportField(
  source_id: string,
  field_name: string,
): ReportField | null {
  const src = getReportSource(source_id);
  if (!src) return null;
  return src.fields.find((f) => f.name === field_name) ?? null;
}

export function requireReportSource(source_id: string): ReportDataSource {
  const src = getReportSource(source_id);
  if (!src) {
    throw new ReportCatalogError(
      'unknown_source',
      `unknown report source: ${source_id}`,
    );
  }
  return src;
}

export function requireReportField(
  source_id: string,
  field_name: string,
): ReportField {
  const src = requireReportSource(source_id);
  const field = src.fields.find((f) => f.name === field_name);
  if (!field) {
    throw new ReportCatalogError(
      'unknown_field',
      `unknown field '${field_name}' on source ${source_id}`,
    );
  }
  return field;
}

/** All distinct schemas referenced in the catalog (for CI invariant tests). */
export const ALL_REPORT_SCHEMAS: readonly ReportDataSourceSchema[] = [
  'mart',
  'app_alerts',
  'app_cases',
  'app_audit',
  'audit',
];

/** Total source count surfaced for the SPA badge + tests. */
export const REPORT_SOURCE_COUNT = SOURCES.length;
