// services/bff/__tests__/connector_schema_field_count_histogram.test.ts
//
// T6 M3.18 — Connector schema field-count histogram.

import request from 'supertest';
import {
  ALL_FIELD_COUNT_BUCKETS,
  ALL_RECORD_FORMATS,
  bucketForFieldCount,
  buildConnectorSchemaFieldCountHistogram,
} from '../src/connector_schema_field_count_histogram';
import { getConnectorSchema, listSchemaConnectorIds } from '../src/connector_schema';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-20T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function makeCsApp(role: string = 'admin') {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
  });
}

// ─── bucketForFieldCount ──────────────────────────────────────────────

describe('bucketForFieldCount helper', () => {
  test('minimal: 1, 2, 3', () => {
    expect(bucketForFieldCount(1)).toBe('minimal');
    expect(bucketForFieldCount(2)).toBe('minimal');
    expect(bucketForFieldCount(3)).toBe('minimal');
  });
  test('small: 4..6', () => {
    expect(bucketForFieldCount(4)).toBe('small');
    expect(bucketForFieldCount(6)).toBe('small');
  });
  test('medium: 7..10', () => {
    expect(bucketForFieldCount(7)).toBe('medium');
    expect(bucketForFieldCount(10)).toBe('medium');
  });
  test('large: 11..15', () => {
    expect(bucketForFieldCount(11)).toBe('large');
    expect(bucketForFieldCount(15)).toBe('large');
  });
  test('x_large: 16+', () => {
    expect(bucketForFieldCount(16)).toBe('x_large');
    expect(bucketForFieldCount(50)).toBe('x_large');
  });
  test('boundary at 3-4 splits buckets', () => {
    expect(bucketForFieldCount(3)).toBe('minimal');
    expect(bucketForFieldCount(4)).toBe('small');
  });
  test('boundary at 6-7 splits buckets', () => {
    expect(bucketForFieldCount(6)).toBe('small');
    expect(bucketForFieldCount(7)).toBe('medium');
  });
  test('boundary at 10-11 splits buckets', () => {
    expect(bucketForFieldCount(10)).toBe('medium');
    expect(bucketForFieldCount(11)).toBe('large');
  });
  test('boundary at 15-16 splits buckets', () => {
    expect(bucketForFieldCount(15)).toBe('large');
    expect(bucketForFieldCount(16)).toBe('x_large');
  });
  test('0 / negative / NaN → null', () => {
    expect(bucketForFieldCount(0)).toBeNull();
    expect(bucketForFieldCount(-1)).toBeNull();
    expect(bucketForFieldCount(NaN)).toBeNull();
    expect(bucketForFieldCount(Infinity)).toBeNull();
  });
});

// ─── Pure resolver shape ──────────────────────────────────────────────

