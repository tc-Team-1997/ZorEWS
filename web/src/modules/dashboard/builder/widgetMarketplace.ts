// widgetMarketplace.ts
//
// ZorEWS Dashboard Builder — Widget Marketplace
// Complete catalog of all available widgets organized by category.
// Used by the drag-and-drop builder to populate the widget panel.
//
// Additive — no existing logic changed.

export type MarketplaceCategory =
  | 'kpi'
  | 'alerts'
  | 'investigations'
  | 'compliance'
  | 'data_fabric'
  | 'executive'
  | 'ai_insights'
  | 'collections'
  | 'insurance'
  | 'banking';

export type WidgetSize = '1x1' | '2x1' | '3x1' | '4x1' | '2x2' | '3x2' | '4x2';

export type WidgetDataSource =
  | 'alerts'
  | 'cases'
  | 'customers'
  | 'indicators'
  | 'compliance'
  | 'audit'
  | 'predictions'
  | 'reports'
  | 'scenarios'
  | 'recovery'
  | 'insurance'
  | 'static';

export interface WidgetConfig {
  /** Filter: domain (banking/insurance/both) */
  domain?:      'banking' | 'insurance' | 'both';
  /** Filter: time range */
  timeRange?:   '1d' | '7d' | '30d' | '90d' | '1y' | 'all';
  /** Filter: severity */
  severity?:    'critical' | 'high' | 'medium' | 'low' | 'all';
  /** Threshold: numeric alert threshold */
  threshold?:   number;
  /** Filter: custom label for the threshold */
  thresholdLabel?: string;
  /** Custom title override */
  title?:       string;
  /** Show trend vs previous period */
  showTrend?:   boolean;
  /** Drill-down route */
  drillTo?:     string;
  /** Max items to show */
  limit?:       number;
  /** Color scheme override */
  colorScheme?: 'default' | 'danger' | 'success' | 'warning' | 'neutral';
}

export interface MarketplaceWidget {
  id:          string;
  name:        string;
  description: string;
  category:    MarketplaceCategory;
  size:        WidgetSize;
  dataSource:  WidgetDataSource;
  icon:        string;          // lucide icon name
  tags:        string[];
  premium?:    boolean;
  defaultConfig: WidgetConfig;
  configKeys:  Array<keyof WidgetConfig>;  // which config options this widget supports
  preview:     string;          // preview description
}

// ─── Widget Marketplace Catalog ───────────────────────────────────────────

