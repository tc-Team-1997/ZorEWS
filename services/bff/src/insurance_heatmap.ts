// services/bff/src/insurance_heatmap.ts
//
// Insurance EWS — Module 10: Insurance Heatmaps (reusable heatmap architecture).
//
// One generic heatmap engine pivots 5 RISK METRICS across 3 DIMENSIONS:
//   metrics    : fraud · lapse_risk · channel_risk · solvency_stress · persistency_weakness
//   dimensions : branch · region · channel
// Every (metric, dimension) pair yields a uniform HeatCell[] so the SPA renders
// any combination from one code path (the spec's "reusable heatmap" ask —
// branch-wise fraud, region-wise lapse, channel hotspots, solvency stress,
// persistency-weakness). Insurance analog of the banking Branch heatmap.
//
// Surfaces:
//   GET /v1/insurance/heatmap/metrics                 → catalog (metrics + dimensions)
//   GET /v1/insurance/heatmap?metric=&dimension=      → HeatmapReport (cells, worst-first)
//
// Deterministic synthesis (FNV-1a + Mulberry32 per (tenant, metric, dimension,
// unit, day)). Builder bodies swap to app_insurance.* when feeds land.

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

export type HeatMetric =
  | 'fraud'
  | 'lapse_risk'
  | 'channel_risk'
  | 'solvency_stress'
  | 'persistency_weakness';
export const ALL_HEAT_METRICS: readonly HeatMetric[] = [
  'fraud',
  'lapse_risk',
  'channel_risk',
  'solvency_stress',
  'persistency_weakness',
];

export type HeatDimension = 'branch' | 'region' | 'channel';
export const ALL_HEAT_DIMENSIONS: readonly HeatDimension[] = ['branch', 'region', 'channel'];

export type HeatLevel = 'low' | 'medium' | 'high' | 'critical';
export const ALL_HEAT_LEVELS: readonly HeatLevel[] = ['low', 'medium', 'high', 'critical'];

export type InsuranceRegion = 'North' | 'South' | 'East' | 'West' | 'Central' | 'Coastal';
export const INSURANCE_REGIONS: readonly InsuranceRegion[] = ['North', 'South', 'East', 'West', 'Central', 'Coastal'];

export type InsuranceChannel = 'Agency' | 'Bancassurance' | 'Broker' | 'Direct' | 'Corporate';
export const INSURANCE_CHANNELS: readonly InsuranceChannel[] = ['Agency', 'Bancassurance', 'Broker', 'Direct', 'Corporate'];

interface InsBranchDef {
  branch_id: string;
  branch_name: string;
  region: InsuranceRegion;
}
export const INSURANCE_BRANCHES: readonly InsBranchDef[] = [
  { branch_id: 'IB-N-01', branch_name: 'Delhi North LO', region: 'North' },
  { branch_id: 'IB-N-02', branch_name: 'Jaipur LO', region: 'North' },
  { branch_id: 'IB-S-01', branch_name: 'Bengaluru LO', region: 'South' },
  { branch_id: 'IB-S-02', branch_name: 'Chennai LO', region: 'South' },
  { branch_id: 'IB-E-01', branch_name: 'Kolkata LO', region: 'East' },
  { branch_id: 'IB-E-02', branch_name: 'Guwahati LO', region: 'East' },
  { branch_id: 'IB-W-01', branch_name: 'Mumbai LO', region: 'West' },
  { branch_id: 'IB-W-02', branch_name: 'Pune LO', region: 'West' },
  { branch_id: 'IB-C-01', branch_name: 'Bhopal LO', region: 'Central' },
  { branch_id: 'IB-C-02', branch_name: 'Nagpur LO', region: 'Central' },
  { branch_id: 'IB-CO-01', branch_name: 'Kochi LO', region: 'Coastal' },
  { branch_id: 'IB-CO-02', branch_name: 'Goa LO', region: 'Coastal' },
];

