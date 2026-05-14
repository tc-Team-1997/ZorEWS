// services/bff/src/connector_schema_source_map.ts
//
// T6 M3.7 — Connector schema source-map view.
//
// M3.3 ships per-tenant schema overrides; the existing
// `/schema/effective` route returns the merged shape. M3.7 adds
// the companion source-map: per-field `source: 'platform' |
// 'tenant_addition'` attribution so the SPA's column-mapper can
// badge each field's origin without a second round-trip to
// compare platform vs effective.
//
// Mirrors the M4.9 / M6.10 / M10.10 resolution-chain shape but for
// the connector field schema. Tenant additions are STRICTLY
// additive (the M3.3 store rejects platform-name collisions via
// `reserved_field`), so the source map is unambiguous: a field
// appearing in the platform schema is `platform`, otherwise it's
// `tenant_addition`.

import { type ConnectorSchema, type FieldType } from './connector_schema';
import { type FieldDef } from './connector_schema';

// ─── Public types ─────────────────────────────────────────────────────

export type FieldSource = 'platform' | 'tenant_addition';

export interface ConnectorFieldSource {
  name: string;
  type: FieldType;
  required: boolean;
  source: FieldSource;
}

export interface ConnectorSchemaSourceMap {
  connector_id: string;
  version: string;
  total_fields: number;
  platform_field_count: number;
  tenant_addition_count: number;
  /** Platform fields first (preserving M3.2 platform ordering), then
   *  tenant additions (preserving M3.3 insertion order). */
  fields: ConnectorFieldSource[];
}

// ─── Pure resolver ────────────────────────────────────────────────────

/**
 * Pure source-map builder. Caller passes the platform schema +
 * the tenant overrides; the function emits a per-field
 * `source: 'platform' | 'tenant_addition'` attribution.
 *
 * Order: platform fields in their declared order, then tenant
 * additions in insertion order. Matches the order that
 * `schemaOverrideStore.effective(...)` produces, so SPA renderers
 * can index both responses by row.
 */
export function mapConnectorSchemaSources(
  platform: ConnectorSchema,
  overrides: readonly FieldDef[],
): ConnectorSchemaSourceMap {
  const platformNames = new Set(platform.fields.map((f) => f.name));
  const fields: ConnectorFieldSource[] = [];
  for (const f of platform.fields) {
    fields.push({ name: f.name, type: f.type, required: f.required, source: 'platform' });
  }
  let tenant_addition_count = 0;
  for (const f of overrides) {
    // Defensive: an override with the same name as a platform field
    // shouldn't exist (M3.3's add() rejects it), but if it slipped
    // through we treat it as platform-precedent — the platform always
    // wins in the merge.
    if (platformNames.has(f.name)) continue;
    fields.push({ name: f.name, type: f.type, required: f.required, source: 'tenant_addition' });
    tenant_addition_count += 1;
  }
  return {
    connector_id: platform.connector_id,
    version: platform.version,
    total_fields: fields.length,
    platform_field_count: platform.fields.length,
    tenant_addition_count,
    fields,
  };
}
