import type {
  Alert,
  CaseDetail,
  CaseSummary,
  CustomerRisk,
  DashboardSummary,
  RuleSummary,
} from '@/lib/api';

// ── Demo accounts (mirrors auth-svc seeds — services/auth-svc/src/users.ts) ──
// Mutable: the MSW /auth/register handler appends new users so signup → login round-trips in mock mode.
import type { Role } from '@/store/auth';

export interface DemoUser {
  id: string;
  username: string;
  email: string;
  password: string;
  display_name: string;
  roles: Role[];
  locked: boolean;
  /** True for admin-created accounts that haven't gone through the
   *  first-login wizard yet. Defaults to false so seed users can sign in
   *  directly. */
  must_change_password?: boolean;
  terms_accepted_at?: string | null;
}

export const DEMO_USERS: DemoUser[] = [
  { id: 'u-001', username: 'alice.admin',   email: 'alice.admin@apex-ews.test',   password: 'Admin!Pass1',   display_name: 'Alice Mwangi',  roles: ['admin'],              locked: false },
  { id: 'u-002', username: 'ravi.risk',     email: 'ravi.risk@apex-ews.test',     password: 'RiskAnalyst!1', display_name: 'Ravi Otieno',   roles: ['risk_analyst'],       locked: false },
  { id: 'u-003', username: 'sue.super',     email: 'sue.super@apex-ews.test',     password: 'Super!Pass1',   display_name: 'Sue Wanjiru',   roles: ['supervisor'],         locked: false },
  { id: 'u-004', username: 'carl.collect',  email: 'carl.collect@apex-ews.test',  password: 'Collect!Pass1', display_name: 'Carl Kamau',    roles: ['collection_officer'], locked: false },
  { id: 'u-005', username: 'fiona.field',   email: 'fiona.field@apex-ews.test',   password: 'Field!Pass1',   display_name: 'Fiona Achieng', roles: ['field_officer'],      locked: false },
];

// Portfolio PD trend — 12 weeks of weekly snapshots so the dashboard's
// time-range selector (7D / 30D / 90D / All) has something to slice. The
// chart trims the trailing N weeks based on selection.
export const dashboardSummary: DashboardSummary = {
  customers_monitored: 18432,
  high_risk_customers: 412,
  active_alerts: 87,
  cases_open: 64,
  risk_trend: [
    { week: 'W-11', pd: 0.038 },
    { week: 'W-10', pd: 0.040 },
    { week: 'W-9',  pd: 0.043 },
    { week: 'W-8',  pd: 0.041 },
    { week: 'W-7',  pd: 0.045 },
    { week: 'W-6',  pd: 0.052 },
    { week: 'W-5',  pd: 0.048 },
    { week: 'W-4',  pd: 0.057 },
    { week: 'W-3',  pd: 0.061 },
    { week: 'W-2',  pd: 0.058 },
    { week: 'W-1',  pd: 0.063 },
    { week: 'W-0',  pd: 0.066 },
  ],
  alerts_by_severity: [
    { severity: 'critical', count: 12 },
    { severity: 'high', count: 30 },
    { severity: 'medium', count: 36 },
    { severity: 'low', count: 15 },
  ],
};

