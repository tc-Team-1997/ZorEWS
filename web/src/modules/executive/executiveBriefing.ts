// web/src/modules/executive/executiveBriefing.ts
//
// AI Executive Briefing generator — daily / weekly / monthly summary cards.
//
// Pure heuristic — deterministic per (tenant, period_start_date) via
// FNV-1a + Mulberry32. Same scheme as aiInsights.ts / bil_dashboards.ts.
// Production swap: function body becomes a Claude / Bedrock messages call
// returning the same shape; signature stays stable.

export type BriefingCadence = 'daily' | 'weekly' | 'monthly';

export const ALL_BRIEFING_CADENCES: readonly BriefingCadence[] = [
  'daily', 'weekly', 'monthly',
] as const;

export interface BriefingHighlight {
  /** Headline metric (e.g. "Portfolio risk +12%"). */
  metric: string;
  /** Direction interpretation. */
  direction: 'positive' | 'negative' | 'neutral';
  /** Single-sentence operator context. */
  detail: string;
  /** Optional drill target. */
  drill_to?: string;
}

export interface ExecutiveBriefing {
  id: string;
  cadence: BriefingCadence;
  period_label: string;
  period_start: string;
  period_end: string;
  generated_at: string;
  /** Top-line one-sentence summary the cockpit renders prominently. */
  headline: string;
  /** 4-6 highlight cards. */
  highlights: BriefingHighlight[];
  /** Single recommended next action for the executive. */
  recommended_action: string;
}

// FNV-1a + Mulberry32
function fnv1a(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h * 16777619) >>> 0;
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let t = seed;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = t;
    r = Math.imul(r ^ (r >>> 15), r | 1);
    r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

const HIGHLIGHT_POOL: ReadonlyArray<{ metric: string; direction: 'positive' | 'negative' | 'neutral'; detail: string; drill_to?: string }> = [
  { metric: 'Portfolio risk score',          direction: 'negative', detail: 'Composite risk score climbed 12 pts vs last period — concentration in NPA-prone sectors.', drill_to: '/banking/sectors' },
  { metric: 'Fraud exposure',                direction: 'positive', detail: 'Active fraud exposure reduced 7% MoM — rule engine retraining + AML adapter wins.', drill_to: '/fraud-signals' },
  { metric: 'Solvency ratio',                direction: 'positive', detail: 'Solvency improved to 218% (IRDAI floor 150%, internal target 200%).', drill_to: '/insurance/solvency' },
  { metric: 'Branch concentration risk',     direction: 'negative', detail: 'Top 5 branches now hold 38% of high-risk exposure (was 31% last quarter).', drill_to: '/branch-heatmap' },
  { metric: 'NPA forecast',                  direction: 'negative', detail: 'PD model projects +23 NPAs over the next quarter — concentrated in SME book.', drill_to: '/banking/npa-prediction' },
  { metric: 'Recovery rate',                 direction: 'positive', detail: 'Recovery rate climbed to 94.2% (target 90%) — Recovery Center workflow adoption driving lift.', drill_to: '/recovery-center/analytics' },
  { metric: 'Compliance score',              direction: 'positive', detail: 'Audit-chain integrity 100% over trailing 30 days; access reviews on schedule.', drill_to: '/audit-center' },
  { metric: 'Policy lapse forecast',         direction: 'negative', detail: '312 policies (₹6.2 Cr premium AUM) projected to lapse in next 60 days.', drill_to: '/insurance/policy-lapse' },
  { metric: 'Claims anomaly cluster',        direction: 'negative', detail: '8 claims this week share WAITING_PERIOD_BREACH + AMOUNT_DEVIATION_30PCT fingerprint.', drill_to: '/insurance/claims-anomaly' },
  { metric: 'Persistency 37-month',          direction: 'negative', detail: 'West Zone persistency fell 2.1 pp — channel mix shift detected.', drill_to: '/insurance/persistency' },
  { metric: 'AI model drift',                direction: 'negative', detail: 'Fraud-LightGBM drift score 0.34 — above 0.30 threshold. Retrain candidate flagged.', drill_to: '/ai/governance/drift' },
  { metric: 'Maker-checker SLA',             direction: 'negative', detail: '6 case maker-checker approvals are within 24h of SLA breach.', drill_to: '/cms/workflow' },
  { metric: 'Hospital fraud cluster',        direction: 'negative', detail: '3 hospitals in NCR cluster show > 12% repeat-claim rate (network avg 4.1%).', drill_to: '/insurance/fraud' },
  { metric: 'Top exposure customer',         direction: 'negative', detail: 'CUST-12873 crossed PD 0.62 — exposure ₹4.8 Cr. Assign relationship manager.', drill_to: '/customers?level=High' },
  { metric: 'Risk-adjusted return',          direction: 'positive', detail: 'RaR held at 16.4% — above tier-1 banking target of 15%.', drill_to: '/analytics' },
  { metric: 'Country diversification',       direction: 'neutral',  detail: 'Cross-country diversification index flat at 0.67 — no shift this period.', drill_to: '/admin/governance/organization' },
];

