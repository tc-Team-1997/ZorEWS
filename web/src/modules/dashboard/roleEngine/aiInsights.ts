// web/src/modules/dashboard/roleEngine/aiInsights.ts
//
// Heuristic AI insight generator — pure function emitting 5 insight cards
// per dashboard load. Deterministic per (role, domain, ISO date) so dev
// mode + tests get stable cards without calling out to an LLM.
//
// Production swap: this function's body becomes a Claude/Bedrock call
// returning the same shape; signature + return type stay stable.

export type AiInsightSeverity = 'info' | 'watch' | 'warning' | 'critical';

export const ALL_AI_INSIGHT_SEVERITIES: readonly AiInsightSeverity[] = [
  'info', 'watch', 'warning', 'critical',
] as const;

export interface AiInsightCard {
  id: string;
  title: string;
  body: string;
  severity: AiInsightSeverity;
  generated_at: string;
  /** Optional deep-link the SPA renders as "Investigate →". */
  drill_to?: string;
}

// FNV-1a + Mulberry32 (same scheme as bil_dashboards.ts + Security Activity Center)
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

const BANKING_TEMPLATES: ReadonlyArray<{ title: string; body: string; severity: AiInsightSeverity; drill_to?: string }> = [
  { title: 'Rising SMA-1 trend detected',           body: 'SMA-1 classifications rose 18% week-over-week in the SME book. Inspect borrowers crossing 30-DPD.', severity: 'warning',  drill_to: '/banking/sma' },
  { title: 'NPA forecast deteriorating',            body: 'PD model forecasts 23 additional NPAs over the next quarter — concentrated in Maharashtra branch cluster.', severity: 'warning',  drill_to: '/banking/npa-prediction' },
  { title: 'Fraud activity spike observed',         body: 'Cross-channel fraud-signal firings up 42% in the last 7 days. 6 customers carry ≥ 2 active fraud flags.', severity: 'critical', drill_to: '/fraud-signals' },
  { title: 'Branch risk worsening',                 body: 'Branch BR-082 moved from medium → high risk band this week. PD weighted average jumped 0.12.', severity: 'warning',  drill_to: '/branch-heatmap' },
  { title: 'Account behaviour anomaly cluster',     body: '14 accounts share a transaction-pattern fingerprint suggesting coordinated fund movement.', severity: 'warning',  drill_to: '/account-behaviour' },
  { title: 'Compliance posture improved',           body: 'Audit-chain integrity 100% over trailing 30 days; access-review SLA met for 4 consecutive quarters.', severity: 'info',     drill_to: '/audit-center' },
  { title: 'Recovery rate above target',            body: 'Restore-success rate climbed to 94.2% (target 90%) — Recovery Center workflow adoption driving lift.', severity: 'info',     drill_to: '/recovery-center/analytics' },
  { title: 'High-exposure customer flagged',        body: 'CUST-12873 (exposure ₹4.8 Cr) crossed PD threshold 0.62 — assign relationship manager review.', severity: 'critical', drill_to: '/customers?level=High' },
];

const INSURANCE_TEMPLATES: ReadonlyArray<{ title: string; body: string; severity: AiInsightSeverity; drill_to?: string }> = [
  { title: 'Policy lapse risk increased',           body: 'Lapse-risk model identifies 312 policies (₹6.2 Cr premium AUM) at high lapse probability in next 60 days.', severity: 'warning',  drill_to: '/insurance/policy-lapse' },
  { title: 'Claims anomaly cluster detected',       body: '8 claims this week share the WAITING_PERIOD_BREACH + AMOUNT_DEVIATION_30PCT fingerprint.', severity: 'critical', drill_to: '/insurance/claims-anomaly' },
  { title: 'Persistency dipped in west zone',       body: '37-month persistency in West Zone fell 2.1 percentage points — channel mix shift detected.', severity: 'warning',  drill_to: '/insurance/persistency' },
  { title: 'Solvency ratio within target',          body: 'Quarterly solvency ratio held at 218% (IRDAI floor 150%, internal target 200%) — no action required.', severity: 'info',     drill_to: '/insurance/solvency' },
  { title: 'Underwriting deviation outlier',        body: 'Agent AGT-4521 issued 9 policies this month outside underwriting guidelines.', severity: 'critical', drill_to: '/insurance/underwriting' },
  { title: 'Channel risk shifting',                 body: 'Direct-channel persistency outperformed bancassurance by 4.8 pp this quarter.', severity: 'info',     drill_to: '/insurance/channel-risk' },
  { title: 'Hospital fraud cluster surfacing',      body: '3 hospitals in NCR cluster show > 12% repeat-claim rate vs network average 4.1%.', severity: 'warning',  drill_to: '/insurance/fraud' },
  { title: 'Lapse-prevention campaign opportunity', body: '847 policies in 45-60d lapse window — target with proactive RM outreach.', severity: 'info',     drill_to: '/insurance/policy-lapse' },
];

