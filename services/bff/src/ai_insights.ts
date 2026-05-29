// services/bff/src/ai_insights.ts
//
// T7 Module 9 — AI Insight Panels.
//
// A UNIFIED, reusable AI-insight container surface. Domain dashboards already
// surface their own slices (top risky borrowers on the banking dashboard,
// fraud highlights on the insurance one); this module is the cross-domain AI
// workbench feed that aggregates every AI-derived insight under ONE uniform
// contract (AiInsight) so the SPA renders them through a single reusable
// <InsightPanel>. Each insight is "powered by" a named model/signal + carries
// ranked items with reasons — the at-a-glance "what should I look at?" lens.
//
// Deterministic synthesis per (tenant, insight_id, day) via FNV-1a + Mulberry32
// (the M7.x / drift / bil_dashboards pattern). In-memory; the additive pg swap
// target is data/schema/042_ai_insights.sql.

// ─── closed enums ────────────────────────────────────────────────────────

export type InsightCategory = 'risk' | 'fraud' | 'retention' | 'trend';
export const ALL_INSIGHT_CATEGORIES: InsightCategory[] = ['risk', 'fraud', 'retention', 'trend'];

export type InsightDomain = 'banking' | 'insurance' | 'cross';
export const ALL_INSIGHT_DOMAINS: InsightDomain[] = ['banking', 'insurance', 'cross'];

export type InsightSeverity = 'critical' | 'high' | 'medium' | 'info';
export const ALL_INSIGHT_SEVERITIES: InsightSeverity[] = ['critical', 'high', 'medium', 'info'];

export function isInsightCategory(v: unknown): v is InsightCategory {
  return typeof v === 'string' && (ALL_INSIGHT_CATEGORIES as string[]).includes(v);
}
export function isInsightDomain(v: unknown): v is InsightDomain {
  return typeof v === 'string' && (ALL_INSIGHT_DOMAINS as string[]).includes(v);
}
export function isInsightSeverity(v: unknown): v is InsightSeverity {
  return typeof v === 'string' && (ALL_INSIGHT_SEVERITIES as string[]).includes(v);
}

// ─── shapes ──────────────────────────────────────────────────────────────

export interface InsightItem {
  entity_id: string;
  entity_label: string;
  /** Normalised 0..1 model score driving the ranking. */
  score: number;
  /** Human-readable score, e.g. "PD 0.82" / "anomaly 0.91" / "lapse 74%". */
  score_label: string;
  reason: string;
  trend: 'up' | 'down' | 'flat';
  /** Signed change vs the prior window (insight-specific units). */
  delta: number;
}

export interface AiInsight {
  insight_id: string;
  tenant_id: string;
  title: string;
  description: string;
  category: InsightCategory;
  domain: InsightDomain;
  severity: InsightSeverity;
  /** The model / signal powering the insight (links back to the registry). */
  model_ref: string;
  /** 0..1 — model confidence in this insight set. */
  confidence: number;
  /** One-line summary metric for the panel header. */
  headline: string;
  generated_at: string;
  item_count: number;
  items: InsightItem[];
}

export interface InsightFeed {
  tenant_id: string;
  generated_at: string;
  total: number;
  by_category: Record<InsightCategory, number>;
  by_severity: Record<InsightSeverity, number>;
  /** Highest-severity insight surfaced first; null when feed empty/filtered out. */
  top_insight: { insight_id: string; title: string; severity: InsightSeverity } | null;
  insights: AiInsight[];
}

export interface InsightFilter {
  category?: InsightCategory;
  domain?: InsightDomain;
  severity?: InsightSeverity;
}

// ─── errors ──────────────────────────────────────────────────────────────

export class AiInsightError extends Error {
  constructor(public readonly code: 'unknown_insight' | 'invalid_input', message: string) {
    super(message);
    this.name = 'AiInsightError';
  }
}

// ─── catalog ─────────────────────────────────────────────────────────────

interface InsightDef {
  insight_id: string;
  title: string;
  description: string;
  category: InsightCategory;
  domain: InsightDomain;
  model_ref: string;
  entity_prefix: string;
  /** Renders a normalised score into a domain-specific label. */
  scoreLabel: (score: number) => string;
  reasons: string[];
  /** Header summary given the top item + count. */
  headline: (top: InsightItem, count: number) => string;
}

