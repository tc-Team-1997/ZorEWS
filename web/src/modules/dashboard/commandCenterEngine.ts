// web/src/modules/dashboard/commandCenterEngine.ts
//
// Enterprise Risk Command Center — deterministic synthesis engine.
// Uses the same FNV-1a + Mulberry32 scheme as executiveCockpitEngine.ts
// so output is stable across browser reloads for the same (tenant, date).
// All functions are pure — no I/O, no side effects.

// ─── PRNG ────────────────────────────────────────────────────────────────

function fnv1a(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h = ((h ^ s.charCodeAt(i)) * 16777619) >>> 0;
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

function rngFor(scope: string): () => number {
  return mulberry32(fnv1a(scope));
}

function dayKey(d: Date) {
  return d.toISOString().slice(0, 10);
}

function round1(n: number) {
  return Math.round(n * 10) / 10;
}

// ─── SECTION 1 — Enterprise Risk Index ───────────────────────────────────

export interface RiskDimension {
  name: string;
  score: number;       // 0-100
  weight: number;      // 0-1, all weights sum to 1
  trend: 'up' | 'down' | 'flat';
  delta: number;       // signed change vs yesterday
}

export interface EnterpriseRiskIndex {
  score: number;         // 0-100, composite
  prevScore: number;
  delta: number;
  direction: 'increasing' | 'decreasing' | 'stable';
  confidence: number;    // 0-100
  band: 'low' | 'medium' | 'elevated' | 'high' | 'critical';
  dimensions: RiskDimension[];
}

const RISK_DIMENSIONS: Array<{ name: string; weight: number }> = [
  { name: 'Credit Risk',        weight: 0.22 },
  { name: 'Fraud Risk',         weight: 0.18 },
  { name: 'Operational Risk',   weight: 0.14 },
  { name: 'Compliance Risk',    weight: 0.14 },
  { name: 'Liquidity Risk',     weight: 0.12 },
  { name: 'Insurance Risk',     weight: 0.10 },
  { name: 'Investigation Risk', weight: 0.06 },
  { name: 'Security Risk',      weight: 0.04 },
];

function bandFor(score: number): EnterpriseRiskIndex['band'] {
  if (score < 25) return 'low';
  if (score < 45) return 'medium';
  if (score < 60) return 'elevated';
  if (score < 75) return 'high';
  return 'critical';
}

export function getEnterpriseRiskIndex(tenant_id: string, asOf: Date = new Date()): EnterpriseRiskIndex {
  const day = dayKey(asOf);
  const rng = rngFor(`cmd:eri:${tenant_id}:${day}`);
  const rngPrev = rngFor(`cmd:eri:${tenant_id}:prev`);

  const dimensions: RiskDimension[] = RISK_DIMENSIONS.map(({ name, weight }) => {
    const r = rngFor(`cmd:dim:${tenant_id}:${name}:${day}`);
    const score = Math.round(28 + r() * 52);   // 28-80 range
    const prevScore = Math.round(28 + rngFor(`cmd:dim:${tenant_id}:${name}:prev`)() * 52);
    const delta = score - prevScore;
    const trend: RiskDimension['trend'] = delta > 2 ? 'up' : delta < -2 ? 'down' : 'flat';
    return { name, score, weight, trend, delta };
  });

  const score = Math.round(
    dimensions.reduce((acc, d) => acc + d.score * d.weight, 0),
  );
  const prevScore = Math.round(22 + rngPrev() * 55);
  const delta = score - prevScore;

  return {
    score,
    prevScore,
    delta,
    direction: delta > 1 ? 'increasing' : delta < -1 ? 'decreasing' : 'stable',
    confidence: Math.round(78 + rng() * 18),
    band: bandFor(score),
    dimensions,
  };
}

// ─── SECTION 2 — Executive Morning Briefing ──────────────────────────────

export interface BriefingChange {
  label: string;
  value: string;
  delta: string;
  positive: boolean;
}

export interface BriefingPriority {
  rank: number;
  text: string;
  domain: string;
  urgency: 'immediate' | 'today' | 'this-week';
}

export interface ExecutiveBriefing {
  greeting: string;       // "Good Morning" | "Good Afternoon" | "Good Evening"
  userName: string;
  headline: string;
  changes: BriefingChange[];
  priorities: BriefingPriority[];
  actions: string[];
  summaryText: string;
}

export function getExecutiveBriefing(tenant_id: string, userName: string, asOf: Date = new Date()): ExecutiveBriefing {
  const hour = asOf.getHours();
  const greeting = hour < 12 ? 'Good Morning' : hour < 17 ? 'Good Afternoon' : 'Good Evening';
  const day = dayKey(asOf);
  const rng = rngFor(`cmd:brief:${tenant_id}:${day}`);

  const changes: BriefingChange[] = [
    { label: 'Risk Score',       value: `${Math.round(38 + rng() * 30)}`,            delta: `${rng() > 0.5 ? '+' : '−'}${Math.round(rng() * 4)}`, positive: rng() < 0.4 },
    { label: 'Active Alerts',    value: `${Math.round(40 + rng() * 120)}`,            delta: `${rng() > 0.5 ? '+' : '−'}${Math.round(rng() * 15)}`, positive: rng() < 0.4 },
    { label: 'Open Cases',       value: `${Math.round(12 + rng() * 60)}`,             delta: `${rng() > 0.5 ? '+' : '−'}${Math.round(rng() * 8)}`, positive: rng() < 0.4 },
    { label: 'Compliance Score', value: `${Math.round(74 + rng() * 20)}%`,            delta: `${rng() > 0.5 ? '+' : '−'}${round1(rng() * 2)}%`, positive: rng() > 0.5 },
    { label: 'Security Events',  value: `${Math.round(2 + rng() * 18)}`,              delta: `${rng() > 0.5 ? '+' : '−'}${Math.round(rng() * 5)}`, positive: rng() < 0.3 },
    { label: 'Recovery Actions', value: `${Math.round(1 + rng() * 8)}`,               delta: `${rng() > 0.5 ? '+' : '−'}${Math.round(rng() * 3)}`, positive: rng() < 0.4 },
  ];

  const priorities: BriefingPriority[] = [
    { rank: 1, text: 'Review 3 critical fraud alerts in MSME portfolio',    domain: 'Fraud',      urgency: 'immediate' },
    { rank: 2, text: 'Approve 2 case escalations pending maker-checker',    domain: 'Cases',      urgency: 'today' },
    { rank: 3, text: 'RBI quarterly compliance filing due in 4 days',       domain: 'Compliance', urgency: 'this-week' },
    { rank: 4, text: 'NPA prediction: 8 borrowers crossed 75% threshold',   domain: 'Credit',     urgency: 'today' },
    { rank: 5, text: 'Security anomaly detected: after-hours admin logins',  domain: 'Security',   urgency: 'immediate' },
  ];

  const actions = [
    'Trigger immediate fraud case review for accounts flagged by AI model',
    'Initiate RBI compliance readiness check for Q2 filing',
    'Escalate NPA early warning alerts to relationship managers',
  ];

  return {
    greeting,
    userName: userName || 'Executive',
    headline: 'Platform risk within acceptable parameters. 2 items require immediate attention.',
    changes,
    priorities,
    actions,
    summaryText: `Portfolio risk score is ${Math.round(38 + rngFor(`cmd:brief2:${tenant_id}:${day}`)() * 30)} today, ${rngFor(`cmd:brief3:${tenant_id}:${day}`)() > 0.5 ? 'up' : 'down'} from yesterday. Fraud detection model flagged a new cluster in MSME segment. Compliance readiness is on track for Q2 filing.`,
  };
}

// ─── SECTION 3 — Top Emerging Risks ─────────────────────────────────────

export interface EmergingRisk {
  name: string;
  domain: 'Banking' | 'Insurance' | 'Cross-domain';
  severity: 'critical' | 'high' | 'medium';
  confidence: number;
  trend: 'accelerating' | 'stable' | 'decelerating';
  impact: string;
  daysToMaterial: number;
}

export function getEmergingRisks(tenant_id: string, asOf: Date = new Date()): EmergingRisk[] {
  const day = dayKey(asOf);
  const BASE: EmergingRisk[] = [
    { name: 'MSME Portfolio Stress',   domain: 'Banking',      severity: 'high',     confidence: 82, trend: 'accelerating',  impact: '₹124 Cr exposure',    daysToMaterial: 21 },
    { name: 'Claims Inflation Spike',  domain: 'Insurance',    severity: 'high',     confidence: 77, trend: 'accelerating',  impact: '₹38 Cr at risk',      daysToMaterial: 14 },
    { name: 'Fraud Cluster — North',   domain: 'Banking',      severity: 'critical', confidence: 91, trend: 'accelerating',  impact: '₹9.4 Cr exposed',     daysToMaterial: 7  },
    { name: 'Liquidity Gap — Q3',      domain: 'Banking',      severity: 'medium',   confidence: 65, trend: 'stable',        impact: '₹280 Cr buffer risk',  daysToMaterial: 45 },
    { name: 'Persistency Decline',     domain: 'Insurance',    severity: 'medium',   confidence: 71, trend: 'decelerating',  impact: '₹17 Cr GWP at risk',   daysToMaterial: 60 },
    { name: 'Cross-border AML Signal', domain: 'Cross-domain', severity: 'high',     confidence: 84, trend: 'accelerating',  impact: 'Regulatory action',    daysToMaterial: 10 },
  ];
  return BASE.map((r, i) => {
    const rng = rngFor(`cmd:er:${tenant_id}:${day}:${i}`);
    return { ...r, confidence: Math.min(98, r.confidence + Math.round((rng() - 0.5) * 6)) };
  });
}

// ─── SECTION 4 — Enterprise Heat Map ────────────────────────────────────

export interface HeatCell {
  label: string;
  riskScore: number;
  alertDensity: number;
  caseDensity: number;
  violations: number;
}

export type HeatDimension = 'Region' | 'Branch' | 'Country' | 'Tenant';

const REGIONS = ['North India', 'West India', 'South India', 'East India', 'GCC', 'SEA'];
const BRANCHES = ['Mumbai-BKC', 'Delhi-CP', 'Bengaluru-MG', 'Chennai-Anna Salai', 'Hyderabad-Hitec', 'Pune-FC Road'];
const COUNTRIES = ['India', 'UAE', 'Singapore', 'Bhutan', 'Kenya', 'USA'];
const TENANTS = ['SBI', 'HDFC', 'ICICI', 'BIL', 'Axis', 'BoB'];

const DIM_LABELS: Record<HeatDimension, string[]> = {
  Region: REGIONS, Branch: BRANCHES, Country: COUNTRIES, Tenant: TENANTS,
};

export function getHeatMap(dimension: HeatDimension, tenant_id: string, asOf: Date = new Date()): HeatCell[] {
  const day = dayKey(asOf);
  return DIM_LABELS[dimension].map((label) => {
    const rng = rngFor(`cmd:heat:${dimension}:${tenant_id}:${label}:${day}`);
    return {
      label,
      riskScore: Math.round(20 + rng() * 72),
      alertDensity: Math.round(2 + rng() * 48),
      caseDensity: Math.round(1 + rng() * 22),
      violations: Math.round(rng() * 8),
    };
  });
}

// ─── SECTION 5 — Executive Forecast Strip ────────────────────────────────

export interface ForecastMetric {
  label: string;
  horizon: '30d' | '60d' | '90d' | '180d';
  value: string;
  direction: 'up' | 'down' | 'flat';
  confidence: number;
  color: string;
}

export function getForecastStrip(tenant_id: string, asOf: Date = new Date()): ForecastMetric[] {
  const day = dayKey(asOf);
  const HORIZONS: ForecastMetric['horizon'][] = ['30d', '60d', '90d', '180d'];
  const METRICS = [
    { label: 'NPA Forecast',        baseVal: 4.8,  unit: '%', upBad: true  },
    { label: 'Fraud Exposure',      baseVal: 12.4, unit: '₹Cr', upBad: true  },
    { label: 'Claims Ratio',        baseVal: 72,   unit: '%', upBad: true  },
    { label: 'Compliance Score',    baseVal: 88,   unit: '%', upBad: false },
    { label: 'Portfolio Risk',      baseVal: 52,   unit: '/100', upBad: true  },
  ];

  const out: ForecastMetric[] = [];
  METRICS.forEach(({ label, baseVal, unit, upBad }) => {
    HORIZONS.forEach((h) => {
      const rng = rngFor(`cmd:fc:${tenant_id}:${label}:${h}:${day}`);
      const multiplier = h === '30d' ? 1 : h === '60d' ? 1.06 : h === '90d' ? 1.13 : 1.22;
      const raw = round1(baseVal * multiplier * (0.96 + rng() * 0.08));
      const delta = raw - baseVal;
      const direction: ForecastMetric['direction'] = delta > 0.3 ? 'up' : delta < -0.3 ? 'down' : 'flat';
      const worsening = (upBad && direction === 'up') || (!upBad && direction === 'down');
      out.push({
        label, horizon: h,
        value: `${raw}${unit}`,
        direction,
        confidence: Math.round(88 - (h === '180d' ? 18 : h === '90d' ? 10 : h === '60d' ? 5 : 0) + rng() * 6),
        color: worsening ? '#DC2626' : direction === 'flat' ? '#6B7280' : '#16A34A',
      });
    });
  });
  return out;
}

// ─── SECTION 6 — Alert Radar ─────────────────────────────────────────────

export interface AlertRadarData {
  severity: 'critical' | 'high' | 'medium' | 'low';
  count: number;
  trend: number;       // % change vs yesterday
  escalations: number;
  slaBreaches: number;
}

export function getAlertRadar(tenant_id: string, asOf: Date = new Date()): AlertRadarData[] {
  const day = dayKey(asOf);
  const SVRS: AlertRadarData['severity'][] = ['critical', 'high', 'medium', 'low'];
  const COUNTS = [4, 28, 65, 140];
  return SVRS.map((severity, i) => {
    const rng = rngFor(`cmd:radar:${tenant_id}:${severity}:${day}`);
    const count = Math.round(COUNTS[i]! * (0.8 + rng() * 0.4));
    return {
      severity,
      count,
      trend: round1((rng() - 0.45) * 30),
      escalations: Math.round(count * 0.08 * rng()),
      slaBreaches: Math.round(count * 0.05 * rng()),
    };
  });
}

// ─── SECTION 7 — Investigation Health ────────────────────────────────────

export interface InvestigationHealth {
  open: number;
  escalated: number;
  pendingApproval: number;
  slaBreaches: number;
  closedToday: number;
  avgResolutionHours: number;
  trend: 'improving' | 'stable' | 'deteriorating';
}

export function getInvestigationHealth(tenant_id: string, asOf: Date = new Date()): InvestigationHealth {
  const rng = rngFor(`cmd:inv:${tenant_id}:${dayKey(asOf)}`);
  const open = Math.round(18 + rng() * 60);
  return {
    open,
    escalated:         Math.round(open * 0.15 * rng()),
    pendingApproval:   Math.round(open * 0.22 * rng()),
    slaBreaches:       Math.round(open * 0.08 * rng()),
    closedToday:       Math.round(2 + rng() * 12),
    avgResolutionHours: round1(18 + rng() * 54),
    trend:             rng() < 0.4 ? 'improving' : rng() < 0.7 ? 'stable' : 'deteriorating',
  };
}

// ─── SECTION 8 — Regulatory Readiness ────────────────────────────────────

export interface RegReadiness {
  regulator: string;
  compliance: number;  // 0-100
  risk: number;        // 0-100
  trend: 'up' | 'down' | 'flat';
  nextDeadline: string;
  status: 'compliant' | 'at-risk' | 'breach';
}

export function getRegulatoryReadiness(tenant_id: string, asOf: Date = new Date()): RegReadiness[] {
  const day = dayKey(asOf);
  const REGS = [
    { regulator: 'RBI',   base: 88, deadline: 'Q2 Filing — 14 days' },
    { regulator: 'Basel', base: 91, deadline: 'ICAAP — 45 days'     },
    { regulator: 'AML',   base: 79, deadline: 'Monthly — 8 days'    },
    { regulator: 'KYC',   base: 85, deadline: 'Quarterly — 22 days' },
    { regulator: 'IRDAI', base: 82, deadline: 'H1 Return — 30 days' },
  ];
  return REGS.map(({ regulator, base, deadline }) => {
    const rng = rngFor(`cmd:reg:${tenant_id}:${regulator}:${day}`);
    const compliance = Math.round(Math.min(99, base + (rng() - 0.5) * 12));
    const risk       = Math.round(100 - compliance + rng() * 8);
    const trend: RegReadiness['trend'] = rng() < 0.45 ? 'up' : rng() < 0.7 ? 'flat' : 'down';
    const status: RegReadiness['status'] =
      compliance >= 85 ? 'compliant' : compliance >= 72 ? 'at-risk' : 'breach';
    return { regulator, compliance, risk, trend, nextDeadline: deadline, status };
  });
}

// ─── SECTION 9 — Tenant Benchmarking ─────────────────────────────────────

export interface BenchmarkRow {
  tenant: string;
  riskScore: number;
  alertRate: number;    // per 1000 accounts
  fraudRate: number;    // bps
  recoveryRate: number; // %
  complianceScore: number;
  isSelf: boolean;
}

const BANKING_TENANTS  = ['SBI', 'HDFC', 'ICICI', 'Axis', 'BoB'];
const INSURANCE_TENANTS = ['LIC', 'HDFC Ergo', 'ICICI Lombard', 'BIL', 'New India'];

export function getTenantBenchmarks(_tenant_id: string, domain: 'banking' | 'insurance' | null, asOf: Date = new Date()): BenchmarkRow[] {
  const day = dayKey(asOf);
  const tenants = domain === 'insurance' ? INSURANCE_TENANTS : BANKING_TENANTS;
  const selfName = domain === 'insurance' ? 'BIL' : 'BANK_DEMO';
  return tenants.map((tenant) => {
    const rng = rngFor(`cmd:bench:${tenant}:${day}`);
    return {
      tenant: tenant === selfName ? `${tenant} (You)` : tenant,
      riskScore:       Math.round(30 + rng() * 55),
      alertRate:       round1(1.2 + rng() * 8.4),
      fraudRate:       round1(2 + rng() * 28),
      recoveryRate:    round1(55 + rng() * 38),
      complianceScore: Math.round(72 + rng() * 25),
      isSelf:          tenant === selfName,
    };
  });
}

// ─── SECTION 10 — AI Copilot responses ───────────────────────────────────

export interface CopilotResponse {
  query: string;
  explanation: string;
  riskDrivers: string[];
  actions: string[];
  relatedCases: number;
  relatedAlerts: number;
}

export const COPILOT_PROMPTS = [
  'Why did risk increase this week?',
  'Show top fraud drivers',
  'Which branches need attention?',
  'What is driving NPA increase?',
  'Summarize compliance exposure',
] as const;

export function getCopilotResponse(query: string, _tenant_id: string): CopilotResponse {
  const RESPONSES: Record<string, Omit<CopilotResponse, 'query'>> = {
    'Why did risk increase this week?': {
      explanation: 'Enterprise risk index increased by 4.2 points driven by a new MSME fraud cluster detected in North India, coupled with a 12% rise in DPD-30+ accounts in the SME book. Operational risk also ticked up due to 3 system anomalies flagged by the security module.',
      riskDrivers: ['MSME fraud cluster (+1.8 pts)', 'DPD-30+ increase (+1.4 pts)', 'System anomalies (+0.7 pts)', 'Claims volatility (+0.3 pts)'],
      actions: ['Escalate MSME fraud cases to investigation', 'Review DPD early warning thresholds', 'Run security incident assessment'],
      relatedCases: 14, relatedAlerts: 38,
    },
    'Show top fraud drivers': {
      explanation: 'Fraud risk is primarily driven by a coordinated synthetic identity cluster affecting 23 accounts across 4 branches. AI model confidence is 91%. Secondary driver is velocity anomalies in UPI transactions in the evening window (8-11 PM).',
      riskDrivers: ['Synthetic identity cluster (₹9.4 Cr)', 'UPI velocity anomaly (₹2.1 Cr)', 'Account takeover attempts (₹0.8 Cr)'],
      actions: ['Freeze 23 flagged accounts for review', 'Apply velocity controls on UPI channel', 'Initiate KYC re-verification batch'],
      relatedCases: 23, relatedAlerts: 61,
    },
    'Which branches need attention?': {
      explanation: 'Mumbai-BKC and Delhi-CP branches have the highest composite risk scores this week. Mumbai-BKC shows elevated fraud signals; Delhi-CP shows compliance documentation gaps for 14% of accounts.',
      riskDrivers: ['Mumbai-BKC: fraud score 78/100', 'Delhi-CP: compliance score 71/100', 'Hyderabad-Hitec: NPA watch list +6 accounts'],
      actions: ['Schedule branch audit for Mumbai-BKC', 'Issue compliance remediation notice to Delhi-CP', 'Assign relationship manager to Hyderabad accounts'],
      relatedCases: 8, relatedAlerts: 27,
    },
    'What is driving NPA increase?': {
      explanation: 'NPA trend is driven by 3 interconnected factors: MSME sector stress post-GST revisions, unseasoned retail book in Q4 FY25 vintages, and 2 large corporate accounts in the construction segment entering pre-NPA territory.',
      riskDrivers: ['MSME sector stress (+₹42 Cr)', 'Retail Q4 FY25 vintage (+₹18 Cr)', 'Construction corporates (+₹64 Cr)'],
      actions: ['Invoke MSME restructuring playbook', 'Flag Q4 vintage for enhanced monitoring', 'Initiate covenant review for 2 construction accounts'],
      relatedCases: 19, relatedAlerts: 44,
    },
    'Summarize compliance exposure': {
      explanation: 'Compliance readiness is 88% overall. AML module has the highest risk at 79% compliance — monthly filing due in 8 days. RBI Q2 filing is on track. IRDAI H1 return requires 3 additional documents.',
      riskDrivers: ['AML monthly filing gap (8 days)', 'IRDAI H1 document shortfall', 'KYC periodic review backlog: 420 accounts'],
      actions: ['Complete AML filing preparation immediately', 'Collect 3 outstanding IRDAI documents', 'Initiate KYC batch review for 420 accounts'],
      relatedCases: 6, relatedAlerts: 12,
    },
  };

  const match = RESPONSES[query] ?? RESPONSES['Why did risk increase this week?']!;
  return { query, ...match };
}
