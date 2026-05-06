// services/bff/src/adapter_sla_dashboard.ts
//
// T6 M14.11 — Per-adapter SLA dashboard.
//
// Fleet-wide companion to M3.5 (`/v1/ingestion/connectors/:id/runs/analytics`).
// M3.5 aggregates the run history for ONE connector; M14.11 runs that
// aggregator across every connector for the tenant, applies per-adapter
// SLA gates (minimum success rate, maximum p95 latency), and rolls up
// the fleet so the SRE / SPA can answer "is anything breaching SLA?"
// in one call.
//
// Design choices:
//  - Pure function. No I/O, no clock dependency. Caller builds the
//    `runsByConnectorId` map by walking the registry (typically
//    `listConnectors → listRuns(window)` per connector).
//  - SLA gates default to `min_success_rate=0.95` + `max_p95_latency_ms=30_000`.
//    The HTTP layer accepts query params to override per call.
//  - Connectors with NO finished runs in the window get
//    `sla_status: 'unknown'` rather than 'breached' — we can't
//    evaluate SLA without data, and lit-up "breach" alarms on
//    just-installed connectors would be noise.
//  - Fleet rollup: counts of met / breached / unknown, mean success
//    rate across connectors with data, worst p95 across same.

import { type Connector, type ConnectorStatus, type ConnectorRun } from './ingestion';
import {
  aggregateRunAnalytics,
  type RunAnalytics,
} from './connector_run_analytics';

// ─── Public types ─────────────────────────────────────────────────────

export interface AdapterSlaTargets {
  /** Minimum acceptable success rate in [0, 1]. */
  min_success_rate: number;
  /** Maximum acceptable p95 latency in milliseconds. */
  max_p95_latency_ms: number;
}

export const DEFAULT_SLA_TARGETS: Readonly<AdapterSlaTargets> = {
  min_success_rate: 0.95,
  max_p95_latency_ms: 30_000,
};

export type SlaStatus = 'met' | 'breached' | 'unknown';

export type SlaBreachReason =
  | 'success_rate_below_target'
  | 'p95_latency_above_target'
  | 'no_finished_runs';

export interface AdapterDashboardRow {
  connector_id: string;
  name: string;
  source_system: string;
  /** Effective connector status from M3.1 (healthy / degraded / paused). */
  connector_status: ConnectorStatus;
  /** Total runs in the window (finished + in_flight). */
  sample_size: number;
  finished_count: number;
  in_flight_count: number;
  success_rate: number | null;
  p95_latency_ms: number | null;
  mean_latency_ms: number | null;
  sla_status: SlaStatus;
  sla_breaches: SlaBreachReason[];
  /** Echo of the targets used to evaluate this row. Lets the SPA
   *  show "evaluated against …" alongside the result. */
  sla_targets: AdapterSlaTargets;
  last_failure: RunAnalytics['last_failure'];
}

export interface FleetSummary {
  total_connectors: number;
  sla_met_count: number;
  sla_breached_count: number;
  sla_unknown_count: number;
  /** Mean success rate across connectors with data. null if none. */
  fleet_mean_success_rate: number | null;
  /** Worst (highest) p95 latency across connectors with data. null if none. */
  fleet_worst_p95_latency_ms: number | null;
}

export interface AdapterSlaDashboard {
  generated_at: string;
  /** Window size used for each connector's analytics. */
  window: number;
  /** Targets the dashboard was evaluated against (echo for transparency). */
  targets: AdapterSlaTargets;
  /** Platform-default targets, in case the caller wants to compare. */
  default_targets: AdapterSlaTargets;
  fleet_summary: FleetSummary;
  per_adapter: AdapterDashboardRow[];
}

// ─── Validation ───────────────────────────────────────────────────────

export class AdapterSlaError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'AdapterSlaError';
  }
}

