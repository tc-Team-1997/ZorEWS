// services/bff/__tests__/reports_catalog.test.ts
//
// T6 M12.1 — BIL reports catalog + async job tracker.

import request from 'supertest';
import {
  InMemoryReportJobStore,
  REPORTS_CATALOG,
  ReportsError,
  getReportDef,
  isJobStatus,
  isReportCategory,
  isReportFormat,
  isReportRegulator,
  listReportDefs,
  type ReportJob,
} from '../src/reports_catalog';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-04T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };
const TH_BANK = { 'X-Tenant-ID': 'BANK_DEMO', 'X-Channel': 'API' };

function makeRptApp(role: string = 'admin', reportJobStore?: InMemoryReportJobStore) {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
    reportJobStore: reportJobStore ?? new InMemoryReportJobStore(),
  });
}

// ─── Catalog schema invariants ─────────────────────────────────────────

describe('REPORTS_CATALOG schema', () => {
  test('exactly 9 BIL reports', () => {
    expect(REPORTS_CATALOG.length).toBe(9);
  });

  test('ids unique', () => {
    const ids = REPORTS_CATALOG.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('every report declares required fields with valid types', () => {
    for (const d of REPORTS_CATALOG) {
      expect(typeof d.id).toBe('string');
      expect(typeof d.name).toBe('string');
      expect(['operational', 'regulatory', 'audit', 'business']).toContain(d.category);
      expect(['manual', 'daily', 'weekly', 'monthly', 'quarterly']).toContain(d.schedule);
      expect(['RBI', 'IRDAI', 'INTERNAL']).toContain(d.regulator);
      expect(Array.isArray(d.supported_formats)).toBe(true);
      expect(d.supported_formats.length).toBeGreaterThan(0);
      for (const f of d.supported_formats) {
        expect(['json', 'csv', 'pdf', 'xlsx']).toContain(f);
      }
    }
  });

  test('regulators include both RBI + IRDAI (BIL pitch requirement)', () => {
    const regulators = new Set(REPORTS_CATALOG.map((d) => d.regulator));
    expect(regulators.has('RBI')).toBe(true);
    expect(regulators.has('IRDAI')).toBe(true);
    expect(regulators.has('INTERNAL')).toBe(true);
  });

  test('legacy_type set on the 4 T4-shipped reports, null elsewhere', () => {
    const withLegacy = REPORTS_CATALOG.filter((d) => d.legacy_type !== null);
    const legacyTypes = new Set(withLegacy.map((d) => d.legacy_type));
    expect(legacyTypes).toEqual(new Set(['snapshot', 'alerts', 'cases', 'rbi']));
  });
});

describe('Type guards + lookup', () => {
  test('isReportFormat / isReportCategory / isReportRegulator / isJobStatus', () => {
    expect(isReportFormat('pdf')).toBe(true);
    expect(isReportFormat('docx')).toBe(false);
    expect(isReportCategory('regulatory')).toBe(true);
    expect(isReportCategory('foo')).toBe(false);
    expect(isReportRegulator('RBI')).toBe(true);
    expect(isReportRegulator('rbi')).toBe(false);
    expect(isJobStatus('queued')).toBe(true);
    expect(isJobStatus('done')).toBe(false);
  });

  test('listReportDefs filters by category', () => {
    const reg = listReportDefs({ category: 'regulatory' });
    expect(reg.length).toBe(3);
    for (const d of reg) expect(d.category).toBe('regulatory');
  });

  test('listReportDefs filters by regulator', () => {
    const irdai = listReportDefs({ regulator: 'IRDAI' });
    for (const d of irdai) expect(d.regulator).toBe('IRDAI');
    expect(irdai.length).toBe(2);
  });

  test('getReportDef returns def + null on miss', () => {
    expect(getReportDef('rbi_quarterly_summary')!.regulator).toBe('RBI');
    expect(getReportDef('no.such.report')).toBeNull();
  });
});

// ─── InMemoryReportJobStore ────────────────────────────────────────────

describe('InMemoryReportJobStore — submit', () => {
  test('valid input → completed job with download_url', () => {
    const s = new InMemoryReportJobStore();
    const j = s.submit('BIL', { report_id: 'rbi_quarterly_summary', format: 'pdf' }, 'taniya', NOW);
    expect(j.job_id).toMatch(/^rj-/);
    expect(j.status).toBe('completed');
    expect(j.download_url).toMatch(/^\/v1\/reports\/jobs\/rj-/);
    expect(j.error_message).toBeNull();
    expect(j.requested_by).toBe('taniya');
    expect(j.tenant_id).toBe('BIL');
    expect(j.parameters).toEqual({});
  });

  test('caller-supplied parameters preserved', () => {
    const s = new InMemoryReportJobStore();
    const j = s.submit(
      'BIL',
      { report_id: 'rbi_quarterly_summary', format: 'json', parameters: { period: 'Q1' } },
      'taniya',
      NOW,
    );
    expect(j.parameters).toEqual({ period: 'Q1' });
  });

  test('unknown report_id → ReportsError(unknown_report)', () => {
    const s = new InMemoryReportJobStore();
    try {
      s.submit('BIL', { report_id: 'no.such', format: 'pdf' }, 't', NOW);
      fail('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(ReportsError);
      expect((e as ReportsError).code).toBe('unknown_report');
    }
  });

  test('unsupported format → ReportsError(unsupported_format)', () => {
    const s = new InMemoryReportJobStore();
    try {
      // sla_breach_digest only supports json + csv (no pdf)
      s.submit('BIL', { report_id: 'sla_breach_digest', format: 'pdf' }, 't', NOW);
      fail('expected throw');
    } catch (e) {
      expect((e as ReportsError).code).toBe('unsupported_format');
    }
  });

  test('invalid format string → ReportsError(invalid_format)', () => {
    const s = new InMemoryReportJobStore();
    expect(() =>
      s.submit('BIL', { report_id: 'rbi_quarterly_summary', format: 'docx' as never }, 't', NOW),
    ).toThrow(/format must be one of/);
  });

  test('tenant isolation — submit in BIL not visible to BANK_DEMO list', () => {
    const s = new InMemoryReportJobStore();
    s.submit('BIL', { report_id: 'rbi_quarterly_summary', format: 'pdf' }, 't', NOW);
    expect(s.list('BIL', {}).total).toBe(1);
    expect(s.list('BANK_DEMO', {}).total).toBe(0);
  });

  test('cap evicts oldest', () => {
    const s = new InMemoryReportJobStore({ cap: 3 });
    for (let i = 0; i < 5; i++) {
      s.submit('BIL', { report_id: 'rbi_quarterly_summary', format: 'pdf' }, `u-${i}`, NOW);
    }
    const out = s.list('BIL', {});
    expect(out.total).toBe(3);
  });
});

describe('InMemoryReportJobStore — list', () => {
  function seed(s: InMemoryReportJobStore): void {
    s.submit('BIL', { report_id: 'rbi_quarterly_summary', format: 'pdf' }, 'alice', NOW);
    s.submit('BIL', { report_id: 'irdai_claims_quarterly', format: 'csv' }, 'bob', NOW);
    s.submit('BIL', { report_id: 'rbi_quarterly_summary', format: 'json' }, 'alice', NOW);
  }

  test('newest-first', () => {
    const s = new InMemoryReportJobStore();
    seed(s);
    const out = s.list('BIL', {});
    expect(out.total).toBe(3);
    // last submitted = first listed
    expect(out.items[0]!.report_id).toBe('rbi_quarterly_summary');
    expect(out.items[0]!.format).toBe('json');
  });

  test('filter by status', () => {
    const s = new InMemoryReportJobStore();
    seed(s);
    expect(s.list('BIL', { status: 'completed' }).total).toBe(3);
    expect(s.list('BIL', { status: 'failed' }).total).toBe(0);
  });

  test('filter by report_id', () => {
    const s = new InMemoryReportJobStore();
    seed(s);
    expect(s.list('BIL', { report_id: 'rbi_quarterly_summary' }).total).toBe(2);
    expect(s.list('BIL', { report_id: 'irdai_claims_quarterly' }).total).toBe(1);
  });

  test('filter by requested_by', () => {
    const s = new InMemoryReportJobStore();
    seed(s);
    expect(s.list('BIL', { requested_by: 'alice' }).total).toBe(2);
    expect(s.list('BIL', { requested_by: 'bob' }).total).toBe(1);
  });

  test('pagination disjointness', () => {
    const s = new InMemoryReportJobStore();
    seed(s);
    const p1 = s.list('BIL', { page: 1, page_size: 2 });
    const p2 = s.list('BIL', { page: 2, page_size: 2 });
    expect(p1.items.length).toBe(2);
    expect(p2.items.length).toBe(1);
    const ids1 = new Set(p1.items.map((j) => j.job_id));
    for (const j of p2.items) expect(ids1.has(j.job_id)).toBe(false);
  });

  test('page_size clamped to [1, 200]', () => {
    const s = new InMemoryReportJobStore();
    seed(s);
    expect(s.list('BIL', { page_size: 99999 }).page_size).toBe(200);
    expect(s.list('BIL', { page_size: 0 }).page_size).toBe(1);
  });
});

describe('InMemoryReportJobStore — get + markFailed', () => {
  test('get returns job; null for miss; null for wrong tenant', () => {
    const s = new InMemoryReportJobStore();
    const j = s.submit('BIL', { report_id: 'rbi_quarterly_summary', format: 'pdf' }, 't', NOW);
    expect(s.get('BIL', j.job_id)!.job_id).toBe(j.job_id);
    expect(s.get('BIL', 'nope')).toBeNull();
    expect(s.get('BANK_DEMO', j.job_id)).toBeNull();
  });

  test('markFailed flips status, clears download_url, sets error_message', () => {
    const s = new InMemoryReportJobStore();
    const j = s.submit('BIL', { report_id: 'rbi_quarterly_summary', format: 'pdf' }, 't', NOW);
    const failed = s.markFailed('BIL', j.job_id, 'computer crashed');
    expect(failed.status).toBe('failed');
    expect(failed.download_url).toBeNull();
    expect(failed.error_message).toBe('computer crashed');
    // Reflected in subsequent get
    expect(s.get('BIL', j.job_id)!.status).toBe('failed');
  });

  test('markFailed unknown_job throws', () => {
    const s = new InMemoryReportJobStore();
    expect(() => s.markFailed('BIL', 'rj-nope', 'oops')).toThrow(/unknown job_id/);
  });
});

// ─── Routes ────────────────────────────────────────────────────────────

describe('GET /v1/reports/catalog', () => {
  test('analyst+ accepted; returns all 9', async () => {
    const { app } = makeRptApp('risk_analyst');
    const r = await request(app).get('/v1/reports/catalog').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total).toBe(9);
  });

  test('?category=regulatory narrows to 3', async () => {
    const { app } = makeRptApp('admin');
    const r = await request(app).get('/v1/reports/catalog?category=regulatory').set(TH_BIL);
    expect(r.body.body.total).toBe(3);
  });

  test('?regulator=IRDAI narrows to 2', async () => {
    const { app } = makeRptApp('admin');
    const r = await request(app).get('/v1/reports/catalog?regulator=IRDAI').set(TH_BIL);
    expect(r.body.body.total).toBe(2);
  });

  test('?category=invalid → 400', async () => {
    const { app } = makeRptApp('admin');
    const r = await request(app).get('/v1/reports/catalog?category=foo').set(TH_BIL);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_category');
  });

  test('?regulator=invalid → 400', async () => {
    const { app } = makeRptApp('admin');
    const r = await request(app).get('/v1/reports/catalog?regulator=FOO').set(TH_BIL);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_regulator');
  });

  test('unknown role → 403', async () => {
    const { app } = makeRptApp('case_owner');
    const r = await request(app).get('/v1/reports/catalog').set(TH_BIL);
    expect(r.status).toBe(403);
  });
});

describe('GET /v1/reports/catalog/:id', () => {
  test('valid id → 200', async () => {
    const { app } = makeRptApp('admin');
    const r = await request(app).get('/v1/reports/catalog/rbi_quarterly_summary').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.id).toBe('rbi_quarterly_summary');
    expect(r.body.body.regulator).toBe('RBI');
  });

  test('unknown id → 404 EWS_404_unknown_report', async () => {
    const { app } = makeRptApp('admin');
    const r = await request(app).get('/v1/reports/catalog/no.such').set(TH_BIL);
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('EWS_404_unknown_report');
  });
});

describe('POST /v1/reports/jobs', () => {
  test('admin: 201 with completed job', async () => {
    const store = new InMemoryReportJobStore();
    const { app } = makeRptApp('admin', store);
    const r = await request(app)
      .post('/v1/reports/jobs')
      .set(TH_BIL)
      .set('x-apex-user', 'taniya')
      .send({ report_id: 'rbi_quarterly_summary', format: 'pdf' });
    expect(r.status).toBe(201);
    expect(r.body.body.status).toBe('completed');
    expect(r.body.body.requested_by).toBe('taniya');
    expect(r.body.body.download_url).toMatch(/^\/v1\/reports\/jobs\/rj-/);
  });

  test('accepts an enveloped request body', async () => {
    const store = new InMemoryReportJobStore();
    const { app } = makeRptApp('admin', store);
    const r = await request(app)
      .post('/v1/reports/jobs')
      .set(TH_BIL)
      .send({
        header: { requestId: 'r-1' },
        body: { report_id: 'rbi_quarterly_summary', format: 'json' },
      });
    expect(r.status).toBe(201);
    expect(store.list('BIL', {}).total).toBe(1);
  });

  test('unknown report_id → 404 EWS_404_unknown_report', async () => {
    const { app } = makeRptApp('admin');
    const r = await request(app)
      .post('/v1/reports/jobs')
      .set(TH_BIL)
      .send({ report_id: 'no.such', format: 'pdf' });
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('EWS_404_unknown_report');
  });

  test('unsupported format → 409 EWS_409_unsupported_format', async () => {
    const { app } = makeRptApp('admin');
    const r = await request(app)
      .post('/v1/reports/jobs')
      .set(TH_BIL)
      .send({ report_id: 'sla_breach_digest', format: 'pdf' });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('EWS_409_unsupported_format');
  });

  test('invalid format → 400 EWS_400_invalid_format', async () => {
    const { app } = makeRptApp('admin');
    const r = await request(app)
      .post('/v1/reports/jobs')
      .set(TH_BIL)
      .send({ report_id: 'rbi_quarterly_summary', format: 'docx' });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_format');
  });

  test('non-admin → 403', async () => {
    const { app } = makeRptApp('risk_analyst');
    const r = await request(app)
      .post('/v1/reports/jobs')
      .set(TH_BIL)
      .send({ report_id: 'rbi_quarterly_summary', format: 'pdf' });
    expect(r.status).toBe(403);
  });
});

describe('GET /v1/reports/jobs', () => {
  async function seed(app: import('express').Express): Promise<void> {
    await request(app)
      .post('/v1/reports/jobs')
      .set(TH_BIL)
      .set('x-apex-user', 'alice')
      .send({ report_id: 'rbi_quarterly_summary', format: 'pdf' });
    await request(app)
      .post('/v1/reports/jobs')
      .set(TH_BIL)
      .set('x-apex-user', 'bob')
      .send({ report_id: 'irdai_claims_quarterly', format: 'csv' });
  }

  test('admin: 200 paginated newest-first', async () => {
    const { app } = makeRptApp('admin');
    await seed(app);
    const r = await request(app).get('/v1/reports/jobs').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total).toBe(2);
    expect(r.body.body.items[0].requested_by).toBe('bob');
    expect(r.body.body.items[1].requested_by).toBe('alice');
  });

  test('?status=completed filter works', async () => {
    const { app } = makeRptApp('admin');
    await seed(app);
    const r = await request(app).get('/v1/reports/jobs?status=completed').set(TH_BIL);
    expect(r.body.body.total).toBe(2);
  });

  test('?status=invalid → 400', async () => {
    const { app } = makeRptApp('admin');
    const r = await request(app).get('/v1/reports/jobs?status=done').set(TH_BIL);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_status');
  });

  test('?report_id filter narrows', async () => {
    const { app } = makeRptApp('admin');
    await seed(app);
    const r = await request(app)
      .get('/v1/reports/jobs?report_id=rbi_quarterly_summary')
      .set(TH_BIL);
    expect(r.body.body.total).toBe(1);
  });

  test('?requested_by filter narrows', async () => {
    const { app } = makeRptApp('admin');
    await seed(app);
    const r = await request(app).get('/v1/reports/jobs?requested_by=alice').set(TH_BIL);
    expect(r.body.body.total).toBe(1);
  });

  test('non-admin → 403', async () => {
    const { app } = makeRptApp('risk_analyst');
    const r = await request(app).get('/v1/reports/jobs').set(TH_BIL);
    expect(r.status).toBe(403);
  });
});