const CROSS_DOMAIN_TEMPLATES: ReadonlyArray<{ title: string; body: string; severity: AiInsightSeverity; drill_to?: string }> = [
  { title: 'Maker-checker SLA breach risk',         body: '6 case maker-checker approvals are within 24h of SLA breach. Reassign to active checker.', severity: 'warning',  drill_to: '/cms/workflow' },
  { title: 'Audit chain integrity verified',        body: 'M15 chain verification ran 4× today against tampered + clean fixtures — all 4 passes detected correctly.', severity: 'info',     drill_to: '/audit-center' },
  { title: 'Recovery approval queue backlog',       body: '17 recovery requests pending approval > 7 days. Highest-risk: restore of CUST-87123 customer record.', severity: 'warning',  drill_to: '/recovery-center/workflow' },
  { title: 'AI model drift threshold crossed',      body: 'Fraud-LightGBM model drift score 0.34 — above 0.30 threshold. Retrain candidate.', severity: 'warning',  drill_to: '/ai/governance/drift' },
];

/**
 * Generate 5 deterministic insight cards for the given (role, domain, day).
 * Pure — no I/O. Different (role, domain, day) yields different cards;
 * same inputs reproduce the same output.
 */
export function generateAiInsights(
  role: string,
  domain: 'banking' | 'insurance' | 'both',
  now: Date = new Date(),
): readonly AiInsightCard[] {
  const day = now.toISOString().slice(0, 10);
  const seed = fnv1a(role + '|' + domain + '|' + day);
  const rng = mulberry32(seed);

  // Pool selection: banking/insurance pick from their own + 2 cross-domain
  // candidates. 'both' caller (super_admin/executive) picks from all 3 pools.
  let pool: ReadonlyArray<{ title: string; body: string; severity: AiInsightSeverity; drill_to?: string }>;
  if (domain === 'banking') {
    pool = [...BANKING_TEMPLATES, ...CROSS_DOMAIN_TEMPLATES];
  } else if (domain === 'insurance') {
    pool = [...INSURANCE_TEMPLATES, ...CROSS_DOMAIN_TEMPLATES];
  } else {
    pool = [...BANKING_TEMPLATES, ...INSURANCE_TEMPLATES, ...CROSS_DOMAIN_TEMPLATES];
  }

  // Pick 5 distinct templates without replacement (cast to mutable so we can push)
  type Template = { title: string; body: string; severity: AiInsightSeverity; drill_to?: string };
  const picked: Template[] = [];
  const indices = new Set<number>();
  let safetyBudget = pool.length * 4;
  while (picked.length < 5 && indices.size < pool.length && safetyBudget-- > 0) {
    const i = Math.floor(rng() * pool.length);
    if (indices.has(i)) continue;
    indices.add(i);
    picked.push(pool[i]!);
  }

  return picked.map((tpl, idx) => ({
    id: 'insight-' + day + '-' + role + '-' + domain + '-' + idx,
    title: tpl.title,
    body: tpl.body,
    severity: tpl.severity,
    generated_at: now.toISOString(),
    drill_to: tpl.drill_to,
  }));
}
