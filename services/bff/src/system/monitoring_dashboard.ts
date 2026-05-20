// services/bff/src/system/monitoring_dashboard.ts
//
// PHASE D.1 — System Monitoring dashboard (PDF §A4 System Monitoring).
//
// Pure composer endpoint that rolls up existing health surfaces into a
// single ops-friendly dashboard payload. Inputs are taken from three
// already-shipped probe surfaces (no new probes, no new stores):
//
//   1. `pingIntegrations()` → external upstream pings (CBS / AML /
//      IFRS9 / Collection mocks). Shape: `HealthReport` from
//      ./integrations/health.
//   2. `runFleetHealth(tenant, asOf, fleet)` → 8 M14 BIL adapters via
//      `Promise.all`. Shape: `FleetHealthReport` from ./adapter_health.
//   3. `IngestionRegistry.health(tenant)` → M3.1 connector fleet
//      aggregate. Shape: `IngestionHealth` from ./ingestion.
//
// Composer combines the three lenses into a single SystemMonitoringReport:
//   - severity verdict (`green | amber | red`) derived from each axis
//   - per-axis summary (counts + worst-offender pointers)
//   - attention[] list — actionable items only, capped at 20
//   - capacity[] hints — connector run-volume + adapter probe latency
//
// Architecture (per execution rules):
//   - Pure function — composer takes inputs explicitly, no I/O of its own.
//   - Additive — no changes to the 3 underlying probe surfaces.
//   - RBAC: `audit:read` admin-only at the route layer.

import type { HealthReport, IntegrationStatus } from '../integrations/health';
import type { FleetHealthReport, AdapterProbe } from '../adapter_health';
import type { IngestionHealth, Connector } from '../ingestion';

/** Severity rollup — drives the SPA's green/amber/red badge. */
export type SystemHealthSeverity = 'green' | 'amber' | 'red';

/** Per-axis summary block. */
export interface SystemAxisSummary {
  axis: 'upstream' | 'adapters' | 'ingestion';
  /** Hand-picked human label for the dashboard tile header. */
  label: string;
  total: number;
  healthy: number;
  degraded: number;
  /** Severity for this axis alone — feeds the overall verdict. */
  severity: SystemHealthSeverity;
  /** Most-broken item in this axis (null when everything healthy). */
  worst_offender: { id: string; label: string; reason: string } | null;
}

/** Compact actionable line. */
export interface SystemAttentionItem {
  axis: 'upstream' | 'adapters' | 'ingestion';
  id: string;
  label: string;
  severity: 'high' | 'medium';
  /** Short human reason — drives the SPA's tooltip. */
  reason: string;
}

/** Capacity / load hint per axis. */
export interface SystemCapacityHint {
  axis: 'adapters' | 'ingestion';
  metric: string;
  value: number;
  /** Units string for SPA rendering (e.g. "ms", "records"). */
  unit: string;
}

export interface SystemMonitoringReport {
  tenant_id: string;
  generated_at: string;
  /** Worst severity across all axes. */
  overall_severity: SystemHealthSeverity;
  /** Per-axis summaries (always 3 rows: upstream / adapters / ingestion). */
  axes: SystemAxisSummary[];
  /** Actionable items across axes — newest-broken first, capped at 20. */
  attention: SystemAttentionItem[];
  /** Capacity hints for the SPA's gauge tiles. */
  capacity: SystemCapacityHint[];
}

/** Cap on the actionable list — keeps the SPA tile rendering bounded. */
export const SYSTEM_MONITORING_ATTENTION_CAP = 20;

// ── Helpers ───────────────────────────────────────────────────────────

/** Combine multiple severities to the worst (green < amber < red). */
function worstSeverity(severities: SystemHealthSeverity[]): SystemHealthSeverity {
  if (severities.includes('red')) return 'red';
  if (severities.includes('amber')) return 'amber';
  return 'green';
}

/** Compose the upstream-integrations axis from `HealthReport`. */
export function summariseUpstreams(report: HealthReport | null): SystemAxisSummary {
  if (!report) {
    return {
      axis: 'upstream',
      label: 'External upstream integrations',
      total: 0,
      healthy: 0,
      degraded: 0,
      severity: 'green',
      worst_offender: null,
    };
  }
  const ups: IntegrationStatus[] = report.integrations;
  const total = ups.length;
  const healthy = ups.filter((u) => u.status === 'up').length;
  const degraded = total - healthy;
  // Severity rule: any down → red. (External integrations are the bank's
  // hot dependencies; anything off is operator-actionable.)
  const severity: SystemHealthSeverity = degraded > 0 ? 'red' : 'green';
  // Worst offender: prefer the down one with the slowest latency (proxy
  // for "most pathological"); fall back to the first down.
  const down = ups
    .filter((u) => u.status === 'down')
    .sort((a, b) => b.latency_ms - a.latency_ms);
  const worst = down[0] ?? null;
  return {
    axis: 'upstream',
    label: 'External upstream integrations',
    total,
    healthy,
    degraded,
    severity,
    worst_offender: worst
      ? {
          id: worst.id,
          label: worst.label,
          reason: worst.message ?? `HTTP ${worst.http_status} (${worst.latency_ms}ms)`,
        }
      : null,
  };
}

