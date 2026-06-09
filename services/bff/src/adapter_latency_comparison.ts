// services/bff/src/adapter_latency_comparison.ts
//
// T6 M14.32 — Adapter request latency percentile comparison.
//
// Composes M14.9 (fleet health probe results) with M14.23 (SLA target
// catalog) to grade each adapter's observed latency against its
// declared SLA target. Assigns an A–F letter grade so the SPA can
// render a single chip per adapter without recomputing the comparison.
//
// Grade scale:
//   A — observed < 50% of SLA target (excellent headroom)
//   B — observed 50–80% of SLA target (healthy)
//   C — observed 80–100% of SLA target (within budget, tight)
//   D — observed 100–125% of SLA target (over but tolerable)
//   F — observed > 125% of SLA target OR probe degraded
//
// Fleet health score = weighted average of grade points (A=100,
// B=80, C=60, D=40, F=0) normalized to 0–100.
//
// Distinct from M14.26 (SLA budget check with headroom_ms) — M14.32
// adds letter grades, fleet_health_score, and grade_distribution.
// Async because the fleet probe itself is async.

import {
  runFleetHealth,
  listFleetAdapters,
  type AdapterFleet,
  type AdapterId,
  type AdapterProbe,
} from './adapter_health';
import { listAdapterSlaCatalog, type AdapterSlaTargets } from './adapter_sla_catalog';

// ─── Public types ─────────────────────────────────────────────────────

export type LatencyGrade = 'A' | 'B' | 'C' | 'D' | 'F';

export interface AdapterLatencyRow {
  adapter_id: AdapterId;
  label: string;
  /** Observed probe latency in ms. null when probe degraded. */
  observed_latency_ms: number | null;
  /** Expected p95 latency from M14.23 catalog. */
  sla_target_ms: number;
  /** (sla_target_ms - observed_latency_ms) / sla_target_ms (0..1 within budget,
   *  negative = over budget). null when degraded. */
  headroom_pct: number | null;
  /** Letter grade A–F. F includes degraded probes. */
  latency_grade: LatencyGrade;
}

export interface AdapterLatencyComparison {
  generated_at: string;
  total_adapters: number;
  /** Count per grade. */
  grade_distribution: Record<LatencyGrade, number>;
  /** Weighted average (A=100, B=80, C=60, D=40, F=0) over all adapters, 0–100. */
  fleet_health_score: number;
  /** Adapter with the best (lowest) latency relative to its SLA target.
   *  null when all are degraded. */
  best_performer: AdapterLatencyRow | null;
  /** Adapter with the worst latency relative to its SLA target.
   *  null when all are within budget. */
  worst_performer: AdapterLatencyRow | null;
  /** All adapter rows sorted: grade asc (A first) then observed_latency asc,
   *  degraded (F) pinned last. */
  adapters: AdapterLatencyRow[];
}

// ─── Grade helpers ────────────────────────────────────────────────────

const GRADE_THRESHOLDS: { grade: LatencyGrade; maxPct: number }[] = [
  { grade: 'A', maxPct: 0.50 },
  { grade: 'B', maxPct: 0.80 },
  { grade: 'C', maxPct: 1.00 },
  { grade: 'D', maxPct: 1.25 },
];

function gradeFor(probe: AdapterProbe, sla: AdapterSlaTargets): LatencyGrade {
  if (probe.status === 'degraded' || probe.latency_ms == null) return 'F';
  const ratio = probe.latency_ms / sla.expected_latency_ms_p95;
  for (const { grade, maxPct } of GRADE_THRESHOLDS) {
    if (ratio <= maxPct) return grade;
  }
  return 'F';
}

const GRADE_POINTS: Record<LatencyGrade, number> = { A: 100, B: 80, C: 60, D: 40, F: 0 };

const GRADE_ORDER: LatencyGrade[] = ['A', 'B', 'C', 'D', 'F'];

// ─── Pure resolver ────────────────────────────────────────────────────

export async function buildAdapterLatencyComparison(
  fleet: AdapterFleet,
  tenant_id: string,
  now: Date,
): Promise<AdapterLatencyComparison> {
  const [probeReport, slaCatalog] = await Promise.all([
    runFleetHealth(tenant_id, now, fleet),
    Promise.resolve(listAdapterSlaCatalog()),
  ]);

  const slaById = new Map<AdapterId, AdapterSlaTargets>(
    slaCatalog.adapters.map(s => [s.adapter_id as AdapterId, s]),
  );

  const rows: AdapterLatencyRow[] = [];
  for (const probe of probeReport.adapters) {
    const sla = slaById.get(probe.adapter_id);
    if (!sla) continue;
    const grade = gradeFor(probe, sla);
    const observed = probe.status === 'degraded' ? null : probe.latency_ms;
    const headroom_pct = observed !== null
      ? Math.round(((sla.expected_latency_ms_p95 - observed) / sla.expected_latency_ms_p95) * 10000) / 10000
      : null;
    rows.push({
      adapter_id: probe.adapter_id,
      label: probe.label,
      observed_latency_ms: observed,
      sla_target_ms: sla.expected_latency_ms_p95,
      headroom_pct,
      latency_grade: grade,
    });
  }

  // Sort: grade asc (A first), then observed_latency asc, degraded (F) last
  rows.sort((a, b) => {
    const ga = GRADE_ORDER.indexOf(a.latency_grade);
    const gb = GRADE_ORDER.indexOf(b.latency_grade);
    if (ga !== gb) return ga - gb;
    // Within same grade: sort by observed_latency asc (degraded have null, handle separately)
    const latA = a.observed_latency_ms ?? Infinity;
    const latB = b.observed_latency_ms ?? Infinity;
    if (latA !== latB) return latA - latB;
    return a.adapter_id < b.adapter_id ? -1 : a.adapter_id > b.adapter_id ? 1 : 0;
  });

  // Grade distribution
  const grade_distribution: Record<LatencyGrade, number> = { A: 0, B: 0, C: 0, D: 0, F: 0 };
  for (const r of rows) grade_distribution[r.latency_grade]++;

  // Fleet health score
  const fleet_health_score = rows.length > 0
    ? Math.round(rows.reduce((s, r) => s + GRADE_POINTS[r.latency_grade], 0) / rows.length)
    : 0;

  // Best performer: non-F with highest headroom_pct (smallest observed relative to SLA)
  const gradedRows = rows.filter(r => r.latency_grade !== 'F' && r.headroom_pct !== null);
  const best_performer = gradedRows.length > 0
    ? gradedRows.reduce((best, r) =>
        (r.headroom_pct! > best.headroom_pct! ? r : best), gradedRows[0])
    : null;

  // Worst performer: non-A, non-degraded with lowest headroom_pct (closest to or over SLA)
  const overBudgetRows = rows.filter(r => r.latency_grade !== 'A' && r.latency_grade !== 'F' && r.headroom_pct !== null);
  const worst_performer = overBudgetRows.length > 0
    ? overBudgetRows.reduce((worst, r) =>
        (r.headroom_pct! < worst.headroom_pct! ? r : worst), overBudgetRows[0])
    : null;

  return {
    generated_at: now.toISOString(),
    total_adapters: rows.length,
    grade_distribution,
    fleet_health_score,
    best_performer,
    worst_performer,
    adapters: rows,
  };
}
