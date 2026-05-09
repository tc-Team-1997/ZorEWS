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

// ─── M14.12 — Per-tenant SLA target overrides ────────────────────────
//
// M14.11 hardcoded the SLA gates as PLATFORM defaults. M14.12 lets a
// tenant persist its own targets so the dashboard doesn't need a
// query-param override on every call. The dashboard route resolves
// in this order:
//
//   1. ?min_success_rate / ?max_p95_latency_ms query param  (per-call)
//   2. tenant override stored here                          (per-tenant)
//   3. DEFAULT_SLA_TARGETS                                  (platform)
//
// Storage is in-memory + tenant-keyed, mirroring the M10.6 tenant-
// defaults pattern used by NotificationPreferenceStore.

export interface TenantSlaTargetsRecord extends AdapterSlaTargets {
  tenant_id: string;
  /** ISO timestamp when the override was last written. null when the
   *  tenant has never set one (caller is reading the platform default). */
  updated_at: string | null;
  updated_by: string | null;
}

export interface AdapterSlaTargetsStore {
  /** Always returns a record. When the tenant has no override, the
   *  fields default to the platform defaults and `updated_at` is null. */
  get(tenant_id: string): TenantSlaTargetsRecord;
  set(
    tenant_id: string,
    targets: AdapterSlaTargets,
    updated_by: string,
    now: Date,
  ): TenantSlaTargetsRecord;
  /** Reset to platform defaults (drops the override). Returns true
   *  if a row was deleted, false if there was nothing to drop. */
  reset(tenant_id: string): boolean;
}

export class InMemoryAdapterSlaTargetsStore implements AdapterSlaTargetsStore {
  private readonly map = new Map<string, TenantSlaTargetsRecord>();

  get(tenant_id: string): TenantSlaTargetsRecord {
    const stored = this.map.get(tenant_id);
    if (stored) return stored;
    return {
      tenant_id,
      ...DEFAULT_SLA_TARGETS,
      updated_at: null,
      updated_by: null,
    };
  }

  set(
    tenant_id: string,
    targets: AdapterSlaTargets,
    updated_by: string,
    now: Date,
  ): TenantSlaTargetsRecord {
    if (!tenant_id || typeof tenant_id !== 'string') {
      throw new AdapterSlaError('invalid_input', 'tenant_id is required');
    }
    if (!updated_by || !updated_by.trim()) {
      throw new AdapterSlaError('invalid_input', 'updated_by is required');
    }
    const next: TenantSlaTargetsRecord = {
      tenant_id,
      min_success_rate: targets.min_success_rate,
      max_p95_latency_ms: targets.max_p95_latency_ms,
      updated_at: now.toISOString(),
      updated_by: updated_by.trim(),
    };
    this.map.set(tenant_id, next);
    return next;
  }

  reset(tenant_id: string): boolean {
    return this.map.delete(tenant_id);
  }
}

export const defaultAdapterSlaTargetsStore: AdapterSlaTargetsStore =
  new InMemoryAdapterSlaTargetsStore();

// ─── M14.13 — SLA breach event log ───────────────────────────────────
//
// Audit history of SLA breaches over time. The dashboard route (M14.11)
// gives a point-in-time view; M14.13 lets an operator answer "when did
// we breach yesterday?" by snapshotting the dashboard at intervals
// (cron / manual button-press) and persisting one event per breached
// row.
//
// Storage is in-memory + FIFO-capped at 200 events per tenant
// (mirrors the M10.8 quiet-hours-mute audit store). Each event is a
// single point-in-time observation; correlating across events into
// "breach windows" is left to the SPA / a future analytics module.

export interface AdapterSlaBreachEvent {
  /** Globally-unique id (uuid). */
  event_id: string;
  tenant_id: string;
  connector_id: string;
  connector_name: string;
  source_system: string;
  /** ISO when the snapshot fired. */
  observed_at: string;
  sla_breaches: SlaBreachReason[];
  /** Echo of the row's metrics at observation time. */
  success_rate: number | null;
  p95_latency_ms: number | null;
  /** Echo of the targets used to evaluate the breach. */
  sla_targets: AdapterSlaTargets;
  // ── M14.14 acknowledgement (optional / backwards-compatible) ─────
  acknowledged_by?: string;
  acknowledged_at?: string;
  acknowledgement_note?: string;
}

/** Result of an acknowledge() call. `already` distinguishes a no-op
 *  re-ack from a fresh one so the route can return 200 vs 409 if needed.
 *  `null` event means the id wasn't found in the tenant's history. */
export interface AdapterSlaBreachAckResult {
  event: AdapterSlaBreachEvent | null;
  already: boolean;
}

export interface AdapterSlaBreachListOptions {
  since?: Date;
  limit?: number;
  /** M14.14 — when set, restrict to acknowledged or unacknowledged
   *  rows. Omitted = both (legacy behaviour). */
  acknowledged?: boolean;
}

