// services/bff/src/banking_sector_watch.ts
//
// Sector Watch heatmap — closes §2.1.4 of ZorEWS_Pending_Gap_Analysis.md.
//
// 3 endpoints back the Sector Watch wireframe screen:
//   GET    /v1/banking/sectors/heatmap
//   GET    /v1/banking/sectors/:sector_id/deep-dive
//   GET/POST/DELETE /v1/banking/sectors/watchlist
//
// Distinct from M3.13 sector dashboard (BIL claims dashboard) — this is
// the BANKING sector view for the credit-risk EWS, covering 12 SME sectors.

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

export const SECTOR_CODES = [
  'Manufacturing',
  'Power',
  'Construction',
  'Real_Estate',
  'Textiles',
  'Auto_Components',
  'Pharma',
  'IT_Services',
  'Hospitality',
  'Logistics',
  'Agro_Processing',
  'Retail_Trade',
] as const;

export type SectorCode = (typeof SECTOR_CODES)[number];
export type HeatLevel = 'low' | 'medium' | 'high' | 'critical';

export const ALL_HEAT_LEVELS: readonly HeatLevel[] = ['low', 'medium', 'high', 'critical'];

export interface SectorHeatmapCell {
  sector: SectorCode;
  npa_ratio_pct: number;
  total_customers: number;
  total_outstanding_kes: number;
  delta_30d_pct: number;
  heat_level: HeatLevel;
  is_watchlisted: boolean;
}

export interface SectorHeatmap {
  tenant_id: string;
  generated_at: string;
  total_sectors: number;
  by_heat_level: Record<HeatLevel, number>;
  cells: SectorHeatmapCell[];
}

export class SectorWatchError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'SectorWatchError';
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

const watchlist = new Map<string, Set<SectorCode>>();

export function buildSectorHeatmap(tenant_id: string, now: Date): SectorHeatmap {
  if (!tenant_id) throw new SectorWatchError('invalid_input', 'tenant_id required');
  const day = now.toISOString().slice(0, 10);
  const wl = watchlist.get(tenant_id) ?? new Set<SectorCode>();
  const scale = tenantScale(tenant_id);
  const cells: SectorHeatmapCell[] = [];
  const counts: Record<HeatLevel, number> = { low: 0, medium: 0, high: 0, critical: 0 };

  for (const sector of SECTOR_CODES) {
    const rng = mulberry32(fnv1a(`${tenant_id}|${sector}|${day}`));
    const npa = Math.round((rng() * 11) * 100) / 100; // 0-11%
    const heat = heatLevelFor(npa);
    counts[heat]++;
    cells.push({
      sector,
      npa_ratio_pct: npa,
      total_customers: Math.round((40 + rng() * 200) * scale),
      total_outstanding_kes: Math.round((500_000_000 + rng() * 4_000_000_000) * scale),
      delta_30d_pct: Math.round((rng() * 4 - 2) * 100) / 100,
      heat_level: heat,
      is_watchlisted: wl.has(sector),
    });
  }
  // Sort worst-first (critical → high → medium → low) then by npa desc
  const rank: Record<HeatLevel, number> = { critical: 0, high: 1, medium: 2, low: 3 };
  cells.sort((a, b) => rank[a.heat_level] - rank[b.heat_level] || b.npa_ratio_pct - a.npa_ratio_pct);

  return {
    tenant_id,
    generated_at: now.toISOString(),
    total_sectors: cells.length,
    by_heat_level: counts,
    cells,
  };
}

export interface SectorDeepDive {
  tenant_id: string;
  sector: SectorCode;
  generated_at: string;
  npa_ratio_pct: number;
  total_customers: number;
  total_outstanding_kes: number;
  heat_level: HeatLevel;
  npa_trend_12m: { month: string; npa_pct: number }[];
  top_at_risk_customers: { customer_id: string; name: string; pd: number; outstanding_kes: number }[];
  contributing_rules: { rule_id: string; rule_name: string; firings_30d: number }[];
}

const FIRST = ['Alice', 'Rajesh', 'Priya', 'Mohan', 'Vikram', 'Meera', 'Arjun', 'Kavya'];
const LAST = ['Patel', 'Kumar', 'Sharma', 'Singh', 'Reddy', 'Nair'];

