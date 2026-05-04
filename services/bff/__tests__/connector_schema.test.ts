// services/bff/__tests__/connector_schema.test.ts
//
// T6 M3.2 — Connector schema metadata.

import request from 'supertest';
import {
  ConnectorSchemaError,
  assertSchemaCoverage,
  getConnectorSchema,
  listSchemaConnectorIds,
  validateRecord,
  type ValidationResult,
} from '../src/connector_schema';
import { SEED_CONNECTORS } from '../src/ingestion';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-04T12:00:00.000Z');
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

// ─── Coverage / catalogue ─────────────────────────────────────────────

describe('connector schema catalogue', () => {
  test('every M3.1 seed connector has a schema', () => {
    expect(() => assertSchemaCoverage(SEED_CONNECTORS)).not.toThrow();
  });

  test('listSchemaConnectorIds returns all 8', () => {
    const ids = listSchemaConnectorIds().sort();
    expect(ids).toEqual(SEED_CONNECTORS.map((s) => s.id).sort());
  });

  test('every schema declares required header fields', () => {
    for (const id of listSchemaConnectorIds()) {
      const s = getConnectorSchema(id)!;
      expect(s.connector_id).toBe(id);
      expect(s.version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(s.fields.length).toBeGreaterThan(0);
      expect(s.primary_key.length).toBeGreaterThan(0);
      // primary_key fields must be in fields[]
      const fieldNames = new Set(s.fields.map((f) => f.name));
      for (const pk of s.primary_key) {
        expect(fieldNames.has(pk)).toBe(true);
      }
      // primary_key fields must be required
      for (const pk of s.primary_key) {
        const f = s.fields.find((x) => x.name === pk)!;
        expect(f.required).toBe(true);
      }
    }
  });

  test('every enum field carries enum_values', () => {
    for (const id of listSchemaConnectorIds()) {
      const s = getConnectorSchema(id)!;
      for (const f of s.fields) {
        if (f.type === 'enum') {
          expect(Array.isArray(f.enum_values)).toBe(true);
          expect(f.enum_values!.length).toBeGreaterThan(0);
        }
      }
    }
  });

  test('getConnectorSchema returns null on unknown id', () => {
    expect(getConnectorSchema('NO-SUCH')).toBeNull();
  });
});

// ─── validateRecord ───────────────────────────────────────────────────

describe('validateRecord', () => {
  test('happy path — valid CBS record', () => {
    const r = validateRecord('cbs_loan_book', {
      customer_id: 'CUST-100123',
      account_id: 'LN-9001234',
      product_type: 'home_loan',
      outstanding_balance: 1250000,
      dpd: 0,
      sanctioned_amount: 1500000,
      disbursed_at: '2024-08-12T09:30:00Z',
      status: 'standard',
    });
    expect(r.valid).toBe(true);
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
    expect(r.connector_id).toBe('cbs_loan_book');
  });

  test('missing required field → error[required]', () => {
    const r = validateRecord('cbs_loan_book', {
      account_id: 'LN-9001234',
      product_type: 'home_loan',
      outstanding_balance: 1250000,
      dpd: 0,
      sanctioned_amount: 1500000,
      disbursed_at: '2024-08-12T09:30:00Z',
      status: 'standard',
    });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.field === 'customer_id' && e.code === 'required')).toBe(true);
  });

  test('null treated as missing (required → error)', () => {
    const r = validateRecord('cbs_loan_book', {
      customer_id: null,
      account_id: 'LN-9001234',
      product_type: 'home_loan',
      outstanding_balance: 1250000,
      dpd: 0,
      sanctioned_amount: 1500000,
      disbursed_at: '2024-08-12T09:30:00Z',
      status: 'standard',
    });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.field === 'customer_id' && e.code === 'required')).toBe(true);
  });

  test('blank string treated as missing for required field', () => {
    const r = validateRecord('cbs_loan_book', {
      customer_id: '   ',
      account_id: 'LN-9001234',
      product_type: 'home_loan',
      outstanding_balance: 1250000,
      dpd: 0,
      sanctioned_amount: 1500000,
      disbursed_at: '2024-08-12T09:30:00Z',
      status: 'standard',
    });
    expect(r.errors.some((e) => e.field === 'customer_id' && e.code === 'required')).toBe(true);
  });

  test('missing optional field passes', () => {
    const r = validateRecord('cbs_loan_book', {
      customer_id: 'CUST-100123',
      account_id: 'LN-9001234',
      product_type: 'home_loan',
      outstanding_balance: 1250000,
      dpd: 0,
      sanctioned_amount: 1500000,
      disbursed_at: '2024-08-12T09:30:00Z',
      status: 'standard',
      // interest_rate, last_payment_at omitted
    });
    expect(r.valid).toBe(true);
  });

  test('wrong type — string where number expected', () => {
    const r = validateRecord('cbs_loan_book', {
      customer_id: 'CUST-100123',
      account_id: 'LN-9001234',
      product_type: 'home_loan',
      outstanding_balance: '1250000',
      dpd: 0,
      sanctioned_amount: 1500000,
      disbursed_at: '2024-08-12T09:30:00Z',
      status: 'standard',
    });
    expect(r.errors.some((e) => e.field === 'outstanding_balance' && e.code === 'wrong_type')).toBe(true);
  });

  test('non-integer rejected for integer field', () => {
    const r = validateRecord('cbs_loan_book', {
      customer_id: 'CUST-100123',
      account_id: 'LN-9001234',
      product_type: 'home_loan',
      outstanding_balance: 1250000,
      dpd: 1.5,
      sanctioned_amount: 1500000,
      disbursed_at: '2024-08-12T09:30:00Z',
      status: 'standard',
    });
    expect(r.errors.some((e) => e.field === 'dpd' && e.code === 'wrong_type')).toBe(true);
  });

  test('NaN/Infinity rejected', () => {
    const r = validateRecord('cbs_loan_book', {
      customer_id: 'CUST-100123',
      account_id: 'LN-9001234',
      product_type: 'home_loan',
      outstanding_balance: Number.POSITIVE_INFINITY,
      dpd: 0,
      sanctioned_amount: 1500000,
      disbursed_at: '2024-08-12T09:30:00Z',
      status: 'standard',
    });
    expect(r.errors.some((e) => e.field === 'outstanding_balance' && e.code === 'wrong_type')).toBe(true);
  });

  test('enum violation', () => {
    const r = validateRecord('cbs_loan_book', {
      customer_id: 'CUST-100123',
      account_id: 'LN-9001234',
      product_type: 'crypto_loan',
      outstanding_balance: 1250000,
      dpd: 0,
      sanctioned_amount: 1500000,
      disbursed_at: '2024-08-12T09:30:00Z',
      status: 'standard',
    });
    expect(r.errors.some((e) => e.field === 'product_type' && e.code === 'enum_violation')).toBe(true);
  });

  test('out_of_range — below min', () => {
    const r = validateRecord('cbs_loan_book', {
      customer_id: 'CUST-100123',
      account_id: 'LN-9001234',
      product_type: 'home_loan',
      outstanding_balance: -10,
      dpd: 0,
      sanctioned_amount: 1500000,
      disbursed_at: '2024-08-12T09:30:00Z',
      status: 'standard',
    });
    expect(r.errors.some((e) => e.field === 'outstanding_balance' && e.code === 'out_of_range')).toBe(true);
  });

  test('out_of_range — above max', () => {
    const r = validateRecord('bureau_pull', {
      customer_id: 'CUST-100123',
      bureau_name: 'CIBIL',
      score: 1200,
      dpd_max_24m: 15,
      enquiries_6m: 2,
      pulled_at: '2026-04-30T01:00:00Z',
    });
    expect(r.errors.some((e) => e.field === 'score' && e.code === 'out_of_range')).toBe(true);
  });

  test('too_long — string over max_length', () => {
    const r = validateRecord('cbs_loan_book', {
      customer_id: 'C'.repeat(33),
      account_id: 'LN-9001234',
      product_type: 'home_loan',
      outstanding_balance: 1250000,
      dpd: 0,
      sanctioned_amount: 1500000,
      disbursed_at: '2024-08-12T09:30:00Z',
      status: 'standard',
    });
    expect(r.errors.some((e) => e.field === 'customer_id' && e.code === 'too_long')).toBe(true);
  });

  test('date format YYYY-MM-DD enforced', () => {
    const r = validateRecord('core_insurance_policies', {
      policy_id: 'POL-BIL-200001',
      customer_id: 'CUST-100123',
      product: 'term_life',
      sum_assured: 5000000,
      premium: 24500,
      start_date: '15-01-2024', // wrong format
      end_date: '2034-01-15',
      status: 'active',
    });
    expect(r.errors.some((e) => e.field === 'start_date' && e.code === 'wrong_type')).toBe(true);
  });

  test('datetime format ISO-8601 enforced', () => {
    const r = validateRecord('cbs_loan_book', {
      customer_id: 'CUST-100123',
      account_id: 'LN-9001234',
      product_type: 'home_loan',
      outstanding_balance: 1250000,
      dpd: 0,
      sanctioned_amount: 1500000,
      disbursed_at: '2024-08-12 09:30:00', // missing T + tz
      status: 'standard',
    });
    expect(r.errors.some((e) => e.field === 'disbursed_at' && e.code === 'wrong_type')).toBe(true);
  });

  test('unknown_field reported as warning, not error (still valid)', () => {
    const r = validateRecord('cbs_loan_book', {
      customer_id: 'CUST-100123',
      account_id: 'LN-9001234',
      product_type: 'home_loan',
      outstanding_balance: 1250000,
      dpd: 0,
      sanctioned_amount: 1500000,
      disbursed_at: '2024-08-12T09:30:00Z',
      status: 'standard',
      mystery_field: 'oops',
    });
    expect(r.valid).toBe(true);
    expect(r.warnings.some((w) => w.field === 'mystery_field' && w.code === 'unknown_field')).toBe(true);
  });

  test('multiple errors aggregated, not short-circuited', () => {
    const r = validateRecord('cbs_loan_book', {
      // missing customer_id, account_id; bad enum; out-of-range
      product_type: 'crypto',
      outstanding_balance: -1,
      dpd: 0,
      sanctioned_amount: 1500000,
      disbursed_at: '2024-08-12T09:30:00Z',
      status: 'standard',
    });
    expect(r.valid).toBe(false);
    expect(r.errors.length).toBeGreaterThanOrEqual(3);
  });

  test('boolean fields not used in BIL schemas — but type check exists', () => {
    // Sanity: walk every schema, confirm no boolean field has been
    // incidentally added without test coverage.
    for (const id of listSchemaConnectorIds()) {
      const s = getConnectorSchema(id)!;
      const hasBool = s.fields.some((f) => f.type === 'boolean');
      expect(hasBool).toBe(false);
    }
  });

  test('throws unknown_connector for unregistered id', () => {
    expect(() => validateRecord('NO-SUCH', {})).toThrow(ConnectorSchemaError);
    try {
      validateRecord('NO-SUCH', {});
    } catch (e) {
      expect((e as ConnectorSchemaError).code).toBe('unknown_connector');
    }
  });

  test('throws invalid_input for non-object record', () => {
    try {
      validateRecord('cbs_loan_book', 'not an object' as unknown);
      fail('expected throw');
    } catch (e) {
      expect((e as ConnectorSchemaError).code).toBe('invalid_input');
    }
    try {
      validateRecord('cbs_loan_book', [] as unknown);
      fail('expected throw');
    } catch (e) {
      expect((e as ConnectorSchemaError).code).toBe('invalid_input');
    }
  });

  test('happy path covers all 8 connectors', () => {
    const samples: Record<string, Record<string, unknown>> = {
      cbs_loan_book: {
        customer_id: 'CUST-100123', account_id: 'LN-9001234', product_type: 'home_loan',
        outstanding_balance: 1250000, dpd: 0, sanctioned_amount: 1500000,
        disbursed_at: '2024-08-12T09:30:00Z', status: 'standard',
      },
      core_insurance_policies: {
        policy_id: 'POL-BIL-200001', customer_id: 'CUST-100123', product: 'term_life',
        sum_assured: 5000000, premium: 24500, start_date: '2024-01-15',
        end_date: '2034-01-15', status: 'active',
      },
      policy_master_increment: {
        policy_id: 'POL-BIL-200001', change_type: 'premium_paid',
        change_at: '2026-05-04T08:15:00Z', customer_id: 'CUST-100123',
      },
      claims_feed: {
        claim_id: 'CLM-BIL-700001', policy_id: 'POL-BIL-200001', customer_id: 'CUST-100123',
        claim_amount: 125000, claim_type: 'illness', filed_at: '2026-05-01T11:20:00Z',
        status: 'submitted',
      },
      agent_productivity: {
        agent_id: 'AGT-001234', branch_code: 'BR-MUM-007', period_month: '2026-04-01',
        policies_sold: 12, persistency_rate: 0.82,
      },
      aml_watchlist: {
        list_id: 'OFAC-SDN-12345', list_type: 'sanctions', entity_name: 'John Doe',
        entity_type: 'individual', date_added: '2026-04-22',
      },
      bureau_pull: {
        customer_id: 'CUST-100123', bureau_name: 'CIBIL', score: 780,
        dpd_max_24m: 15, enquiries_6m: 2, pulled_at: '2026-04-30T01:00:00Z',
      },
      ifrs9_stage_feed: {
        customer_id: 'CUST-100123', stage: 1, pd: 0.012, lgd: 0.45,
        ead: 1250000, ecl: 6750, snapshot_date: '2026-04-30',
      },
    };
    for (const [id, rec] of Object.entries(samples)) {
      const r = validateRecord(id, rec);
      expect(r.valid).toBe(true);
      expect(r.errors).toEqual([]);
    }
  });
});

