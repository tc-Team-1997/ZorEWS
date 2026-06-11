// services/bff/src/connector_field_usage_stats.ts
// T6 M3.29 — Connector schema field usage statistics.

import { listSchemaConnectorIds, getConnectorSchema } from './connector_schema';

export interface ConnectorFieldUsageStat {
  connector_id: string;
  total_fields: number;
  required_pct: number;
  enum_field_count: number;
  numeric_field_count: number;
  string_field_count: number;
  schema_complexity_score: number;
}

export interface ConnectorFieldUsageStatsResult {
  generated_at: string;
  connectors: ConnectorFieldUsageStat[];
}

export function buildConnectorFieldUsageStats(now: Date): ConnectorFieldUsageStatsResult {
  const ids = listSchemaConnectorIds();
  const connectors: ConnectorFieldUsageStat[] = [];

  for (const id of ids) {
    const schema = getConnectorSchema(id);
    if (!schema) continue;

    const fields = schema.fields;
    const total_fields = fields.length;
    const required_count = fields.filter((f) => f.required).length;
    const required_pct = total_fields === 0 ? 0 : Math.round((required_count / total_fields) * 100) / 100;
    const enum_field_count = fields.filter((f) => f.type === 'enum').length;
    const numeric_field_count = fields.filter((f) => f.type === 'integer' || f.type === 'number').length;
    const string_field_count = fields.filter((f) => f.type === 'string').length;
    const schema_complexity_score =
      enum_field_count * 3 + numeric_field_count * 2 + Math.round(required_pct * 10);

    connectors.push({
      connector_id: id,
      total_fields,
      required_pct,
      enum_field_count,
      numeric_field_count,
      string_field_count,
      schema_complexity_score,
    });
  }

  connectors.sort((a, b) => b.schema_complexity_score - a.schema_complexity_score);

  return {
    generated_at: now.toISOString(),
    connectors,
  };
}