export function validateSlaTargets(input: unknown): AdapterSlaTargets {
  const i = (input ?? {}) as Record<string, unknown>;
  const min_success_rate =
    i.min_success_rate === undefined
      ? DEFAULT_SLA_TARGETS.min_success_rate
      : Number(i.min_success_rate);
  const max_p95_latency_ms =
    i.max_p95_latency_ms === undefined
      ? DEFAULT_SLA_TARGETS.max_p95_latency_ms
      : Number(i.max_p95_latency_ms);
  if (
    !Number.isFinite(min_success_rate) ||
    min_success_rate < 0 ||
    min_success_rate > 1
  ) {
    throw new AdapterSlaError(
      'invalid_input',
      'min_success_rate must be a number in [0, 1]',
    );
  }
  if (
    !Number.isFinite(max_p95_latency_ms) ||
    max_p95_latency_ms < 0 ||
    max_p95_latency_ms > 24 * 60 * 60 * 1000
  ) {
    throw new AdapterSlaError(
      'invalid_input',
      'max_p95_latency_ms must be a non-negative number ≤ 86_400_000 (24h)',
    );
  }
  return { min_success_rate, max_p95_latency_ms };
}

// ─── Pure aggregator ──────────────────────────────────────────────────

/**
 * Build a fleet-wide adapter SLA dashboard. Caller passes the resolved
 * connectors[] and a per-connector run window. Pure function.
 */
export function buildAdapterSlaDashboard(
  connectors: readonly Connector[],
  runsByConnectorId: ReadonlyMap<string, readonly ConnectorRun[]>,
  targets: AdapterSlaTargets,
  options: { window: number; now: Date },
): AdapterSlaDashboard {
  const per_adapter: AdapterDashboardRow[] = [];
  let metCount = 0;
  let breachedCount = 0;
  let unknownCount = 0;
  const successRates: number[] = [];
  const p95s: number[] = [];

  for (const c of connectors) {
    const runs = runsByConnectorId.get(c.id) ?? [];
    const a = aggregateRunAnalytics(runs);
    const breaches: SlaBreachReason[] = [];
    let status: SlaStatus;
    if (a.success_rate === null || a.duration_ms.p95 === null) {
      breaches.push('no_finished_runs');
      status = 'unknown';
      unknownCount += 1;
    } else {
      if (a.success_rate < targets.min_success_rate) {
        breaches.push('success_rate_below_target');
      }
      if (a.duration_ms.p95 > targets.max_p95_latency_ms) {
        breaches.push('p95_latency_above_target');
      }
      if (breaches.length === 0) {
        status = 'met';
        metCount += 1;
      } else {
        status = 'breached';
        breachedCount += 1;
      }
      successRates.push(a.success_rate);
      p95s.push(a.duration_ms.p95);
    }
    per_adapter.push({
      connector_id: c.id,
      name: c.name,
      source_system: c.source_system,
      connector_status: c.status,
      sample_size: a.sample_size,
      finished_count: a.sample_size - a.in_flight_count,
      in_flight_count: a.in_flight_count,
      success_rate: a.success_rate,
      p95_latency_ms: a.duration_ms.p95,
      mean_latency_ms: a.duration_ms.mean,
      sla_status: status,
      sla_breaches: breaches,
      sla_targets: targets,
      last_failure: a.last_failure,
    });
  }

  const fleet_mean_success_rate =
    successRates.length === 0
      ? null
      : successRates.reduce((s, x) => s + x, 0) / successRates.length;
  const fleet_worst_p95_latency_ms =
    p95s.length === 0 ? null : Math.max(...p95s);

  return {
    generated_at: options.now.toISOString(),
    window: options.window,
    targets,
    default_targets: DEFAULT_SLA_TARGETS,
    fleet_summary: {
      total_connectors: connectors.length,
      sla_met_count: metCount,
      sla_breached_count: breachedCount,
      sla_unknown_count: unknownCount,
      fleet_mean_success_rate,
      fleet_worst_p95_latency_ms,
    },
    per_adapter,
  };
}