// Mock alerts with prioritization fields. confidence + customer_exposure_kes
// are added so the criticality formula in web/src/lib/criticality.ts can
// produce a meaningful ranking. The MSW handler computes criticality_score
// at request time so the formula stays in one place; the values here are
// the rule-engine outputs + customer-service joins.
//
// criticality_score and linked_alert_ids are filled in by the handler — set
// to placeholder zero/empty in seed so the type checker is happy.
//
// Two alerts on c-106 (Faisal Hussein) demonstrate the dedup pass: when
// dedup=true the higher-criticality one becomes primary and the other
// shows up as linked.
export const alerts: Alert[] = [
  {
    id: 'a-1001',
    severity: 'critical',
    customer: { id: 'c-101', name: 'Achieng Otieno' },
    rule: { id: 'r-22', name: 'Salary inflow stopped 60d' },
    indicators: ['IND_BEH_03', 'IND_TXN_07'],
    age_min: 38,
    assignee: 'risk',
    created_at: '2026-04-26T08:14:00Z',
    confidence: 0.92,
    customer_exposure_kes: 1_240_000,
    criticality_score: 0,
    linked_alert_ids: [],
  },
  {
    id: 'a-1002',
    severity: 'high',
    customer: { id: 'c-102', name: 'Brian Kamau' },
    rule: { id: 'r-09', name: 'DPD ≥ 30 + utilisation > 95%' },
    indicators: ['IND_FIN_02', 'IND_CRD_01'],
    age_min: 122,
    assignee: 'field',
    created_at: '2026-04-26T06:10:00Z',
    confidence: 0.88,
    customer_exposure_kes: 540_000,
    criticality_score: 0,
    linked_alert_ids: [],
  },
  {
    id: 'a-1003',
    severity: 'medium',
    customer: { id: 'c-103', name: 'Catherine Wanjiru' },
    rule: { id: 'r-14', name: 'Cheque return 2× in 30d' },
    indicators: ['IND_TXN_11'],
    age_min: 240,
    assignee: null,
    created_at: '2026-04-25T22:00:00Z',
    confidence: 0.65,
    customer_exposure_kes: 320_000,
    criticality_score: 0,
    linked_alert_ids: [],
  },
  {
    id: 'a-1004',
    severity: 'low',
    customer: { id: 'c-104', name: 'Daniel Mwangi' },
    rule: { id: 'r-03', name: 'Bureau enquiry surge' },
    indicators: ['IND_CRD_05'],
    age_min: 510,
    assignee: 'risk',
    created_at: '2026-04-25T12:30:00Z',
    confidence: 0.55,
    customer_exposure_kes: 150_000,
    criticality_score: 0,
    linked_alert_ids: [],
  },
  {
    id: 'a-1005',
    severity: 'high',
    customer: { id: 'c-105', name: 'Esther Njeri' },
    rule: { id: 'r-18', name: 'Sudden cash withdrawal pattern' },
    indicators: ['IND_TXN_03', 'IND_BEH_06'],
    age_min: 75,
    assignee: 'field',
    created_at: '2026-04-26T07:00:00Z',
    confidence: 0.80,
    customer_exposure_kes: 880_000,
    criticality_score: 0,
    linked_alert_ids: [],
  },
  {
    id: 'a-1006',
    severity: 'critical',
    customer: { id: 'c-106', name: 'Faisal Hussein' },
    rule: { id: 'r-25', name: 'Multi-bureau delinquency confirmed' },
    indicators: ['IND_CRD_02', 'IND_FIN_05'],
    age_min: 12,
    assignee: null,
    created_at: '2026-04-26T08:55:00Z',
    confidence: 0.95,
    customer_exposure_kes: 1_650_000,
    criticality_score: 0,
    linked_alert_ids: [],
  },
  {
    id: 'a-1007',
    severity: 'medium',
    customer: { id: 'c-107', name: 'Grace Atieno' },
    rule: { id: 'r-11', name: 'Restructure flag + utilisation > 80%' },
    indicators: ['IND_FIN_07'],
    age_min: 305,
    assignee: 'risk',
    created_at: '2026-04-25T20:00:00Z',
    confidence: 0.70,
    customer_exposure_kes: 470_000,
    criticality_score: 0,
    linked_alert_ids: [],
  },
  {
    // Second alert on c-106 — proves the customer-dedup pass merges
    // these into one row when dedup=true (with linked_alert_ids set).
    id: 'a-1008',
    severity: 'medium',
    customer: { id: 'c-106', name: 'Faisal Hussein' },
    rule: { id: 'r-15', name: 'Net flow drop 30d > 40%' },
    indicators: ['IND_TXN_05'],
    age_min: 180,
    assignee: null,
    created_at: '2026-04-26T03:00:00Z',
    confidence: 0.60,
    customer_exposure_kes: 1_650_000,
    criticality_score: 0,
    linked_alert_ids: [],
  },
  {
    id: 'a-1009',
    severity: 'critical',
    customer: { id: 'c-115', name: 'Olivia Cherop' },
    rule: { id: 'r-30', name: 'Cross-product default cascade' },
    indicators: ['IND_CRD_01', 'IND_FIN_02', 'IND_BEH_03'],
    age_min: 22,
    assignee: 'risk',
    created_at: '2026-04-26T08:42:00Z',
    confidence: 0.97,
    customer_exposure_kes: 1_980_000,
    criticality_score: 0,
    linked_alert_ids: [],
  },
  {
    id: 'a-1010',
    severity: 'high',
    customer: { id: 'c-118', name: 'Ruth Akinyi' },
    rule: { id: 'r-31', name: 'Direct-debit bounce ≥ 3 in 30d' },
    indicators: ['IND_TXN_11', 'IND_BEH_06'],
    age_min: 95,
    assignee: 'field',
    created_at: '2026-04-26T06:55:00Z',
    confidence: 0.84,
    customer_exposure_kes: 840_000,
    criticality_score: 0,
    linked_alert_ids: [],
  },
  {
    id: 'a-1011',
    severity: 'high',
    customer: { id: 'c-120', name: 'Tabitha Njoroge' },
    rule: { id: 'r-09', name: 'DPD ≥ 30 + utilisation > 95%' },
    indicators: ['IND_FIN_02', 'IND_CRD_01'],
    age_min: 210,
    assignee: null,
    created_at: '2026-04-26T01:20:00Z',
    confidence: 0.81,
    customer_exposure_kes: 1_110_000,
    criticality_score: 0,
    linked_alert_ids: [],
  },
  {
    id: 'a-1012',
    severity: 'medium',
    customer: { id: 'c-116', name: 'Peter Maina' },
    rule: { id: 'r-33', name: 'Account dormancy with active loan' },
    indicators: ['IND_BEH_01', 'IND_FIN_05'],
    age_min: 420,
    assignee: 'risk',
    created_at: '2026-04-25T17:00:00Z',
    confidence: 0.72,
    customer_exposure_kes: 720_000,
    criticality_score: 0,
    linked_alert_ids: [],
  },
  {
    id: 'a-1013',
    severity: 'low',
    customer: { id: 'c-113', name: 'Mary Wambui' },
    rule: { id: 'r-34', name: 'Card spend anomaly z-score > 2.5' },
    indicators: ['IND_TXN_03'],
    age_min: 600,
    assignee: null,
    created_at: '2026-04-25T08:00:00Z',
    confidence: 0.58,
    customer_exposure_kes: 420_000,
    criticality_score: 0,
    linked_alert_ids: [],
  },
];

