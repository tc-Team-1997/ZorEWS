// services/bff/src/finops_dashboard.ts
//
// T5.5 — FinOps dashboard.
//
// Deterministic per (tenant_id, day-of-asOf) synthesis of monthly
// cloud spend allocation + cost-per-alert + cost-per-customer
// efficiency metrics. Production swap = AWS Cost Explorer / Athena
// query satisfying the same shape; the resolver interface stays
// stable.
//
// Drives the SPA "FinOps" panel: "what does this tenant cost us per
// month?" + "is cost-per-alert trending down?" + "are some services
// disproportionately heavy?".
//
// Pure function — no I/O. Mirror of M11.x dashboard builders +
// FNV-1a + Mulberry32 deterministic synthesis (same scheme as
// `bil_dashboards.ts`).

// ─── Public types ──────────────────────────────────────────────────────

export type FinOpsService =
  | 'aurora'
  | 'msk'
  | 'eks'
  | 's3'
  | 'cloudwatch'
  | 'kms'
  | 'data_transfer'
  | 'route53'
  | 'waf'
  | 'other';

export const ALL_FINOPS_SERVICES: readonly FinOpsService[] = [
  'aurora',
  'msk',
  'eks',
  's3',
  'cloudwatch',
  'kms',
  'data_transfer',
  'route53',
  'waf',
  'other',
];

export interface ServiceCostBreakdown {
  service: FinOpsService;
  cost_usd: number;
  /** % of total tenant spend (0..1, rounded to 4 decimal places). */
  share: number;
  /** Direction vs the 30-day prior period. */
  trend: 'up' | 'flat' | 'down';
  /** Signed % delta vs prior period; null when prior=0 (divide-by-zero). */
  delta_pct: number | null;
}

export interface FinOpsEfficiencyMetrics {
  /** Cost in USD per alert routed in the period. Null when zero alerts. */
  cost_per_alert_usd: number | null;
  /** Cost in USD per active customer in the period. */
  cost_per_customer_usd: number | null;
  /** Total alerts routed in the period (used as denominator). */
  total_alerts: number;
  /** Total active customers in the period (used as denominator). */
  total_active_customers: number;
}

export interface FinOpsDashboard {
  tenant_id: string;
  generated_at: string;
  /** YYYY-MM of the reporting period. */
  period: string;
  total_cost_usd: number;
  /** % delta vs prior month total. Null when prior=0. */
  total_delta_pct: number | null;
  services: ServiceCostBreakdown[];
  efficiency: FinOpsEfficiencyMetrics;
  /** Highest-cost service with the biggest opportunity (largest absolute
   *  delta_pct ≥ 5% and trend=up). Null when nothing qualifies. */
  optimisation_candidate: FinOpsService | null;
}

// ─── Helpers ───────────────────────────────────────────────────────────

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 0x100000000;
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

// Hand-tuned per-service baseline cost share (sums to ~1.0).
// Aurora + MSK + EKS dominate; cloudwatch + KMS thin slices.
const BASELINE_SHARE: Record<FinOpsService, number> = {
  aurora: 0.32,
  msk: 0.18,
  eks: 0.22,
  s3: 0.08,
  cloudwatch: 0.05,
  kms: 0.02,
  data_transfer: 0.06,
  route53: 0.01,
  waf: 0.04,
  other: 0.02,
};

// ─── Pure resolver ─────────────────────────────────────────────────────

