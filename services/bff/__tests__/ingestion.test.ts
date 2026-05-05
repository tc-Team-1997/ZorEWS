// services/bff/__tests__/ingestion.test.ts
//
// T6 M3.1 — BIL Data Ingestion connector registry.
//
// Three layers:
//   1. Schema invariants — 8 seed connectors, ids unique, source_systems
//      cover the 8 BIL upstreams.
//   2. InMemoryIngestionRegistry — list/get/runNow/listRuns/health/
//      setPaused, status transitions per default_status, deterministic
//      stats per (tenant, connector, day), retention cap, tenant
//      isolation.
//   3. Routes — RBAC, envelope, every status code path.

import request from 'supertest';
import {
  IngestionError,
  InMemoryIngestionRegistry,
  SEED_CONNECTORS,
  type Connector,
  type ConnectorRun,
} from '../src/ingestion';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-04T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };
const TH_BANK = { 'X-Tenant-ID': 'BANK_DEMO', 'X-Channel': 'API' };

function makeIngApp(role: string = 'admin', ingestionRegistry?: InMemoryIngestionRegistry) {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
    ingestionRegistry: ingestionRegistry ?? new InMemoryIngestionRegistry(),
  });
}

// ─── Seed schema invariants ────────────────────────────────────────────

describe('SEED_CONNECTORS schema', () => {
  test('10 connectors covering the BIL upstream list (8 from M3.1 + 2 from M3.4)', () => {
    expect(SEED_CONNECTORS.length).toBe(10);
  });

  test('ids are unique', () => {
    const ids = SEED_CONNECTORS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('every connector declares the required fields', () => {
    for (const c of SEED_CONNECTORS) {
      expect(typeof c.id).toBe('string');
      expect(c.id.length).toBeGreaterThan(0);
      expect(typeof c.name).toBe('string');
      expect(typeof c.source_system).toBe('string');
      expect(['kafka_stream', 'batch_csv', 'rest_api', 'soap_api', 'sftp_drop']).toContain(c.type);
      expect(['healthy', 'degraded', 'failing', 'paused']).toContain(c.default_status);
      expect(typeof c.schedule).toBe('string');
    }
  });

  test('source_systems span the BIL upstreams', () => {
    const systems = new Set(SEED_CONNECTORS.map((c) => c.source_system));
    expect(systems.has('CBS')).toBe(true);
    expect(systems.has('CORE_INSURANCE')).toBe(true);
    expect(systems.has('POLICY_MASTER')).toBe(true);
    expect(systems.has('CLAIMS')).toBe(true);
    expect(systems.has('AGENT')).toBe(true);
    expect(systems.has('AML')).toBe(true);
    expect(systems.has('BUREAU')).toBe(true);
    expect(systems.has('IFRS9')).toBe(true);
    // M3.4 additions
    expect(systems.has('BRANCH')).toBe(true);
    expect(systems.has('COLLECTION')).toBe(true);
  });
});

// ─── InMemoryIngestionRegistry ─────────────────────────────────────────

describe('InMemoryIngestionRegistry — list + get', () => {
  test('list() returns every seed connector', () => {
    const r = new InMemoryIngestionRegistry();
    expect(r.list('BIL').length).toBe(SEED_CONNECTORS.length);
  });

  test('default status reflects the seed (healthy or degraded)', () => {
    const r = new InMemoryIngestionRegistry();
    const list = r.list('BIL');
    const agent = list.find((c) => c.id === 'agent_productivity')!;
    expect(agent.status).toBe('degraded');
    const cbs = list.find((c) => c.id === 'cbs_loan_book')!;
    expect(cbs.status).toBe('healthy');
  });

  test('initial last_run_at + last_run_status are null (no runs yet)', () => {
    const r = new InMemoryIngestionRegistry();
    for (const c of r.list('BIL')) {
      expect(c.last_run_at).toBeNull();
      expect(c.last_run_status).toBeNull();
    }
  });

  test('last_run_records is deterministic per (tenant, connector, day)', () => {
    const r = new InMemoryIngestionRegistry();
    const a1 = r.get('BIL', 'cbs_loan_book')!;
    const a2 = r.get('BIL', 'cbs_loan_book')!;
    expect(a1.last_run_records).toBe(a2.last_run_records);
  });

  test('different tenants get different last_run_records (tenant in seed)', () => {
    const r = new InMemoryIngestionRegistry();
    const bil = r.get('BIL', 'cbs_loan_book')!;
    const bank = r.get('BANK_DEMO', 'cbs_loan_book')!;
    expect(bil.last_run_records).not.toBe(bank.last_run_records);
  });

  test('get() unknown id → null', () => {
    const r = new InMemoryIngestionRegistry();
    expect(r.get('BIL', 'no.such.connector')).toBeNull();
  });

  test('record-volume varies by connector type (kafka > batch > weekly bureau still big)', () => {
    const r = new InMemoryIngestionRegistry();
    const list = r.list('BIL');
    const kafka = list.find((c) => c.type === 'kafka_stream')!;
    const batch = list.find((c) => c.type === 'batch_csv')!;
    expect(kafka.last_run_records).toBeGreaterThan(batch.last_run_records);
  });
});

describe('InMemoryIngestionRegistry — runNow', () => {
  test('healthy connector → success run, records_processed > 0', () => {
    const r = new InMemoryIngestionRegistry();
    const run = r.runNow('BIL', 'cbs_loan_book', 'taniya', NOW);
    expect(run.run_id).toMatch(/^run-/);
    expect(run.status).toBe('success');
    expect(run.records_processed).toBeGreaterThan(0);
    expect(run.records_failed).toBe(0);
    expect(run.error_message).toBeNull();
    expect(run.triggered_manually).toBe(true);
  });

  test('degraded connector → partial run with non-zero records_failed + error_message', () => {
    const r = new InMemoryIngestionRegistry();
    const run = r.runNow('BIL', 'agent_productivity', 'taniya', NOW);
    expect(run.status).toBe('partial');
    expect(run.records_failed).toBeGreaterThan(0);
    expect(run.error_message).toMatch(/rejected/);
  });

  test('triggered_manually=false when triggered_by is "scheduler"', () => {
    const r = new InMemoryIngestionRegistry();
    const run = r.runNow('BIL', 'cbs_loan_book', 'scheduler', NOW);
    expect(run.triggered_manually).toBe(false);
  });

  test('subsequent get() reflects the last run', () => {
    const r = new InMemoryIngestionRegistry();
    const run = r.runNow('BIL', 'cbs_loan_book', 'taniya', NOW);
    const c = r.get('BIL', 'cbs_loan_book')!;
    expect(c.last_run_at).toBe(run.started_at);
    expect(c.last_run_status).toBe('success');
  });

  test('unknown connector → IngestionError(unknown_connector)', () => {
    const r = new InMemoryIngestionRegistry();
    try {
      r.runNow('BIL', 'no.such', 'taniya', NOW);
      fail('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(IngestionError);
      expect((e as IngestionError).code).toBe('unknown_connector');
    }
  });

  test('paused connector → IngestionError(paused)', () => {
    const r = new InMemoryIngestionRegistry();
    r.setPaused('BIL', 'cbs_loan_book', true, NOW);
    try {
      r.runNow('BIL', 'cbs_loan_book', 'taniya', NOW);
      fail('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(IngestionError);
      expect((e as IngestionError).code).toBe('paused');
    }
  });
});

describe('InMemoryIngestionRegistry — listRuns', () => {
  test('newest-first ordering', () => {
    const r = new InMemoryIngestionRegistry();
    r.runNow('BIL', 'cbs_loan_book', 'a', new Date(NOW.getTime() + 1000));
    r.runNow('BIL', 'cbs_loan_book', 'b', new Date(NOW.getTime() + 2000));
    r.runNow('BIL', 'cbs_loan_book', 'c', new Date(NOW.getTime() + 3000));
    const runs = r.listRuns('BIL', 'cbs_loan_book');
    expect(runs.length).toBe(3);
    for (let i = 1; i < runs.length; i++) {
      expect(runs[i - 1]!.started_at >= runs[i]!.started_at).toBe(true);
    }
  });

  test('limit clamped to [1, 200]', () => {
    const r = new InMemoryIngestionRegistry();
    for (let i = 0; i < 5; i++) {
      r.runNow('BIL', 'cbs_loan_book', 't', new Date(NOW.getTime() + i * 1000));
    }
    expect(r.listRuns('BIL', 'cbs_loan_book', 0).length).toBe(1);
    expect(r.listRuns('BIL', 'cbs_loan_book', 99999).length).toBe(5);
    expect(r.listRuns('BIL', 'cbs_loan_book', 2).length).toBe(2);
  });

  test('unknown connector → IngestionError(unknown_connector)', () => {
    const r = new InMemoryIngestionRegistry();
    expect(() => r.listRuns('BIL', 'no.such')).toThrow(/unknown connector/);
  });

  test('runs are tenant-scoped', () => {
    const r = new InMemoryIngestionRegistry();
    r.runNow('BIL', 'cbs_loan_book', 'taniya', NOW);
    expect(r.listRuns('BIL', 'cbs_loan_book').length).toBe(1);
    expect(r.listRuns('BANK_DEMO', 'cbs_loan_book').length).toBe(0);
  });

  test('retention cap evicts oldest', () => {
    const r = new InMemoryIngestionRegistry({ runHistoryCap: 3 });
    for (let i = 0; i < 5; i++) {
      r.runNow('BIL', 'cbs_loan_book', `actor-${i}`, new Date(NOW.getTime() + i * 1000));
    }
    const runs = r.listRuns('BIL', 'cbs_loan_book');
    expect(runs.length).toBe(3);
    // Newest 3 retained — actor-4, actor-3, actor-2.
    // Note: the actor field isn't stored on the run, but the timestamps are.
    expect(runs[0]!.started_at).toBe(new Date(NOW.getTime() + 4000).toISOString());
  });
});

describe('InMemoryIngestionRegistry — health', () => {
  test('aggregates by_status correctly', () => {
    const r = new InMemoryIngestionRegistry();
    const h = r.health('BIL');
    expect(h.total_connectors).toBe(10);
    // 9 healthy + 1 degraded by default (agent_productivity is the only
    // degraded seed; M3.4 additions are both healthy)
    expect(h.by_status.healthy).toBe(9);
    expect(h.by_status.degraded).toBe(1);
    expect(h.by_status.failing).toBe(0);
    expect(h.by_status.paused).toBe(0);
  });

  test('attention_required lists non-healthy connectors only', () => {
    const r = new InMemoryIngestionRegistry();
    const h = r.health('BIL');
    expect(h.attention_required.length).toBe(1);
    expect(h.attention_required[0]!.id).toBe('agent_productivity');
  });

  test('paused connector flips status + appears in attention_required', () => {
    const r = new InMemoryIngestionRegistry();
    r.setPaused('BIL', 'cbs_loan_book', true, NOW);
    const h = r.health('BIL');
    expect(h.by_status.paused).toBe(1);
    expect(h.attention_required.find((c) => c.id === 'cbs_loan_book')).toBeDefined();
  });

  test('fleet_records_last_run sums across every connector', () => {
    const r = new InMemoryIngestionRegistry();
    const h = r.health('BIL');
    const list = r.list('BIL');
    const expected = list.reduce((s, c) => s + c.last_run_records, 0);
    expect(h.fleet_records_last_run).toBe(expected);
  });
});

describe('InMemoryIngestionRegistry — setPaused', () => {
  test('setPaused(true) sets status="paused" + paused_at', () => {
    const r = new InMemoryIngestionRegistry();
    const c = r.setPaused('BIL', 'cbs_loan_book', true, NOW);
    expect(c.status).toBe('paused');
    expect(c.paused_at).toBe(NOW.toISOString());
  });

  test('setPaused(false) clears paused_at + reverts status', () => {
    const r = new InMemoryIngestionRegistry();
    r.setPaused('BIL', 'cbs_loan_book', true, NOW);
    const c = r.setPaused('BIL', 'cbs_loan_book', false, NOW);
    expect(c.status).toBe('healthy');
    expect(c.paused_at).toBeNull();
  });

  test('unknown connector → throws', () => {
    const r = new InMemoryIngestionRegistry();
    expect(() => r.setPaused('BIL', 'no.such', true, NOW)).toThrow(/unknown connector/);
  });

  test('tenant isolation — pause in BIL does not affect BANK_DEMO', () => {
    const r = new InMemoryIngestionRegistry();
    r.setPaused('BIL', 'cbs_loan_book', true, NOW);
    expect(r.get('BIL', 'cbs_loan_book')!.status).toBe('paused');
    expect(r.get('BANK_DEMO', 'cbs_loan_book')!.status).toBe('healthy');
  });
});

// ─── Routes ────────────────────────────────────────────────────────────

describe('GET /v1/ingestion/health', () => {
  test('admin: 200 with the connector summary', async () => {
    const { app } = makeIngApp('admin');
    const r = await request(app).get('/v1/ingestion/health').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_connectors).toBe(10);
    expect(r.body.body.by_status.degraded).toBe(1);
  });

  test('non-admin → 403', async () => {
    const { app } = makeIngApp('risk_analyst');
    const r = await request(app).get('/v1/ingestion/health').set(TH_BIL);
    expect(r.status).toBe(403);
  });
});

describe('GET /v1/ingestion/connectors', () => {
  test('admin: 200 with every seed connector', async () => {
    const { app } = makeIngApp('admin');
    const r = await request(app).get('/v1/ingestion/connectors').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total).toBe(10);
  });

  test('non-admin → 403', async () => {
    const { app } = makeIngApp('risk_analyst');
    const r = await request(app).get('/v1/ingestion/connectors').set(TH_BIL);
    expect(r.status).toBe(403);
  });
});

describe('GET /v1/ingestion/connectors/:id', () => {
  test('valid id → 200', async () => {
    const { app } = makeIngApp('admin');
    const r = await request(app).get('/v1/ingestion/connectors/cbs_loan_book').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.id).toBe('cbs_loan_book');
  });

  test('unknown id → 404 EWS_404_unknown_connector', async () => {
    const { app } = makeIngApp('admin');
    const r = await request(app).get('/v1/ingestion/connectors/no.such').set(TH_BIL);
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('EWS_404_unknown_connector');
  });
});

describe('POST /v1/ingestion/connectors/:id/run', () => {
  test('admin: 202 with run + records_processed > 0', async () => {
    const store = new InMemoryIngestionRegistry();
    const { app } = makeIngApp('admin', store);
    const r = await request(app)
      .post('/v1/ingestion/connectors/cbs_loan_book/run')
      .set(TH_BIL)
      .set('x-apex-user', 'taniya');
    expect(r.status).toBe(202);
    expect(r.body.body.run_id).toMatch(/^run-/);
    expect(r.body.body.status).toBe('success');
    expect(r.body.body.triggered_manually).toBe(true);
    expect(store.listRuns('BIL', 'cbs_loan_book').length).toBe(1);
  });

  test('unknown id → 404', async () => {
    const { app } = makeIngApp('admin');
    const r = await request(app).post('/v1/ingestion/connectors/no.such/run').set(TH_BIL);
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('EWS_404_unknown_connector');
  });

  test('paused connector → 409 EWS_409_paused', async () => {
    const store = new InMemoryIngestionRegistry();
    store.setPaused('BIL', 'cbs_loan_book', true, NOW);
    const { app } = makeIngApp('admin', store);
    const r = await request(app).post('/v1/ingestion/connectors/cbs_loan_book/run').set(TH_BIL);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('EWS_409_paused');
  });

  test('non-admin → 403', async () => {
    const { app } = makeIngApp('risk_analyst');
    const r = await request(app).post('/v1/ingestion/connectors/cbs_loan_book/run').set(TH_BIL);
    expect(r.status).toBe(403);
  });
});

describe('GET /v1/ingestion/connectors/:id/runs', () => {
  test('returns runs newest-first', async () => {
    const store = new InMemoryIngestionRegistry();
    const { app } = makeIngApp('admin', store);
    await request(app).post('/v1/ingestion/connectors/cbs_loan_book/run').set(TH_BIL);
    await request(app).post('/v1/ingestion/connectors/cbs_loan_book/run').set(TH_BIL);
    const r = await request(app).get('/v1/ingestion/connectors/cbs_loan_book/runs').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.connector_id).toBe('cbs_loan_book');
    expect(r.body.body.total).toBe(2);
  });

  test('?limit caps the response', async () => {
    const store = new InMemoryIngestionRegistry();
    for (let i = 0; i < 4; i++) {
      store.runNow('BIL', 'cbs_loan_book', 't', new Date(NOW.getTime() + i * 1000));
    }
    const { app } = makeIngApp('admin', store);
    const r = await request(app)
      .get('/v1/ingestion/connectors/cbs_loan_book/runs?limit=2')
      .set(TH_BIL);
    expect(r.body.body.items.length).toBe(2);
    expect(r.body.body.limit).toBe(2);
  });

  test('unknown id → 404', async () => {
    const { app } = makeIngApp('admin');
    const r = await request(app).get('/v1/ingestion/connectors/no.such/runs').set(TH_BIL);
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('EWS_404_unknown_connector');
  });
});

