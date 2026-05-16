// services/bff/__tests__/connector_run_volume_hourly.test.ts
//
// T6 M3.12 — Connector fleet run-volume hourly histogram.

import request from 'supertest';
import { buildConnectorRunHourlyVolume } from '../src/connector_run_volume_hourly';
import {
  InMemoryIngestionRegistry,
  type Connector,
  type ConnectorRun,
  type IngestionHealth,
  type IngestionRegistry,
  type RunStatus,
} from '../src/ingestion';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-16T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

/** Mock registry for controlled pure-resolver tests. */
class MockRegistry implements IngestionRegistry {
  constructor(
    private readonly connectors: Connector[],
    private readonly runsByConnector: Record<string, ConnectorRun[]>,
  ) {}
  list(): Connector[] { return [...this.connectors]; }
  get(_t: string, id: string): Connector | null {
    return this.connectors.find((c) => c.id === id) ?? null;
  }
  runNow(): ConnectorRun { throw new Error('not used'); }
  listRuns(_t: string, connector_id: string, limit = 200): ConnectorRun[] {
    return (this.runsByConnector[connector_id] ?? []).slice(0, limit);
  }
  health(): IngestionHealth { throw new Error('not used'); }
  setPaused(): Connector { throw new Error('not used'); }
}

function makeConnector(id: string): Connector {
  return {
    id,
    name: id,
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
  };
}

function makeRun(at: Date, status: RunStatus = 'success'): ConnectorRun {
  return {
    run_id: `run-${at.toISOString()}`,
    connector_id: 'c',
    started_at: at.toISOString(),
    finished_at: new Date(at.getTime() + 1000).toISOString(),
    status,
    records_processed: 100,
    records_failed: 0,
    error_message: null,
    triggered_manually: false,
  };
}