export function buildSectorDeepDive(tenant_id: string, sector: SectorCode, now: Date): SectorDeepDive {
  if (!tenant_id) throw new SectorWatchError('invalid_input', 'tenant_id required');
  if (!SECTOR_CODES.includes(sector))
    throw new SectorWatchError('unknown_sector', `unknown sector ${sector}`);

  const day = now.toISOString().slice(0, 10);
  const rng = mulberry32(fnv1a(`${tenant_id}|${sector}|${day}|deep`));
  const npa = Math.round((rng() * 11) * 100) / 100;
  const heat = heatLevelFor(npa);
  const scale = tenantScale(tenant_id);

  // 12-month trend
  const trend: { month: string; npa_pct: number }[] = [];
  let cur = Math.max(0.5, npa - 2 + rng() * 3);
  for (let i = 11; i >= 0; i--) {
    const m = new Date(now);
    m.setUTCMonth(m.getUTCMonth() - i);
    cur = Math.max(0.1, cur + (rng() - 0.5) * 1.2);
    trend.push({ month: m.toISOString().slice(0, 7), npa_pct: Math.round(cur * 100) / 100 });
  }
  // Last point anchored to current npa
  trend[trend.length - 1].npa_pct = npa;

  // Top 5 at-risk customers
  const top: SectorDeepDive['top_at_risk_customers'] = [];
  for (let i = 0; i < 5; i++) {
    const cRng = mulberry32(fnv1a(`${tenant_id}|${sector}|cust|${i}`));
    const fname = FIRST[Math.floor(cRng() * FIRST.length)];
    const lname = LAST[Math.floor(cRng() * LAST.length)];
    top.push({
      customer_id: `c-${String(200000 + i + Math.floor(cRng() * 1000))}`,
      name: `${fname} ${lname}`,
      pd: Math.round((0.45 + cRng() * 0.5) * 100) / 100,
      outstanding_kes: Math.round((10_000_000 + cRng() * 90_000_000) * scale),
    });
  }
  top.sort((a, b) => b.pd - a.pd);

  // Contributing rules
  const ruleNames = [
    'DPD-cliff-30d',
    'EMI-bounce-3-in-30',
    'Cash-velocity-spike',
    'Stock-statement-overdue',
    'Sector-overexposure',
  ];
  const rules: SectorDeepDive['contributing_rules'] = ruleNames.map((name, idx) => {
    const rRng = mulberry32(fnv1a(`${tenant_id}|${sector}|rule|${idx}`));
    return {
      rule_id: `R-${100 + idx}`,
      rule_name: name,
      firings_30d: Math.round((5 + rRng() * 45) * scale),
    };
  });
  rules.sort((a, b) => b.firings_30d - a.firings_30d);

  return {
    tenant_id,
    sector,
    generated_at: now.toISOString(),
    npa_ratio_pct: npa,
    total_customers: Math.round((40 + rng() * 200) * scale),
    total_outstanding_kes: Math.round((500_000_000 + rng() * 4_000_000_000) * scale),
    heat_level: heat,
    npa_trend_12m: trend,
    top_at_risk_customers: top,
    contributing_rules: rules,
  };
}

export function listWatchlist(tenant_id: string): SectorCode[] {
  if (!tenant_id) throw new SectorWatchError('invalid_input', 'tenant_id required');
  const wl = watchlist.get(tenant_id);
  return wl ? Array.from(wl).sort() : [];
}

export function addToWatchlist(tenant_id: string, sector: SectorCode): SectorCode[] {
  if (!tenant_id) throw new SectorWatchError('invalid_input', 'tenant_id required');
  if (!SECTOR_CODES.includes(sector))
    throw new SectorWatchError('unknown_sector', `unknown sector ${sector}`);
  if (!watchlist.has(tenant_id)) watchlist.set(tenant_id, new Set());
  watchlist.get(tenant_id)!.add(sector);
  return listWatchlist(tenant_id);
}

export function removeFromWatchlist(tenant_id: string, sector: SectorCode): SectorCode[] {
  if (!tenant_id) throw new SectorWatchError('invalid_input', 'tenant_id required');
  watchlist.get(tenant_id)?.delete(sector);
  return listWatchlist(tenant_id);
}

export function _resetSectorWatchlist() {
  watchlist.clear();
}