// Per-metric headline labelling — what the headline_value means for the metric.
const HEADLINE: Record<HeatMetric, { label: string; unit: 'count' | 'pct' | 'ratio' }> = {
  fraud: { label: 'Open fraud cases', unit: 'count' },
  lapse_risk: { label: 'Lapse rate', unit: 'pct' },
  channel_risk: { label: 'Complaint ratio', unit: 'pct' },
  solvency_stress: { label: 'Solvency ratio', unit: 'ratio' },
  persistency_weakness: { label: '13m persistency', unit: 'pct' },
};

export interface HeatMetricDef {
  metric: HeatMetric;
  label: string;
  description: string;
  natural_dimension: HeatDimension;
  headline_label: string;
  headline_unit: 'count' | 'pct' | 'ratio';
  // higher headline = worse? (solvency + persistency are inverted — lower is worse)
  higher_is_worse: boolean;
}

export const HEAT_METRIC_CATALOG: readonly HeatMetricDef[] = [
  { metric: 'fraud', label: 'Fraud concentration', description: 'Open fraud cases + SIU load by unit.', natural_dimension: 'branch', headline_label: HEADLINE.fraud.label, headline_unit: 'count', higher_is_worse: true },
  { metric: 'lapse_risk', label: 'Lapse risk', description: 'Policy lapse pressure by unit.', natural_dimension: 'region', headline_label: HEADLINE.lapse_risk.label, headline_unit: 'pct', higher_is_worse: true },
  { metric: 'channel_risk', label: 'Channel risk', description: 'Complaint + mis-sell pressure by channel.', natural_dimension: 'channel', headline_label: HEADLINE.channel_risk.label, headline_unit: 'pct', higher_is_worse: true },
  { metric: 'solvency_stress', label: 'Solvency stress', description: 'Solvency-ratio headroom by unit (lower = worse).', natural_dimension: 'region', headline_label: HEADLINE.solvency_stress.label, headline_unit: 'ratio', higher_is_worse: false },
  { metric: 'persistency_weakness', label: 'Persistency weakness', description: '13-month persistency by unit (lower = worse).', natural_dimension: 'channel', headline_label: HEADLINE.persistency_weakness.label, headline_unit: 'pct', higher_is_worse: false },
];

export interface HeatCell {
  id: string;
  label: string;
  group: string | null; // region for a branch; null for region; channel-tier for channel
  risk_score: number; // 0..100 (always: higher = worse, regardless of metric polarity)
  heat_level: HeatLevel;
  headline_value: number;
  headline_label: string;
  headline_unit: 'count' | 'pct' | 'ratio';
  volume: number; // policies in-force in this cell
  delta_30d_pct: number;
}

export interface InsuranceHeatmapReport {
  tenant_id: string;
  generated_at: string;
  metric: HeatMetric;
  dimension: HeatDimension;
  total_cells: number;
  by_heat_level: Record<HeatLevel, number>;
  cells: HeatCell[];
}

export class InsuranceHeatmapError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'InsuranceHeatmapError';
  }
}

function tenantScale(t: string): number {
  return t === 'BIL' ? 0.6 : 1.0;
}

function heatLevelFor(score: number): HeatLevel {
  if (score >= 75) return 'critical';
  if (score >= 50) return 'high';
  if (score >= 25) return 'medium';
  return 'low';
}

const HEAT_RANK: Record<HeatLevel, number> = { critical: 0, high: 1, medium: 2, low: 3 };

