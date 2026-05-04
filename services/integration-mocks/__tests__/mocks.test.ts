import request from 'supertest';
import { buildServer } from '../src/server';

// Disable chaos for deterministic timing in unit tests; assertions for the
// chaos middleware itself live in chaos.test.ts.
process.env.MOCK_CHAOS_DISABLED = '1';

describe('integration-mocks — /healthz', () => {
  test('returns ok with all four upstream profiles', async () => {
    const app = buildServer();
    const res = await request(app).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(Object.keys(res.body.upstreams).sort()).toEqual(['aml', 'cbs', 'collection', 'ifrs9']);
  });
});

describe('integration-mocks — CBS', () => {
  test('GET /cbs/customers/:id returns a customer envelope', async () => {
    const app = buildServer();
    const res = await request(app).get('/cbs/customers/c-1042');
    expect(res.status).toBe(200);
    expect(res.body.customer_id).toBe('c-1042');
    expect(res.body.full_name).toBeTruthy();
    expect(['retail', 'sme', 'corporate']).toContain(res.body.segment);
  });

  test('GET /cbs/loans/:id returns a loan envelope', async () => {
    const app = buildServer();
    const res = await request(app).get('/cbs/loans/l-10042');
    expect(res.status).toBe(200);
    expect(res.body.loan_id).toBe('l-10042');
    expect(res.body.principal_kes).toBeGreaterThan(0);
    expect(['mortgage', 'auto', 'personal', 'sme']).toContain(res.body.product);
  });

  test('GET /cbs/loans paginates with status filter', async () => {
    const app = buildServer();
    const res = await request(app).get('/cbs/loans?status=ACTIVE&page=1&page_size=20');
    expect(res.status).toBe(200);
    expect(res.body.page).toBe(1);
    expect(res.body.page_size).toBe(20);
    expect(Array.isArray(res.body.items)).toBe(true);
    for (const it of res.body.items) expect(it.status).toBe('ACTIVE');
  });

  test('POST /cbs/replay 400 without from/to', async () => {
    const app = buildServer();
    const res = await request(app).post('/cbs/replay').send({});
    expect(res.status).toBe(400);
  });

  test('POST /cbs/replay 202 with a job_id', async () => {
    const app = buildServer();
    const res = await request(app)
      .post('/cbs/replay')
      .send({ from: '2026-01-01T00:00:00Z', to: '2026-01-02T00:00:00Z' });
    expect(res.status).toBe(202);
    expect(res.body.job_id).toMatch(/^replay-/);
    expect(res.body.status).toBe('queued');
  });
});

describe('integration-mocks — AML', () => {
  test('POST /aml/inbound 202 with flag_id', async () => {
    const app = buildServer();
    const res = await request(app)
      .post('/aml/inbound')
      .send({ customer_id: 'c-1100', transaction_id: 't-9001' });
    expect(res.status).toBe(202);
    expect(res.body.flag_id).toMatch(/^aml-/);
    expect(['structuring', 'velocity_spike', 'high_risk_geo', 'pep_match']).toContain(
      res.body.reason_code,
    );
  });

  test('POST /aml/inbound 400 on missing fields', async () => {
    const app = buildServer();
    const res = await request(app).post('/aml/inbound').send({});
    expect(res.status).toBe(400);
  });

  test('GET /aml/outbound returns a list of verdicts', async () => {
    const app = buildServer();
    const res = await request(app).get('/aml/outbound?limit=10');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.items)).toBe(true);
    expect(res.body.items.length).toBeLessThanOrEqual(10);
    for (const v of res.body.items) {
      expect(['cleared', 'sar_filed', 'monitor', 'frozen']).toContain(v.decision);
    }
  });
});

describe('integration-mocks — IFRS9', () => {
  test('GET /ifrs9/stages/:id returns a stage row', async () => {
    const app = buildServer();
    const res = await request(app).get('/ifrs9/stages/c-1042');
    expect(res.status).toBe(200);
    expect(res.body.customer_id).toBe('c-1042');
    expect([1, 2, 3]).toContain(res.body.current_stage);
  });

  test('POST /ifrs9/inputs computes ECL = EAD * PD * LGD', async () => {
    const app = buildServer();
    const res = await request(app).post('/ifrs9/inputs').send({
      customer_id: 'c-1100',
      loan_id: 'l-10100',
      pd: 0.1,
      lgd: 0.5,
      ead_kes: 1_000_000,
    });
    expect(res.status).toBe(202);
    expect(res.body.ecl_kes).toBe(50_000);
    expect(res.body.horizon_months).toBe(12);
  });

  test('POST /ifrs9/inputs 400 on out-of-range pd', async () => {
    const app = buildServer();
    const res = await request(app)
      .post('/ifrs9/inputs')
      .send({ customer_id: 'c-1', loan_id: 'l-1', pd: 1.5, lgd: 0.5, ead_kes: 1000 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/pd/);
  });
});

describe('integration-mocks — Collection', () => {
  test('POST /collection/cases routes critical to high-touch queue', async () => {
    const app = buildServer();
    const res = await request(app).post('/collection/cases').send({
      case_id: 'case-9001',
      customer_id: 'c-1100',
      severity: 'critical',
      reason: 'auto-routed from EWS',
    });
    expect(res.status).toBe(202);
    expect(res.body.assigned_queue).toBe('high-touch');
    expect(res.body.assigned_team).toBe('collections-priority');
  });

  test('POST /collection/cases routes low to standard queue', async () => {
    const app = buildServer();
    const res = await request(app).post('/collection/cases').send({
      case_id: 'case-9002',
      customer_id: 'c-1101',
      severity: 'low',
      reason: 'auto-routed',
    });
    expect(res.status).toBe(202);
    expect(res.body.assigned_queue).toBe('standard');
  });

  test('POST /ews/collection/callback 202', async () => {
    const app = buildServer();
    const res = await request(app)
      .post('/ews/collection/callback')
      .send({
        case_id: 'case-9001',
        outcome: 'cured',
        closed_at: '2026-04-28T12:00:00Z',
      });
    expect(res.status).toBe(202);
    expect(res.body.forwarded_to).toBe('apex.collection-adapter');
  });

  test('POST /collection/cases 400 on missing fields', async () => {
    const app = buildServer();
    const res = await request(app).post('/collection/cases').send({});
    expect(res.status).toBe(400);
  });
});
