// web/src/modules/dashboard/riskTrend/riskTrendConfigurationEngine.ts
//
// Pure-TypeScript configuration engine for the Enterprise Risk Trend
// Intelligence feature. No JSX, no side-effects — fully testable.

// ─── Domain Types ─────────────────────────────────────────────────────────────

export type RiskDomain =
  | 'credit'
  | 'fraud'
  | 'collections'
  | 'compliance'
  | 'operational'
  | 'cyber'
  | 'insurance'
  | 'investigation'
  | 'recovery'
  | 'enterprise';

export type MetricType =
  | 'alert_count'
  | 'exposure_amount'
  | 'outstanding_portfolio'
  | 'npa_exposure'
  | 'fraud_loss'
  | 'recovery_amount'
  | 'compliance_breaches'
  | 'investigation_volume'
  | 'insurance_claims_exposure'
  | 'enterprise_risk_score';

export type SeverityLevel = 'critical' | 'high' | 'medium' | 'low';

export type ForecastHorizon = 7 | 30 | 60 | 90;

export type BenchmarkPeriod =
  | 'previous_period'
  | 'previous_month'
  | 'previous_quarter'
  | 'previous_year'
  | 'industry_benchmark'
  | 'peer_institutions';

export type AlertSource =
  | 'rules_engine'
  | 'ai_models'
  | 'fraud_detection'
  | 'compliance_engine'
  | 'investigation_center'
  | 'recovery_center'
  | 'case_management'
  | 'data_quality'
  | 'event_streaming';

export type RoleTemplate =
  | 'cro'
  | 'ceo'
  | 'cfo'
  | 'risk_analyst'
  | 'compliance'
  | 'fraud'
  | 'recovery'
  | 'executive';

// ─── Sub-config Types ─────────────────────────────────────────────────────────

export interface SeverityThreshold {
  level: SeverityLevel;
  label: string;
  min: number;
  max: number | null;
  color: string;
  enabled: boolean;
}

export interface ForecastConfig {
  enabled: boolean;
  horizon: ForecastHorizon;
  showConfidenceBand: boolean;
  showDriftDetection: boolean;
  showKeyDrivers: boolean;
  explainLogic: boolean;
}

export interface ExecutiveInsights {
  showEmergingRisks: boolean;
  showTopRiskDrivers: boolean;
  showPortfolioImpact: boolean;
  showRiskTrendSummary: boolean;
  showRecommendedActions: boolean;
}

// ─── Root Config ──────────────────────────────────────────────────────────────

export interface RiskTrendConfig {
  // Section 1 – Risk Domains
  domains: RiskDomain[];
  // Section 2 – Metrics
  metricType: MetricType;
  // Section 3 – Severity
  severities: SeverityThreshold[];
  // Section 4 – AI Forecast
  forecast: ForecastConfig;
  // Section 5 – Benchmark
  benchmark: BenchmarkPeriod | null;
  // Section 6 – Alert Sources
  sources: AlertSource[];
  // Section 7 – Executive Insights
  executiveInsights: ExecutiveInsights;
  // Chart visualisation settings
  chartType: 'line' | 'bar' | 'area';
  timeRange: '7d' | '30d' | '90d' | '1y';
  granularity: 'daily' | 'weekly' | 'monthly';
}

// ─── Default Severity Thresholds ──────────────────────────────────────────────

export const DEFAULT_SEVERITY_THRESHOLDS: SeverityThreshold[] = [
  { level: 'critical', label: 'Critical', min: 90, max: null,  color: '#E24B4A', enabled: true },
  { level: 'high',     label: 'High',     min: 70, max: 89,    color: '#EF9F27', enabled: true },
  { level: 'medium',   label: 'Medium',   min: 40, max: 69,    color: '#2196F3', enabled: true },
  { level: 'low',      label: 'Low',      min: 0,  max: 39,    color: '#1D9E75', enabled: true },
];

// ─── Role-based Defaults ──────────────────────────────────────────────────────