export function buildFinOpsDashboard(
  tenant_id: string,
  now: Date,
): FinOpsDashboard {
  if (!tenant_id) {
    throw new Error('tenant_id required');
  }

  // Period = YYYY-MM of now (UTC).
  const year = now.getUTCFullYear();
  const monthIdx = now.getUTCMonth(); // 0-indexed
  const period = `${year}-${String(monthIdx + 1).padStart(2, '0')}`;

  // Seed determinism per (tenant, month).
  const seed = fnv1a(`finops|${tenant_id}|${period}`);
  const rng = mulberry32(seed);

  // Total monthly spend scaled by tenant — BIL gets ~70% of BANK_DEMO
  // since BIL synthetic data is 60% scale (per bil_dashboards.ts
  // pattern). Range $8k–$14k base.
  const baseTotal = 8000 + rng() * 6000; // $8k-$14k
  const tenantScale = tenant_id === 'BIL' ? 0.7 : 1.0;
  const total_cost_usd = round2(baseTotal * tenantScale);

  // Per-service allocation with ±15% jitter on baseline shares.
  const rawShares: Record<FinOpsService, number> = {} as Record<FinOpsService, number>;
  let shareTotal = 0;
  for (const svc of ALL_FINOPS_SERVICES) {
    const baseline = BASELINE_SHARE[svc];
    const jitter = 1 + (rng() - 0.5) * 0.3; // ±15%
    rawShares[svc] = baseline * jitter;
    shareTotal += rawShares[svc];
  }
  // Normalise to sum-to-1.
  for (const svc of ALL_FINOPS_SERVICES) {
    rawShares[svc] = rawShares[svc] / shareTotal;
  }

  // Prior-month total (for total_delta_pct + per-service trend).
  // Compute by re-seeding with the prior period.
  const priorMonth = monthIdx === 0 ? 11 : monthIdx - 1;
  const priorYear = monthIdx === 0 ? year - 1 : year;
  const priorPeriod = `${priorYear}-${String(priorMonth + 1).padStart(2, '0')}`;
  const priorSeed = fnv1a(`finops|${tenant_id}|${priorPeriod}`);
  const priorRng = mulberry32(priorSeed);
  const priorBaseTotal = 8000 + priorRng() * 6000;
  const prior_total_cost_usd = round2(priorBaseTotal * tenantScale);
  const total_delta_pct =
    prior_total_cost_usd > 0
      ? round4((total_cost_usd - prior_total_cost_usd) / prior_total_cost_usd)
      : null;

  // Per-service breakdown — also synthesise prior shares for trend.
  const priorRawShares: Record<FinOpsService, number> = {} as Record<FinOpsService, number>;
  let priorShareTotal = 0;
  for (const svc of ALL_FINOPS_SERVICES) {
    const baseline = BASELINE_SHARE[svc];
    const jitter = 1 + (priorRng() - 0.5) * 0.3;
    priorRawShares[svc] = baseline * jitter;
    priorShareTotal += priorRawShares[svc];
  }
  for (const svc of ALL_FINOPS_SERVICES) {
    priorRawShares[svc] = priorRawShares[svc] / priorShareTotal;
  }

  const services: ServiceCostBreakdown[] = ALL_FINOPS_SERVICES.map((svc) => {
    const cost = round2(total_cost_usd * rawShares[svc]);
    const priorCost = round2(prior_total_cost_usd * priorRawShares[svc]);
    const delta_pct = priorCost > 0 ? round4((cost - priorCost) / priorCost) : null;
    let trend: 'up' | 'flat' | 'down' = 'flat';
    if (delta_pct !== null) {
      if (delta_pct > 0.05) trend = 'up';
      else if (delta_pct < -0.05) trend = 'down';
    }
    return {
      service: svc,
      cost_usd: cost,
      share: round4(rawShares[svc]),
      trend,
      delta_pct,
    };
  });

  // Efficiency metrics — alerts + active customers derived deterministically
  // for the period.
  // BIL scale 60% per bil_dashboards.ts convention.
  const alertRng = mulberry32(fnv1a(`finops|alerts|${tenant_id}|${period}`));
  const baseAlerts = Math.floor(800 + alertRng() * 1200); // 800-2000
  const total_alerts = Math.max(0, Math.floor(baseAlerts * tenantScale));
  const custRng = mulberry32(fnv1a(`finops|customers|${tenant_id}|${period}`));
  const baseCust = Math.floor(2000 + custRng() * 8000); // 2k-10k
  const total_active_customers = Math.max(0, Math.floor(baseCust * tenantScale));

  const cost_per_alert_usd = total_alerts > 0 ? round2(total_cost_usd / total_alerts) : null;
  const cost_per_customer_usd =
    total_active_customers > 0 ? round2(total_cost_usd / total_active_customers) : null;

  const efficiency: FinOpsEfficiencyMetrics = {
    cost_per_alert_usd,
    cost_per_customer_usd,
    total_alerts,
    total_active_customers,
  };

  // optimisation_candidate — service with up-trend AND |delta_pct| ≥ 5%
  // sorted by absolute cost desc. Canonical service-order tie-break.
  let optimisation_candidate: FinOpsService | null = null;
  let bestCost = 0;
  for (const row of services) {
    if (row.trend === 'up' && row.delta_pct !== null && row.delta_pct >= 0.05) {
      if (row.cost_usd > bestCost) {
        bestCost = row.cost_usd;
        optimisation_candidate = row.service;
      }
    }
  }

  return {
    tenant_id,
    generated_at: now.toISOString(),
    period,
    total_cost_usd,
    total_delta_pct,
    services,
    efficiency,
    optimisation_candidate,
  };
}