export interface AdapterSlaBreachEventStore {
  record(e: AdapterSlaBreachEvent): void;
  /** Newest-first; optional `since` filter on `observed_at`. The
   *  3-arg legacy call shape is preserved as a positional shortcut. */
  list(
    tenant_id: string,
    since?: Date,
    limit?: number,
  ): readonly AdapterSlaBreachEvent[];
  /** M14.14 — same as `list` but accepts the `acknowledged` filter. */
  query(
    tenant_id: string,
    opts: AdapterSlaBreachListOptions,
  ): readonly AdapterSlaBreachEvent[];
  count(tenant_id: string): number;
  /** Wipe a tenant's history. Returns the number of rows cleared. */
  clear(tenant_id: string): number;
  /** M14.14 — stamp ack metadata on a recorded event. Idempotent on
   *  an already-acknowledged event (returns `already: true`, leaves
   *  the original ack metadata untouched so the audit trail is
   *  honest). */
  acknowledge(
    tenant_id: string,
    event_id: string,
    by: string,
    at: Date,
    note?: string,
  ): AdapterSlaBreachAckResult;
}

export const ADAPTER_SLA_BREACH_EVENT_CAP = 200;

export class InMemoryAdapterSlaBreachEventStore
  implements AdapterSlaBreachEventStore
{
  private readonly map = new Map<string, AdapterSlaBreachEvent[]>();

  record(e: AdapterSlaBreachEvent): void {
    const arr = this.map.get(e.tenant_id) ?? [];
    arr.push(e);
    while (arr.length > ADAPTER_SLA_BREACH_EVENT_CAP) arr.shift();
    this.map.set(e.tenant_id, arr);
  }

  list(
    tenant_id: string,
    since?: Date,
    limit?: number,
  ): readonly AdapterSlaBreachEvent[] {
    return this.query(tenant_id, { since, limit });
  }

  query(
    tenant_id: string,
    opts: AdapterSlaBreachListOptions,
  ): readonly AdapterSlaBreachEvent[] {
    const arr = this.map.get(tenant_id) ?? [];
    const sinceMs = opts.since?.getTime();
    const filtered = arr.filter((e) => {
      if (sinceMs !== undefined && new Date(e.observed_at).getTime() < sinceMs) return false;
      if (opts.acknowledged === true && !e.acknowledged_at) return false;
      if (opts.acknowledged === false && e.acknowledged_at) return false;
      return true;
    });
    const newestFirst = [...filtered].reverse();
    return typeof opts.limit === 'number' && opts.limit > 0
      ? newestFirst.slice(0, opts.limit)
      : newestFirst;
  }

  count(tenant_id: string): number {
    return this.map.get(tenant_id)?.length ?? 0;
  }

  clear(tenant_id: string): number {
    const n = this.map.get(tenant_id)?.length ?? 0;
    this.map.delete(tenant_id);
    return n;
  }

  acknowledge(
    tenant_id: string,
    event_id: string,
    by: string,
    at: Date,
    note?: string,
  ): AdapterSlaBreachAckResult {
    const arr = this.map.get(tenant_id);
    if (!arr) return { event: null, already: false };
    const idx = arr.findIndex((e) => e.event_id === event_id);
    if (idx < 0) return { event: null, already: false };
    const existing = arr[idx]!;
    if (existing.acknowledged_at) {
      return { event: existing, already: true };
    }
    const updated: AdapterSlaBreachEvent = {
      ...existing,
      acknowledged_by: by,
      acknowledged_at: at.toISOString(),
      ...(note ? { acknowledgement_note: note } : {}),
    };
    arr[idx] = updated;
    return { event: updated, already: false };
  }
}

export const defaultAdapterSlaBreachEventStore: AdapterSlaBreachEventStore =
  new InMemoryAdapterSlaBreachEventStore();

/**
 * Walk a dashboard result and push one event per breached row to the
 * store. Returns the events that were recorded so the caller can
 * surface them in the response. Pure-side-effect; idempotent only in
 * the sense that you'll get one new row per call (de-dup is the
 * caller's job — typically not needed since snapshots fire on a
 * cadence, not on every dashboard read).
 */
export function recordBreachEvents(
  store: AdapterSlaBreachEventStore,
  dashboard: AdapterSlaDashboard,
  tenant_id: string,
  now: Date,
  uuid: () => string,
): AdapterSlaBreachEvent[] {
  const out: AdapterSlaBreachEvent[] = [];
  for (const row of dashboard.per_adapter) {
    if (row.sla_status !== 'breached') continue;
    const event: AdapterSlaBreachEvent = {
      event_id: uuid(),
      tenant_id,
      connector_id: row.connector_id,
      connector_name: row.name,
      source_system: row.source_system,
      observed_at: now.toISOString(),
      sla_breaches: [...row.sla_breaches],
      success_rate: row.success_rate,
      p95_latency_ms: row.p95_latency_ms,
      sla_targets: row.sla_targets,
    };
    store.record(event);
    out.push(event);
  }
  return out;
}

/**
 * Resolve which targets the dashboard should evaluate against for a
 * given call. Priority: per-call query override > stored tenant
 * override > platform default. The caller passes whatever subset of
 * targets they parsed from query params (or `null` for "no override").
 */
export function resolveSlaTargets(
  store: AdapterSlaTargetsStore,
  tenant_id: string,
  perCallOverride: Partial<AdapterSlaTargets> | null,
): AdapterSlaTargets {
  const stored = store.get(tenant_id);
  return {
    min_success_rate:
      perCallOverride?.min_success_rate ?? stored.min_success_rate,
    max_p95_latency_ms:
      perCallOverride?.max_p95_latency_ms ?? stored.max_p95_latency_ms,
  };
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