// Mock customer risk profiles. The SHAP reasons follow the contract in
// services/ai-copilot-svc/app/main.py:ReasonCode (feature / value / shap_value
// / direction). Feature names match ml/pipelines/features.py NUMERIC_FEATURES
// + the encoded categorical column shapes (e.g. `product_type=credit_card`).
export const customers: Record<string, CustomerRisk> = {
  'c-101': {
    id: 'c-101',
    name: 'Achieng Otieno',
    pd: 0.78,
    level: 'High',
    exposure: 1_240_000,
    dpd: 32,
    balance_trend: [
      { month: 'Nov', balance: 312000 },
      { month: 'Dec', balance: 290000 },
      { month: 'Jan', balance: 248000 },
      { month: 'Feb', balance: 192000 },
      { month: 'Mar', balance: 110000 },
      { month: 'Apr', balance: 64000 },
    ],
    top_reasons: [
      { feature: 'dpd_max_90d',          value: 32,           shap_value:  0.41, direction: 'positive' },
      { feature: 'utilization',          value: 0.97,         shap_value:  0.32, direction: 'positive' },
      { feature: 'bureau_score',         value: 540,          shap_value:  0.18, direction: 'positive' },
      { feature: 'repayment_delay_streak', value: 3,          shap_value:  0.11, direction: 'positive' },
      { feature: 'tenure_months',        value: 26,           shap_value: -0.08, direction: 'negative' },
    ],
    model_name: 'pd_xgboost',
    model_version: '0.1.0',
  },
  'c-102': {
    id: 'c-102',
    name: 'Brian Kamau',
    pd: 0.42,
    level: 'Medium',
    exposure: 540_000,
    dpd: 12,
    balance_trend: [
      { month: 'Nov', balance: 180000 },
      { month: 'Dec', balance: 175000 },
      { month: 'Jan', balance: 160000 },
      { month: 'Feb', balance: 150000 },
      { month: 'Mar', balance: 138000 },
      { month: 'Apr', balance: 122000 },
    ],
    top_reasons: [
      { feature: 'utilization',          value: 0.91,           shap_value:  0.28, direction: 'positive' },
      { feature: 'bureau_score',         value: 605,            shap_value:  0.16, direction: 'positive' },
      { feature: 'product_type=credit_card', value: 'credit_card', shap_value: 0.12, direction: 'positive' },
      { feature: 'tenure_months',        value: 41,             shap_value: -0.10, direction: 'negative' },
      { feature: 'txn_volume_zscore_90d', value: -1.2,          shap_value:  0.07, direction: 'positive' },
    ],
    model_name: 'pd_xgboost',
    model_version: '0.1.0',
  },
  'c-103': makeCustomer('c-103', 'Catherine Wanjiru', 0.18, 'Low',    320_000,  4),
  'c-104': makeCustomer('c-104', 'Daniel Mwangi',     0.09, 'Low',    150_000,  0),
  'c-105': makeCustomer('c-105', 'Esther Njeri',      0.61, 'High',   880_000, 22),
  'c-106': makeCustomer('c-106', 'Faisal Hussein',    0.74, 'High', 1_650_000, 41),
  'c-107': makeCustomer('c-107', 'Grace Atieno',      0.34, 'Medium', 470_000,  8),
  'c-108': makeCustomer('c-108', 'Hassan Otieno',     0.12, 'Low',    220_000,  0),
  'c-109': makeCustomer('c-109', 'Irene Mutua',       0.51, 'High',   780_000, 17),
  'c-110': makeCustomer('c-110', 'James Kiprotich',   0.27, 'Medium', 380_000,  3),
  'c-111': makeCustomer('c-111', 'Kavita Singh',      0.06, 'Low',    180_000,  0),
  'c-112': makeCustomer('c-112', 'Linus Owino',       0.55, 'High',   910_000, 28),
  'c-113': makeCustomer('c-113', 'Mary Wambui',       0.31, 'Medium', 420_000,  6),
  'c-114': makeCustomer('c-114', 'Nathan Korir',      0.08, 'Low',    260_000,  0),
  'c-115': makeCustomer('c-115', 'Olivia Cherop',     0.83, 'High', 1_980_000, 67),
  'c-116': makeCustomer('c-116', 'Peter Maina',       0.58, 'High',   720_000, 24),
  'c-117': makeCustomer('c-117', 'Quentin Wamalwa',   0.36, 'Medium', 510_000, 11),
  'c-118': makeCustomer('c-118', 'Ruth Akinyi',       0.69, 'High',   840_000, 19),
  'c-119': makeCustomer('c-119', 'Samuel Tanui',      0.11, 'Low',    195_000,  0),
  'c-120': makeCustomer('c-120', 'Tabitha Njoroge',   0.64, 'High', 1_110_000, 35),
};

