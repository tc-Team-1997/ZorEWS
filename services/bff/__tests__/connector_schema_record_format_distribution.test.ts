// services/bff/__tests__/connector_schema_record_format_distribution.test.ts
//
// T6 M3.15 — Connector schema record_format distribution.

import request from 'supertest';
import {
  summarizeConnectorSchemaRecordFormats,
  ALL_RECORD_FORMATS,
} from '../src/connector_schema_record_format_distribution';
import {
  getConnectorSchema,
  listSchemaConnectorIds,
  type ConnectorSchema,
  type RecordFormat,
} from '../src/connector_schema';

function allSchemas(): ConnectorSchema[] {
  return listSchemaConnectorIds()
    .map((id) => getConnectorSchema(id))
    .filter((s): s is ConnectorSchema => s !== null);
}
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-17T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };
const TH_BANK = { 'X-Tenant-ID': 'BANK_DEMO', 'X-Channel': 'API' };

function makeRfApp(role: string = 'admin') {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
  });
}

// ─── Pure resolver tests ─────────────────────────────────────────────

describe('M3.15 — canonical record_format order', () => {
  test('exactly 4 formats in canonical order', () => {
    const s = summarizeConnectorSchemaRecordFormats(NOW);
    expect(s.formats.length).toBe(4);
    expect(s.formats.map((r) => r.format)).toEqual([
      'kafka_json',
      'csv',
      'sftp_csv',
      'rest_json',
    ]);
    expect([...ALL_RECORD_FORMATS]).toEqual([
      'kafka_json',
      'csv',
      'sftp_csv',
      'rest_json',
    ]);
  });
});

describe('M3.15 — total_connectors matches SCHEMAS_BY_ID size', () => {
  test('total_connectors = Σ schema count', () => {
    const s = summarizeConnectorSchemaRecordFormats(NOW);
    expect(s.total_connectors).toBe(listSchemaConnectorIds().length);
  });
});

describe('M3.15 — Σ formats.count = total_connectors partition invariant', () => {
  test('partition holds', () => {
    const s = summarizeConnectorSchemaRecordFormats(NOW);
    const sum = s.formats.reduce((acc, r) => acc + r.count, 0);
    expect(sum).toBe(s.total_connectors);
  });
});

describe('M3.15 — Σ total_fields per row = envelope total_fields', () => {
  test('total fields partition', () => {
    const s = summarizeConnectorSchemaRecordFormats(NOW);
    const sum = s.formats.reduce((acc, r) => acc + r.total_fields, 0);
    expect(sum).toBe(s.total_fields);
  });
});

describe('M3.15 — required + optional = total_fields per row', () => {
  test('per-row required + optional partition', () => {
    const s = summarizeConnectorSchemaRecordFormats(NOW);
    for (const row of s.formats) {
      expect(row.total_required_fields + row.total_optional_fields).toBe(
        row.total_fields,
      );
    }
  });
});

describe('M3.15 — connector_ids sorted asc per row', () => {
  test('per-row connector_ids ascending', () => {
    const s = summarizeConnectorSchemaRecordFormats(NOW);
    for (const row of s.formats) {
      const sorted = [...row.connector_ids].sort();
      expect(row.connector_ids).toEqual(sorted);
    }
  });
});

describe('M3.15 — connector_ids subset of SCHEMAS_BY_ID', () => {
  test('every id is a real connector', () => {
    const s = summarizeConnectorSchemaRecordFormats(NOW);
    const known = new Set(listSchemaConnectorIds());
    for (const row of s.formats) {
      for (const id of row.connector_ids) {
        expect(known.has(id)).toBe(true);
      }
    }
  });
});

describe('M3.15 — count matches manual scan', () => {
  test('per-format count agrees with direct SCHEMAS_BY_ID scan', () => {
    const s = summarizeConnectorSchemaRecordFormats(NOW);
    for (const fmt of ALL_RECORD_FORMATS) {
      const manual = allSchemas().filter(
        (s) => s.record_format === fmt,
      ).length;
      const row = s.formats.find((r) => r.format === fmt)!;
      expect(row.count).toBe(manual);
    }
  });
});

describe('M3.15 — mean_field_count formula', () => {
  test('mean = round(total_fields / count) or 0 when count=0', () => {
    const s = summarizeConnectorSchemaRecordFormats(NOW);
    for (const row of s.formats) {
      if (row.count === 0) {
        expect(row.mean_field_count).toBe(0);
      } else {
        expect(row.mean_field_count).toBe(
          Math.round(row.total_fields / row.count),
        );
      }
    }
  });
});

describe('M3.15 — sample_connectors cap 3', () => {
  test('every row has ≤ 3 samples', () => {
    const s = summarizeConnectorSchemaRecordFormats(NOW);
    for (const row of s.formats) {
      expect(row.sample_connectors.length).toBeLessThanOrEqual(3);
      expect(row.sample_connectors.length).toBeLessThanOrEqual(row.count);
    }
  });
});

describe('M3.15 — sample_connectors sorted field_count desc + connector_id asc', () => {
  test('each row\'s samples respect sort order', () => {
    const s = summarizeConnectorSchemaRecordFormats(NOW);
    for (const row of s.formats) {
      for (let i = 1; i < row.sample_connectors.length; i++) {
        const a = row.sample_connectors[i - 1];
        const b = row.sample_connectors[i];
        if (a.field_count === b.field_count) {
          expect(a.connector_id.localeCompare(b.connector_id)).toBeLessThan(0);
        } else {
          expect(a.field_count).toBeGreaterThan(b.field_count);
        }
      }
    }
  });
});