export const WIDGET_MARKETPLACE: MarketplaceWidget[] = [

  // ── KPI Widgets ──────────────────────────────────────────────────────
  {
    id: 'kpi_critical_alerts',
    name: 'Critical Alerts',
    description: 'Live count of critical risk alerts requiring immediate action',
    category: 'kpi',
    size: '2x1',
    dataSource: 'alerts',
    icon: 'alert-octagon',
    tags: ['alerts', 'critical', 'kpi', 'real-time'],
    defaultConfig: { severity: 'critical', timeRange: '1d', showTrend: true, colorScheme: 'danger', drillTo: '/alerts' },
    configKeys: ['severity', 'timeRange', 'showTrend', 'threshold', 'title'],
    preview: 'Shows count of critical alerts with trend vs yesterday and quick-access link',
  },
  {
    id: 'kpi_open_cases',
    name: 'Open Cases',
    description: 'Total open investigation and risk cases across all queues',
    category: 'kpi',
    size: '2x1',
    dataSource: 'cases',
    icon: 'folder-open',
    tags: ['cases', 'cms', 'kpi'],
    defaultConfig: { timeRange: '30d', showTrend: true, drillTo: '/cms/cases' },
    configKeys: ['timeRange', 'showTrend', 'limit', 'title'],
    preview: 'Case count with breakdown by status (open/assigned/investigating)',
  },
  {
    id: 'kpi_high_risk_accounts',
    name: 'High-Risk Accounts',
    description: 'Borrowers with PD ≥ 0.60 requiring immediate attention',
    category: 'kpi',
    size: '2x1',
    dataSource: 'predictions',
    icon: 'users',
    tags: ['npa', 'pd', 'credit risk', 'kpi'],
    defaultConfig: { threshold: 0.60, timeRange: '1d', showTrend: true, drillTo: '/customers', colorScheme: 'warning' },
    configKeys: ['threshold', 'timeRange', 'showTrend', 'domain', 'title'],
    preview: 'Count of accounts above PD threshold with week-on-week change',
  },
  {
    id: 'kpi_sla_breaches',
    name: 'SLA Breaches',
    description: 'Cases and alerts with breached SLA windows',
    category: 'kpi',
    size: '2x1',
    dataSource: 'cases',
    icon: 'clock',
    tags: ['sla', 'breach', 'kpi', 'compliance'],
    defaultConfig: { timeRange: '1d', showTrend: true, colorScheme: 'danger', drillTo: '/cms/cases' },
    configKeys: ['timeRange', 'showTrend', 'threshold', 'title'],
    preview: 'SLA breach count with trend and worst-offender case',
  },
  {
    id: 'kpi_compliance_readiness',
    name: 'Compliance Readiness',
    description: 'Overall regulatory compliance readiness score (0-100%)',
    category: 'kpi',
    size: '2x1',
    dataSource: 'compliance',
    icon: 'shield-check',
    tags: ['compliance', 'rbi', 'irdai', 'kpi'],
    defaultConfig: { showTrend: true, drillTo: '/regulatory-compliance-center', colorScheme: 'success' },
    configKeys: ['showTrend', 'threshold', 'title'],
    preview: 'Compliance score with upcoming filing deadlines count',
  },
  {
    id: 'kpi_recovery_rate',
    name: 'Recovery Rate',
    description: 'NPA recovery rate as % of outstanding portfolio',
    category: 'kpi',
    size: '2x1',
    dataSource: 'recovery',
    icon: 'trending-up',
    tags: ['recovery', 'npa', 'collections', 'kpi'],
    defaultConfig: { timeRange: '30d', showTrend: true, drillTo: '/recovery-center' },
    configKeys: ['timeRange', 'showTrend', 'threshold', 'title'],
    preview: 'Recovery rate % with monthly trend and target comparison',
  },
  {
    id: 'kpi_enterprise_risk_index',
    name: 'Enterprise Risk Index',
    description: 'Composite enterprise risk score (0-100)',
    category: 'executive',
    size: '2x1',
    dataSource: 'predictions',
    icon: 'gauge',
    tags: ['executive', 'risk index', 'kpi', 'board'],
    defaultConfig: { showTrend: true, drillTo: '/executive-cockpit' },
    configKeys: ['showTrend', 'title'],
    preview: 'Risk index gauge with band (Normal/Elevated/High/Critical)',
  },
  {
    id: 'kpi_portfolio_npa',
    name: 'Portfolio NPA %',
    description: 'Gross NPA ratio as % of total portfolio outstanding',
    category: 'banking',
    size: '2x1',
    dataSource: 'predictions',
    icon: 'percent',
    tags: ['npa', 'portfolio', 'banking', 'rbi'],
    defaultConfig: { timeRange: '30d', showTrend: true, domain: 'banking' },
    configKeys: ['timeRange', 'domain', 'showTrend', 'threshold', 'title'],
    preview: 'NPA ratio with RBI threshold indicator and monthly trend',
  },

  // ── Alert Widgets ─────────────────────────────────────────────────────
  {
    id: 'alert_live_feed',
    name: 'Live Alert Feed',
    description: 'Real-time feed of latest risk alerts with severity badges',
    category: 'alerts',
    size: '4x2',
    dataSource: 'alerts',
    icon: 'bell',
    tags: ['alerts', 'live', 'real-time', 'feed'],
    defaultConfig: { severity: 'all', limit: 10, timeRange: '1d', drillTo: '/alerts' },
    configKeys: ['severity', 'limit', 'timeRange', 'domain', 'title'],
    preview: 'Scrollable list of recent alerts with customer, rule, severity, and age',
  },
  {
    id: 'alert_severity_donut',
    name: 'Alert Severity Mix',
    description: 'Donut chart showing alert distribution by severity',
    category: 'alerts',
    size: '2x2',
    dataSource: 'alerts',
    icon: 'pie-chart',
    tags: ['alerts', 'severity', 'chart', 'distribution'],
    defaultConfig: { timeRange: '7d', domain: 'both' },
    configKeys: ['timeRange', 'domain', 'title'],
    preview: 'Donut with Critical/High/Medium/Low segments and total count',
  },
  {
    id: 'alert_trend_chart',
    name: 'Alert Volume Trend',
    description: 'Daily alert volume trend over selected period',
    category: 'alerts',
    size: '4x2',
    dataSource: 'alerts',
    icon: 'trending-up',
    tags: ['alerts', 'trend', 'chart', 'volume'],
    defaultConfig: { timeRange: '30d', domain: 'both' },
    configKeys: ['timeRange', 'domain', 'severity', 'title'],
    preview: 'Line chart of daily alert count with severity breakdown',
  },
  {
    id: 'alert_sla_panel',
    name: 'SLA Status Panel',
    description: 'Alerts segmented by SLA status (on-time/breached/approaching)',
    category: 'alerts',
    size: '3x1',
    dataSource: 'alerts',
    icon: 'clock',
    tags: ['alerts', 'sla', 'compliance', 'panel'],
    defaultConfig: { timeRange: '7d', drillTo: '/alerts' },
    configKeys: ['timeRange', 'domain', 'title'],
    preview: 'Three-column panel: On Time | Approaching | Breached with counts',
  },

  // ── Investigation Widgets ─────────────────────────────────────────────
  {
    id: 'investigation_queue',
    name: 'Investigation Queue',
    description: 'Active investigation cases prioritized by urgency',
    category: 'investigations',
    size: '4x2',
    dataSource: 'cases',
    icon: 'search',
    tags: ['investigation', 'fraud', 'queue', 'cases'],
    defaultConfig: { limit: 8, timeRange: '30d', drillTo: '/investigation-center' },
    configKeys: ['limit', 'timeRange', 'domain', 'title'],
    preview: 'List of open investigations with case ID, type, assigned analyst, SLA',
  },
  {
    id: 'investigation_funnel',
    name: 'Investigation Funnel',
    description: 'Funnel showing investigation stages: Opened → In Progress → Closed',
    category: 'investigations',
    size: '3x2',
    dataSource: 'cases',
    icon: 'filter',
    tags: ['investigation', 'funnel', 'chart', 'workflow'],
    defaultConfig: { timeRange: '30d' },
    configKeys: ['timeRange', 'domain', 'title'],
    preview: 'Funnel chart from investigation opened to verdict',
  },
  {
    id: 'fraud_cluster_map',
    name: 'Fraud Cluster Map',
    description: 'Geographic heat-map of fraud clusters by region/branch',
    category: 'investigations',
    size: '4x2',
    dataSource: 'cases',
    icon: 'map-pin',
    tags: ['fraud', 'geographic', 'map', 'cluster'],
    defaultConfig: { timeRange: '30d', domain: 'banking' },
    configKeys: ['timeRange', 'domain', 'title'],
    preview: 'India map heat-map with fraud cluster intensity by geography',
  },
  {
    id: 'sar_filing_status',
    name: 'SAR Filing Status',
    description: 'Suspicious Activity Reports: filed, pending, overdue',
    category: 'investigations',
    size: '2x1',
    dataSource: 'compliance',
    icon: 'file-text',
    tags: ['sar', 'aml', 'compliance', 'filing'],
    defaultConfig: { showTrend: true, drillTo: '/investigation-center' },
    configKeys: ['timeRange', 'showTrend', 'title'],
    preview: 'SAR count panel with filed/pending/overdue split and 7-day deadline alerts',
  },

  // ── Compliance Widgets ────────────────────────────────────────────────
  {
    id: 'compliance_calendar',
    name: 'Filing Calendar',
    description: 'Upcoming regulatory filing deadlines (RBI, IRDAI, AML)',
    category: 'compliance',
    size: '4x2',
    dataSource: 'compliance',
    icon: 'calendar',
    tags: ['compliance', 'filing', 'calendar', 'deadlines'],
    defaultConfig: { limit: 6, drillTo: '/regulatory-compliance-center' },
    configKeys: ['limit', 'timeRange', 'domain', 'title'],
    preview: 'Card list of upcoming filings with days-remaining countdown badges',
  },
  {
    id: 'compliance_radar',
    name: 'Compliance Radar',
    description: 'Hexagonal radar chart across 6 compliance dimensions',
    category: 'compliance',
    size: '2x2',
    dataSource: 'compliance',
    icon: 'shield',
    tags: ['compliance', 'radar', 'chart', 'rbi', 'irdai'],
    defaultConfig: { domain: 'both', drillTo: '/regulatory-compliance-center' },
    configKeys: ['domain', 'title'],
    preview: 'Radar: RBI / Basel / AML / KYC / IRDAI / FATF readiness scores',
  },
  {
    id: 'kyc_backlog',
    name: 'KYC Review Backlog',
    description: 'Accounts with KYC refresh overdue or approaching expiry',
    category: 'compliance',
    size: '2x1',
    dataSource: 'compliance',
    icon: 'user-check',
    tags: ['kyc', 'compliance', 'backlog', 'rbi'],
    defaultConfig: { showTrend: true, drillTo: '/regulatory-compliance-center' },
    configKeys: ['threshold', 'showTrend', 'title'],
    preview: 'Count of KYC overdue accounts with severity (30/60/90 day segments)',
  },
  {
    id: 'aml_gaps',
    name: 'AML Compliance Gaps',
    description: 'AML flagged transactions pending resolution before filing',
    category: 'compliance',
    size: '2x1',
    dataSource: 'compliance',
    icon: 'alert-triangle',
    tags: ['aml', 'compliance', 'gaps', 'fiu'],
    defaultConfig: { showTrend: true, colorScheme: 'warning' },
    configKeys: ['showTrend', 'title'],
    preview: 'AML gap count with days-to-deadline and resolution progress bar',
  },

  // ── Data Fabric Widgets ───────────────────────────────────────────────
  {
    id: 'data_pipeline_health',
    name: 'Pipeline Health',
    description: 'Live health status of all data ingestion pipelines',
    category: 'data_fabric',
    size: '4x2',
    dataSource: 'static',
    icon: 'database',
    tags: ['data fabric', 'pipeline', 'health', 'ingestion'],
    defaultConfig: { drillTo: '/data-ingestion' },
    configKeys: ['title', 'limit'],
    preview: 'Grid of 8 connector health cards (CBS/Bureau/AML/IFRS9/Insurance)',
  },
  {
    id: 'data_quality_score',
    name: 'Data Quality Score',
    description: 'Overall DQ score with per-dataset breakdown',
    category: 'data_fabric',
    size: '2x2',
    dataSource: 'static',
    icon: 'bar-chart-2',
    tags: ['data quality', 'dq score', 'data fabric'],
    defaultConfig: { drillTo: '/dq-score', showTrend: true },
    configKeys: ['showTrend', 'title'],
    preview: 'DQ score gauge with critical violations count and freshness indicator',
  },
  {
    id: 'streaming_latency',
    name: 'Streaming Latency',
    description: 'Real-time p95 latency from data ingestion to alert (SLA: < 60s)',
    category: 'data_fabric',
    size: '2x1',
    dataSource: 'static',
    icon: 'zap',
    tags: ['streaming', 'latency', 'sla', 'real-time'],
    defaultConfig: { drillTo: '/admin/streaming-latency', threshold: 60 },
    configKeys: ['threshold', 'showTrend', 'title'],
    preview: 'p95 latency number with green/amber/red SLA status badge',
  },

  // ── Executive Widgets ─────────────────────────────────────────────────
  {
    id: 'executive_briefing',
    name: 'AI Executive Briefing',
    description: 'AI-generated daily briefing with top priorities and risks',
    category: 'executive',
    size: '4x2',
    dataSource: 'predictions',
    icon: 'sparkles',
    tags: ['executive', 'ai', 'briefing', 'daily'],
    defaultConfig: { drillTo: '/executive-cockpit' },
    configKeys: ['domain', 'title'],
    preview: 'Gradient card with AI-summarized top risks, pending decisions, deadlines',
  },
  {
    id: 'portfolio_pd_trend',
    name: 'Portfolio PD Trend',
    description: 'Weekly portfolio probability of default trend (4-week view)',
    category: 'executive',
    size: '4x2',
    dataSource: 'predictions',
    icon: 'trending-up',
    tags: ['pd', 'portfolio', 'trend', 'executive', 'npa'],
    defaultConfig: { timeRange: '30d', domain: 'banking', drillTo: '/predictive-risk-center' },
    configKeys: ['timeRange', 'domain', 'title'],
    preview: 'Area chart of weekly PD with high/medium/low band markers',
  },
  {
    id: 'board_scorecard',
    name: 'Board Scorecard',
    description: 'Key regulatory KPIs vs thresholds — board-ready view',
    category: 'executive',
    size: '4x2',
    dataSource: 'compliance',
    icon: 'clipboard-list',
    tags: ['executive', 'board', 'scorecard', 'regulatory'],
    defaultConfig: { domain: 'both', drillTo: '/board-reporting-center' },
    configKeys: ['domain', 'title'],
    preview: 'Traffic-light table: CRAR / NPA / PCR / LCR / Solvency vs thresholds',
  },
  {
    id: 'stress_test_results',
    name: 'Stress Test Summary',
    description: 'Latest RBI stress test results — ECL impact and capital adequacy',
    category: 'executive',
    size: '3x2',
    dataSource: 'predictions',
    icon: 'layers',
    tags: ['stress test', 'executive', 'ecl', 'capital', 'rbi'],
    defaultConfig: { drillTo: '/digital-twin-center' },
    configKeys: ['title', 'domain'],
    preview: 'Three-scenario table (Baseline/Adverse/Severely Adverse) with ECL, CRAR',
  },

  // ── AI Insights Widgets ───────────────────────────────────────────────
  {
    id: 'npa_prediction_list',
    name: 'NPA Prediction List',
    description: 'AI-scored top borrowers at risk of NPA in next 90 days',
    category: 'ai_insights',
    size: '4x2',
    dataSource: 'predictions',
    icon: 'cpu',
    tags: ['npa', 'ai', 'prediction', 'early warning'],
    defaultConfig: { threshold: 0.60, limit: 8, domain: 'banking', drillTo: '/banking/npa-prediction' },
    configKeys: ['threshold', 'limit', 'domain', 'title'],
    preview: 'Ranked list of high-PD borrowers with SHAP top factors and exposure',
  },
  {
    id: 'ai_recommendations',
    name: 'AI Recommendations',
    description: 'Autonomous agent recommendations awaiting human review',
    category: 'ai_insights',
    size: '4x2',
    dataSource: 'predictions',
    icon: 'brain-circuit',
    tags: ['ai', 'autonomous', 'recommendations', 'agent'],
    defaultConfig: { limit: 6, drillTo: '/autonomous-risk-center' },
    configKeys: ['limit', 'domain', 'title'],
    preview: 'Card list of agent recommendations with approve/override quick actions',
  },
  {
    id: 'model_performance',
    name: 'Model Performance',
    description: 'Production AI model AUC, drift, and champion/challenger status',
    category: 'ai_insights',
    size: '3x2',
    dataSource: 'predictions',
    icon: 'activity',
    tags: ['ai governance', 'model', 'performance', 'auc', 'drift'],
    defaultConfig: { drillTo: '/ai/governance' },
    configKeys: ['title', 'domain'],
    preview: 'Model table: NPA/Fraud/Churn/Lapse with AUC, PSI drift, status',
  },

  // ── Collections Widgets ───────────────────────────────────────────────
  {
    id: 'collections_queue',
    name: 'Collections Queue',
    description: 'NPA recovery cases prioritized by exposure and DPD',
    category: 'collections',
    size: '4x2',
    dataSource: 'recovery',
    icon: 'banknote',
    tags: ['collections', 'recovery', 'queue', 'npa'],
    defaultConfig: { limit: 8, timeRange: '30d', drillTo: '/collections-risk' },
    configKeys: ['limit', 'timeRange', 'title', 'domain'],
    preview: 'Recovery case list with borrower, DPD, exposure, assigned officer, status',
  },
  {
    id: 'recovery_funnel',
    name: 'Recovery Pipeline',
    description: 'Recovery stage distribution: Outreach → Legal → Resolution',
    category: 'collections',
    size: '3x2',
    dataSource: 'recovery',
    icon: 'git-branch',
    tags: ['recovery', 'funnel', 'pipeline', 'collections'],
    defaultConfig: { timeRange: '30d', drillTo: '/recovery-center' },
    configKeys: ['timeRange', 'domain', 'title'],
    preview: 'Funnel from outreach through legal to OTS/write-off with counts',
  },

  // ── Insurance Widgets ─────────────────────────────────────────────────
  {
    id: 'claims_ratio_trend',
    name: 'Claims Ratio Trend',
    description: 'Monthly claims ratio vs target — by product line',
    category: 'insurance',
    size: '4x2',
    dataSource: 'insurance',
    icon: 'bar-chart-2',
    tags: ['insurance', 'claims', 'ratio', 'trend', 'irdai'],
    defaultConfig: { timeRange: '30d', domain: 'insurance', drillTo: '/insurance/claims-anomaly' },
    configKeys: ['timeRange', 'threshold', 'title'],
    preview: 'Line chart of claims ratio with benchmark and target lines',
  },
  {
    id: 'persistency_heatmap',
    name: 'Persistency Heatmap',
    description: '13th/25th month persistency by agent and channel',
    category: 'insurance',
    size: '3x2',
    dataSource: 'insurance',
    icon: 'grid',
    tags: ['insurance', 'persistency', 'heatmap', 'channel', 'irdai'],
    defaultConfig: { domain: 'insurance', drillTo: '/insurance/policy-lapse' },
    configKeys: ['domain', 'title'],
    preview: 'Color-coded heatmap of persistency by channel and product type',
  },
  {
    id: 'solvency_gauge',
    name: 'Solvency Margin Gauge',
    description: 'ASM/RSM solvency ratio with IRDAI 1.5x threshold indicator',
    category: 'insurance',
    size: '2x2',
    dataSource: 'insurance',
    icon: 'gauge',
    tags: ['insurance', 'solvency', 'irdai', 'gauge'],
    defaultConfig: { domain: 'insurance', threshold: 1.5 },
    configKeys: ['threshold', 'title'],
    preview: 'Semi-circle gauge with red zone < 1.35x and watch zone < 1.5x',
  },

  // ── Banking Widgets ───────────────────────────────────────────────────
  {
    id: 'sma_migration',
    name: 'SMA Migration Tracker',
    description: 'Weekly SMA-0/1/2 account migration in/out flow',
    category: 'banking',
    size: '3x2',
    dataSource: 'predictions',
    icon: 'arrow-right',
    tags: ['banking', 'sma', 'migration', 'npa', 'rbi'],
    defaultConfig: { timeRange: '7d', domain: 'banking', drillTo: '/banking/sma' },
    configKeys: ['timeRange', 'domain', 'title'],
    preview: 'Sankey-style flow: New SMA entries vs cures vs NPA slippage',
  },
  {
    id: 'sector_concentration',
    name: 'Sector Concentration',
    description: 'Portfolio concentration by industry sector vs RBI limits',
    category: 'banking',
    size: '4x2',
    dataSource: 'indicators',
    icon: 'pie-chart',
    tags: ['banking', 'sector', 'concentration', 'rbi', 'portfolio'],
    defaultConfig: { domain: 'banking', drillTo: '/banking/sectors' },
    configKeys: ['domain', 'title', 'limit'],
    preview: 'Donut chart + table of sector exposure % vs RBI concentration limit',
  },
  {
    id: 'branch_heatmap',
    name: 'Branch Risk Heatmap',
    description: 'Geographic risk heatmap by branch NPA and alert concentration',
    category: 'banking',
    size: '4x2',
    dataSource: 'predictions',
    icon: 'map',
    tags: ['banking', 'branch', 'heatmap', 'geographic', 'npa'],
    defaultConfig: { domain: 'banking', drillTo: '/branch-heatmap' },
    configKeys: ['domain', 'timeRange', 'title'],
    preview: 'India state map heat-coded by branch-level NPA and alert intensity',
  },
];