// Compact constructor for thin (list-only) customer records — fills in
// boring fields with sensible defaults so the customer LIST page has
// enough rows to demonstrate filtering. The full-fidelity SHAP/balance
// fields here are throwaway; clicking through to the detail page still
// works because the handler returns whatever record is in the dict.
function makeCustomer(
  id: string,
  name: string,
  pd: number,
  level: 'Low' | 'Medium' | 'High',
  exposure: number,
  dpd: number,
): CustomerRisk {
  return {
    id,
    name,
    pd,
    level,
    exposure,
    dpd,
    balance_trend: [
      { month: 'Nov', balance: Math.round(exposure * 0.32) },
      { month: 'Dec', balance: Math.round(exposure * 0.28) },
      { month: 'Jan', balance: Math.round(exposure * 0.24) },
      { month: 'Feb', balance: Math.round(exposure * 0.21) },
      { month: 'Mar', balance: Math.round(exposure * 0.17) },
      { month: 'Apr', balance: Math.round(exposure * 0.14) },
    ],
    top_reasons: [
      { feature: 'utilization',  value: Math.min(0.99, 0.4 + pd * 0.6), shap_value: pd * 0.4,   direction: 'positive' },
      { feature: 'bureau_score', value: Math.round(720 - pd * 200),     shap_value: pd * 0.25,  direction: 'positive' },
      { feature: 'tenure_months',value: 36,                              shap_value: -0.08,      direction: 'negative' },
    ],
    model_name: 'pd_xgboost',
    model_version: '0.1.0',
  };
}

