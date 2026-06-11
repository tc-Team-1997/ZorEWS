// services/bff/src/connector_uptime_stats.ts
//
// T6 M3.26 — Connector uptime statistics.
//
// For each connector, compute uptime stats from the last 20 runs:
//   - uptime_pct = success_runs / total_finished_runs * 100
//   - mtbf_hours = mean time between failures (null if no failures)
//   - sla_met = uptime_pct >= 99.0
//
// Sort by uptime_pct asc (worst first).
//
// Route: GET /v1/ingestion/connectors/uptime-stats
//   RBAC: audit:read (admin)

import { defaultIngestionRegistry, type IngestionRegistry } from './ingestion';

// ─── Public types ─────────────────────────────────────────────────────

export interface ConnectorUptimeStat {
  connector_id: string;
  name: string;
  source_system: string;
  total_runs_sampled: number;
  success_count: number;
  failure_count: number;
  partial_count: number;
  still_running_count: number;
  total_finished_runs: number;
  uptime_pct: number;
  mtbf_hours: number | null;
  sla_met: boolean;
}

export interface ConnectorUptimeReport {
  tenant_id: string;
  generated_at: string;
  connectors: ConnectorUptimeStat[];
  fleet_avg_uptime_pct: number;
  connectors_below_sla: string[];
  all_sla_met: boolean;
}

const SLA_THRESHOLD = 99.0;
const SAMPLE_SIZE = 20;

// ─── Pure resolver ────────────────────────────────────────────────────

export function buildConnectorUptimeStats(
  registry: IngestionRegistry,
  tenant_id: string,
  now: Date,
): ConnectorUptimeReport {
  if (!tenant_id) throw new Error('tenant_id is required');

  const connectors = registry.list(tenant_id);
  const stats: ConnectorUptimeStat[] = [];

  for (const c of connectors) {
    const runs = registry.listRuns(tenant_id, c.id, SAMPLE_SIZE);
    const total_runs_sampled = runs.length;

    let success_count = 0;
    let failure_count = 0;
    let partial_count = 0;
    let still_running_count = 0;

    const failureTimes: number[] = [];

    for (const r of runs) {
      if (r.status === 'success') success_count++;
      else if (r.status === 'failure') {
        failure_count++;
        failureTimes.push(new Date(r.started_at).getTime());
      } else if (r.status === 'partial') partial_count++;
      else if (r.status === 'running') still_running_count++;
    }

    const total_finished_runs = success_count + failure_count + partial_count;
    const uptime_pct =
      total_finished_runs === 0
        ? 100
        : Math.round((success_count / total_finished_runs) * 10000) / 100;

    // MTBF: mean time between failures (hours)
    let mtbf_hours: number | null = null;
    if (failureTimes.length >= 2) {
      const sorted = [...failureTimes].sort((a, b) => a - b);
      let totalGap = 0;
      for (let i = 1; i < sorted.length; i++) totalGap += sorted[i] - sorted[i - 1];
      mtbf_hours = Math.round((totalGap / (sorted.length - 1) / 3600000) * 100) / 100;
    }

    stats.push({
      connector_id: c.id,
      name: c.name,
      source_system: c.source_system,
      total_runs_sampled,
      success_count,
      failure_count,
      partial_count,
      still_running_count,
      total_finished_runs,
      uptime_pct,
      mtbf_hours,
      sla_met: uptime_pct >= SLA_THRESHOLD,
    });
  }

  // Sort worst first (lowest uptime)
  stats.sort((a, b) => a.uptime_pct - b.uptime_pct);

  const fleet_avg_uptime_pct =
    stats.length === 0
      ? 100
      : Math.round((stats.reduce((s, c) => s + c.uptime_pct, 0) / stats.length) * 100) / 100;

  const connectors_below_sla = stats
    .filter((c) => !c.sla_met)
    .map((c) => c.connector_id);

  return {
    tenant_id,
    generated_at: now.toISOString(),
    connectors: stats,
    fleet_avg_uptime_pct,
    connectors_below_sla,
    all_sla_met: connectors_below_sla.length === 0,
  };
}
