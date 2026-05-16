// services/bff/__tests__/connector_type_distribution.test.ts
//
// T6 M3.13 — Connector type distribution rollup.

import request from 'supertest';
import {
  summarizeConnectorTypeDistribution,
  ALL_CONNECTOR_TYPES,
} from '../src/connector_type_distribution';
import {
  InMemoryIngestionRegistry,
  SEED_CONNECTORS,
  type Connector,
  type ConnectorRun,
  type IngestionHealth,
  type IngestionRegistry,
  type ConnectorType,
} from '../src/ingestion';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-16T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

class MockRegistry implements IngestionRegistry {
  constructor(private readonly connectors: Connector[]) {}
  list(): Connector[] { return [...this.connectors]; }
  get(_t: string, id: string): Connector | null {
    return this.connectors.find((c) => c.id === id) ?? null;
  }
  runNow(): ConnectorRun { throw new Error('not used'); }
  listRuns(): ConnectorRun[] { return []; }
  health(): IngestionHealth { throw new Error('not used'); }
  setPaused(): Connector { throw new Error('not used'); }
}

function connector(overrides: Partial<Connector> = {}): Connector {
  return {
    id: 'c-1',
    name: 'Test Connector',
    source_system: 'CBS',
    type: 'rest_api',
    schedule: 'daily',
    default_status: 'healthy',
    description: '',
    status: 'healthy',
    last_run_at: null,
    last_run_status: null,
    last_run_records: 0,
    average_lag_seconds: 0,
    paused_at: null,
    ...overrides,
  };
}

function makeTdApp(role: string = 'admin', registry?: IngestionRegistry) {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
    ingestionRegistry: registry ?? new InMemoryIngestionRegistry(),
  });
}

// ─── summarizeConnectorTypeDistribution — pure ───────────────────────

describe('M3.13 — empty registry', () => {
  test('zero connectors → every type at 0 with every status key emitted', () => {
    const s = summarizeConnectorTypeDistribution(new MockRegistry([]), 'BIL', NOW);
    expect(s.tenant_id).toBe('BIL');
    expect(s.total_connectors).toBe(0);
    expect(s.types.length).toBe(5);
    for (const row of s.types) {
      expect(row.count).toBe(0);
      expect(Object.keys(row.by_status).length).toBe(4);
      expect(row.by_status.healthy).toBe(0);
      expect(row.distinct_source_systems).toBe(0);
      expect(row.sample_connectors).toEqual([]);
    }
    expect(s.most_common_type).toBeNull();
    expect(s.unused_types).toEqual([...ALL_CONNECTOR_TYPES]);
  });
});

describe('M3.13 — canonical type order', () => {
  test('types[] in canonical order', () => {
    const s = summarizeConnectorTypeDistribution(new MockRegistry([]), 'BIL', NOW);
    expect(s.types.map((r) => r.type)).toEqual([...ALL_CONNECTOR_TYPES]);
  });
});

describe('M3.13 — single placement', () => {
  test('one rest_api connector → only rest_api row populated', () => {
    const reg = new MockRegistry([connector({ id: 'c1', type: 'rest_api' })]);
    const s = summarizeConnectorTypeDistribution(reg, 'BIL', NOW);
    const rest = s.types.find((r) => r.type === 'rest_api')!;
    expect(rest.count).toBe(1);
    expect(rest.by_status.healthy).toBe(1);
    const kafka = s.types.find((r) => r.type === 'kafka_stream')!;
    expect(kafka.count).toBe(0);
  });
});

describe('M3.13 — by_status partition', () => {
  test('Σ by_status per row = row.count', () => {
    const reg = new MockRegistry([
      connector({ id: 'c1', type: 'rest_api', status: 'healthy' }),
      connector({ id: 'c2', type: 'rest_api', status: 'degraded' }),
      connector({ id: 'c3', type: 'rest_api', status: 'failing' }),
      connector({ id: 'c4', type: 'rest_api', status: 'paused' }),
    ]);
    const s = summarizeConnectorTypeDistribution(reg, 'BIL', NOW);
    const rest = s.types.find((r) => r.type === 'rest_api')!;
    const sum = Object.values(rest.by_status).reduce((a, b) => a + b, 0);
    expect(sum).toBe(rest.count);
    expect(rest.count).toBe(4);
  });
});