export const rules: RuleSummary[] = [
  {
    id: 'r-22',
    name: 'Salary inflow stopped 60d',
    family: 'Behavioural',
    status: 'live',
    version: '2.1.0',
    owner: 'risk-ops',
    updated_at: '2026-04-22',
    when: { all: [{ indicator: 'IND_BEH_03', op: '>=', value: 60 }] },
    then: { alert: { severity: 'critical', queue: 'critical' } },
  },
  {
    id: 'r-09',
    name: 'DPD ≥ 30 + utilisation > 95%',
    family: 'Financial',
    status: 'live',
    version: '1.4.0',
    owner: 'risk-ops',
    updated_at: '2026-04-18',
    when: {
      all: [
        { indicator: 'IND_FIN_02', op: '>', value: 0.95 },
        { indicator: 'IND_CRD_01', op: '>=', value: 30 },
      ],
    },
    then: { alert: { severity: 'high', queue: 'critical' } },
  },
  {
    id: 'r-14',
    name: 'Cheque return 2× in 30d',
    family: 'Transaction',
    status: 'simulate',
    version: '0.9.0',
    owner: 'fraud-ops',
    updated_at: '2026-04-25',
    when: { all: [{ indicator: 'IND_TXN_11', op: '>=', value: 2, window_days: 30 }] },
    then: { alert: { severity: 'medium', queue: 'medium' } },
  },
  {
    id: 'r-03',
    name: 'Bureau enquiry surge',
    family: 'Credit',
    status: 'draft',
    version: '0.2.0',
    owner: 'risk-ops',
    updated_at: '2026-04-26',
    when: { all: [{ indicator: 'IND_CRD_05', op: '>=', value: 3, window_days: 14 }] },
    then: { alert: { severity: 'low', queue: 'low' } },
  },
  {
    id: 'r-18',
    name: 'Sudden cash withdrawal pattern',
    family: 'Transaction',
    status: 'live',
    version: '1.0.1',
    owner: 'aml-ops',
    updated_at: '2026-04-20',
    when: {
      any: [
        { indicator: 'IND_TXN_03', op: '>', value: 3 },
        { indicator: 'IND_BEH_06', op: '>=', value: 7 },
      ],
    },
    then: { alert: { severity: 'high', queue: 'critical' } },
  },
  {
    id: 'r-25',
    name: 'Multi-bureau delinquency confirmed',
    family: 'Credit',
    status: 'retired',
    version: '0.5.0',
    owner: 'risk-ops',
    updated_at: '2026-03-30',
    when: { all: [{ indicator: 'IND_CRD_02', op: '>=', value: 2 }] },
    then: { alert: { severity: 'critical', queue: 'critical' } },
  },
  {
    id: 'r-30',
    name: 'Cross-product default cascade',
    family: 'Credit',
    status: 'live',
    version: '1.2.0',
    owner: 'risk-ops',
    updated_at: '2026-04-24',
    when: {
      all: [
        { indicator: 'IND_CRD_01', op: '>=', value: 60 },
        { indicator: 'IND_FIN_02', op: '>', value: 0.9 },
        { indicator: 'IND_BEH_03', op: '>=', value: 30 },
      ],
    },
    then: { alert: { severity: 'critical', queue: 'critical' } },
  },
  {
    id: 'r-31',
    name: 'Direct-debit bounce ≥ 3 in 30d',
    family: 'Transaction',
    status: 'live',
    version: '1.0.0',
    owner: 'fraud-ops',
    updated_at: '2026-04-19',
    when: { all: [{ indicator: 'IND_TXN_11', op: '>=', value: 3, window_days: 30 }] },
    then: { alert: { severity: 'high', queue: 'critical' } },
  },
  {
    id: 'r-32',
    name: 'Geographic risk migration',
    family: 'Behavioural',
    status: 'draft',
    version: '0.1.0',
    owner: 'risk-ops',
    updated_at: '2026-04-26',
    when: { all: [{ indicator: 'IND_BEH_09', op: '==', value: 'high_risk_region' }] },
    then: { alert: { severity: 'medium', queue: 'medium' } },
  },
  {
    id: 'r-33',
    name: 'Account dormancy with active loan',
    family: 'Behavioural',
    status: 'simulate',
    version: '0.4.0',
    owner: 'risk-ops',
    updated_at: '2026-04-23',
    when: {
      all: [
        { indicator: 'IND_BEH_01', op: '>=', value: 90 },
        { indicator: 'IND_FIN_05', op: '>', value: 0 },
      ],
    },
    then: { alert: { severity: 'medium', queue: 'medium' } },
  },
  {
    id: 'r-34',
    name: 'Card spend anomaly z-score > 2.5',
    family: 'Transaction',
    status: 'live',
    version: '1.1.0',
    owner: 'aml-ops',
    updated_at: '2026-04-21',
    when: { all: [{ indicator: 'IND_TXN_03', op: '>', value: 2.5 }] },
    then: { alert: { severity: 'low', queue: 'low' } },
  },
];