describe('GET /v1/reports/jobs/:job_id', () => {
  test('returns job when found', async () => {
    const store = new InMemoryReportJobStore();
    const j = store.submit('BIL', { report_id: 'rbi_quarterly_summary', format: 'pdf' }, 't', NOW);
    const { app } = makeRptApp('admin', store);
    const r = await request(app).get(`/v1/reports/jobs/${j.job_id}`).set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.job_id).toBe(j.job_id);
  });

  test('404 on miss', async () => {
    const { app } = makeRptApp('admin');
    const r = await request(app).get('/v1/reports/jobs/rj-nope').set(TH_BIL);
    expect(r.status).toBe(404);
  });

  test('cross-tenant lookup → 404', async () => {
    const store = new InMemoryReportJobStore();
    const j = store.submit('BIL', { report_id: 'rbi_quarterly_summary', format: 'pdf' }, 't', NOW);
    const { app } = makeRptApp('admin', store);
    const r = await request(app).get(`/v1/reports/jobs/${j.job_id}`).set(TH_BANK);
    expect(r.status).toBe(404);
  });
});

describe('Existing /v1/reports/:type still works (no regression)', () => {
  test('GET /v1/reports/snapshot still 200 — catalog routes did not shadow it', async () => {
    const { app } = makeRptApp('admin');
    const r = await request(app).get('/v1/reports/snapshot').set(TH_BIL);
    expect(r.status).toBe(200);
    // The legacy route returns a ReportPayload with type=snapshot
    expect(r.body.body.type).toBe('snapshot');
  });
});

describe('Tenant isolation through routes', () => {
  test('BIL submit does not leak to BANK_DEMO list', async () => {
    const store = new InMemoryReportJobStore();
    const { app } = makeRptApp('admin', store);
    await request(app)
      .post('/v1/reports/jobs')
      .set(TH_BIL)
      .send({ report_id: 'rbi_quarterly_summary', format: 'pdf' });
    const bil = await request(app).get('/v1/reports/jobs').set(TH_BIL);
    const bank = await request(app).get('/v1/reports/jobs').set(TH_BANK);
    expect(bil.body.body.total).toBe(1);
    expect(bank.body.body.total).toBe(0);
  });
});
