// services/bff/src/connector_schema_record_format_distribution.ts
//
// T6 M3.15 — Connector schema record_format distribution.
//
// M3.13 ships the connector TYPE distribution (kafka_stream / batch_csv /
// rest_api / soap_api / sftp_drop — how the platform CONNECTS upstream).
// M3.14 ships the field-type × required cross-tab matrix.
//
// M3.15 lands the orthogonal PIVOT-BY-RECORD_FORMAT view over the M3.2
// connector schema catalog. The `record_format` field on each
// ConnectorSchema is distinct from connector_type — it describes the
// WIRE FORMAT the connector speaks (kafka_json / csv / sftp_csv /
// rest_json), independent of the underlying transport.
//
// Mirror of M14.27 / M7.13 / M3.13 / M5.16 1D distribution pattern with
// every-enum-key-present-at-0 + canonical-order tie-break + envelope
// leaderboards.
//
// Drives the BIL ops "schema wire-format audit" panel:
//   "how many of our connectors speak kafka_json vs sftp_csv?"
//   "is anyone still on csv (no header schema)?"
//   "what's our mean field-count by wire format?"
//
// Platform-static — same response across tenants since the schema
// catalog is platform data.

import {
  getConnectorSchema,
  listSchemaConnectorIds,
  type ConnectorSchema,
  type RecordFormat,
} from './connector_schema';

// ─── Canonical enum ────────────────────────────────────────────────────

export const ALL_RECORD_FORMATS: readonly RecordFormat[] = [
  'kafka_json',
  'csv',
  'sftp_csv',
  'rest_json',
] as const;

// ─── Public types ──────────────────────────────────────────────────────

export interface RecordFormatRow {
  format: RecordFormat;
  count: number;
  /** Schema connector_ids that use this record_format, sorted asc. */
  connector_ids: string[];
  /** Sum of fields[] length across this row's schemas. */
  total_fields: number;
  /** Sum of required fields across this row's schemas. */
  total_required_fields: number;
  /** Sum of optional fields across this row's schemas. */
  total_optional_fields: number;
  /** Mean field count per connector for this format (rounded; 0 when count=0). */
  mean_field_count: number;
  /** Top-3 connectors by total field count, sorted desc then connector_id asc. */
  sample_connectors: Array<{
    connector_id: string;
    version: string;
    field_count: number;
  }>;
}

export interface RecordFormatDistributionSummary {
  generated_at: string;
  total_connectors: number;
  total_fields: number;
  /** Per-format rows in canonical ALL_RECORD_FORMATS order even when zero-count. */
  formats: RecordFormatRow[];
  /** Format with highest count; canonical-order tie-break; null when
   *  zero schemas in the catalog. */
  most_common_format: RecordFormat | null;
  /** Formats with count=0 in canonical order — surfaces "no connector
   *  speaks csv anymore — can we deprecate it?". */
  unused_formats: RecordFormat[];
}

// ─── Pure resolver ─────────────────────────────────────────────────────

export function summarizeConnectorSchemaRecordFormats(
  now: Date,
): RecordFormatDistributionSummary {
  const schemas: ConnectorSchema[] = listSchemaConnectorIds()
    .map((id) => getConnectorSchema(id))
    .filter((s): s is ConnectorSchema => s !== null);

  // Build per-format buckets.
  const buckets = new Map<RecordFormat, RecordFormatRow>();
  for (const fmt of ALL_RECORD_FORMATS) {
    buckets.set(fmt, {
      format: fmt,
      count: 0,
      connector_ids: [],
      total_fields: 0,
      total_required_fields: 0,
      total_optional_fields: 0,
      mean_field_count: 0,
      sample_connectors: [],
    });
  }

  // Per-format candidate pool for sample selection.
  const candidatesByFormat = new Map<
    RecordFormat,
    Array<{ connector_id: string; version: string; field_count: number }>
  >();
  for (const fmt of ALL_RECORD_FORMATS) candidatesByFormat.set(fmt, []);

  let total_fields = 0;

  for (const s of schemas) {
    const row = buckets.get(s.record_format);
    if (!row) continue; // defensive: unknown format silently skipped
    row.count++;
    row.connector_ids.push(s.connector_id);
    const fieldCount = s.fields.length;
    const requiredCount = s.fields.filter((f) => f.required).length;
    const optionalCount = fieldCount - requiredCount;
    row.total_fields += fieldCount;
    row.total_required_fields += requiredCount;
    row.total_optional_fields += optionalCount;
    total_fields += fieldCount;
    candidatesByFormat.get(s.record_format)!.push({
      connector_id: s.connector_id,
      version: s.version,
      field_count: fieldCount,
    });
  }

  // Finalize each row.
  for (const fmt of ALL_RECORD_FORMATS) {
    const row = buckets.get(fmt)!;
    row.connector_ids.sort();
    row.mean_field_count = row.count === 0 ? 0 : Math.round(row.total_fields / row.count);

    const candidates = candidatesByFormat.get(fmt)!;
    candidates.sort((a, b) => {
      if (b.field_count !== a.field_count) return b.field_count - a.field_count;
      return a.connector_id.localeCompare(b.connector_id);
    });
    row.sample_connectors = candidates.slice(0, 3);
  }

  // most_common_format — canonical-order tie-break via iteration order.
  let most_common_format: RecordFormat | null = null;
  let mostCount = 0;
  for (const fmt of ALL_RECORD_FORMATS) {
    const row = buckets.get(fmt)!;
    if (row.count > mostCount) {
      mostCount = row.count;
      most_common_format = fmt;
    }
  }

  // unused_formats — canonical-order subset filter.
  const unused_formats: RecordFormat[] = ALL_RECORD_FORMATS.filter(
    (f) => buckets.get(f)!.count === 0,
  );

  const formats: RecordFormatRow[] = ALL_RECORD_FORMATS.map((f) => buckets.get(f)!);

  return {
    generated_at: now.toISOString(),
    total_connectors: schemas.length,
    total_fields,
    formats,
    most_common_format,
    unused_formats,
  };
}