export const caseDetails: CaseDetail[] = [
  {
    id: 'case-501',
    alert_id: 'a-1001',
    customer: { id: 'c-101', name: 'Achieng Otieno' },
    loan_id: 'loan-c101-1',
    severity: 'critical',
    rule: { id: 'r-22', name: 'Salary inflow stopped 60d' },
    reason_summary: '[CRITICAL] Salary inflow stopped 60d (IND_BEH_03, IND_TXN_07).',
    state: 'assigned',
    assignee: 'fiona.field',
    outcome: null,
    created_at: '2026-04-26T08:14:00Z',
    updated_at: '2026-04-26T08:18:00Z',
    closed_at: null,
    actions: [],
  },
  {
    id: 'case-502',
    alert_id: 'a-1002',
    customer: { id: 'c-102', name: 'Brian Kamau' },
    loan_id: 'loan-c102-1',
    severity: 'high',
    rule: { id: 'r-09', name: 'DPD ≥ 30 + utilisation > 95%' },
    reason_summary: '[HIGH] DPD ≥ 30 + utilisation > 95% (IND_FIN_02, IND_CRD_01).',
    state: 'in_action',
    assignee: 'fiona.field',
    outcome: null,
    created_at: '2026-04-26T06:10:00Z',
    updated_at: '2026-04-26T11:25:00Z',
    closed_at: null,
    actions: [
      {
        action_id: 'act-502-1',
        ts: '2026-04-26T10:00:00Z',
        kind: 'call',
        officer_id: 'fiona.field',
        outcome_note: 'Customer promised payment by Friday',
      },
      {
        action_id: 'act-502-2',
        ts: '2026-04-26T11:25:00Z',
        kind: 'visit',
        officer_id: 'fiona.field',
        outcome_note: 'Visited residence; customer confirmed salary delay',
        gps: { lat: -1.2921, lng: 36.8219, accuracy_m: 12 },
      },
    ],
  },
  {
    id: 'case-503',
    alert_id: 'a-1006',
    customer: { id: 'c-106', name: 'Faisal Hussein' },
    loan_id: null,
    severity: 'medium',
    rule: { id: 'r-15', name: 'Net flow drop 30d > 40%' },
    reason_summary: '[MEDIUM] Net flow drop 30d > 40% (IND_TXN_05).',
    state: 'open',
    assignee: null,
    outcome: null,
    created_at: '2026-04-27T07:50:00Z',
    updated_at: '2026-04-27T07:50:00Z',
    closed_at: null,
    actions: [],
  },
  {
    id: 'case-504',
    alert_id: 'a-1009',
    customer: { id: 'c-115', name: 'Olivia Cherop' },
    loan_id: 'loan-c115-1',
    severity: 'critical',
    rule: { id: 'r-30', name: 'Cross-product default cascade' },
    reason_summary: '[CRITICAL] Cross-product default cascade (IND_CRD_01, IND_FIN_02, IND_BEH_03).',
    state: 'assigned',
    assignee: 'carl.collect',
    outcome: null,
    created_at: '2026-04-26T08:42:00Z',
    updated_at: '2026-04-26T09:05:00Z',
    closed_at: null,
    actions: [
      {
        action_id: 'act-504-1',
        ts: '2026-04-26T09:05:00Z',
        kind: 'call',
        officer_id: 'carl.collect',
        outcome_note: 'Left voicemail; will retry tomorrow',
      },
    ],
  },
  {
    id: 'case-505',
    alert_id: 'a-1010',
    customer: { id: 'c-118', name: 'Ruth Akinyi' },
    loan_id: 'loan-c118-1',
    severity: 'high',
    rule: { id: 'r-31', name: 'Direct-debit bounce ≥ 3 in 30d' },
    reason_summary: '[HIGH] Direct-debit bounce ≥ 3 in 30d (IND_TXN_11, IND_BEH_06).',
    state: 'open',
    assignee: null,
    outcome: null,
    created_at: '2026-04-26T07:00:00Z',
    updated_at: '2026-04-26T07:00:00Z',
    closed_at: null,
    actions: [],
  },
];