describe('M3.13 — Σ row.count = total_connectors', () => {
  test('partition across types', () => {
    const reg = new MockRegistry([
      connector({ id: 'c1', type: 'rest_api' }),
      connector({ id: 'c2', type: 'kafka_stream' }),
      connector({ id: 'c3', type: 'batch_csv' }),
    ]);
    const s = summarizeConnectorTypeDistribution(reg, 'BIL', NOW);
    const sum = s.types.reduce((acc, r) => acc + r.count, 0);
    expect(sum).toBe(s.total_connectors);
    expect(s.total_connectors).toBe(3);
  });
});

describe('M3.13 — by_source_system map', () => {
  test('per-system counts correct + only systems present as keys', () => {
    const reg = new MockRegistry([
      connector({ id: 'c1', type: 'rest_api', source_system: 'CBS' }),
      connector({ id: 'c2', type: 'rest_api', source_system: 'CBS' }),
      connector({ id: 'c3', type: 'rest_api', source_system: 'AML' }),
    ]);
    const s = summarizeConnectorTypeDistribution(reg, 'BIL', NOW);
    const rest = s.types.find((r) => r.type === 'rest_api')!;
    expect(rest.by_source_system.CBS).toBe(2);
    expect(rest.by_source_system.AML).toBe(1);
    expect(Object.keys(rest.by_source_system).length).toBe(2);
  });

  test('Σ by_source_system per row = row.count', () => {
    const reg = new MockRegistry([
      connector({ id: 'c1', type: 'rest_api', source_system: 'CBS' }),
      connector({ id: 'c2', type: 'rest_api', source_system: 'AML' }),
    ]);
    const s = summarizeConnectorTypeDistribution(reg, 'BIL', NOW);
    for (const row of s.types) {
      const sum = Object.values(row.by_source_system).reduce((a, b) => a + b, 0);
      expect(sum).toBe(row.count);
    }
  });
});

describe('M3.13 — distinct_source_systems counter', () => {
  test('matches Object.keys(by_source_system).length per row', () => {
    const reg = new MockRegistry([
      connector({ id: 'c1', type: 'rest_api', source_system: 'CBS' }),
      connector({ id: 'c2', type: 'rest_api', source_system: 'CBS' }), // dup
      connector({ id: 'c3', type: 'rest_api', source_system: 'AML' }),
    ]);
    const s = summarizeConnectorTypeDistribution(reg, 'BIL', NOW);
    const rest = s.types.find((r) => r.type === 'rest_api')!;
    expect(rest.distinct_source_systems).toBe(2);
  });
});

describe('M3.13 — sample_connectors', () => {
  test('cap 3 + sorted by id asc', () => {
    const reg = new MockRegistry([
      connector({ id: 'z-2', type: 'rest_api' }),
      connector({ id: 'a-1', type: 'rest_api' }),
      connector({ id: 'm-3', type: 'rest_api' }),
      connector({ id: 'b-4', type: 'rest_api' }),
      connector({ id: 'd-5', type: 'rest_api' }),
    ]);
    const s = summarizeConnectorTypeDistribution(reg, 'BIL', NOW);
    const rest = s.types.find((r) => r.type === 'rest_api')!;
    expect(rest.sample_connectors.length).toBe(3);
    expect(rest.sample_connectors.map((c) => c.connector_id)).toEqual(['a-1', 'b-4', 'd-5']);
  });

  test('carries name + source_system + status', () => {
    const reg = new MockRegistry([
      connector({ id: 'c1', type: 'rest_api', name: 'Test', source_system: 'CBS', status: 'degraded' }),
    ]);
    const s = summarizeConnectorTypeDistribution(reg, 'BIL', NOW);
    const rest = s.types.find((r) => r.type === 'rest_api')!;
    expect(rest.sample_connectors[0]!.name).toBe('Test');
    expect(rest.sample_connectors[0]!.source_system).toBe('CBS');
    expect(rest.sample_connectors[0]!.status).toBe('degraded');
  });
});