const INSIGHT_CATALOG: InsightDef[] = [
  {
    insight_id: 'top_risky_borrowers',
    title: 'Top risky borrowers',
    description: 'Customers with the highest model-estimated probability of default this cycle.',
    category: 'risk',
    domain: 'banking',
    model_ref: 'pd_xgb_v3',
    entity_prefix: 'CUST',
    scoreLabel: (s) => `PD ${s.toFixed(2)}`,
    reasons: ['DPD breach + utilisation spike', 'bureau score drop > 40pts', 'repeated min-payments', 'income volatility flag', 'cross-product exposure rising'],
    headline: (top, n) => `${n} borrowers above the watch threshold — worst PD ${top.score.toFixed(2)}`,
  },
  {
    insight_id: 'fraud_anomaly_highlights',
    title: 'Fraud anomaly highlights',
    description: 'Transactions and accounts flagged by the fraud model as anomalous in the last window.',
    category: 'fraud',
    domain: 'banking',
    model_ref: 'fraud_lgbm_v1',
    entity_prefix: 'TXN',
    scoreLabel: (s) => `anomaly ${s.toFixed(2)}`,
    reasons: ['geo-velocity impossible travel', 'device fingerprint change', 'sudden withdrawal spike', 'salary credit disappeared', 'channel switch anomaly'],
    headline: (top, n) => `${n} anomalies flagged — peak score ${top.score.toFixed(2)}`,
  },
  {
    insight_id: 'lapse_prediction_insights',
    title: 'Lapse prediction insights',
    description: 'Policies the lapse model predicts are most likely to lapse in the next 30 days.',
    category: 'retention',
    domain: 'insurance',
    model_ref: 'lapse_xgb_v1',
    entity_prefix: 'POL',
    scoreLabel: (s) => `lapse ${Math.round(s * 100)}%`,
    reasons: ['premium overdue > 15d', 'grace period entered', 'agent left the book', 'first-year policy', 'auto-debit bounce'],
    headline: (top, n) => `${n} policies at lapse risk — top likelihood ${Math.round(top.score * 100)}%`,
  },
  {
    insight_id: 'persistency_risk',
    title: 'Persistency risk (agents)',
    description: 'Agents whose books show weakening 13-month persistency — a leading churn signal.',
    category: 'retention',
    domain: 'insurance',
    model_ref: 'persistency_signal',
    entity_prefix: 'AGT',
    scoreLabel: (s) => `risk ${s.toFixed(2)}`,
    reasons: ['persistency below branch median', 'cancellation cluster', 'mis-selling complaint', 'payout-ratio drift', 'new-business quality dip'],
    headline: (top, n) => `${n} agent books weakening — highest risk ${top.score.toFixed(2)}`,
  },
  {
    insight_id: 'claim_fraud_highlights',
    title: 'Claim fraud highlights',
    description: 'Claims the anomaly model scored as most suspicious for SIU triage.',
    category: 'fraud',
    domain: 'insurance',
    model_ref: 'claim_anomaly',
    entity_prefix: 'CLM',
    scoreLabel: (s) => `anomaly ${s.toFixed(2)}`,
    reasons: ['waiting-period breach', 'repeat reason < 180d', 'amount deviation > 30%', 'flagged hospital', 'rapid policy-to-claim'],
    headline: (top, n) => `${n} suspicious claims — peak score ${top.score.toFixed(2)}`,
  },
  {
    insight_id: 'unusual_trends',
    title: 'Unusual trends',
    description: 'Emerging aggregate anomalies across portfolios that no single alert would surface.',
    category: 'trend',
    domain: 'cross',
    model_ref: 'trend_monitor',
    entity_prefix: 'SIG',
    scoreLabel: (s) => `z ${(s * 4).toFixed(1)}`,
    reasons: ['NPA inflow accelerating in SME', 'fraud rate up in digital channel', 'lapse spike in unit-linked', 'collections promise-to-pay falling', 'utilisation creeping in retail cards'],
    headline: (top, n) => `${n} emerging trends — strongest signal ${(top.score * 4).toFixed(1)}σ`,
  },
];

export function listInsightCatalog(): { insight_id: string; title: string; category: InsightCategory; domain: InsightDomain; model_ref: string }[] {
  return INSIGHT_CATALOG.map((d) => ({ insight_id: d.insight_id, title: d.title, category: d.category, domain: d.domain, model_ref: d.model_ref }));
}

// ─── deterministic synthesis ─────────────────────────────────────────────

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const round = (n: number, dp = 2) => Math.round(n * 10 ** dp) / 10 ** dp;

function severityForTopScore(score: number): InsightSeverity {
  if (score >= 0.85) return 'critical';
  if (score >= 0.7) return 'high';
  if (score >= 0.5) return 'medium';
  return 'info';
}

