// services/bff/__tests__/connector_schema_required_matrix.test.ts
//
// T6 M3.14 — Connector schema field-type × required cross-tab matrix.

import request from 'supertest';
import {
  buildConnectorSchemaRequiredMatrix,
  ALL_REQUIRED_COLUMNS,
} from '../src/connector_schema_required_matrix';
import {
  listSchemaConnectorIds,
  getConnectorSchema,
} from '../src/connector_schema';
import { ALL_FIELD_TYPES } from '../src/connector_schema_type_matrix';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-17T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function makeRmApp(role: string = 'admin') {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
  });
}

// Compute manual totals from the actual catalog for cross-checks.
function manualTotals() {
  let total_fields = 0;
  const byTypeRequired: Record<string, number> = {};
  const byTypeOptional: Record<string, number> = {};
  for (const t of ALL_FIELD_TYPES) {
    byTypeRequired[t] = 0;
    byTypeOptional[t] = 0;
  }
  for (const cid of listSchemaConnectorIds()) {
    const schema = getConnectorSchema(cid)!;
    for (const f of schema.fields) {
      total_fields++;
      if (f.required) byTypeRequired[f.type]++;
      else byTypeOptional[f.type]++;
    }
  }
  return { total_fields, byTypeRequired, byTypeOptional };
}

// ─── buildConnectorSchemaRequiredMatrix — pure ───────────────────────

describe('M3.14 — basic shape', () => {
  test('envelope has every expected field', () => {
    const m = buildConnectorSchemaRequiredMatrix(NOW);
    expect(m.generated_at).toBe(NOW.toISOString());
    expect(m.total_connectors).toBe(listSchemaConnectorIds().length);
    expect(m.total_types).toBe(ALL_FIELD_TYPES.length);
    expect(m.rows.length).toBe(ALL_FIELD_TYPES.length);
    expect(m.columns.length).toBe(2);
    expect(m.total_fields).toBeGreaterThan(0);
  });
});

describe('M3.14 — rows in canonical type order', () => {
  test('rows[] follows ALL_FIELD_TYPES', () => {
    const m = buildConnectorSchemaRequiredMatrix(NOW);
    expect(m.rows.map((r) => r.type)).toEqual([...ALL_FIELD_TYPES]);
  });
});

describe('M3.14 — columns required-then-optional', () => {
  test('columns[].required_column = [required, optional]', () => {
    const m = buildConnectorSchemaRequiredMatrix(NOW);
    expect(m.columns.map((c) => c.required_column)).toEqual([...ALL_REQUIRED_COLUMNS]);
  });
});

describe('M3.14 — total_fields matches manual count', () => {
  test('Σ fields across catalog = total_fields', () => {
    const m = buildConnectorSchemaRequiredMatrix(NOW);
    const manual = manualTotals();
    expect(m.total_fields).toBe(manual.total_fields);
  });
});

describe('M3.14 — per-row totals match manual', () => {
  test('required_count + optional_count match manual scan', () => {
    const m = buildConnectorSchemaRequiredMatrix(NOW);
    const manual = manualTotals();
    for (const row of m.rows) {
      expect(row.required_count).toBe(manual.byTypeRequired[row.type]);
      expect(row.optional_count).toBe(manual.byTypeOptional[row.type]);
    }
  });
});

describe('M3.14 — per-row partition invariant', () => {
  test('required + optional = row.total per row', () => {
    const m = buildConnectorSchemaRequiredMatrix(NOW);
    for (const row of m.rows) {
      expect(row.required_count + row.optional_count).toBe(row.total);
    }
  });
});

describe('M3.14 — per-column total = Σ by_type', () => {
  test('col.total = Σ values in by_type', () => {
    const m = buildConnectorSchemaRequiredMatrix(NOW);
    for (const col of m.columns) {
      const sum = Object.values(col.by_type).reduce((a, b) => a + b, 0);
      expect(col.total).toBe(sum);
    }
  });
});

describe('M3.14 — grand-total cross-check', () => {
  test('Σ rows.total = Σ cols.total = total_fields', () => {
    const m = buildConnectorSchemaRequiredMatrix(NOW);
    const rowSum = m.rows.reduce((acc, r) => acc + r.total, 0);
    const colSum = m.columns.reduce((acc, c) => acc + c.total, 0);
    expect(rowSum).toBe(m.total_fields);
    expect(colSum).toBe(m.total_fields);
  });
});

describe('M3.14 — every-type-key-present per column', () => {
  test('col.by_type has every FieldType key', () => {
    const m = buildConnectorSchemaRequiredMatrix(NOW);
    for (const col of m.columns) {
      for (const t of ALL_FIELD_TYPES) {
        expect(col.by_type).toHaveProperty(t);
        expect(typeof col.by_type[t]).toBe('number');
      }
    }
  });
});