describe('M3.13 — default 10-connector seed', () => {
  test('uses real SEED_CONNECTORS via InMemoryIngestionRegistry', () => {
    const reg = new InMemoryIngestionRegistry();
    const s = summarizeConnectorTypeDistribution(reg, 'BIL', NOW);
    expect(s.total_connectors).toBe(SEED_CONNECTORS.length);
    expect(s.total_connectors).toBe(10);
    const sumCount = s.types.reduce((acc, r) => acc + r.count, 0);
    expect(sumCount).toBe(s.total_connectors);
  });

  test('seed has at least one kafka_stream + rest_api', () => {
    const reg = new InMemoryIngestionRegistry();
    const s = summarizeConnectorTypeDistribution(reg, 'BIL', NOW);
    const kafka = s.types.find((r) => r.type === 'kafka_stream')!;
    const rest = s.types.find((r) => r.type === 'rest_api')!;
    expect(kafka.count).toBeGreaterThan(0);
    expect(rest.count).toBeGreaterThan(0);
  });
});

describe('M3.13 — most_common_type', () => {
  test('points at highest-count type', () => {
    const reg = new MockRegistry([
      connector({ id: 'a', type: 'kafka_stream' }),
      connector({ id: 'b', type: 'kafka_stream' }),
      connector({ id: 'c', type: 'kafka_stream' }),
      connector({ id: 'd', type: 'rest_api' }),
    ]);
    const s = summarizeConnectorTypeDistribution(reg, 'BIL', NOW);
    expect(s.most_common_type).toBe('kafka_stream');
  });

  test('canonical tie-break: kafka_stream beats batch_csv at same count', () => {
    const reg = new MockRegistry([
      connector({ id: 'a', type: 'batch_csv' }),
      connector({ id: 'b', type: 'kafka_stream' }),
    ]);
    const s = summarizeConnectorTypeDistribution(reg, 'BIL', NOW);
    expect(s.most_common_type).toBe('kafka_stream');
  });

  test('null when empty', () => {
    const s = summarizeConnectorTypeDistribution(new MockRegistry([]), 'BIL', NOW);
    expect(s.most_common_type).toBeNull();
  });
});

describe('M3.13 — unused_types', () => {
  test('zero-count types in canonical order', () => {
    const reg = new MockRegistry([connector({ type: 'rest_api' })]);
    const s = summarizeConnectorTypeDistribution(reg, 'BIL', NOW);
    expect(s.unused_types).toEqual(['kafka_stream', 'batch_csv', 'soap_api', 'sftp_drop']);
  });
});

// ─── GET /v1/ingestion/type-distribution ─────────────────────────────

describe('M3.13 — GET /v1/ingestion/type-distribution', () => {
  test('admin → 200 with default registry (10 seed connectors)', async () => {
    const { app } = makeTdApp('admin');
    const r = await request(app).get('/v1/ingestion/type-distribution').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_connectors).toBe(10);
    expect(r.body.body.types.length).toBe(5);
    expect(r.body.body.most_common_type).not.toBeNull();
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeTdApp('case_owner');
    const r = await request(app).get('/v1/ingestion/type-distribution').set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('tenant-aware: same seed in BIL + BANK_DEMO', async () => {
    const { app } = makeTdApp('admin');
    const bil = await request(app).get('/v1/ingestion/type-distribution').set(TH_BIL);
    const bank = await request(app)
      .get('/v1/ingestion/type-distribution')
      .set('X-Tenant-ID', 'BANK_DEMO')
      .set('X-Channel', 'API');
    expect(bil.status).toBe(200);
    expect(bank.status).toBe(200);
    // Same registry seed → same total + same distribution (until tenant
    // overrides paused state).
    expect(bil.body.body.total_connectors).toBe(bank.body.body.total_connectors);
  });

  test('M3.12 /v1/ingestion/run-volume/hourly still works (sibling regression)', async () => {
    const { app } = makeTdApp('admin');
    const r = await request(app).get('/v1/ingestion/run-volume/hourly').set(TH_BIL);
    expect(r.status).toBe(200);
  });
});