const RECOMMENDED_ACTIONS: readonly string[] = [
  'Schedule a CRO review of the SME book concentration risk before next board meeting.',
  'Initiate maker-checker review on the top-3 retail rule templates given drift signals.',
  'Convene fraud + compliance leads to discuss NCR hospital cluster intervention.',
  'Brief the board on the +12% portfolio risk score uptick at next monthly meeting.',
  'Authorize relationship-manager outreach to the 8 customers in the high-exposure watch.',
  'Approve recovery-team headcount uplift to sustain 94.2% restore rate.',
  'Direct the AI/ML lead to action the fraud-LightGBM drift retraining now.',
];

const CADENCE_HEADLINES: Record<BriefingCadence, readonly string[]> = {
  daily: [
    'Today\'s risk picture stable; 2 critical alerts in the SME book need same-day attention.',
    'Daily snapshot: fraud exposure ticked down, lapse risk ticked up.',
    'Routine day — no breach-band events. Maker-checker queue clean.',
  ],
  weekly: [
    'Week-on-week portfolio risk climbed 4.2 pts; fraud exposure improved 2.1%.',
    'Weekly headline: recovery rate sustained above target; persistency under target in 1 zone.',
    'Mid-quarter pulse — compliance posture green; NPA forecast trending warmer.',
  ],
  monthly: [
    'Monthly summary: portfolio risk +12%, fraud exposure -7%, solvency improved, branch concentration risk rising.',
    'M-o-M view: the recovery workflow upgrade is paying off; underwriting deviation under control.',
    'Monthly board view: compliance health 96/100; risk-adjusted return held at 16.4%.',
  ],
};

const PERIOD_LABEL_FORMATTERS: Record<BriefingCadence, (d: Date) => string> = {
  daily: (d) => d.toISOString().slice(0, 10),
  weekly: (d) => 'Week of ' + d.toISOString().slice(0, 10),
  monthly: (d) => d.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' }),
};

function periodWindow(cadence: BriefingCadence, asOf: Date): { start: Date; end: Date } {
  const end = new Date(asOf);
  const start = new Date(asOf);
  if (cadence === 'daily') {
    start.setUTCHours(0, 0, 0, 0);
    end.setUTCHours(23, 59, 59, 999);
  } else if (cadence === 'weekly') {
    start.setUTCDate(start.getUTCDate() - 6);
    start.setUTCHours(0, 0, 0, 0);
    end.setUTCHours(23, 59, 59, 999);
  } else {
    start.setUTCMonth(start.getUTCMonth() - 1);
    start.setUTCDate(1);
    start.setUTCHours(0, 0, 0, 0);
    end.setUTCHours(23, 59, 59, 999);
  }
  return { start, end };
}

const HIGHLIGHTS_PER_CADENCE: Record<BriefingCadence, number> = {
  daily: 4,
  weekly: 5,
  monthly: 6,
};

/**
 * Generate one briefing per cadence (daily / weekly / monthly).
 * Deterministic per (tenant, cadence, period_start). Same inputs → same output.
 */
export function generateExecutiveBriefing(
  tenant_id: string,
  cadence: BriefingCadence,
  asOf: Date = new Date(),
): ExecutiveBriefing {
  const { start, end } = periodWindow(cadence, asOf);
  const seedKey = 'exec:briefing:' + tenant_id + ':' + cadence + ':' + start.toISOString().slice(0, 10);
  const rng = mulberry32(fnv1a(seedKey));

  // Pick N distinct highlights without replacement
  const target = HIGHLIGHTS_PER_CADENCE[cadence];
  type Highlight = { metric: string; direction: 'positive' | 'negative' | 'neutral'; detail: string; drill_to?: string };
  const picked: Highlight[] = [];
  const idxs = new Set<number>();
  let safety = HIGHLIGHT_POOL.length * 4;
  while (picked.length < target && idxs.size < HIGHLIGHT_POOL.length && safety-- > 0) {
    const i = Math.floor(rng() * HIGHLIGHT_POOL.length);
    if (idxs.has(i)) continue;
    idxs.add(i);
    picked.push(HIGHLIGHT_POOL[i]!);
  }

  const headlinePool = CADENCE_HEADLINES[cadence];
  const headline = headlinePool[Math.floor(rng() * headlinePool.length)]!;
  const action = RECOMMENDED_ACTIONS[Math.floor(rng() * RECOMMENDED_ACTIONS.length)]!;

  return {
    id: 'briefing-' + tenant_id + '-' + cadence + '-' + start.toISOString().slice(0, 10),
    cadence,
    period_label: PERIOD_LABEL_FORMATTERS[cadence](start),
    period_start: start.toISOString(),
    period_end: end.toISOString(),
    generated_at: asOf.toISOString(),
    headline,
    highlights: picked.map((p) => ({ ...p })),
    recommended_action: action,
  };
}

