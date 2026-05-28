// services/bff/src/insurance_channel_risk.ts
//
// Insurance EWS — Module 7: Channel Risk.
//
// Scores the distribution force — agents, brokers, bancassurance, direct
// and online channels — on a composite risk blend of four sub-scores:
// persistency, fraud, complaint, and mis-selling. Surfaces a channel-risk
// leaderboard, per-channel health, mis-selling alerts, and complaint
// analytics. Pure-function builders over deterministic synthesis (FNV-1a
// seed + Mulberry32), same template as Modules 1–6. Swap builder bodies to
// app_insurance.{channel_risk_scores,agent_health,mis_selling_alerts,
// complaint_analytics} when the agency + grievance feeds land. Shapes frozen.
//
// Surfaces:
//   buildChannelRiskDashboard(tenant, now)     → ChannelRiskDashboard (4 widgets)
//   analyzeAgent(input, now)                   → AgentRiskAnalysis (ad-hoc)
//   listHighRiskAgents(tenant, now, opts)      → HighRiskAgentList

// ─── deterministic synthesis helpers ───────────────────────────────────

function seedFrom(...parts: string[]): number {
  let h = 2166136261 >>> 0;
  for (const part of parts) {
    for (let i = 0; i < part.length; i++) {
      h ^= part.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
  }
  return h >>> 0;
}
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function utcDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

// ─── domain enums ───────────────────────────────────────────────────────

export const CHANNEL_TYPES = ['agent', 'broker', 'bancassurance', 'direct', 'online'] as const;
export type ChannelType = (typeof CHANNEL_TYPES)[number];

export const CHANNEL_RISK_BANDS = ['healthy', 'watch', 'elevated', 'critical'] as const;
export type ChannelRiskBand = (typeof CHANNEL_RISK_BANDS)[number];

export const MIS_SELLING_INDICATORS = [
  'free_look_cancellation',
  'early_surrender',
  'suitability_mismatch',
  'churning',
] as const;
export type MisSellingIndicator = (typeof MIS_SELLING_INDICATORS)[number];

export const MIS_SELLING_SEVERITIES = ['info', 'warning', 'critical'] as const;
export type MisSellingSeverity = (typeof MIS_SELLING_SEVERITIES)[number];

export const COMPLAINT_CATEGORIES = [
  'mis_selling',
  'claim_dispute',
  'servicing_delay',
  'premium_dispute',
  'unauthorised_transaction',
] as const;
export type ComplaintCategory = (typeof COMPLAINT_CATEGORIES)[number];

/** Classify a composite channel-risk score (0..1) into a band. */
export function bandForRisk(score: number): ChannelRiskBand {
  if (score >= 0.75) return 'critical';
  if (score >= 0.5) return 'elevated';
  if (score >= 0.25) return 'watch';
  return 'healthy';
}

export function severityFromBand(band: ChannelRiskBand): MisSellingSeverity {
  if (band === 'critical') return 'critical';
  if (band === 'elevated') return 'warning';
  return 'info';
}

export class ChannelRiskError extends Error {
  constructor(
    public code: 'invalid_input' | 'invalid_channel' | 'invalid_indicator' | 'invalid_value',
    message: string,
  ) {
    super(message);
    this.name = 'ChannelRiskError';
  }
}

// ─── shapes ─────────────────────────────────────────────────────────────

export interface SubScores {
  persistency: number; // 0..1 — low persistency → high risk
  fraud: number; // 0..1
  complaint: number; // 0..1
  mis_selling: number; // 0..1
}
export interface AgentRiskRow {
  agent_id: string;
  agent_name: string;
  channel: ChannelType;
  composite_risk: number; // 0..1
  sub_scores: SubScores;
  policies_sold_90d: number;
  persistency_13m: number; // 0..1
  band: ChannelRiskBand;
  rank: number;
}
export interface ChannelHealthRow {
  channel: ChannelType;
  agent_count: number;
  mean_risk: number; // 0..1
  high_risk_agents: number; // composite_risk ≥ 0.5
  persistency_13m: number; // channel-wide
  complaint_rate: number; // 0..1
  mis_selling_rate: number; // 0..1
  band: ChannelRiskBand;
}
export interface MisSellingAlert {
  alert_id: string;
  agent_id: string;
  agent_name: string;
  channel: ChannelType;
  indicator: MisSellingIndicator;
  count_30d: number;
  severity: MisSellingSeverity;
  status: 'open' | 'acknowledged' | 'resolved';
  raised_at: string;
}
export interface ComplaintAnalyticsRow {
  category: ComplaintCategory;
  count_30d: number;
  resolved: number;
  pending: number;
  mean_resolution_days: number;
  trend: 'up' | 'flat' | 'down';
}
export interface ChannelRiskDashboard {
  tenant_id: string;
  generated_at: string;
  totals: {
    agents_scored: number;
    high_risk_agents: number;
    critical_agents: number;
    open_mis_selling_alerts: number;
    complaints_30d: number;
    worst_channel: string | null;
  };
  channel_risk_leaderboard: AgentRiskRow[]; // top 10 worst agents
  channel_health: ChannelHealthRow[]; // per channel, worst-first
  mis_selling_alerts: MisSellingAlert[]; // open, worst-first, top 12
  complaint_analytics: ComplaintAnalyticsRow[]; // by category
  model_version: string;
}

export interface AnalyzeAgentInput {
  agent_id?: string;
  channel?: string;
  // Risk signals
  persistency_13m?: number; // 0..1 — low → risk
  fraud_flag_count?: number; // count of open fraud flags
  complaint_rate?: number; // 0..1
  free_look_cancellation_rate?: number; // 0..1 — mis-selling signal
  early_surrender_rate?: number; // 0..1 — mis-selling signal
  suitability_mismatch_rate?: number; // 0..1 — mis-selling signal
}
export interface RiskDriver {
  driver: string;
  sub_score: number; // 0..1
  weight: number; // contribution to composite (share)
  detail: string;
}
export interface AgentRiskAnalysis {
  agent_id: string;
  channel: ChannelType;
  composite_risk: number; // 0..1
  band: ChannelRiskBand;
  sub_scores: SubScores;
  drivers: RiskDriver[];
  requires_action: boolean; // elevated+ → true
  recommended_action: string;
  model_version: string;
  analyzed_at: string;
}

export interface HighRiskAgentList {
  tenant_id: string;
  generated_at: string;
  channel_filter: ChannelType | 'all';
  band_filter: ChannelRiskBand | 'all';
  total: number;
  agents: AgentRiskRow[];
}

const MODEL_VERSION = 'channel-risk-stub-v1';

// Composite weighting of the four sub-scores. Mis-selling + fraud weigh
// heaviest — they're the regulatory + conduct-risk concerns.
const W_PERSISTENCY = 0.25;
const W_FRAUD = 0.3;
const W_COMPLAINT = 0.15;
const W_MIS_SELLING = 0.3;

const AGENT_NAMES = [
  'A. Bhattacharya', 'S. Pillai', 'R. Verma', 'M. Kulkarni', 'J. Thomas',
  'D. Saxena', 'P. Banerjee', 'N. Krishnan', 'V. Chauhan', 'K. Patel',
  'L. Fernandes', 'B. Sinha', 'T. Acharya', 'G. Malhotra', 'H. Qureshi',
  'C. Dsouza', 'U. Reddy', 'F. Sheikh', 'O. Naidu', 'W. Joseph',
];

function tenantScale(tenant_id: string): number {
  return tenant_id === 'BANK_DEMO' ? 1.0 : 0.6;
}

function blendComposite(s: SubScores): number {
  return round4(
    Math.max(
      0,
      Math.min(
        1,
        s.persistency * W_PERSISTENCY +
          s.fraud * W_FRAUD +
          s.complaint * W_COMPLAINT +
          s.mis_selling * W_MIS_SELLING,
      ),
    ),
  );
}

/** Synthesise the agent book for a tenant on a given day. */
function synthAgents(tenant_id: string, now: Date): AgentRiskRow[] {
  const day = utcDay(now);
  const scale = tenantScale(tenant_id);
  const count = Math.max(20, Math.round(60 * scale));
  const out: AgentRiskRow[] = [];
  for (let i = 0; i < count; i++) {
    const r = rng(seedFrom(tenant_id, day, 'agent', String(i)));
    const channel = CHANNEL_TYPES[Math.floor(r() * CHANNEL_TYPES.length)];
    const nameIdx = i % AGENT_NAMES.length;
    const persistency13m = round4(0.45 + r() * 0.5); // 0.45..0.95
    const sub: SubScores = {
      persistency: round4(Math.max(0, Math.min(1, 1 - persistency13m + (r() - 0.5) * 0.2))),
      fraud: round4(r() ** 2.2), // skewed low; a few hot
      complaint: round4(r() ** 1.6),
      mis_selling: round4(r() ** 1.8),
    };
    const composite = blendComposite(sub);
    out.push({
      agent_id: `AGT-${tenant_id}-${String(50000 + i)}`,
      agent_name: AGENT_NAMES[nameIdx],
      channel,
      composite_risk: composite,
      sub_scores: sub,
      policies_sold_90d: 10 + Math.floor(r() * 140),
      persistency_13m: persistency13m,
      band: bandForRisk(composite),
      rank: 0,
    });
  }
  return out
    .sort((a, b) => b.composite_risk - a.composite_risk || a.agent_id.localeCompare(b.agent_id))
    .map((a, i) => ({ ...a, rank: i + 1 }));
}

// ─── builders ─────────────────────────────────────────────────────────────

export function buildChannelRiskDashboard(tenant_id: string, now: Date): ChannelRiskDashboard {
  if (!tenant_id) throw new ChannelRiskError('invalid_input', 'tenant_id required');
  const agents = synthAgents(tenant_id, now);

  // Channel health — aggregate per channel.
  const channel_health: ChannelHealthRow[] = CHANNEL_TYPES.map((ch) => {
    const inCh = agents.filter((a) => a.channel === ch);
    const n = inCh.length || 1;
    const meanRisk = round4(inCh.reduce((acc, a) => acc + a.composite_risk, 0) / n);
    const meanPersistency = round4(inCh.reduce((acc, a) => acc + a.persistency_13m, 0) / n);
    const meanComplaint = round4(inCh.reduce((acc, a) => acc + a.sub_scores.complaint, 0) / n);
    const meanMisSelling = round4(inCh.reduce((acc, a) => acc + a.sub_scores.mis_selling, 0) / n);
    return {
      channel: ch,
      agent_count: inCh.length,
      mean_risk: meanRisk,
      high_risk_agents: inCh.filter((a) => a.composite_risk >= 0.5).length,
      persistency_13m: meanPersistency,
      complaint_rate: meanComplaint,
      mis_selling_rate: meanMisSelling,
      band: bandForRisk(meanRisk),
    };
  }).sort((a, b) => b.mean_risk - a.mean_risk || a.channel.localeCompare(b.channel));

  const mis_selling_alerts = synthMisSellingAlerts(tenant_id, now, agents);
  const complaint_analytics = synthComplaintAnalytics(tenant_id, now);

  const worstChannel = channel_health.find((c) => c.agent_count > 0) ?? null;

  return {
    tenant_id,
    generated_at: now.toISOString(),
    totals: {
      agents_scored: agents.length,
      high_risk_agents: agents.filter((a) => a.composite_risk >= 0.5).length,
      critical_agents: agents.filter((a) => a.band === 'critical').length,
      open_mis_selling_alerts: mis_selling_alerts.filter((m) => m.status === 'open').length,
      complaints_30d: complaint_analytics.reduce((acc, c) => acc + c.count_30d, 0),
      worst_channel: worstChannel ? worstChannel.channel : null,
    },
    channel_risk_leaderboard: agents.slice(0, 10),
    channel_health,
    mis_selling_alerts: mis_selling_alerts.filter((m) => m.status === 'open').slice(0, 12),
    complaint_analytics,
    model_version: MODEL_VERSION,
  };
}

function synthMisSellingAlerts(tenant_id: string, now: Date, agents: AgentRiskRow[]): MisSellingAlert[] {
  let seq = 0;
  return agents
    .filter((a) => a.sub_scores.mis_selling >= 0.4) // watch+ on the mis-selling axis raises an alert
    .map((a) => {
      const r = rng(seedFrom(tenant_id, utcDay(now), 'misselling', a.agent_id));
      const indicator = MIS_SELLING_INDICATORS[Math.floor(r() * MIS_SELLING_INDICATORS.length)];
      return {
        alert_id: `MSL-${tenant_id}-${String(700000 + seq++)}`,
        agent_id: a.agent_id,
        agent_name: a.agent_name,
        channel: a.channel,
        indicator,
        count_30d: 1 + Math.floor(r() * 12),
        severity: severityFromBand(bandForRisk(a.sub_scores.mis_selling)),
        status: 'open' as const,
        raised_at: now.toISOString(),
      };
    })
    .sort((a, b) => {
      const rank = { critical: 0, warning: 1, info: 2 } as const;
      return rank[a.severity] - rank[b.severity] || b.count_30d - a.count_30d || a.alert_id.localeCompare(b.alert_id);
    });
}

function synthComplaintAnalytics(tenant_id: string, now: Date): ComplaintAnalyticsRow[] {
  const scale = tenantScale(tenant_id);
  return COMPLAINT_CATEGORIES.map((cat) => {
    const r = rng(seedFrom(tenant_id, utcDay(now), 'complaint', cat));
    const count = Math.round((20 + r() * 120) * scale);
    const resolved = Math.round(count * (0.55 + r() * 0.35));
    const trendRoll = r();
    return {
      category: cat,
      count_30d: count,
      resolved,
      pending: count - resolved,
      mean_resolution_days: round4(3 + r() * 25),
      trend: trendRoll > 0.6 ? 'up' : trendRoll > 0.3 ? 'flat' : 'down',
    } as ComplaintAnalyticsRow;
  }).sort((a, b) => b.count_30d - a.count_30d || a.category.localeCompare(b.category));
}

export interface HighRiskAgentOpts {
  channel?: string;
  band?: string;
  limit?: number;
}

export function listHighRiskAgents(
  tenant_id: string,
  now: Date,
  opts: HighRiskAgentOpts = {},
): HighRiskAgentList {
  if (!tenant_id) throw new ChannelRiskError('invalid_input', 'tenant_id required');
  let channel_filter: ChannelType | 'all' = 'all';
  if (opts.channel !== undefined && opts.channel !== 'all') {
    if (!CHANNEL_TYPES.includes(opts.channel as ChannelType)) {
      throw new ChannelRiskError('invalid_channel', `channel must be one of ${CHANNEL_TYPES.join(', ')} or 'all'`);
    }
    channel_filter = opts.channel as ChannelType;
  }
  let band_filter: ChannelRiskBand | 'all' = 'all';
  if (opts.band !== undefined && opts.band !== 'all') {
    if (!CHANNEL_RISK_BANDS.includes(opts.band as ChannelRiskBand)) {
      throw new ChannelRiskError('invalid_value', `band must be one of ${CHANNEL_RISK_BANDS.join(', ')} or 'all'`);
    }
    band_filter = opts.band as ChannelRiskBand;
  }
  const limit = Math.max(1, Math.min(200, opts.limit ?? 50));

  let rows = synthAgents(tenant_id, now);
  if (channel_filter !== 'all') rows = rows.filter((a) => a.channel === channel_filter);
  if (band_filter !== 'all') rows = rows.filter((a) => a.band === band_filter);
  // already rank-sorted worst-first by synthAgents

  return {
    tenant_id,
    generated_at: now.toISOString(),
    channel_filter,
    band_filter,
    total: rows.length,
    agents: rows.slice(0, limit),
  };
}

/**
 * Ad-hoc channel-risk score for a single agent. Deterministic weighted blend
 * of the four sub-scores, clamped to [0,1], with a per-driver breakdown and
 * an action flag. Same inputs → same output.
 */
export function analyzeAgent(input: AnalyzeAgentInput, now: Date): AgentRiskAnalysis {
  if (!input || typeof input !== 'object') throw new ChannelRiskError('invalid_input', 'request body required');

  let channel: ChannelType = 'agent';
  if (input.channel !== undefined) {
    if (!CHANNEL_TYPES.includes(input.channel as ChannelType)) {
      throw new ChannelRiskError('invalid_channel', `channel must be one of ${CHANNEL_TYPES.join(', ')}`);
    }
    channel = input.channel as ChannelType;
  }

  const persistency13m = clamp01OrThrow(input.persistency_13m, 0.8);
  const fraudFlags = numOr(input.fraud_flag_count, 0);
  if (fraudFlags < 0) throw new ChannelRiskError('invalid_value', 'fraud_flag_count must be ≥ 0');
  const complaintRate = clamp01OrThrow(input.complaint_rate, 0.05);
  const freeLook = clamp01OrThrow(input.free_look_cancellation_rate, 0.05);
  const earlySurrender = clamp01OrThrow(input.early_surrender_rate, 0.05);
  const suitability = clamp01OrThrow(input.suitability_mismatch_rate, 0.05);

  const sub: SubScores = {
    persistency: round4(Math.max(0, Math.min(1, 1 - persistency13m))),
    fraud: round4(Math.min(1, fraudFlags * 0.2)),
    complaint: round4(Math.min(1, complaintRate * 2)),
    mis_selling: round4(Math.min(1, freeLook * 0.4 + earlySurrender * 0.35 + suitability * 0.5)),
  };
  const composite = blendComposite(sub);
  const band = bandForRisk(composite);

  const drivers: RiskDriver[] = [
    { driver: 'persistency', sub_score: sub.persistency, weight: round4(sub.persistency * W_PERSISTENCY), detail: `13-month persistency ${(persistency13m * 100).toFixed(0)}%` },
    { driver: 'fraud', sub_score: sub.fraud, weight: round4(sub.fraud * W_FRAUD), detail: `${fraudFlags} open fraud flag(s)` },
    { driver: 'complaint', sub_score: sub.complaint, weight: round4(sub.complaint * W_COMPLAINT), detail: `Complaint rate ${(complaintRate * 100).toFixed(1)}%` },
    { driver: 'mis_selling', sub_score: sub.mis_selling, weight: round4(sub.mis_selling * W_MIS_SELLING), detail: `Free-look ${(freeLook * 100).toFixed(0)}% · early-surrender ${(earlySurrender * 100).toFixed(0)}% · suitability-mismatch ${(suitability * 100).toFixed(0)}%` },
  ].sort((a, b) => b.weight - a.weight);

  const requires_action = band === 'elevated' || band === 'critical';

  return {
    agent_id: input.agent_id ?? 'AGT-ADHOC',
    channel,
    composite_risk: composite,
    band,
    sub_scores: sub,
    drivers,
    requires_action,
    recommended_action: action(band, drivers[0]?.driver),
    model_version: MODEL_VERSION,
    analyzed_at: now.toISOString(),
  };
}

function action(band: ChannelRiskBand, topDriver?: string): string {
  if (band === 'critical') {
    return topDriver === 'fraud'
      ? 'Suspend agent code + refer to SIU — freeze new business immediately'
      : 'Suspend agent code + conduct-risk review before reinstatement';
  }
  if (band === 'elevated') {
    return topDriver === 'mis_selling'
      ? 'Mandatory re-training + 100% pre-issuance call-back audit on this agent'
      : topDriver === 'persistency'
        ? 'Place on persistency-improvement plan with monthly review'
        : 'Escalate to channel-compliance for targeted review';
  }
  if (band === 'watch') return 'Add to watch-list — sample 10% of policies for QA call-back';
  return 'Within tolerance — no action';
}

function numOr(v: unknown, fallback: number): number {
  if (v === undefined || v === null) return fallback;
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) throw new ChannelRiskError('invalid_value', 'numeric signal must be finite');
  return n;
}
function clamp01OrThrow(v: unknown, fallback: number): number {
  const n = numOr(v, fallback);
  if (n < 0 || n > 1) throw new ChannelRiskError('invalid_value', 'signal must be in [0,1]');
  return n;
}