/** Compose the adapter fleet axis from `FleetHealthReport`. */
export function summariseAdapterFleet(report: FleetHealthReport | null): SystemAxisSummary {
  if (!report) {
    return {
      axis: 'adapters',
      label: 'M14 adapter fleet',
      total: 0,
      healthy: 0,
      degraded: 0,
      severity: 'green',
      worst_offender: null,
    };
  }
  const total = report.total;
  const healthy = report.up_count;
  const degraded = report.degraded_count;
  // Severity rule: any adapter degraded → amber (adapters are
  // best-effort, fall back to cached data; not red unless every
  // adapter is down).
  let severity: SystemHealthSeverity = 'green';
  if (degraded > 0 && degraded < total) severity = 'amber';
  if (degraded > 0 && degraded === total) severity = 'red';
  // Worst offender: slowest degraded adapter.
  const downs = report.adapters
    .filter((a: AdapterProbe) => a.status === 'degraded')
    .sort((a, b) => b.latency_ms - a.latency_ms);
  const worst = downs[0] ?? null;
  return {
    axis: 'adapters',
    label: 'M14 adapter fleet',
    total,
    healthy,
    degraded,
    severity,
    worst_offender: worst
      ? {
          id: worst.adapter_id,
          label: worst.label,
          reason: worst.error ?? `degraded after ${worst.latency_ms}ms`,
        }
      : null,
  };
}

/** Compose the ingestion-connectors axis from `IngestionHealth`. */
export function summariseIngestion(report: IngestionHealth | null): SystemAxisSummary {
  if (!report) {
    return {
      axis: 'ingestion',
      label: 'M3 ingestion connectors',
      total: 0,
      healthy: 0,
      degraded: 0,
      severity: 'green',
      worst_offender: null,
    };
  }
  const total = report.total_connectors;
  const healthy = report.by_status.healthy;
  // Treat anything not-healthy as degraded — includes paused (paused
  // counts as "operator-attention" for the dashboard rollup).
  const degraded = total - healthy;
  // Severity rule: any `failing` → red; any `degraded` or `paused` → amber.
  let severity: SystemHealthSeverity = 'green';
  if (report.by_status.degraded > 0 || report.by_status.paused > 0) severity = 'amber';
  if (report.by_status.failing > 0) severity = 'red';
  // Worst offender: first failing (newest already sorted by upstream).
  const failing = report.attention_required.filter((c: Connector) => c.status === 'failing');
  const candidate: Connector | undefined = failing[0] ?? report.attention_required[0];
  const worst = candidate ?? null;
  return {
    axis: 'ingestion',
    label: 'M3 ingestion connectors',
    total,
    healthy,
    degraded,
    severity,
    worst_offender: worst
      ? {
          id: worst.id,
          label: worst.name,
          reason: `status=${worst.status}; source_system=${worst.source_system}`,
        }
      : null,
  };
}

/** Composer input — all three lenses optional so a partial probe still renders. */
export interface SystemMonitoringInput {
  tenant_id: string;
  upstream: HealthReport | null;
  adapters: FleetHealthReport | null;
  ingestion: IngestionHealth | null;
}

/** Top-level composer. */
export function buildSystemMonitoringReport(
  input: SystemMonitoringInput,
  now: Date,
): SystemMonitoringReport {
  const upstreamSum = summariseUpstreams(input.upstream);
  const adapterSum = summariseAdapterFleet(input.adapters);
  const ingestionSum = summariseIngestion(input.ingestion);

  const overall_severity = worstSeverity([
    upstreamSum.severity,
    adapterSum.severity,
    ingestionSum.severity,
  ]);

  const attention: SystemAttentionItem[] = [];

  // Upstream: every down integration is operator-actionable.
  if (input.upstream) {
    for (const u of input.upstream.integrations) {
      if (u.status === 'down') {
        attention.push({
          axis: 'upstream',
          id: u.id,
          label: u.label,
          severity: 'high',
          reason: u.message ?? `HTTP ${u.http_status} (${u.latency_ms}ms)`,
        });
      }
    }
  }

  // Adapters: surface every degraded probe. Drains them in fleet-report
  // order (which is the M14.9 probe order — deterministic).
  if (input.adapters) {
    for (const a of input.adapters.adapters) {
      if (a.status === 'degraded') {
        attention.push({
          axis: 'adapters',
          id: a.adapter_id,
          label: a.label,
          severity: 'medium',
          reason: a.error ?? `degraded after ${a.latency_ms}ms`,
        });
      }
    }
  }

  // Ingestion: surface every connector that the M3.1 health rollup
  // already flagged for attention. `failing` is high; `degraded` /
  // `paused` are medium.
  if (input.ingestion) {
    for (const c of input.ingestion.attention_required) {
      const sev: SystemAttentionItem['severity'] = c.status === 'failing' ? 'high' : 'medium';
      attention.push({
        axis: 'ingestion',
        id: c.id,
        label: c.name,
        severity: sev,
        reason: `status=${c.status}; source_system=${c.source_system}`,
      });
    }
  }

  // Sort: high severity first, then axis (upstream → adapters →
  // ingestion as a stable tie-break that matches the SPA's tile order).
  const axisRank = { upstream: 0, adapters: 1, ingestion: 2 };
  attention.sort((a, b) => {
    if (a.severity !== b.severity) {
      return a.severity === 'high' ? -1 : 1;
    }
    return axisRank[a.axis] - axisRank[b.axis];
  });

  const capped = attention.slice(0, SYSTEM_MONITORING_ATTENTION_CAP);

  const capacity: SystemCapacityHint[] = [];
  if (input.adapters) {
    capacity.push({
      axis: 'adapters',
      metric: 'fleet probe wall-clock',
      value: input.adapters.total_latency_ms,
      unit: 'ms',
    });
  }
  if (input.ingestion) {
    capacity.push({
      axis: 'ingestion',
      metric: 'fleet records (last run)',
      value: input.ingestion.fleet_records_last_run,
      unit: 'records',
    });
  }

  return {
    tenant_id: input.tenant_id,
    generated_at: now.toISOString(),
    overall_severity,
    axes: [upstreamSum, adapterSum, ingestionSum],
    attention: capped,
    capacity,
  };
}
