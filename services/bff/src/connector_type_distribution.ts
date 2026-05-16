// services/bff/src/connector_type_distribution.ts
//
// T6 M3.13 — Connector type distribution rollup.
//
// M3.1 ships the 10-connector registry with per-connector type +
// status + source_system. M3.5 ships per-connector run analytics.
// M3.6 ships failure pattern clustering. M3.12 ships the fleet-wide
// hourly run-volume histogram. M3.13 lands the TYPE-pivoted view:
// for each ConnectorType, surface count + by_status + by_source_system.
//
// Use case: BIL ops opens the ingestion page and wants the answer
// to "how many kafka_stream connectors do we have? how are the
// rest_api connectors doing (healthy vs degraded)? which upstream
// system has the most connectors?" with one round-trip.
//
// Mirror of M14.27 method distribution / M5.16 / M11.11 / M3.12
// pivot pattern. Pure rollup over the registry; tenant-aware
// (status may be tenant-overridden).

import type {
  Connector,
  ConnectorStatus,
  ConnectorType,
  IngestionRegistry,
} from './ingestion';

// ─── Constants ────────────────────────────────────────────────────────

export const ALL_CONNECTOR_TYPES: readonly ConnectorType[] = [
  'kafka_stream',
  'batch_csv',
  'rest_api',
  'soap_api',
  'sftp_drop',
] as const;

const ALL_STATUSES: readonly ConnectorStatus[] = [
  'healthy',
  'degraded',
  'failing',
  'paused',
] as const;

const SAMPLE_CAP = 3;

// ─── Public types ─────────────────────────────────────────────────────

export interface ConnectorTypeSampleRow {
  connector_id: string;
  name: string;
  source_system: string;
  status: ConnectorStatus;
}

export interface ConnectorTypeRow {
  type: ConnectorType;
  count: number;
  /** Per-ConnectorStatus count; every key present at 0 when absent. */
  by_status: Record<ConnectorStatus, number>;
  /** Per-source_system count. Only systems with ≥1 connector of this
   *  type appear as keys (compact map). */
  by_source_system: Record<string, number>;
  /** Number of distinct source_system values for this type. */
  distinct_source_systems: number;
  /** Up to 3 sample connectors of this type. Sorted by connector_id
   *  asc for deterministic rendering. */
  sample_connectors: ConnectorTypeSampleRow[];
}

export interface ConnectorTypeDistributionSummary {
  tenant_id: string;
  generated_at: string;
  total_connectors: number;
  /** Every ALL_CONNECTOR_TYPES in canonical order even when zero-count. */
  types: ConnectorTypeRow[];
  /** Highest count type. Canonical-order tie-break (kafka_stream wins
   *  over batch_csv at same count). null when no connectors. */
  most_common_type: ConnectorType | null;
  /** Types with count=0 in canonical order. */
  unused_types: ConnectorType[];
}

// ─── Helpers ──────────────────────────────────────────────────────────

function emptyByStatus(): Record<ConnectorStatus, number> {
  return { healthy: 0, degraded: 0, failing: 0, paused: 0 };
}

interface RowBuilder {
  type: ConnectorType;
  count: number;
  by_status: Record<ConnectorStatus, number>;
  by_source_system: Record<string, number>;
  source_systems: Set<string>;
  connectors: Connector[];
}

function newBuilder(type: ConnectorType): RowBuilder {
  return {
    type,
    count: 0,
    by_status: emptyByStatus(),
    by_source_system: {},
    source_systems: new Set(),
    connectors: [],
  };
}

// ─── Pure resolver ────────────────────────────────────────────────────

export function summarizeConnectorTypeDistribution(
  registry: IngestionRegistry,
  tenant_id: string,
  now: Date,
): ConnectorTypeDistributionSummary {
  const builders = new Map<ConnectorType, RowBuilder>();
  for (const t of ALL_CONNECTOR_TYPES) builders.set(t, newBuilder(t));

  const connectors = registry.list(tenant_id);
  for (const c of connectors) {
    const b = builders.get(c.type);
    if (!b) continue;
    b.count++;
    if (ALL_STATUSES.includes(c.status)) b.by_status[c.status]++;
    b.by_source_system[c.source_system] = (b.by_source_system[c.source_system] ?? 0) + 1;
    b.source_systems.add(c.source_system);
    b.connectors.push(c);
  }

  // Materialise rows + samples + counters.
  const types: ConnectorTypeRow[] = ALL_CONNECTOR_TYPES.map((t) => {
    const b = builders.get(t)!;
    const sample = [...b.connectors]
      .sort((a, c) => a.id.localeCompare(c.id))
      .slice(0, SAMPLE_CAP)
      .map((c) => ({
        connector_id: c.id,
        name: c.name,
        source_system: c.source_system,
        status: c.status,
      }));
    return {
      type: b.type,
      count: b.count,
      by_status: b.by_status,
      by_source_system: b.by_source_system,
      distinct_source_systems: b.source_systems.size,
      sample_connectors: sample,
    };
  });

  // most_common_type: highest count with canonical-order tie-break.
  let most_common_type: ConnectorType | null = null;
  let mostCount = 0;
  for (const t of ALL_CONNECTOR_TYPES) {
    const b = builders.get(t)!;
    if (b.count > mostCount) {
      mostCount = b.count;
      most_common_type = t;
    }
  }
  if (mostCount === 0) most_common_type = null;

  const unused_types = ALL_CONNECTOR_TYPES.filter(
    (t) => builders.get(t)!.count === 0,
  );

  return {
    tenant_id,
    generated_at: now.toISOString(),
    total_connectors: connectors.length,
    types,
    most_common_type,
    unused_types,
  };
}