function buildInsightFromDef(tenant_id: string, def: InsightDef, now: Date): AiInsight {
  const day = now.toISOString().slice(0, 10);
  const rng = mulberry32(fnv1a(`${tenant_id}|insight|${def.insight_id}|${day}`));
  const n = 4 + Math.floor(rng() * 4); // 4..7 items
  const items: InsightItem[] = [];
  for (let i = 0; i < n; i++) {
    const score = round(Math.min(0.99, 0.45 + rng() * 0.5), 4); // 0.45..0.95
    const trendRoll = rng();
    const trend: InsightItem['trend'] = trendRoll > 0.6 ? 'up' : trendRoll > 0.25 ? 'flat' : 'down';
    items.push({
      entity_id: `${def.entity_prefix}-${tenant_id === 'BANK_DEMO' ? 'BD' : tenant_id.slice(0, 3).toUpperCase()}-${100000 + Math.floor(rng() * 900000)}`,
      entity_label: `${def.entity_prefix} ${100000 + i}`,
      score,
      score_label: def.scoreLabel(score),
      reason: def.reasons[Math.floor(rng() * def.reasons.length)],
      trend,
      delta: round((rng() - 0.4) * 0.2, 4),
    });
  }
  // Rank worst-first by score.
  items.sort((a, b) => b.score - a.score || a.entity_id.localeCompare(b.entity_id));
  const top = items[0];
  const severity = severityForTopScore(top.score);
  const confidence = round(0.7 + rng() * 0.28, 4);
  return {
    insight_id: def.insight_id,
    tenant_id,
    title: def.title,
    description: def.description,
    category: def.category,
    domain: def.domain,
    severity,
    model_ref: def.model_ref,
    confidence,
    headline: def.headline(top, n),
    generated_at: now.toISOString(),
    item_count: n,
    items,
  };
}

// ─── store ───────────────────────────────────────────────────────────────

export interface AiInsightStore {
  /** One insight by id (computes on demand). */
  get(tenant_id: string, insight_id: string, now?: Date): AiInsight;
  /** Full feed across the catalog, optionally filtered. */
  feed(tenant_id: string, filter?: InsightFilter, now?: Date): InsightFeed;
}

export class InMemoryAiInsightStore implements AiInsightStore {
  private def(insight_id: string): InsightDef {
    const d = INSIGHT_CATALOG.find((x) => x.insight_id === insight_id);
    if (!d) throw new AiInsightError('unknown_insight', `unknown insight ${insight_id}`);
    return d;
  }

  get(tenant_id: string, insight_id: string, now: Date = new Date()): AiInsight {
    if (!tenant_id) throw new AiInsightError('invalid_input', 'tenant_id required');
    return buildInsightFromDef(tenant_id, this.def(insight_id), now);
  }

  feed(tenant_id: string, filter: InsightFilter = {}, now: Date = new Date()): InsightFeed {
    if (!tenant_id) throw new AiInsightError('invalid_input', 'tenant_id required');
    let defs = INSIGHT_CATALOG;
    if (filter.category) defs = defs.filter((d) => d.category === filter.category);
    if (filter.domain) defs = defs.filter((d) => d.domain === filter.domain);
    let insights = defs.map((d) => buildInsightFromDef(tenant_id, d, now));
    if (filter.severity) insights = insights.filter((i) => i.severity === filter.severity);

    const by_category = Object.fromEntries(ALL_INSIGHT_CATEGORIES.map((c) => [c, 0])) as Record<InsightCategory, number>;
    const by_severity = Object.fromEntries(ALL_INSIGHT_SEVERITIES.map((s) => [s, 0])) as Record<InsightSeverity, number>;
    for (const i of insights) {
      by_category[i.category] += 1;
      by_severity[i.severity] += 1;
    }
    // Highest-severity first for the feed ordering + top_insight.
    const sevRank: Record<InsightSeverity, number> = { critical: 3, high: 2, medium: 1, info: 0 };
    insights.sort((a, b) => sevRank[b.severity] - sevRank[a.severity] || a.insight_id.localeCompare(b.insight_id));
    const top = insights.length > 0 ? insights[0] : null;
    return {
      tenant_id,
      generated_at: now.toISOString(),
      total: insights.length,
      by_category,
      by_severity,
      top_insight: top ? { insight_id: top.insight_id, title: top.title, severity: top.severity } : null,
      insights,
    };
  }
}

// ─── singleton + reset ─────────────────────────────────────────────────────

export const defaultAiInsightStore: AiInsightStore = new InMemoryAiInsightStore();

export function _resetAiInsightStore(): void {
  // Stateless (synthesised per call) — no-op, kept for test-harness symmetry.
}