describe('POST /v1/ingestion/connectors/:id/{pause,resume}', () => {
  test('pause → resume round-trip', async () => {
    const store = new InMemoryIngestionRegistry();
    const { app } = makeIngApp('admin', store);
    const pause = await request(app)
      .post('/v1/ingestion/connectors/cbs_loan_book/pause')
      .set(TH_BIL);
    expect(pause.status).toBe(200);
    expect(pause.body.body.status).toBe('paused');
    expect(pause.body.body.paused_at).toBe(NOW.toISOString());
    const resume = await request(app)
      .post('/v1/ingestion/connectors/cbs_loan_book/resume')
      .set(TH_BIL);
    expect(resume.status).toBe(200);
    expect(resume.body.body.status).toBe('healthy');
    expect(resume.body.body.paused_at).toBeNull();
  });

  test('pause unknown id → 404', async () => {
    const { app } = makeIngApp('admin');
    const r = await request(app).post('/v1/ingestion/connectors/no.such/pause').set(TH_BIL);
    expect(r.status).toBe(404);
  });

  test('resume unknown id → 404', async () => {
    const { app } = makeIngApp('admin');
    const r = await request(app).post('/v1/ingestion/connectors/no.such/resume').set(TH_BIL);
    expect(r.status).toBe(404);
  });
});

describe('Tenant isolation through routes', () => {
  test('paused state in BIL does not affect BANK_DEMO read', async () => {
    const store = new InMemoryIngestionRegistry();
    const { app } = makeIngApp('admin', store);
    await request(app).post('/v1/ingestion/connectors/cbs_loan_book/pause').set(TH_BIL);
    const bil = await request(app).get('/v1/ingestion/connectors/cbs_loan_book').set(TH_BIL);
    const bank = await request(app).get('/v1/ingestion/connectors/cbs_loan_book').set(TH_BANK);
    expect(bil.body.body.status).toBe('paused');
    expect(bank.body.body.status).toBe('healthy');
  });
});
