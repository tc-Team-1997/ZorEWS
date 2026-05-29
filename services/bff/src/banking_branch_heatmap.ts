// services/bff/src/banking_branch_heatmap.ts
//
// Branch / Geography Risk heatmap (§2.1.8) — portfolio stress by BRANCH and
// by REGION (geography). Distinct from Sector Watch (banking_sector_watch.ts),
// which pivots on industry sector; this is the geographic / org-unit view.
//
// 3 endpoints back the Branch Heatmap screen:
//   GET /v1/banking/branches/heatmap?dimension=branch|region
//   GET /v1/banking/branches/:branch_id              — single-branch summary
//   GET /v1/banking/branches/:branch_id/deep-dive    — 12m NPA trend + top customers + sector mix
//
// Deterministic synthesis (FNV-1a + Mulberry32 per (tenant, branch, day))
// matches the other banking-EWS pages. The region dimension is a
// customer-weighted rollup of its branches so the two views reconcile.

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

export type BranchRegion = 'North' | 'South' | 'East' | 'West' | 'Central' | 'Coastal';
export const ALL_REGIONS: readonly BranchRegion[] = [
  'North',
  'South',
  'East',
  'West',
  'Central',
  'Coastal',
];

export type HeatLevel = 'low' | 'medium' | 'high' | 'critical';
export const ALL_HEAT_LEVELS: readonly HeatLevel[] = ['low', 'medium', 'high', 'critical'];

export type HeatmapDimension = 'branch' | 'region';
export const ALL_DIMENSIONS: readonly HeatmapDimension[] = ['branch', 'region'];

interface BranchDef {
  branch_id: string;
  branch_name: string;
  region: BranchRegion;
  city: string;
}

// 16 branches across the 6 regions.
export const BRANCHES: readonly BranchDef[] = [
  { branch_id: 'BR-N-01', branch_name: 'Delhi Connaught Place', region: 'North', city: 'Delhi' },
  { branch_id: 'BR-N-02', branch_name: 'Chandigarh Sector 17', region: 'North', city: 'Chandigarh' },
  { branch_id: 'BR-N-03', branch_name: 'Jaipur MI Road', region: 'North', city: 'Jaipur' },
  { branch_id: 'BR-S-01', branch_name: 'Bengaluru MG Road', region: 'South', city: 'Bengaluru' },
  { branch_id: 'BR-S-02', branch_name: 'Chennai T Nagar', region: 'South', city: 'Chennai' },
  { branch_id: 'BR-S-03', branch_name: 'Hyderabad Banjara Hills', region: 'South', city: 'Hyderabad' },
  { branch_id: 'BR-E-01', branch_name: 'Kolkata Park Street', region: 'East', city: 'Kolkata' },
  { branch_id: 'BR-E-02', branch_name: 'Patna Boring Road', region: 'East', city: 'Patna' },
  { branch_id: 'BR-W-01', branch_name: 'Mumbai Fort', region: 'West', city: 'Mumbai' },
  { branch_id: 'BR-W-02', branch_name: 'Pune FC Road', region: 'West', city: 'Pune' },
  { branch_id: 'BR-W-03', branch_name: 'Ahmedabad CG Road', region: 'West', city: 'Ahmedabad' },
  { branch_id: 'BR-C-01', branch_name: 'Bhopal MP Nagar', region: 'Central', city: 'Bhopal' },
  { branch_id: 'BR-C-02', branch_name: 'Nagpur Sitabuldi', region: 'Central', city: 'Nagpur' },
  { branch_id: 'BR-CO-01', branch_name: 'Kochi Marine Drive', region: 'Coastal', city: 'Kochi' },
  { branch_id: 'BR-CO-02', branch_name: 'Visakhapatnam Beach Road', region: 'Coastal', city: 'Visakhapatnam' },
  { branch_id: 'BR-CO-03', branch_name: 'Goa Panaji', region: 'Coastal', city: 'Panaji' },
];

export interface HeatCell {
  id: string; // branch_id or region name
  label: string; // branch_name or region name
  region: BranchRegion;
  city: string | null; // branch city; null for region rollups
  branch_count: number | null; // null for branch cells; count for region cells
  npa_ratio_pct: number;
  total_customers: number;
  total_outstanding_kes: number;
  delta_30d_pct: number;
  heat_level: HeatLevel;
}