describe('M3.14 — cell cross-check invariant', () => {
  test('row.required_count === columns[required].by_type[type]', () => {
    const m = buildConnectorSchemaRequiredMatrix(NOW);
    const requiredCol = m.columns.find((c) => c.required_column === 'required')!;
    const optionalCol = m.columns.find((c) => c.required_column === 'optional')!;
    for (const row of m.rows) {
      expect(row.required_count).toBe(requiredCol.by_type[row.type]);
      expect(row.optional_count).toBe(optionalCol.by_type[row.type]);
    }
  });
});

describe('M3.14 — required_ratio formula', () => {
  test('= required_count / total for non-zero total; 0 for zero total', () => {
    const m = buildConnectorSchemaRequiredMatrix(NOW);
    for (const row of m.rows) {
      if (row.total > 0) {
        expect(row.required_ratio).toBeCloseTo(row.required_count / row.total);
      } else {
        expect(row.required_ratio).toBe(0);
      }
    }
  });

  test('required_ratio bounded in [0, 1]', () => {
    const m = buildConnectorSchemaRequiredMatrix(NOW);
    for (const row of m.rows) {
      expect(row.required_ratio).toBeGreaterThanOrEqual(0);
      expect(row.required_ratio).toBeLessThanOrEqual(1);
    }
  });
});

describe('M3.14 — peak_cell formula', () => {
  test('peak_cell.count equals max across all cells', () => {
    const m = buildConnectorSchemaRequiredMatrix(NOW);
    let maxSeen = 0;
    for (const row of m.rows) {
      if (row.required_count > maxSeen) maxSeen = row.required_count;
      if (row.optional_count > maxSeen) maxSeen = row.optional_count;
    }
    expect(m.peak_cell!.count).toBe(maxSeen);
  });

  test('peak_cell.samples are sorted and cap at 5', () => {
    const m = buildConnectorSchemaRequiredMatrix(NOW);
    const samples = m.peak_cell!.samples;
    expect(samples.length).toBeLessThanOrEqual(5);
    for (let i = 1; i < samples.length; i++) {
      const prev = samples[i - 1]!;
      const curr = samples[i]!;
      if (prev.connector_id !== curr.connector_id) {
        expect(prev.connector_id.localeCompare(curr.connector_id)).toBeLessThan(0);
      } else {
        expect(prev.field_name.localeCompare(curr.field_name)).toBeLessThan(0);
      }
    }
  });

  test('peak_cell.samples carry valid (connector_id, field_name) pairs', () => {
    const m = buildConnectorSchemaRequiredMatrix(NOW);
    for (const s of m.peak_cell!.samples) {
      const schema = getConnectorSchema(s.connector_id);
      expect(schema).not.toBeNull();
      const field = schema!.fields.find((f) => f.name === s.field_name);
      expect(field).toBeDefined();
      expect(field!.type).toBe(m.peak_cell!.type);
      expect(field!.required).toBe(m.peak_cell!.required_column === 'required');
    }
  });
});

describe('M3.14 — empty_cells', () => {
  test('each empty_cell has count=0 on both axes', () => {
    const m = buildConnectorSchemaRequiredMatrix(NOW);
    for (const ec of m.empty_cells) {
      const row = m.rows.find((r) => r.type === ec.type)!;
      if (ec.required_column === 'required') {
        expect(row.required_count).toBe(0);
      } else {
        expect(row.optional_count).toBe(0);
      }
    }
  });

  test('canonical row-major order (type asc index, then required before optional)', () => {
    const m = buildConnectorSchemaRequiredMatrix(NOW);
    for (let i = 1; i < m.empty_cells.length; i++) {
      const prev = m.empty_cells[i - 1]!;
      const curr = m.empty_cells[i]!;
      const prevTIdx = ALL_FIELD_TYPES.indexOf(prev.type);
      const currTIdx = ALL_FIELD_TYPES.indexOf(curr.type);
      if (prevTIdx !== currTIdx) {
        expect(currTIdx).toBeGreaterThan(prevTIdx);
      } else {
        const prevCIdx = ALL_REQUIRED_COLUMNS.indexOf(prev.required_column);
        const currCIdx = ALL_REQUIRED_COLUMNS.indexOf(curr.required_column);
        expect(currCIdx).toBeGreaterThan(prevCIdx);
      }
    }
  });

  test('partition: empty + non_empty = 14 (7 types × 2 required-cols)', () => {
    const m = buildConnectorSchemaRequiredMatrix(NOW);
    const total_cells = ALL_FIELD_TYPES.length * ALL_REQUIRED_COLUMNS.length;
    let non_empty = 0;
    for (const row of m.rows) {
      if (row.required_count > 0) non_empty++;
      if (row.optional_count > 0) non_empty++;
    }
    expect(m.empty_cells.length + non_empty).toBe(total_cells);
  });
});