// ─── Lookup helpers ───────────────────────────────────────────────────────

export function getWidgetsByCategory(category: MarketplaceCategory): MarketplaceWidget[] {
  return WIDGET_MARKETPLACE.filter(w => w.category === category);
}

export function searchWidgets(query: string): MarketplaceWidget[] {
  const q = query.toLowerCase();
  return WIDGET_MARKETPLACE.filter(w =>
    w.name.toLowerCase().includes(q) ||
    w.description.toLowerCase().includes(q) ||
    w.tags.some(t => t.includes(q))
  );
}

export function getWidgetById(id: string): MarketplaceWidget | undefined {
  return WIDGET_MARKETPLACE.find(w => w.id === id);
}

export const CATEGORY_LABELS: Record<MarketplaceCategory, string> = {
  kpi:           'KPI Widgets',
  alerts:        'Alert Widgets',
  investigations: 'Investigation Widgets',
  compliance:    'Compliance Widgets',
  data_fabric:   'Data Fabric Widgets',
  executive:     'Executive Widgets',
  ai_insights:   'AI Insights Widgets',
  collections:   'Collections Widgets',
  insurance:     'Insurance Widgets',
  banking:       'Banking Widgets',
};

export const CATEGORY_ICONS: Record<MarketplaceCategory, string> = {
  kpi:           'bar-chart-2',
  alerts:        'bell',
  investigations: 'search',
  compliance:    'shield',
  data_fabric:   'database',
  executive:     'gauge',
  ai_insights:   'cpu',
  collections:   'banknote',
  insurance:     'heart',
  banking:       'landmark',
};

export const SIZE_LABELS: Record<WidgetSize, string> = {
  '1x1': 'Tiny (1×1)',
  '2x1': 'Small (2×1)',
  '3x1': 'Medium (3×1)',
  '4x1': 'Wide (4×1)',
  '2x2': 'Square (2×2)',
  '4x2': 'Large (4×2)',
  '3x2': 'Medium-Large (3×2)',
};