export interface BranchHeatmap {
  tenant_id: string;
  generated_at: string;
  dimension: HeatmapDimension;
  total_cells: number;
  by_heat_level: Record<HeatLevel, number>;
  cells: HeatCell[];
}

export class BranchHeatmapError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'BranchHeatmapError';
  }
}

function tenantScale(t: string): number {
  return t === 'BIL' ? 0.6 : 1.0;
}

function heatLevelFor(npa: number): HeatLevel {
  if (npa >= 8) return 'critical';
  if (npa >= 5) return 'high';
  if (npa >= 2.5) return 'medium';
  return 'low';
}

const HEAT_RANK: Record<HeatLevel, number> = { critical: 0, high: 1, medium: 2, low: 3 };

interface BranchMetrics {
  npa_ratio_pct: number;
  total_customers: number;
  total_outstanding_kes: number;
  delta_30d_pct: number;
}

function branchMetrics(tenant_id: string, branch: BranchDef, day: string): BranchMetrics {
  const rng = mulberry32(fnv1a(`${tenant_id}|${branch.branch_id}|${day}`));
  const scale = tenantScale(tenant_id);
  return {
    npa_ratio_pct: Math.round(rng() * 11 * 100) / 100, // 0-11%
    total_customers: Math.round((30 + rng() * 180) * scale),
    total_outstanding_kes: Math.round((300_000_000 + rng() * 3_500_000_000) * scale),
    delta_30d_pct: Math.round((rng() * 4 - 2) * 100) / 100,
  };
}

function branchCell(tenant_id: string, branch: BranchDef, day: string): HeatCell {
  const m = branchMetrics(tenant_id, branch, day);
  return {
    id: branch.branch_id,
    label: branch.branch_name,
    region: branch.region,
    city: branch.city,
    branch_count: null,
    npa_ratio_pct: m.npa_ratio_pct,
    total_customers: m.total_customers,
    total_outstanding_kes: m.total_outstanding_kes,
    delta_30d_pct: m.delta_30d_pct,
    heat_level: heatLevelFor(m.npa_ratio_pct),
  };
}

export function buildBranchHeatmap(
  tenant_id: string,
  dimension: HeatmapDimension,
  now: Date,
): BranchHeatmap {
  if (!tenant_id) throw new BranchHeatmapError('invalid_input', 'tenant_id required');
  if (!ALL_DIMENSIONS.includes(dimension))
    throw new BranchHeatmapError('invalid_dimension', `unknown dimension ${dimension}`);
  const day = now.toISOString().slice(0, 10);
  const counts: Record<HeatLevel, number> = { low: 0, medium: 0, high: 0, critical: 0 };
  let cells: HeatCell[];

  if (dimension === 'branch') {
    cells = BRANCHES.map((b) => branchCell(tenant_id, b, day));
  } else {
    // Region rollup — customer-weighted NPA across the region's branches.
    cells = ALL_REGIONS.map((region) => {
      const branches = BRANCHES.filter((b) => b.region === region);
      let customers = 0;
      let outstanding = 0;
      let weightedNpaNum = 0;
      let weightedDeltaNum = 0;
      for (const b of branches) {
        const m = branchMetrics(tenant_id, b, day);
        customers += m.total_customers;
        outstanding += m.total_outstanding_kes;
        weightedNpaNum += m.npa_ratio_pct * m.total_customers;
        weightedDeltaNum += m.delta_30d_pct * m.total_customers;
      }
      const npa = customers > 0 ? Math.round((weightedNpaNum / customers) * 100) / 100 : 0;
      const delta = customers > 0 ? Math.round((weightedDeltaNum / customers) * 100) / 100 : 0;
      return {
        id: region,
        label: region,
        region,
        city: null,
        branch_count: branches.length,
        npa_ratio_pct: npa,
        total_customers: customers,
        total_outstanding_kes: outstanding,
        delta_30d_pct: delta,
        heat_level: heatLevelFor(npa),
      };
    });
  }

  for (const c of cells) counts[c.heat_level]++;
  cells.sort((a, b) => HEAT_RANK[a.heat_level] - HEAT_RANK[b.heat_level] || b.npa_ratio_pct - a.npa_ratio_pct);

  return {
    tenant_id,
    generated_at: now.toISOString(),
    dimension,
    total_cells: cells.length,
    by_heat_level: counts,
    cells,
  };
}