/**
 * Synthetic per-case SLA posture so the list page can filter on
 * "?sla=breached,approaching" without joining against the separate
 * /v1/cases/sla-summary endpoint. The mapping is hand-tuned to give
 * the demo at least one row in each bucket.
 */
const CASE_SLA_STATUS: Record<string, 'on_track' | 'approaching' | 'breached' | 'closed'> = {
  'case-501': 'approaching',
  'case-502': 'on_track',
  'case-503': 'breached',
  'case-504': 'on_track',
  'case-505': 'approaching',
};

/**
 * Derived list-row view of caseDetails. Re-computed on each handler call so
 * mutations stay consistent across list + detail screens.
 */
export function caseSummariesFrom(now: () => Date = () => new Date()): CaseSummary[] {
  const t = now().getTime();
  return caseDetails.map((c) => ({
    id: c.id,
    alert_id: c.alert_id,
    customer: c.customer,
    state: c.state,
    assignee: c.assignee ?? null,
    age_min: Math.max(0, Math.floor((t - Date.parse(c.created_at)) / 60000)),
    sla_status: c.state === 'closed' ? 'closed' : (CASE_SLA_STATUS[c.id] ?? 'on_track'),
  }));
}

// Back-compat export — older modules import `cases`. Snapshot at module load.
export const cases: CaseSummary[] = caseSummariesFrom();