export const ROLE_DEFAULTS: Record<RoleTemplate, Partial<RiskTrendConfig>> = {
  cro: {
    domains: ['credit', 'fraud', 'collections', 'compliance', 'operational', 'enterprise'],
    metricType: 'enterprise_risk_score',
    forecast: { enabled: true, horizon: 30, showConfidenceBand: true, showDriftDetection: true, showKeyDrivers: true, explainLogic: false },
    benchmark: 'previous_quarter',
    chartType: 'area',
    timeRange: '90d',
    granularity: 'weekly',
    executiveInsights: { showEmergingRisks: true, showTopRiskDrivers: true, showPortfolioImpact: true, showRiskTrendSummary: true, showRecommendedActions: true },
  },
  ceo: {
    domains: ['enterprise', 'credit', 'fraud', 'compliance'],
    metricType: 'enterprise_risk_score',
    forecast: { enabled: true, horizon: 90, showConfidenceBand: false, showDriftDetection: false, showKeyDrivers: true, explainLogic: false },
    benchmark: 'previous_year',
    chartType: 'area',
    timeRange: '1y',
    granularity: 'monthly',
    executiveInsights: { showEmergingRisks: true, showTopRiskDrivers: true, showPortfolioImpact: true, showRiskTrendSummary: true, showRecommendedActions: false },
  },
  cfo: {
    domains: ['credit', 'collections', 'recovery', 'enterprise'],
    metricType: 'outstanding_portfolio',
    forecast: { enabled: true, horizon: 60, showConfidenceBand: true, showDriftDetection: false, showKeyDrivers: false, explainLogic: false },
    benchmark: 'previous_quarter',
    chartType: 'bar',
    timeRange: '90d',
    granularity: 'monthly',
    executiveInsights: { showEmergingRisks: false, showTopRiskDrivers: false, showPortfolioImpact: true, showRiskTrendSummary: true, showRecommendedActions: false },
  },
  risk_analyst: {
    domains: ['credit', 'fraud', 'operational', 'investigation'],
    metricType: 'alert_count',
    forecast: { enabled: true, horizon: 30, showConfidenceBand: true, showDriftDetection: true, showKeyDrivers: true, explainLogic: true },
    benchmark: 'previous_month',
    chartType: 'line',
    timeRange: '30d',
    granularity: 'daily',
    executiveInsights: { showEmergingRisks: true, showTopRiskDrivers: true, showPortfolioImpact: false, showRiskTrendSummary: false, showRecommendedActions: true },
  },
  compliance: {
    domains: ['compliance', 'investigation', 'cyber'],
    metricType: 'compliance_breaches',
    forecast: { enabled: false, horizon: 30, showConfidenceBand: false, showDriftDetection: false, showKeyDrivers: false, explainLogic: false },
    benchmark: 'previous_quarter',
    chartType: 'bar',
    timeRange: '90d',
    granularity: 'weekly',
    executiveInsights: { showEmergingRisks: false, showTopRiskDrivers: false, showPortfolioImpact: false, showRiskTrendSummary: true, showRecommendedActions: true },
  },
  fraud: {
    domains: ['fraud', 'cyber', 'investigation'],
    metricType: 'fraud_loss',
    forecast: { enabled: true, horizon: 7, showConfidenceBand: true, showDriftDetection: true, showKeyDrivers: true, explainLogic: true },
    benchmark: 'previous_month',
    chartType: 'line',
    timeRange: '30d',
    granularity: 'daily',
    executiveInsights: { showEmergingRisks: true, showTopRiskDrivers: true, showPortfolioImpact: false, showRiskTrendSummary: false, showRecommendedActions: true },
  },
  recovery: {
    domains: ['recovery', 'collections', 'credit'],
    metricType: 'recovery_amount',
    forecast: { enabled: true, horizon: 30, showConfidenceBand: false, showDriftDetection: false, showKeyDrivers: false, explainLogic: false },
    benchmark: 'previous_month',
    chartType: 'bar',
    timeRange: '30d',
    granularity: 'weekly',
    executiveInsights: { showEmergingRisks: false, showTopRiskDrivers: false, showPortfolioImpact: true, showRiskTrendSummary: true, showRecommendedActions: false },
  },
  executive: {
    domains: ['credit', 'fraud', 'compliance', 'enterprise'],
    metricType: 'enterprise_risk_score',
    forecast: { enabled: true, horizon: 90, showConfidenceBand: false, showDriftDetection: false, showKeyDrivers: true, explainLogic: false },
    benchmark: 'previous_year',
    chartType: 'area',
    timeRange: '1y',
    granularity: 'monthly',
    executiveInsights: { showEmergingRisks: true, showTopRiskDrivers: true, showPortfolioImpact: true, showRiskTrendSummary: true, showRecommendedActions: false },
  },
};

// ─── Factory ──────────────────────────────────────────────────────────────────

export function buildDefaultConfig(role?: RoleTemplate): RiskTrendConfig {
  const base: RiskTrendConfig = {
    domains: ['credit', 'fraud', 'collections', 'compliance', 'operational'],
    metricType: 'alert_count',
    severities: DEFAULT_SEVERITY_THRESHOLDS.map((t) => ({ ...t })),
    forecast: {
      enabled: false,
      horizon: 30,
      showConfidenceBand: true,
      showDriftDetection: false,
      showKeyDrivers: false,
      explainLogic: false,
    },
    benchmark: null,
    sources: ['rules_engine', 'ai_models', 'fraud_detection', 'case_management'],
    executiveInsights: {
      showEmergingRisks: false,
      showTopRiskDrivers: false,
      showPortfolioImpact: false,
      showRiskTrendSummary: false,
      showRecommendedActions: false,
    },
    chartType: 'line',
    timeRange: '30d',
    granularity: 'daily',
  };

  if (!role) return base;

  const overrides = ROLE_DEFAULTS[role];
  return {
    ...base,
    ...overrides,
    severities: DEFAULT_SEVERITY_THRESHOLDS.map((t) => ({ ...t })),
    forecast: overrides.forecast ? { ...base.forecast, ...overrides.forecast } : base.forecast,
    executiveInsights: overrides.executiveInsights
      ? { ...base.executiveInsights, ...overrides.executiveInsights }
      : base.executiveInsights,
  };
}