describe('buildConnectorSchemaFieldCountHistogram pure', () => {
  test('basic shape — generated_at, total_connectors, buckets', () => {
    const r = buildConnectorSchemaFieldCountHistogram(NOW);
    expect(r.generated_at).toBe(NOW.toISOString());
    expect(r.total_connectors).toBeGreaterThan(0);
    expect(r.buckets).toHaveLength(5);
  });

  test('buckets in canonical ALL_FIELD_COUNT_BUCKETS order', () => {
    const r = buildConnectorSchemaFieldCountHistogram(NOW);
    expect(r.buckets.map((b) => b.bucket)).toEqual([...ALL_FIELD_COUNT_BUCKETS]);
  });

  test('bucket metadata: minimal min=1 max=3 inclusive', () => {
    const r = buildConnectorSchemaFieldCountHistogram(NOW);
    const minimal = r.buckets[0];
    expect(minimal.min).toBe(1);
    expect(minimal.max).toBe(3);
    expect(minimal.max_inclusive).toBe(true);
  });

  test('bucket metadata: x_large max=null max_inclusive=false', () => {
    const r = buildConnectorSchemaFieldCountHistogram(NOW);
    const x_large = r.buckets[4];
    expect(x_large.min).toBe(16);
    expect(x_large.max).toBeNull();
    expect(x_large.max_inclusive).toBe(false);
  });

  test('every by_record_format key present per bucket (4 keys)', () => {
    const r = buildConnectorSchemaFieldCountHistogram(NOW);
    for (const bucket of r.buckets) {
      expect(Object.keys(bucket.by_record_format).sort()).toEqual(
        [...ALL_RECORD_FORMATS].sort(),
      );
    }
  });

  test('Σ bucket.count = total_connectors partition invariant', () => {
    const r = buildConnectorSchemaFieldCountHistogram(NOW);
    const sum = r.buckets.reduce((acc, b) => acc + b.count, 0);
    expect(sum).toBe(r.total_connectors);
  });

  test('Σ by_record_format per bucket = bucket.count partition', () => {
    const r = buildConnectorSchemaFieldCountHistogram(NOW);
    for (const bucket of r.buckets) {
      const sum = ALL_RECORD_FORMATS.reduce(
        (acc, f) => acc + bucket.by_record_format[f],
        0,
      );
      expect(sum).toBe(bucket.count);
    }
  });

  test('total_fields_across_catalog matches manual sum of schemas', () => {
    const r = buildConnectorSchemaFieldCountHistogram(NOW);
    let manualTotal = 0;
    let manualCount = 0;
    for (const id of listSchemaConnectorIds()) {
      const s = getConnectorSchema(id);
      if (s) {
        manualTotal += s.fields.length;
        manualCount++;
      }
    }
    expect(r.total_fields_across_catalog).toBe(manualTotal);
    expect(r.total_connectors).toBe(manualCount);
  });

  test('min_fields <= mean_fields <= max_fields when non-empty', () => {
    const r = buildConnectorSchemaFieldCountHistogram(NOW);
    expect(r.min_fields).not.toBeNull();
    expect(r.max_fields).not.toBeNull();
    expect(r.mean_fields).not.toBeNull();
    expect(r.min_fields!).toBeLessThanOrEqual(r.mean_fields!);
    expect(r.mean_fields!).toBeLessThanOrEqual(r.max_fields!);
  });

  test('peak_bucket non-null + matches highest count + canonical tie-break', () => {
    const r = buildConnectorSchemaFieldCountHistogram(NOW);
    expect(r.peak_bucket).not.toBeNull();
    // Verify peak_bucket has the highest count (no other bucket strictly higher).
    const peakRow = r.buckets.find((b) => b.bucket === r.peak_bucket)!;
    expect(peakRow.count).toBe(r.peak_count);
    for (const bucket of r.buckets) {
      expect(bucket.count).toBeLessThanOrEqual(r.peak_count);
    }
    // Canonical tie-break: if multiple buckets tied, earliest in canonical order wins.
    const tiedBuckets = r.buckets.filter((b) => b.count === r.peak_count);
    if (tiedBuckets.length > 1) {
      const canonicalFirst = ALL_FIELD_COUNT_BUCKETS.find(
        (k) => tiedBuckets.some((b) => b.bucket === k),
      );
      expect(r.peak_bucket).toBe(canonicalFirst);
    }
  });

  test('sample_connector_ids cap 3 + sorted asc per bucket', () => {
    const r = buildConnectorSchemaFieldCountHistogram(NOW);
    for (const bucket of r.buckets) {
      expect(bucket.sample_connector_ids.length).toBeLessThanOrEqual(3);
      const sorted = [...bucket.sample_connector_ids].sort();
      expect(bucket.sample_connector_ids).toEqual(sorted);
    }
  });

  test('empty_buckets in canonical order and all count=0', () => {
    const r = buildConnectorSchemaFieldCountHistogram(NOW);
    for (const eb of r.empty_buckets) {
      const row = r.buckets.find((b) => b.bucket === eb)!;
      expect(row.count).toBe(0);
    }
    // canonical-order subset invariant
    const empty_idx = r.empty_buckets.map((b) => ALL_FIELD_COUNT_BUCKETS.indexOf(b));
    expect(empty_idx).toEqual([...empty_idx].sort((a, b) => a - b));
  });

  test('non-empty bucket count > 0 → has sample_connector_ids', () => {
    const r = buildConnectorSchemaFieldCountHistogram(NOW);
    for (const bucket of r.buckets) {
      if (bucket.count > 0) {
        expect(bucket.sample_connector_ids.length).toBeGreaterThan(0);
        expect(bucket.sample_connector_ids.length).toBeLessThanOrEqual(
          Math.min(3, bucket.count),
        );
      }
    }
  });

  test('mean_fields formula matches Σ/total_connectors rounded', () => {
    const r = buildConnectorSchemaFieldCountHistogram(NOW);
    const expected = Math.round(
      (r.total_fields_across_catalog / r.total_connectors) * 100,
    ) / 100;
    expect(r.mean_fields).toBe(expected);
  });

  test('platform-static — different now → same data (only generated_at changes)', () => {
    const r1 = buildConnectorSchemaFieldCountHistogram(NOW);
    const r2 = buildConnectorSchemaFieldCountHistogram(new Date('2027-01-01T00:00:00.000Z'));
    expect(r2.total_connectors).toBe(r1.total_connectors);
    expect(r2.total_fields_across_catalog).toBe(r1.total_fields_across_catalog);
    expect(r2.peak_bucket).toBe(r1.peak_bucket);
    expect(r2.empty_buckets).toEqual(r1.empty_buckets);
    expect(r2.buckets.map((b) => b.count)).toEqual(r1.buckets.map((b) => b.count));
  });

  test('every sample_connector_id has a real schema in M3.2 catalog', () => {
    const r = buildConnectorSchemaFieldCountHistogram(NOW);
    for (const bucket of r.buckets) {
      for (const id of bucket.sample_connector_ids) {
        expect(getConnectorSchema(id)).not.toBeNull();
      }
    }
  });

  test('every sample_connector_id falls in its claimed bucket', () => {
    const r = buildConnectorSchemaFieldCountHistogram(NOW);
    for (const bucket of r.buckets) {
      for (const id of bucket.sample_connector_ids) {
        const schema = getConnectorSchema(id)!;
        expect(bucketForFieldCount(schema.fields.length)).toBe(bucket.bucket);
      }
    }
  });
});

