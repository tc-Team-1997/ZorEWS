// services/bff/src/adapter_data_volume.ts
// T6 M14.38 — Adapter data volume analysis.

import { defaultIngestionRegistry, type IngestionRegistry, type ConnectorType } from './ingestion';

export type DataCategory = 'high_volume' | 'medium' | 'low';

export interface ConnectorDataVolume {
  connector_id: string;
  name: string;
  type: ConnectorType;
  avg_records_per_run: number;
  daily_volume_estimate: number;
  monthly_volume: number;
  data_category: DataCategory;
}

export interface DataTierSummary {
  high_volume: number;
  medium: number;
  low: number;
}

export interface AdapterDataVolume {
  tenant_id: string;
  generated_at: string;
  connectors: ConnectorDataVolume[];
  total_monthly_volume: number;
  highest_volume_connector: string | null;
  data_tier_summary: DataTierSummary;
}

const RUNS_PER_DAY: Record<ConnectorType, number> = {
  kafka_stream: 24,
  rest_api: 24,
  batch_csv: 1,
  sftp_drop: 1,
  soap_api: 4,
};

export function buildAdapterDataVolume(
  registry: IngestionRegistry,
  tenant_id: string,
  now: Date,
): AdapterDataVolume {
  const connectors = registry.list(tenant_id);

  const rows: ConnectorDataVolume[] = connectors.map((c) => {
    const runs = registry.listRuns(tenant_id, c.id, 20);
    const finishedRuns = runs.filter((r) => r.status === 'success' || r.status === 'partial');
    const avg_records_per_run = finishedRuns.length > 0
      ? Math.round(finishedRuns.reduce((s, r) => s + r.records_processed, 0) / finishedRuns.length)
      : c.last_run_records > 0 ? c.last_run_records : 0;

    const runs_per_day = RUNS_PER_DAY[c.type] ?? 1;
    const daily_volume_estimate = avg_records_per_run * runs_per_day;
    const monthly_volume = daily_volume_estimate * 30;

    let data_category: DataCategory;
    if (monthly_volume > 100000) data_category = 'high_volume';
    else if (monthly_volume >= 10000) data_category = 'medium';
    else data_category = 'low';

    return { connector_id: c.id, name: c.name, type: c.type, avg_records_per_run, daily_volume_estimate, monthly_volume, data_category };
  });

  rows.sort((a, b) => b.monthly_volume - a.monthly_volume);

  const total_monthly_volume = rows.reduce((s, r) => s + r.monthly_volume, 0);
  const highest_volume_connector = rows.length > 0 ? rows[0].connector_id : null;
  const data_tier_summary: DataTierSummary = {
    high_volume: rows.filter((r) => r.data_category === 'high_volume').length,
    medium: rows.filter((r) => r.data_category === 'medium').length,
    low: rows.filter((r) => r.data_category === 'low').length,
  };

  return { tenant_id, generated_at: now.toISOString(), connectors: rows, total_monthly_volume, highest_volume_connector, data_tier_summary };
}

export { defaultIngestionRegistry };