export function buildBranchSummary(
  tenant_id: string,
  branch_id: string,
  now: Date,
): HeatCell & { generated_at: string } {
  if (!tenant_id) throw new BranchHeatmapError('invalid_input', 'tenant_id required');
  const branch = BRANCHES.find((b) => b.branch_id === branch_id);
  if (!branch) throw new BranchHeatmapError('unknown_branch', `unknown branch ${branch_id}`);
  const day = now.toISOString().slice(0, 10);
  return { ...branchCell(tenant_id, branch, day), generated_at: now.toISOString() };
}

const SECTORS = ['Manufacturing', 'Real_Estate', 'Retail_Trade', 'Textiles', 'Logistics', 'Hospitality'];
const FIRST = ['Alice', 'Rajesh', 'Priya', 'Mohan', 'Vikram', 'Meera', 'Arjun', 'Kavya'];
const LAST = ['Patel', 'Kumar', 'Sharma', 'Singh', 'Reddy', 'Nair'];

export interface BranchDeepDive {
  tenant_id: string;
  branch_id: string;
  branch_name: string;
  region: BranchRegion;
  city: string;
  generated_at: string;
  npa_ratio_pct: number;
  total_customers: number;
  total_outstanding_kes: number;
  heat_level: HeatLevel;
  npa_trend_12m: { month: string; npa_pct: number }[];
  top_at_risk_customers: { customer_id: string; name: string; pd: number; outstanding_kes: number }[];
  sector_mix: { sector: string; customers: number; npa_ratio_pct: number }[];
}

export function buildBranchDeepDive(tenant_id: string, branch_id: string, now: Date): BranchDeepDive {
  if (!tenant_id) throw new BranchHeatmapError('invalid_input', 'tenant_id required');
  const branch = BRANCHES.find((b) => b.branch_id === branch_id);
  if (!branch) throw new BranchHeatmapError('unknown_branch', `unknown branch ${branch_id}`);

  const day = now.toISOString().slice(0, 10);
  const m = branchMetrics(tenant_id, branch, day);
  const scale = tenantScale(tenant_id);
  const rng = mulberry32(fnv1a(`${tenant_id}|${branch_id}|deep`));

  // 12-month NPA trend, anchored to current.
  const trend: { month: string; npa_pct: number }[] = [];
  let cur = Math.max(0.4, m.npa_ratio_pct - 2 + rng() * 3);
  for (let i = 11; i >= 0; i--) {
    const mo = new Date(now);
    mo.setUTCMonth(mo.getUTCMonth() - i);
    cur = Math.max(0.1, cur + (rng() - 0.5) * 1.2);
    trend.push({ month: mo.toISOString().slice(0, 7), npa_pct: Math.round(cur * 100) / 100 });
  }
  trend[trend.length - 1].npa_pct = m.npa_ratio_pct;

  // Top 5 at-risk customers.
  const top: BranchDeepDive['top_at_risk_customers'] = [];
  for (let i = 0; i < 5; i++) {
    const cRng = mulberry32(fnv1a(`${tenant_id}|${branch_id}|cust|${i}`));
    top.push({
      customer_id: `c-${String(200000 + i + Math.floor(cRng() * 1000))}`,
      name: `${FIRST[Math.floor(cRng() * FIRST.length)]} ${LAST[Math.floor(cRng() * LAST.length)]}`,
      pd: Math.round((0.45 + cRng() * 0.5) * 100) / 100,
      outstanding_kes: Math.round((8_000_000 + cRng() * 80_000_000) * scale),
    });
  }
  top.sort((a, b) => b.pd - a.pd);

  // Sector mix within the branch.
  const sector_mix: BranchDeepDive['sector_mix'] = SECTORS.map((sector, idx) => {
    const sRng = mulberry32(fnv1a(`${tenant_id}|${branch_id}|sector|${idx}`));
    return {
      sector,
      customers: Math.round((5 + sRng() * 40) * scale),
      npa_ratio_pct: Math.round(sRng() * 12 * 100) / 100,
    };
  });
  sector_mix.sort((a, b) => b.npa_ratio_pct - a.npa_ratio_pct);

  return {
    tenant_id,
    branch_id,
    branch_name: branch.branch_name,
    region: branch.region,
    city: branch.city,
    generated_at: now.toISOString(),
    npa_ratio_pct: m.npa_ratio_pct,
    total_customers: m.total_customers,
    total_outstanding_kes: m.total_outstanding_kes,
    heat_level: heatLevelFor(m.npa_ratio_pct),
    npa_trend_12m: trend,
    top_at_risk_customers: top,
    sector_mix,
  };
}
