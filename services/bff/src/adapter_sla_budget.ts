// services/bff/src/adapter_sla_budget.ts
//
// T6 M14.26 — Adapter SLA latency budget check.
//
// Cross-module resolver bridging M14.9 (fleet-health probes with
// observed latency_ms per adapter) and M14.23 (per-adapter SLA
// targets with expected_latency_ms_p95). For each adapter, computes
// whether the observed latency lies within the SLA budget and by
// how much.
//
// Drives the SPA's green/amber/red SLA badges directly:
//   - green: observed < expected (within budget)
//   - amber: observed within 25% above expected (over but tolerable)
//   - red:   observed > 1.25 × expected (significantly over)
//
// Probe failures (status='degraded') surface as `null` observed
// latency + within_budget=false + a separate `degraded_count` in
// the envelope so the SPA can render them distinctly from "slow
// but responding" adapters.
//
// Pure resolver — composes runFleetHealth() output with the static
// SLA catalogue. Async because the probe itself is async.

import {
  runFleetHealth,
  type AdapterFleet,
  type AdapterId,
} from './adapter_health';
import { listAdapterSlaCatalog, type AdapterSlaTargets } from './adapter_sla_catalog';

// ─── Public types ─────────────────────────────────────────────────────

export type SlaBudgetVerdict = 'within_budget' | 'over_budget' | 'over_budget_severe' | 'degraded';

const AMBER_MULTIPLIER = 1.25;

export interface AdapterBudgetRow {
  adapter_id: AdapterId;
  label: string;
  expected_p95_ms: number;
  /** Observed latency from the M14.9 probe. null when probe failed
   *  (status='degraded'). */
  observed_latency_ms: number | null;
  /** 'up' or 'degraded' — directly from the probe. */
  status: 'up' | 'degraded';
  /** True iff observed < expected. False for degraded probes. */
  within_budget: boolean;
  /** expected - observed (positive = within budget; negative = over).
   *  null when degraded. */
  headroom_ms: number | null;
  /** headroom_ms / expected — signed [-N, 1]. null when degraded. */
  headroom_pct: number | null;
  /** Coarser verdict for the SPA: within_budget | over_budget |
   *  over_budget_severe | degraded. */
  verdict: SlaBudgetVerdict;
  /** Probe error message when status='degraded'. */
  error?: string;
}

export interface AdapterSlaBudgetReport {
  tenant_id: string;
  generated_at: string;
  total_adapters: number;
  total_within_budget: number;
  total_over_budget: number;
  /** Subset of over-budget where observed > AMBER_MULTIPLIER × expected. */
  total_over_budget_severe: number;
  total_degraded: number;
  /** Adapter with the largest NEGATIVE headroom (most over budget;
   *  degraded probes excluded since they have null headroom). null
   *  when zero over-budget adapters. */
  worst_offender: {
    adapter_id: AdapterId;
    label: string;
    headroom_ms: number;
  } | null;
  /** Adapter with the largest POSITIVE headroom (most slack; degraded
   *  probes excluded). null when zero within-budget adapters. */
  most_slack: {
    adapter_id: AdapterId;
    label: string;
    headroom_ms: number;
  } | null;
  /** Per-adapter rows sorted by headroom_ms asc (worst-first; degraded
   *  pinned to the END). adapter_id asc tie-break. */
  adapters: AdapterBudgetRow[];
}

// ─── Pure helpers ─────────────────────────────────────────────────────

function verdictOf(
  status: 'up' | 'degraded',
  observed: number | null,
  expected: number,
): SlaBudgetVerdict {
  if (status === 'degraded' || observed === null) return 'degraded';
  if (observed <= expected) return 'within_budget';
  if (observed <= expected * AMBER_MULTIPLIER) return 'over_budget';
  return 'over_budget_severe';
}

// ─── Pure resolver ────────────────────────────────────────────────────

export async function buildAdapterSlaBudgetReport(
  tenant_id: string,
  asOf: Date,
  fleet: AdapterFleet,
): Promise<AdapterSlaBudgetReport> {
  const slaCatalog = listAdapterSlaCatalog();
  const slaById = new Map<AdapterId, AdapterSlaTargets>(
    slaCatalog.adapters.map((s) => [s.adapter_id, s]),
  );
  const probe = await runFleetHealth(tenant_id, asOf, fleet);

  const rows: AdapterBudgetRow[] = probe.adapters
    .filter((p) => slaById.has(p.adapter_id))
    .map((p) => {
      const sla = slaById.get(p.adapter_id)!;
      const expected = sla.expected_latency_ms_p95;
      const status = p.status;
      const observed = status === 'degraded' ? null : p.latency_ms;
      const headroom_ms = observed === null ? null : expected - observed;
      const headroom_pct = observed === null ? null : (expected - observed) / expected;
      const within_budget = status === 'up' && observed !== null && observed <= expected;
      const row: AdapterBudgetRow = {
        adapter_id: p.adapter_id,
        label: p.label,
        expected_p95_ms: expected,
        observed_latency_ms: observed,
        status,
        within_budget,
        headroom_ms,
        headroom_pct,
        verdict: verdictOf(status, observed, expected),
      };
      if (p.error) row.error = p.error;
      return row;
    });

  // Sort: degraded last; remaining by headroom_ms asc (worst first)
  // with adapter_id asc tie-break.
  rows.sort((a, b) => {
    const aDeg = a.headroom_ms === null;
    const bDeg = b.headroom_ms === null;
    if (aDeg !== bDeg) return aDeg ? 1 : -1;
    if (!aDeg && !bDeg) {
      if (a.headroom_ms !== b.headroom_ms) return a.headroom_ms! - b.headroom_ms!;
    }
    return a.adapter_id.localeCompare(b.adapter_id);
  });

  let total_within_budget = 0;
  let total_over_budget = 0;
  let total_over_budget_severe = 0;
  let total_degraded = 0;
  for (const r of rows) {
    if (r.verdict === 'within_budget') total_within_budget++;
    else if (r.verdict === 'over_budget') total_over_budget++;
    else if (r.verdict === 'over_budget_severe') total_over_budget_severe++;
    else total_degraded++;
  }

  // worst_offender: most-negative headroom (degraded excluded).
  // most_slack: most-positive headroom (degraded excluded).
  let worst: AdapterBudgetRow | null = null;
  let slack: AdapterBudgetRow | null = null;
  for (const r of rows) {
    if (r.headroom_ms === null) continue;
    if (r.headroom_ms < 0) {
      if (!worst || r.headroom_ms < worst.headroom_ms!) worst = r;
    }
    if (r.headroom_ms > 0) {
      if (!slack || r.headroom_ms > slack.headroom_ms!) slack = r;
    }
  }

  return {
    tenant_id,
    generated_at: asOf.toISOString(),
    total_adapters: rows.length,
    total_within_budget,
    total_over_budget: total_over_budget + total_over_budget_severe,
    total_over_budget_severe,
    total_degraded,
    worst_offender: worst
      ? { adapter_id: worst.adapter_id, label: worst.label, headroom_ms: worst.headroom_ms! }
      : null,
    most_slack: slack
      ? { adapter_id: slack.adapter_id, label: slack.label, headroom_ms: slack.headroom_ms! }
      : null,
    adapters: rows,
  };
}