// ─── Route ────────────────────────────────────────────────────────────

describe('GET /v1/ingestion/schema/field-count-histogram route', () => {
  test('admin happy path — 200 + envelope shape', async () => {
    const { app } = makeCsApp('admin');
    const r = await request(app)
      .get('/v1/ingestion/schema/field-count-histogram')
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_connectors).toBeGreaterThan(0);
    expect(r.body.body.buckets).toHaveLength(5);
    expect(r.body.body.buckets[0].bucket).toBe('minimal');
    expect(r.body.body.peak_bucket).toBeTruthy();
  });

  test('non-admin role → 403', async () => {
    const { app } = makeCsApp('case_owner');
    const r = await request(app)
      .get('/v1/ingestion/schema/field-count-histogram')
      .set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('platform-static — BIL ↔ BANK_DEMO same response', async () => {
    const { app } = makeCsApp('admin');
    const rBil = await request(app)
      .get('/v1/ingestion/schema/field-count-histogram')
      .set(TH_BIL);
    const rBd = await request(app)
      .get('/v1/ingestion/schema/field-count-histogram')
      .set({ 'X-Tenant-ID': 'BANK_DEMO', 'X-Channel': 'API' });
    expect(rBil.status).toBe(200);
    expect(rBd.status).toBe(200);
    expect(rBd.body.body.total_connectors).toBe(rBil.body.body.total_connectors);
    expect(rBd.body.body.peak_bucket).toBe(rBil.body.body.peak_bucket);
    expect(rBd.body.body.buckets.map((b: { count: number }) => b.count)).toEqual(
      rBil.body.body.buckets.map((b: { count: number }) => b.count),
    );
  });

  test('M3.2 sibling regression: GET /v1/ingestion/connectors/cbs_loan_book/schema still 200', async () => {
    const { app } = makeCsApp('admin');
    const r = await request(app)
      .get('/v1/ingestion/connectors/cbs_loan_book/schema')
      .set(TH_BIL);
    expect(r.status).toBe(200);
  });

  test('literal /schema/field-count-histogram not captured by :id wildcard', async () => {
    const { app } = makeCsApp('admin');
    const r = await request(app)
      .get('/v1/ingestion/schema/field-count-histogram')
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_connectors).toBeGreaterThan(0);
  });
});