function makeVolApp(role: string = 'admin', registry?: IngestionRegistry) {
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

function atHour(h: number): Date {
  // 2026-05-16T<HH>:30:00.000Z so it's clearly in hour H, not at boundary.
  const iso = `2026-05-16T${String(h).padStart(2, '0')}:30:00.000Z`;
  return new Date(iso);
}

// ─── buildConnectorRunHourlyVolume — pure ────────────────────────────

describe('M3.12 — empty input', () => {
  test('zero connectors → 24 zero buckets + zero envelope', () => {
    const reg = new MockRegistry([], {});
    const s = buildConnectorRunHourlyVolume(reg, 'BIL', NOW);
    expect(s.tenant_id).toBe('BIL');
    expect(s.generated_at).toBe(NOW.toISOString());
    expect(s.total_runs).toBe(0);
    expect(s.active_connectors).toBe(0);
    expect(s.total_connectors).toBe(0);
    expect(s.by_hour.length).toBe(24);
    for (const b of s.by_hour) {
      expect(b.total_runs).toBe(0);
      expect(b.by_status.success).toBe(0);
    }
    expect(s.peak_hour).toBeNull();
    expect(s.peak_count).toBe(0);
    expect(s.quiet_hours).toEqual([0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23]);
    expect(s.mean_runs_per_hour).toBe(0);
  });

  test('connector with no runs → active_connectors stays at 0, total_connectors=1', () => {
    const reg = new MockRegistry([makeConnector('c1')], {});
    const s = buildConnectorRunHourlyVolume(reg, 'BIL', NOW);
    expect(s.total_connectors).toBe(1);
    expect(s.active_connectors).toBe(0);
    expect(s.total_runs).toBe(0);
  });
});

describe('M3.12 — by_hour is always 24 entries in 0..23 order', () => {
  test('hours emitted in canonical order', () => {
    const reg = new MockRegistry([], {});
    const s = buildConnectorRunHourlyVolume(reg, 'BIL', NOW);
    expect(s.by_hour.map((b) => b.hour)).toEqual(
      Array.from({ length: 24 }, (_, i) => i),
    );
  });
});

describe('M3.12 — single run placement', () => {
  test('one run at UTC 14:30 lands in bucket 14', () => {
    const reg = new MockRegistry(
      [makeConnector('c1')],
      { c1: [makeRun(atHour(14), 'success')] },
    );
    const s = buildConnectorRunHourlyVolume(reg, 'BIL', NOW);
    expect(s.total_runs).toBe(1);
    expect(s.by_hour[14]!.total_runs).toBe(1);
    expect(s.by_hour[14]!.by_status.success).toBe(1);
    expect(s.by_hour[13]!.total_runs).toBe(0);
    expect(s.by_hour[15]!.total_runs).toBe(0);
    expect(s.peak_hour).toBe(14);
    expect(s.peak_count).toBe(1);
    expect(s.active_connectors).toBe(1);
  });

  test('hour 0 and hour 23 boundaries handled', () => {
    const reg = new MockRegistry(
      [makeConnector('c1')],
      { c1: [makeRun(atHour(0), 'success'), makeRun(atHour(23), 'success')] },
    );
    const s = buildConnectorRunHourlyVolume(reg, 'BIL', NOW);
    expect(s.by_hour[0]!.total_runs).toBe(1);
    expect(s.by_hour[23]!.total_runs).toBe(1);
  });
});

describe('M3.12 — multi-status accumulation', () => {
  test('multiple statuses in one bucket all counted', () => {
    const reg = new MockRegistry(
      [makeConnector('c1')],
      {
        c1: [
          makeRun(atHour(10), 'success'),
          makeRun(atHour(10), 'failure'),
          makeRun(atHour(10), 'partial'),
          makeRun(atHour(10), 'running'),
        ],
      },
    );
    const s = buildConnectorRunHourlyVolume(reg, 'BIL', NOW);
    const b = s.by_hour[10]!;
    expect(b.total_runs).toBe(4);
    expect(b.by_status.success).toBe(1);
    expect(b.by_status.failure).toBe(1);
    expect(b.by_status.partial).toBe(1);
    expect(b.by_status.running).toBe(1);
  });
});

describe('M3.12 — multi-connector aggregation', () => {
  test('runs from different connectors aggregate into the same bucket', () => {
    const reg = new MockRegistry(
      [makeConnector('c1'), makeConnector('c2')],
      {
        c1: [makeRun(atHour(8), 'success')],
        c2: [makeRun(atHour(8), 'success'), makeRun(atHour(8), 'success')],
      },
    );
    const s = buildConnectorRunHourlyVolume(reg, 'BIL', NOW);
    expect(s.by_hour[8]!.total_runs).toBe(3);
    expect(s.active_connectors).toBe(2);
    expect(s.total_connectors).toBe(2);
  });

  test('active_connectors counts only connectors with ≥1 run', () => {
    const reg = new MockRegistry(
      [makeConnector('c1'), makeConnector('c2'), makeConnector('c3')],
      { c1: [makeRun(atHour(8), 'success')] },
    );
    const s = buildConnectorRunHourlyVolume(reg, 'BIL', NOW);
    expect(s.total_connectors).toBe(3);
    expect(s.active_connectors).toBe(1);
  });
});

describe('M3.12 — by_status partition per bucket', () => {
  test('Σ by_status per bucket = total_runs', () => {
    const reg = new MockRegistry(
      [makeConnector('c1')],
      {
        c1: [
          makeRun(atHour(3), 'success'),
          makeRun(atHour(3), 'failure'),
          makeRun(atHour(3), 'partial'),
        ],
      },
    );
    const s = buildConnectorRunHourlyVolume(reg, 'BIL', NOW);
    for (const b of s.by_hour) {
      const sum = Object.values(b.by_status).reduce((a, c) => a + c, 0);
      expect(sum).toBe(b.total_runs);
    }
  });

  test('Σ by_hour.total_runs = total_runs', () => {
    const reg = new MockRegistry(
      [makeConnector('c1')],
      { c1: [makeRun(atHour(5), 'success'), makeRun(atHour(7), 'success'), makeRun(atHour(7), 'success')] },
    );
    const s = buildConnectorRunHourlyVolume(reg, 'BIL', NOW);
    const hourSum = s.by_hour.reduce((a, b) => a + b.total_runs, 0);
    expect(hourSum).toBe(s.total_runs);
    expect(s.total_runs).toBe(3);
  });
});

describe('M3.12 — peak_hour formula', () => {
  test('points at highest-count hour', () => {
    const reg = new MockRegistry(
      [makeConnector('c1')],
      {
        c1: [
          makeRun(atHour(2), 'success'),
          makeRun(atHour(15), 'success'),
          makeRun(atHour(15), 'success'),
          makeRun(atHour(15), 'success'),
        ],
      },
    );
    const s = buildConnectorRunHourlyVolume(reg, 'BIL', NOW);
    expect(s.peak_hour).toBe(15);
    expect(s.peak_count).toBe(3);
  });

  test('earliest hour wins on tie', () => {
    const reg = new MockRegistry(
      [makeConnector('c1')],
      {
        c1: [
          makeRun(atHour(17), 'success'),
          makeRun(atHour(17), 'success'),
          makeRun(atHour(3), 'success'),
          makeRun(atHour(3), 'success'),
        ],
      },
    );
    const s = buildConnectorRunHourlyVolume(reg, 'BIL', NOW);
    expect(s.peak_hour).toBe(3); // earliest hour at same count
  });

  test('null when no runs', () => {
    const reg = new MockRegistry([makeConnector('c1')], { c1: [] });
    const s = buildConnectorRunHourlyVolume(reg, 'BIL', NOW);
    expect(s.peak_hour).toBeNull();
    expect(s.peak_count).toBe(0);
  });
});

describe('M3.12 — quiet_hours', () => {
  test('lists every zero-count hour in ascending order', () => {
    const reg = new MockRegistry(
      [makeConnector('c1')],
      { c1: [makeRun(atHour(0), 'success'), makeRun(atHour(12), 'success'), makeRun(atHour(23), 'success')] },
    );
    const s = buildConnectorRunHourlyVolume(reg, 'BIL', NOW);
    // Active hours: 0, 12, 23. Quiet: everything else.
    expect(s.quiet_hours).toEqual([1,2,3,4,5,6,7,8,9,10,11,13,14,15,16,17,18,19,20,21,22]);
  });

  test('empty when every hour has at least one run', () => {
    const runs: ConnectorRun[] = [];
    for (let h = 0; h < 24; h++) runs.push(makeRun(atHour(h), 'success'));
    const reg = new MockRegistry([makeConnector('c1')], { c1: runs });
    const s = buildConnectorRunHourlyVolume(reg, 'BIL', NOW);
    expect(s.quiet_hours).toEqual([]);
  });
});

describe('M3.12 — mean_runs_per_hour', () => {
  test('= round(total / 24)', () => {
    const runs: ConnectorRun[] = [];
    // 48 runs spread across all 24 hours (2 per hour).
    for (let h = 0; h < 24; h++) {
      runs.push(makeRun(atHour(h), 'success'));
      runs.push(makeRun(atHour(h), 'success'));
    }
    const reg = new MockRegistry([makeConnector('c1')], { c1: runs });
    const s = buildConnectorRunHourlyVolume(reg, 'BIL', NOW);
    expect(s.total_runs).toBe(48);
    expect(s.mean_runs_per_hour).toBe(2);
  });

  test('= 0 when total < 12 (rounds down)', () => {
    const reg = new MockRegistry(
      [makeConnector('c1')],
      { c1: [makeRun(atHour(8), 'success')] },
    );
    const s = buildConnectorRunHourlyVolume(reg, 'BIL', NOW);
    expect(s.mean_runs_per_hour).toBe(0);
  });
});

describe('M3.12 — per_connector_limit surfaced', () => {
  test('always set to 200', () => {
    const reg = new MockRegistry([], {});
    const s = buildConnectorRunHourlyVolume(reg, 'BIL', NOW);
    expect(s.per_connector_limit).toBe(200);
  });
});

// ─── GET /v1/ingestion/run-volume/hourly ─────────────────────────────

describe('M3.12 — GET /v1/ingestion/run-volume/hourly', () => {
  test('admin → 200 with default registry (fresh tenant has 10 connectors, 0 runs)', async () => {
    const { app } = makeVolApp('admin');
    const r = await request(app).get('/v1/ingestion/run-volume/hourly').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.tenant_id).toBe('BIL');
    expect(r.body.body.by_hour.length).toBe(24);
    expect(r.body.body.total_connectors).toBeGreaterThan(0);
    expect(r.body.body.total_runs).toBe(0);
    expect(r.body.body.active_connectors).toBe(0);
  });

  test('populated registry: runNow adds runs to histogram', async () => {
    const registry = new InMemoryIngestionRegistry();
    // Trigger 3 runs across 3 different hours.
    registry.runNow('BIL', 'cbs_loan_book', 'alice', atHour(3));
    registry.runNow('BIL', 'cbs_loan_book', 'alice', atHour(10));
    registry.runNow('BIL', 'cbs_loan_book', 'alice', atHour(10));
    const { app } = makeVolApp('admin', registry);
    const r = await request(app).get('/v1/ingestion/run-volume/hourly').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_runs).toBe(3);
    expect(r.body.body.by_hour[3].total_runs).toBe(1);
    expect(r.body.body.by_hour[10].total_runs).toBe(2);
    expect(r.body.body.peak_hour).toBe(10);
    expect(r.body.body.peak_count).toBe(2);
    expect(r.body.body.active_connectors).toBe(1);
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeVolApp('case_owner');
    const r = await request(app).get('/v1/ingestion/run-volume/hourly').set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('cross-tenant: BIL runs invisible to BANK_DEMO', async () => {
    const registry = new InMemoryIngestionRegistry();
    registry.runNow('BIL', 'cbs_loan_book', 'alice', atHour(5));
    const { app } = makeVolApp('admin', registry);
    const r = await request(app)
      .get('/v1/ingestion/run-volume/hourly')
      .set('X-Tenant-ID', 'BANK_DEMO')
      .set('X-Channel', 'API');
    expect(r.status).toBe(200);
    expect(r.body.body.total_runs).toBe(0);
  });

  test('M3.1 /v1/ingestion/health still works (sibling regression)', async () => {
    const { app } = makeVolApp('admin');
    const r = await request(app).get('/v1/ingestion/health').set(TH_BIL);
    expect(r.status).toBe(200);
  });
});