// ─── Routes ───────────────────────────────────────────────────────────

describe('GET /v1/ingestion/connectors/:id/schema', () => {
  test('admin: 200 with schema body', async () => {
    const { app } = makeCsApp('admin');
    const r = await request(app).get('/v1/ingestion/connectors/cbs_loan_book/schema').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.connector_id).toBe('cbs_loan_book');
    expect(r.body.body.fields.length).toBeGreaterThan(0);
  });

  test('risk_analyst → 403 (audit:read is admin-only, matches M3.1 read routes)', async () => {
    const { app } = makeCsApp('risk_analyst');
    const r = await request(app).get('/v1/ingestion/connectors/cbs_loan_book/schema').set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('all 8 connectors return 200', async () => {
    const { app } = makeCsApp('admin');
    for (const s of SEED_CONNECTORS) {
      const r = await request(app).get(`/v1/ingestion/connectors/${s.id}/schema`).set(TH_BIL);
      expect(r.status).toBe(200);
      expect(r.body.body.connector_id).toBe(s.id);
    }
  });

  test('unknown connector → 404 EWS_404_unknown_connector', async () => {
    const { app } = makeCsApp('admin');
    const r = await request(app).get('/v1/ingestion/connectors/NO-SUCH/schema').set(TH_BIL);
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('EWS_404_unknown_connector');
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeCsApp('case_owner');
    const r = await request(app).get('/v1/ingestion/connectors/cbs_loan_book/schema').set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('missing tenant header → 400', async () => {
    const { app } = makeCsApp('admin');
    const r = await request(app).get('/v1/ingestion/connectors/cbs_loan_book/schema');
    expect([400, 401, 403]).toContain(r.status);
  });
});

describe('POST /v1/ingestion/connectors/:id/schema/validate', () => {
  test('valid record → 200, valid:true', async () => {
    const { app } = makeCsApp('admin');
    const r = await request(app)
      .post('/v1/ingestion/connectors/cbs_loan_book/schema/validate')
      .set(TH_BIL)
      .send({
        record: {
          customer_id: 'CUST-100123',
          account_id: 'LN-9001234',
          product_type: 'home_loan',
          outstanding_balance: 1250000,
          dpd: 0,
          sanctioned_amount: 1500000,
          disbursed_at: '2024-08-12T09:30:00Z',
          status: 'standard',
        },
      });
    expect(r.status).toBe(200);
    const result = r.body.body as ValidationResult;
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  test('accepts enveloped body', async () => {
    const { app } = makeCsApp('admin');
    const r = await request(app)
      .post('/v1/ingestion/connectors/ifrs9_stage_feed/schema/validate')
      .set(TH_BIL)
      .send({
        header: { requestId: 'r-1' },
        body: {
          record: {
            customer_id: 'CUST-100123', stage: 1, pd: 0.012, lgd: 0.45,
            ead: 1250000, ecl: 6750, snapshot_date: '2026-04-30',
          },
        },
      });
    expect(r.status).toBe(200);
    expect(r.body.body.valid).toBe(true);
  });

  test('invalid record → 200, valid:false with errors[]', async () => {
    const { app } = makeCsApp('admin');
    const r = await request(app)
      .post('/v1/ingestion/connectors/cbs_loan_book/schema/validate')
      .set(TH_BIL)
      .send({ record: { customer_id: 'X', account_id: 'Y' } }); // most fields missing
    expect(r.status).toBe(200);
    expect(r.body.body.valid).toBe(false);
    expect(r.body.body.errors.length).toBeGreaterThan(0);
  });

  test('unknown_field → warning, valid still true', async () => {
    const { app } = makeCsApp('admin');
    const r = await request(app)
      .post('/v1/ingestion/connectors/aml_watchlist/schema/validate')
      .set(TH_BIL)
      .send({
        record: {
          list_id: 'OFAC-1', list_type: 'sanctions', entity_name: 'John',
          entity_type: 'individual', date_added: '2026-04-22',
          extra_thing: 'oops',
        },
      });
    expect(r.status).toBe(200);
    expect(r.body.body.valid).toBe(true);
    expect(r.body.body.warnings[0].field).toBe('extra_thing');
  });

  test('unknown connector → 404', async () => {
    const { app } = makeCsApp('admin');
    const r = await request(app)
      .post('/v1/ingestion/connectors/NO-SUCH/schema/validate')
      .set(TH_BIL)
      .send({ record: {} });
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('EWS_404_unknown_connector');
  });

  test('non-object record → 400 EWS_400_invalid_input', async () => {
    const { app } = makeCsApp('admin');
    const r = await request(app)
      .post('/v1/ingestion/connectors/cbs_loan_book/schema/validate')
      .set(TH_BIL)
      .send({ record: 'not-an-object' });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_input');
  });

  test('array record → 400 EWS_400_invalid_input', async () => {
    const { app } = makeCsApp('admin');
    const r = await request(app)
      .post('/v1/ingestion/connectors/cbs_loan_book/schema/validate')
      .set(TH_BIL)
      .send({ record: [] });
    expect(r.status).toBe(400);
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeCsApp('case_owner');
    const r = await request(app)
      .post('/v1/ingestion/connectors/cbs_loan_book/schema/validate')
      .set(TH_BIL)
      .send({ record: {} });
    expect(r.status).toBe(403);
  });
});

// ─── No-regression ────────────────────────────────────────────────────

describe('No-regression: M3.1 ingestion routes still work', () => {
  test('GET /v1/ingestion/connectors still 200', async () => {
    const { app } = makeCsApp('admin');
    const r = await request(app).get('/v1/ingestion/connectors').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total).toBe(8);
  });

  test('GET /v1/ingestion/connectors/:id still 200 (not shadowed by /schema)', async () => {
    const { app } = makeCsApp('admin');
    const r = await request(app).get('/v1/ingestion/connectors/cbs_loan_book').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.id).toBe('cbs_loan_book');
  });

  test('GET /v1/ingestion/connectors/:id/runs still 200', async () => {
    const { app } = makeCsApp('admin');
    const r = await request(app).get('/v1/ingestion/connectors/cbs_loan_book/runs').set(TH_BIL);
    expect(r.status).toBe(200);
  });

  test('GET /v1/ingestion/health still 200', async () => {
    const { app } = makeCsApp('admin');
    const r = await request(app).get('/v1/ingestion/health').set(TH_BIL);
    expect(r.status).toBe(200);
  });
});
