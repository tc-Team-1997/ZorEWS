// services/bff/src/connector_schema_field_count_histogram.ts
//
// T6 M3.18 — Connector schema field-count histogram.
//
// M3.2 ships the per-connector schema metadata catalog (field types,
// required flags, ranges, enums). M3.14 ships the cross-connector
// field-type × required matrix. M3.18 ships the FIELD-COUNT
// distribution: how many connectors have 1-3 fields vs 4-6 vs 7-10
// vs 11-15 vs >15? Useful for ingestion ops + SPA "complexity at a
// glance" panel.
//
// 5 canonical buckets (closed enum, declared iteration order):
//   minimal (1-3) / small (4-6) / medium (7-10) / large (11-15) /
//   x_large (>15; open-ended max).
//
// Per-bucket: {bucket, label, min, max (null for x_large),
//   max_inclusive, count, by_record_format (every RecordFormat key
//   at 0 when absent), sample_connector_ids (cap 3 sorted asc)}.
//
// Envelope: total_connectors + total_fields_across_catalog (Σ per-
// connector field count) + peak_bucket (canonical tie-break) + mean
// + min + max + empty_buckets[] canonical.
//
// Platform-static. Mirror of M4.15 (indicator weight histogram) +
// M5.18 (rule template indicator-count histogram) + M9.11 / M8.12 /
// M7.15 / M3.16 bucketing pattern for the connector schema surface.

import {
  getConnectorSchema,
  listSchemaConnectorIds,
  type RecordFormat,
} from './connector_schema';

// ─── Public types ──────────────────────────────────────────────────────

export type FieldCountBucket =
  | 'minimal'
  | 'small'
  | 'medium'
  | 'large'
  | 'x_large';

export const ALL_FIELD_COUNT_BUCKETS: readonly FieldCountBucket[] = [
  'minimal',
  'small',
  'medium',
  'large',
  'x_large',
];

export const ALL_RECORD_FORMATS: readonly RecordFormat[] = [
  'kafka_json',
  'csv',
  'sftp_csv',
  'rest_json',
];

interface BucketMeta {
  bucket: FieldCountBucket;
  label: string;
  min: number;
  /** null for the open-ended x_large bucket. */
  max: number | null;
  /** All non-terminal buckets have INCLUSIVE max (1-3 means 3 is
   *  inside the minimal bucket, not the boundary of small). */
  max_inclusive: boolean;
}

const BUCKET_META: readonly BucketMeta[] = [
  { bucket: 'minimal', label: '1-3 fields', min: 1, max: 3, max_inclusive: true },
  { bucket: 'small', label: '4-6 fields', min: 4, max: 6, max_inclusive: true },
  { bucket: 'medium', label: '7-10 fields', min: 7, max: 10, max_inclusive: true },
  { bucket: 'large', label: '11-15 fields', min: 11, max: 15, max_inclusive: true },
  { bucket: 'x_large', label: '16+ fields', min: 16, max: null, max_inclusive: false },
];

export interface FieldCountBucketRow extends BucketMeta {
  count: number;
  /** Distribution of record_format across connectors in this bucket.
   *  Every RecordFormat key present at 0 when absent (stable grid). */
  by_record_format: Record<RecordFormat, number>;
  /** Cap 3, sorted connector_id asc — SPA can drill-into the bucket. */
  sample_connector_ids: string[];
}

export interface ConnectorSchemaFieldCountHistogram {
  generated_at: string;
  total_connectors: number;
  total_fields_across_catalog: number;
  buckets: FieldCountBucketRow[];
  /** Highest-count bucket; canonical ALL_FIELD_COUNT_BUCKETS tie-break
   *  (earlier bucket wins at tied); null when zero connectors. */
  peak_bucket: FieldCountBucket | null;
  peak_count: number;
  /** Rounded mean across the catalog; null when total_connectors=0. */
  mean_fields: number | null;
  min_fields: number | null;
  max_fields: number | null;
  /** Canonical-order subset of count=0 buckets. */
  empty_buckets: FieldCountBucket[];
}

// ─── Helpers ───────────────────────────────────────────────────────────

export function bucketForFieldCount(n: number): FieldCountBucket | null {
  if (!Number.isFinite(n) || n < 1) return null;
  if (n <= 3) return 'minimal';
  if (n <= 6) return 'small';
  if (n <= 10) return 'medium';
  if (n <= 15) return 'large';
  return 'x_large';
}

function emptyByRecordFormat(): Record<RecordFormat, number> {
  const out = {} as Record<RecordFormat, number>;
  for (const f of ALL_RECORD_FORMATS) out[f] = 0;
  return out;
}

// ─── Pure resolver ─────────────────────────────────────────────────────

export function buildConnectorSchemaFieldCountHistogram(
  now: Date,
): ConnectorSchemaFieldCountHistogram {
  // Build empty buckets in canonical order — stable SPA axis.
  const bucketRows: FieldCountBucketRow[] = BUCKET_META.map((m) => ({
    ...m,
    count: 0,
    by_record_format: emptyByRecordFormat(),
    sample_connector_ids: [],
  }));
  const bucketIndex = new Map<FieldCountBucket, FieldCountBucketRow>();
  for (const row of bucketRows) bucketIndex.set(row.bucket, row);

  const connectorIds = listSchemaConnectorIds().slice().sort();
  let total_fields = 0;
  let min_fields: number | null = null;
  let max_fields: number | null = null;

  for (const connectorId of connectorIds) {
    const schema = getConnectorSchema(connectorId);
    if (!schema) continue;

    const fieldCount = schema.fields.length;
    total_fields += fieldCount;
    if (min_fields === null || fieldCount < min_fields) min_fields = fieldCount;
    if (max_fields === null || fieldCount > max_fields) max_fields = fieldCount;

    const bucketKey = bucketForFieldCount(fieldCount);
    if (!bucketKey) continue; // defensive: schema with 0 fields would skip

    const bucket = bucketIndex.get(bucketKey)!;
    bucket.count++;
    if (
      ALL_RECORD_FORMATS.includes(schema.record_format) &&
      bucket.by_record_format[schema.record_format] !== undefined
    ) {
      bucket.by_record_format[schema.record_format]++;
    }
    if (bucket.sample_connector_ids.length < 3) {
      bucket.sample_connector_ids.push(connectorId);
    }
  }

  // sample_connector_ids already in asc order since connectorIds was sorted.

  const total_connectors = connectorIds.filter((id) =>
    getConnectorSchema(id),
  ).length;

  // peak_bucket — canonical iteration tie-break.
  let peak_bucket: FieldCountBucket | null = null;
  let peak_count = 0;
  for (const bucket of bucketRows) {
    if (bucket.count > peak_count) {
      peak_count = bucket.count;
      peak_bucket = bucket.bucket;
    }
  }

  const mean_fields =
    total_connectors > 0
      ? Math.round((total_fields / total_connectors) * 100) / 100
      : null;

  const empty_buckets = bucketRows
    .filter((b) => b.count === 0)
    .map((b) => b.bucket);

  return {
    generated_at: now.toISOString(),
    total_connectors,
    total_fields_across_catalog: total_fields,
    buckets: bucketRows,
    peak_bucket,
    peak_count,
    mean_fields,
    min_fields,
    max_fields,
    empty_buckets,
  };
}