/**
 * Generate all 3 briefings (daily + weekly + monthly) for a given tenant in
 * one call — drives the Section 5 panel in a single pass.
 */
export function generateAllBriefings(tenant_id: string, asOf: Date = new Date()): readonly ExecutiveBriefing[] {
  return ALL_BRIEFING_CADENCES.map((c) => generateExecutiveBriefing(tenant_id, c, asOf));
}

// ───────────────────────────────────────────────────────────────────────
// Section 6 — Board Reporting Hub (report definitions)
// ───────────────────────────────────────────────────────────────────────

export type ReportFormat = 'pdf' | 'xlsx' | 'csv';

export const ALL_REPORT_FORMATS: readonly ReportFormat[] = ['pdf', 'xlsx', 'csv'] as const;

export type ReportTemplate =
  | 'executive_summary'
  | 'quarterly_board_pack'
  | 'regulatory_rbi_quarterly'
  | 'regulatory_irdai_quarterly'
  | 'risk_profile_snapshot'
  | 'recovery_performance'
  | 'fraud_investigation_summary';

export interface ReportTemplateDef {
  id: ReportTemplate;
  label: string;
  description: string;
  /** Supported export formats. */
  formats: readonly ReportFormat[];
  /** Cadence the template is typically run at. */
  cadence: 'on_demand' | 'weekly' | 'monthly' | 'quarterly';
  /** Where the data feeding the report comes from. */
  source: string;
  /** Reuses existing T4.6 self-service report builder data source id. */
  legacy_source_id?: string;
}

export const REPORT_TEMPLATES: readonly ReportTemplateDef[] = [
  { id: 'executive_summary',        label: 'Executive Summary',        description: 'Cockpit KPI snapshot + AI briefing + top-10 exposures.',  formats: ['pdf', 'xlsx'],    cadence: 'on_demand', source: 'Cockpit live state' },
  { id: 'quarterly_board_pack',     label: 'Quarterly Board Pack',     description: '40-slide board deck — risk / portfolio / compliance / AI.', formats: ['pdf'],             cadence: 'quarterly', source: 'Cockpit + analytics rollup' },
  { id: 'regulatory_rbi_quarterly', label: 'RBI Quarterly Pack',       description: 'RBI Master Direction on Banking Operations quarterly pack.',  formats: ['pdf', 'xlsx'],    cadence: 'quarterly', source: 'mart.customer_360 + audit chain', legacy_source_id: 'recovery_records' },
  { id: 'regulatory_irdai_quarterly', label: 'IRDAI Quarterly Pack',   description: 'IRDAI Form-K + solvency + persistency disclosures pack.',      formats: ['pdf', 'xlsx'],    cadence: 'quarterly', source: 'mart.policy_360 (when wired)' },
  { id: 'risk_profile_snapshot',    label: 'Risk Profile Snapshot',    description: 'Customer + portfolio risk profile rollup for a window.',      formats: ['pdf', 'xlsx', 'csv'], cadence: 'on_demand', source: 'mart.customer_360' },
  { id: 'recovery_performance',     label: 'Recovery Performance',     description: 'Restore + purge + approval timeline (M15 chain pivot).',     formats: ['pdf', 'xlsx', 'csv'], cadence: 'monthly',   source: 'app_recovery.recovery_workflow_events', legacy_source_id: 'recovery_actions' },
  { id: 'fraud_investigation_summary', label: 'Fraud Investigation Summary', description: 'Open + closed fraud investigations with verdicts.',     formats: ['pdf', 'xlsx'],    cadence: 'monthly',   source: 'investigation tracker + fraud signals' },
];

export function getReportTemplate(id: string): ReportTemplateDef | undefined {
  return REPORT_TEMPLATES.find((r) => r.id === id);
}