describe('M3.14 — strictest_type + loosest_type', () => {
  test('strictest_type has the highest required_ratio (no other has strictly more)', () => {
    const m = buildConnectorSchemaRequiredMatrix(NOW);
    expect(m.strictest_type).not.toBeNull();
    const target = m.rows.find((r) => r.type === m.strictest_type!.type)!;
    expect(m.strictest_type!.required_ratio).toBe(target.required_ratio);
    for (const row of m.rows) {
      if (row.total === 0) continue;
      expect(row.required_ratio).toBeLessThanOrEqual(target.required_ratio);
    }
  });

  test('loosest_type has the lowest required_ratio (no other has strictly less)', () => {
    const m = buildConnectorSchemaRequiredMatrix(NOW);
    expect(m.loosest_type).not.toBeNull();
    const target = m.rows.find((r) => r.type === m.loosest_type!.type)!;
    expect(m.loosest_type!.required_ratio).toBe(target.required_ratio);
    for (const row of m.rows) {
      if (row.total === 0) continue;
      expect(row.required_ratio).toBeGreaterThanOrEqual(target.required_ratio);
    }
  });
});

describe('M3.14 — platform-static', () => {
  test('different now → same matrix data', () => {
    const a = buildConnectorSchemaRequiredMatrix(new Date('2026-01-01T00:00:00.000Z'));
    const b = buildConnectorSchemaRequiredMatrix(new Date('2026-12-31T00:00:00.000Z'));
    expect(a.total_fields).toBe(b.total_fields);
    expect(a.rows.map((r) => r.total)).toEqual(b.rows.map((r) => r.total));
    expect(a.peak_cell).toEqual(b.peak_cell);
  });
});

// ─── GET /v1/ingestion/schema/required-matrix ────────────────────────

describe('M3.14 — GET /v1/ingestion/schema/required-matrix', () => {
  test('admin → 200 with full matrix', async () => {
    const { app } = makeRmApp('admin');
    const r = await request(app).get('/v1/ingestion/schema/required-matrix').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.rows.length).toBe(ALL_FIELD_TYPES.length);
    expect(r.body.body.columns.length).toBe(2);
    expect(r.body.body.total_fields).toBeGreaterThan(0);
  });

  test('shape contains every expected field', async () => {
    const { app } = makeRmApp('admin');
    const r = await request(app).get('/v1/ingestion/schema/required-matrix').set(TH_BIL);
    expect(r.body.body).toHaveProperty('rows');
    expect(r.body.body).toHaveProperty('columns');
    expect(r.body.body).toHaveProperty('peak_cell');
    expect(r.body.body).toHaveProperty('empty_cells');
    expect(r.body.body).toHaveProperty('strictest_type');
    expect(r.body.body).toHaveProperty('loosest_type');
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeRmApp('case_owner');
    const r = await request(app).get('/v1/ingestion/schema/required-matrix').set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('platform-static: BIL ↔ BANK_DEMO same response', async () => {
    const { app } = makeRmApp('admin');
    const bil = await request(app).get('/v1/ingestion/schema/required-matrix').set(TH_BIL);
    const bank = await request(app)
      .get('/v1/ingestion/schema/required-matrix')
      .set('X-Tenant-ID', 'BANK_DEMO')
      .set('X-Channel', 'API');
    expect(bil.body.body.total_fields).toBe(bank.body.body.total_fields);
    expect(bil.body.body.peak_cell).toEqual(bank.body.body.peak_cell);
  });

  test('literal `/required-matrix` not captured by `:id/schema` wildcard', async () => {
    const { app } = makeRmApp('admin');
    const r = await request(app).get('/v1/ingestion/schema/required-matrix').set(TH_BIL);
    expect(r.status).toBe(200);
  });

  test('M3.11 /v1/ingestion/schema/type-matrix still 200 (sibling regression)', async () => {
    const { app } = makeRmApp('admin');
    const r = await request(app).get('/v1/ingestion/schema/type-matrix').set(TH_BIL);
    expect(r.status).toBe(200);
  });

  test('M3.8 /v1/ingestion/schema/field-index still 200 (sibling regression)', async () => {
    const { app } = makeRmApp('admin');
    const r = await request(app).get('/v1/ingestion/schema/field-index').set(TH_BIL);
    expect(r.status).toBe(200);
  });
});