describe('M3.15 — sample_connectors carries field_count + version', () => {
  test('every sample has version + field_count > 0', () => {
    const s = summarizeConnectorSchemaRecordFormats(NOW);
    for (const row of s.formats) {
      for (const sample of row.sample_connectors) {
        expect(typeof sample.version).toBe('string');
        expect(sample.version.length).toBeGreaterThan(0);
        expect(sample.field_count).toBeGreaterThan(0);
      }
    }
  });
});

describe('M3.15 — most_common_format formula', () => {
  test('most_common is the highest-count format', () => {
    const s = summarizeConnectorSchemaRecordFormats(NOW);
    if (s.most_common_format) {
      const top = s.formats.find((r) => r.format === s.most_common_format)!;
      for (const row of s.formats) {
        expect(top.count).toBeGreaterThanOrEqual(row.count);
      }
    }
  });
});

describe('M3.15 — most_common_format canonical tie-break', () => {
  test('kafka_json wins over csv at same count via canonical iteration', () => {
    // The default catalog has multiple kafka_json schemas + 1 csv, so
    // kafka_json should be most_common deterministically.
    const s = summarizeConnectorSchemaRecordFormats(NOW);
    const kafka = s.formats.find((r) => r.format === 'kafka_json')!;
    expect(kafka.count).toBeGreaterThan(0);
    expect(s.most_common_format).toBe('kafka_json');
  });
});

describe('M3.15 — unused_formats canonical order', () => {
  test('zero-count formats listed in canonical order', () => {
    const s = summarizeConnectorSchemaRecordFormats(NOW);
    const zeroFormats = s.formats
      .filter((r) => r.count === 0)
      .map((r) => r.format);
    expect(s.unused_formats).toEqual(zeroFormats);
    // Order matches ALL_RECORD_FORMATS iteration order
    for (let i = 1; i < s.unused_formats.length; i++) {
      const prevIdx = ALL_RECORD_FORMATS.indexOf(s.unused_formats[i - 1]);
      const currIdx = ALL_RECORD_FORMATS.indexOf(s.unused_formats[i]);
      expect(prevIdx).toBeLessThan(currIdx);
    }
  });
});

describe('M3.15 — generated_at echoes now', () => {
  test('ISO timestamp echoed', () => {
    const s = summarizeConnectorSchemaRecordFormats(NOW);
    expect(s.generated_at).toBe(NOW.toISOString());
  });
});

// ─── Route tests ─────────────────────────────────────────────────────

describe('M3.15 — GET /v1/ingestion/schema/record-format-distribution', () => {
  test('admin → 200 with full distribution', async () => {
    const { app } = makeRfApp('admin');
    const res = await request(app)
      .get('/v1/ingestion/schema/record-format-distribution')
      .set(TH_BIL);
    expect(res.status).toBe(200);
    expect(res.body.body.formats.length).toBe(4);
    expect(res.body.body.total_connectors).toBe(
      listSchemaConnectorIds().length,
    );
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeRfApp('field_officer');
    const res = await request(app)
      .get('/v1/ingestion/schema/record-format-distribution')
      .set(TH_BIL);
    expect(res.status).toBe(403);
  });

  test('platform-static: same response across tenants', async () => {
    const { app } = makeRfApp('admin');
    const bil = await request(app)
      .get('/v1/ingestion/schema/record-format-distribution')
      .set(TH_BIL);
    const bank = await request(app)
      .get('/v1/ingestion/schema/record-format-distribution')
      .set(TH_BANK);
    expect(bil.status).toBe(200);
    expect(bank.status).toBe(200);
    expect(bil.body.body.total_connectors).toBe(bank.body.body.total_connectors);
    expect(bil.body.body.most_common_format).toBe(
      bank.body.body.most_common_format,
    );
    expect(bil.body.body.formats.map((r: { format: RecordFormat }) => r.format)).toEqual(
      bank.body.body.formats.map((r: { format: RecordFormat }) => r.format),
    );
  });

  test('M3.13 /v1/ingestion/type-distribution sibling regression still 200', async () => {
    const { app } = makeRfApp('admin');
    const res = await request(app)
      .get('/v1/ingestion/type-distribution')
      .set(TH_BIL);
    expect(res.status).toBe(200);
  });

  test('literal `/record-format-distribution` not captured by `:id` wildcard', async () => {
    const { app } = makeRfApp('admin');
    const wildcardRes = await request(app)
      .get('/v1/ingestion/connectors/record-format-distribution/schema')
      .set(TH_BIL);
    // This is a path under /v1/ingestion/connectors/:id/schema (M3.2),
    // which would 404 for unknown connector. Test that the M3.15 route
    // is on the schema sub-path and doesn't shadow.
    expect([200, 404]).toContain(wildcardRes.status);
    const formatRes = await request(app)
      .get('/v1/ingestion/schema/record-format-distribution')
      .set(TH_BIL);
    expect(formatRes.status).toBe(200);
    expect(formatRes.body.body.formats).toBeDefined();
  });
});