// ─── Label Helpers ────────────────────────────────────────────────────────────

const DOMAIN_LABELS: Record<RiskDomain, string> = {
  credit:         'Credit Risk',
  fraud:          'Fraud Detection',
  collections:    'Collections',
  compliance:     'Compliance',
  operational:    'Operational Risk',
  cyber:          'Cyber Risk',
  insurance:      'Insurance Risk',
  investigation:  'Investigation',
  recovery:       'Recovery',
  enterprise:     'Enterprise-wide',
};

export function getDomainLabel(d: RiskDomain): string {
  return DOMAIN_LABELS[d] ?? d;
}

const METRIC_LABELS: Record<MetricType, string> = {
  alert_count:                 'Alert Count',
  exposure_amount:             'Exposure Amount (KES)',
  outstanding_portfolio:       'Outstanding Portfolio',
  npa_exposure:                'NPA Exposure',
  fraud_loss:                  'Fraud Loss',
  recovery_amount:             'Recovery Amount',
  compliance_breaches:         'Compliance Breaches',
  investigation_volume:        'Investigation Volume',
  insurance_claims_exposure:   'Insurance Claims Exposure',
  enterprise_risk_score:       'Enterprise Risk Score',
};

export function getMetricLabel(m: MetricType): string {
  return METRIC_LABELS[m] ?? m;
}

const SOURCE_LABELS: Record<AlertSource, string> = {
  rules_engine:         'Rules Engine',
  ai_models:            'AI Models',
  fraud_detection:      'Fraud Detection',
  compliance_engine:    'Compliance Engine',
  investigation_center: 'Investigation Center',
  recovery_center:      'Recovery Center',
  case_management:      'Case Management',
  data_quality:         'Data Quality',
  event_streaming:      'Event Streaming',
};

export function getSourceLabel(s: AlertSource): string {
  return SOURCE_LABELS[s] ?? s;
}

// ─── Validation ───────────────────────────────────────────────────────────────

export function validateConfig(c: RiskTrendConfig): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!c.domains || c.domains.length === 0) {
    errors.push('At least one risk domain must be selected.');
  }

  if (!c.sources || c.sources.length === 0) {
    errors.push('At least one alert source must be selected.');
  }

  const enabledSeverities = c.severities.filter((s) => s.enabled);
  if (enabledSeverities.length === 0) {
    errors.push('At least one severity level must be enabled.');
  }

  if (c.forecast.enabled) {
    if (![7, 30, 60, 90].includes(c.forecast.horizon)) {
      errors.push('Forecast horizon must be 7, 30, 60, or 90 days.');
    }
  }

  return { valid: errors.length === 0, errors };
}

// ─── All-values exports (for UI checkboxes) ───────────────────────────────────

export const ALL_DOMAINS: RiskDomain[] = [
  'credit', 'fraud', 'collections', 'compliance', 'operational',
  'cyber', 'insurance', 'investigation', 'recovery', 'enterprise',
];

export const ALL_METRICS: MetricType[] = [
  'alert_count', 'exposure_amount', 'outstanding_portfolio', 'npa_exposure',
  'fraud_loss', 'recovery_amount', 'compliance_breaches', 'investigation_volume',
  'insurance_claims_exposure', 'enterprise_risk_score',
];

export const ALL_SOURCES: AlertSource[] = [
  'rules_engine', 'ai_models', 'fraud_detection', 'compliance_engine',
  'investigation_center', 'recovery_center', 'case_management', 'data_quality',
  'event_streaming',
];

export const ALL_ROLE_TEMPLATES: RoleTemplate[] = [
  'cro', 'ceo', 'cfo', 'risk_analyst', 'compliance', 'fraud', 'recovery', 'executive',
];

export const ROLE_TEMPLATE_LABELS: Record<RoleTemplate, string> = {
  cro:          'Chief Risk Officer',
  ceo:          'Chief Executive Officer',
  cfo:          'Chief Financial Officer',
  risk_analyst: 'Risk Analyst',
  compliance:   'Compliance Officer',
  fraud:        'Fraud Analyst',
  recovery:     'Recovery Specialist',
  executive:    'Executive View',
};