// Compute a 0..100 worse-is-higher risk score + a metric-specific headline value
// for one unit, deterministically.
function scoreUnit(
  tenant_id: string,
  metric: HeatMetric,
  dimension: HeatDimension,
  unitId: string,
  day: string,
): { risk_score: number; headline_value: number; volume: number; delta_30d_pct: number } {
  const rng = mulberry32(fnv1a(`${tenant_id}|${metric}|${dimension}|${unitId}|${day}`));
  const scale = tenantScale(tenant_id);
  const base = rng(); // 0..1 raw stress

  let headline_value: number;
  let risk_score: number;
  switch (metric) {
    case 'fraud': {
      const cases = Math.round(base * 28 * scale); // 0-28 open fraud cases
      headline_value = cases;
      risk_score = Math.round(Math.min(100, (cases / 28) * 100));
      break;
    }
    case 'lapse_risk': {
      const lapsePct = Math.round(base * 22 * 100) / 100; // 0-22%
      headline_value = lapsePct;
      risk_score = Math.round(Math.min(100, (lapsePct / 22) * 100));
      break;
    }
    case 'channel_risk': {
      const complaintPct = Math.round(base * 9 * 100) / 100; // 0-9%
      headline_value = complaintPct;
      risk_score = Math.round(Math.min(100, (complaintPct / 9) * 100));
      break;
    }
    case 'solvency_stress': {
      // Solvency ratio 1.10 .. 2.30; regulatory floor 1.50 → lower = worse.
      const ratio = Math.round((1.1 + base * 1.2) * 100) / 100;
      headline_value = ratio;
      // map ratio∈[1.1,2.3] inverted to score∈[0,100] (1.1 → 100, 2.3 → 0)
      risk_score = Math.round(Math.min(100, Math.max(0, ((2.3 - ratio) / 1.2) * 100)));
      break;
    }
    case 'persistency_weakness': {
      // 13m persistency 55%..95%; lower = worse.
      const persistency = Math.round((55 + base * 40) * 100) / 100;
      headline_value = persistency;
      risk_score = Math.round(Math.min(100, Math.max(0, ((95 - persistency) / 40) * 100)));
      break;
    }
  }

  return {
    risk_score,
    headline_value,
    volume: Math.round((200 + rng() * 3000) * scale),
    delta_30d_pct: Math.round((rng() * 4 - 2) * 100) / 100,
  };
}

interface Unit {
  id: string;
  label: string;
  group: string | null;
}

function unitsFor(dimension: HeatDimension): Unit[] {
  switch (dimension) {
    case 'branch':
      return INSURANCE_BRANCHES.map((b) => ({ id: b.branch_id, label: b.branch_name, group: b.region }));
    case 'region':
      return INSURANCE_REGIONS.map((r) => ({ id: r, label: r, group: null }));
    case 'channel':
      return INSURANCE_CHANNELS.map((c) => ({ id: c, label: c, group: c === 'Agency' || c === 'Broker' ? 'Intermediated' : 'Direct/Partner' }));
  }
}

export function listHeatmapCatalog(): { metrics: readonly HeatMetricDef[]; dimensions: readonly HeatDimension[] } {
  return { metrics: HEAT_METRIC_CATALOG, dimensions: ALL_HEAT_DIMENSIONS };
}

export function buildInsuranceHeatmap(
  tenant_id: string,
  metric: HeatMetric,
  dimension: HeatDimension,
  now: Date,
): InsuranceHeatmapReport {
  if (!tenant_id) throw new InsuranceHeatmapError('invalid_input', 'tenant_id required');
  if (!ALL_HEAT_METRICS.includes(metric))
    throw new InsuranceHeatmapError('invalid_metric', `unknown metric ${metric}`);
  if (!ALL_HEAT_DIMENSIONS.includes(dimension))
    throw new InsuranceHeatmapError('invalid_dimension', `unknown dimension ${dimension}`);

  const day = now.toISOString().slice(0, 10);
  const headline = HEADLINE[metric];
  const counts: Record<HeatLevel, number> = { low: 0, medium: 0, high: 0, critical: 0 };

  const cells: HeatCell[] = unitsFor(dimension).map((u) => {
    const s = scoreUnit(tenant_id, metric, dimension, u.id, day);
    const heat_level = heatLevelFor(s.risk_score);
    counts[heat_level]++;
    return {
      id: u.id,
      label: u.label,
      group: u.group,
      risk_score: s.risk_score,
      heat_level,
      headline_value: s.headline_value,
      headline_label: headline.label,
      headline_unit: headline.unit,
      volume: s.volume,
      delta_30d_pct: s.delta_30d_pct,
    };
  });

  cells.sort((a, b) => HEAT_RANK[a.heat_level] - HEAT_RANK[b.heat_level] || b.risk_score - a.risk_score);

  return {
    tenant_id,
    generated_at: now.toISOString(),
    metric,
    dimension,
    total_cells: cells.length,
    by_heat_level: counts,
    cells,
  };
}
