// services/bff/src/data_freshness_report.ts
// T6 M3.30 — Data freshness report

import { type IngestionRegistry, type Connector } from './ingestion';

export type DataAgeTier = 'fresh' | 'stale' | 'very_stale' | 'never_run';

export interface ConnectorFreshnessRow {
  connector_id: string;
  name: string;
  source_system: string;
  type: string;
  schedule: string;
  last_run_at: string | null;
  freshness_hours: number | null;
  expected_frequency_hours: number | null;
  freshness_ratio: number | null;
  data_age_tier: DataAgeTier;
}

export interface DataFreshnessReport {
  tenant_id: string;
  generated_at: string;
  connectors: ConnectorFreshnessRow[];
  stale_count: number;
  very_stale_count: number;
  never_run_count: number;
  freshest_connector: string | null;
  stalest_connector: string | null;
  overall_freshness_score: number;
}

const SCHEDULE_FREQUENCY: Record<string, number> = {
  kafka_stream: 0.017, // ~1 min
  rest_api: 1,
  batch_csv: 24,
  sftp_drop: 24,
  soap_api: 4,
};

export function buildDataFreshnessReport(
  registry: IngestionRegistry,
  tenant_id: string,
  now: Date
): DataFreshnessReport {
  const connectors = registry.list(tenant_id);
  const nowMs = now.getTime();
  const generated_at = now.toISOString();

  const rows: ConnectorFreshnessRow[] = connectors.map((c) => {
    const expected_frequency_hours = SCHEDULE_FREQUENCY[c.type] ?? 24;
    let freshness_hours: number | null = null;
    let freshness_ratio: number | null = null;
    let data_age_tier: DataAgeTier;

    if (c.last_run_at === null) {
      data_age_tier = 'never_run';
    } else {
      freshness_hours = (nowMs - new Date(c.last_run_at).getTime()) / (1000 * 60 * 60);
      freshness_ratio = freshness_hours / expected_frequency_hours;
      if (freshness_ratio < 1.5) data_age_tier = 'fresh';
      else if (freshness_ratio < 3) data_age_tier = 'stale';
      else data_age_tier = 'very_stale';
    }

    return {
      connector_id: c.id,
      name: c.name,
      source_system: c.source_system,
      type: c.type,
      schedule: c.schedule,
      last_run_at: c.last_run_at,
      freshness_hours: freshness_hours !== null ? Math.round(freshness_hours * 100) / 100 : null,
      expected_frequency_hours,
      freshness_ratio: freshness_ratio !== null ? Math.round(freshness_ratio * 100) / 100 : null,
      data_age_tier,
    };
  });

  // Sort by freshness_ratio desc (never_run treated as Infinity)
  rows.sort((a, b) => {
    const ra = a.freshness_ratio !== null ? a.freshness_ratio : Infinity;
    const rb = b.freshness_ratio !== null ? b.freshness_ratio : Infinity;
    return rb - ra;
  });

  const stale_count = rows.filter((r) => r.data_age_tier === 'stale').length;
  const very_stale_count = rows.filter((r) => r.data_age_tier === 'very_stale').length;
  const never_run_count = rows.filter((r) => r.data_age_tier === 'never_run').length;

  const freshOnes = rows.filter((r) => r.freshness_ratio !== null);
  const freshestConnector = freshOnes.length > 0
    ? freshOnes.reduce((best, r) => (r.freshness_ratio! < best.freshness_ratio! ? r : best)).connector_id
    : null;

  const staleOnes = rows.filter((r) => r.freshness_ratio !== null && r.freshness_ratio > 0);
  const stalestConnector = staleOnes.length > 0
    ? staleOnes.reduce((worst, r) => (r.freshness_ratio! > worst.freshness_ratio! ? r : worst)).connector_id
    : null;

  const total = rows.length;
  const freshCount = rows.filter((r) => r.data_age_tier === 'fresh').length;
  const overall_freshness_score = total > 0 ? Math.round((freshCount / total) * 100) : 100;

  return {
    tenant_id,
    generated_at,
    connectors: rows,
    stale_count,
    very_stale_count,
    never_run_count,
    freshest_connector: freshestConnector,
    stalest_connector: stalestConnector,
    overall_freshness_score,
  };
}
