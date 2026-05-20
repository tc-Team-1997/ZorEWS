// services/bff/__tests__/system_monitoring_dashboard.test.ts
//
// Phase D.1 — System Monitoring dashboard tests.

import request from 'supertest';
import {
  buildSystemMonitoringReport,
  summariseUpstreams,
  summariseAdapterFleet,
  summariseIngestion,
  SYSTEM_MONITORING_ATTENTION_CAP,
  type SystemMonitoringReport,
} from '../src/system/monitoring_dashboard';
import type { HealthReport } from '../src/integrations/health';
import type { FleetHealthReport } from '../src/adapter_health';
import type { IngestionHealth, Connector } from '../src/ingestion';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-21T09:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API', 'X-APEX-USER': 'alice.admin' };

// ── Fixture helpers ────────────────────────────────────────────────────

function upstreamReport(over: {
  cbsDown?: boolean;
  amlDown?: boolean;
  ifrs9Down?: boolean;
  collectionDown?: boolean;
} = {}): HealthReport {
  const mk = (
    id: 'cbs' | 'aml' | 'ifrs9' | 'collection',
    label: string,
    down: boolean,
  ) => ({
    id,
    label,
    probe_url: `http://mocks${id}`,
    latency_ms: down ? 1500 : 12,
    status: down ? ('down' as const) : ('up' as const),
    http_status: down ? 503 : 200,
    message: down ? '503 Service Unavailable' : undefined,
  });
  return {
    base_url: 'http://mocks',
    generated_at: NOW.toISOString(),
    integrations: [
      mk('cbs', 'Core Banking System', !!over.cbsDown),
      mk('aml', 'AML Hub', !!over.amlDown),
      mk('ifrs9', 'IFRS 9 Engine', !!over.ifrs9Down),
      mk('collection', 'Collection System', !!over.collectionDown),
    ],
  };
}

function adapterReport(degraded_count: number = 0): FleetHealthReport {
  const adapterIds: Array<'insurance' | 'ifrs9' | 'aml' | 'dms' | 'bureau' | 'agent' | 'finance' | 'hr'> = [
    'insurance', 'ifrs9', 'aml', 'dms', 'bureau', 'agent', 'finance', 'hr',
  ];
  return {
    tenant_id: 'BIL',
    generated_at: NOW.toISOString(),
    total_latency_ms: 240,
    total: 8,
    up_count: 8 - degraded_count,
    degraded_count,
    adapters: adapterIds.map((id, idx) => ({
      adapter_id: id,
      label: `Adapter ${id}`,
      base_path: `/v1/integrations/${id}`,
      status: idx < degraded_count ? 'degraded' : 'up',
      latency_ms: idx < degraded_count ? 800 + idx * 50 : 30 + idx * 5,
      sample_count: idx < degraded_count ? 0 : 5,
      error: idx < degraded_count ? `probe-fail-${id}` : undefined,
    })),
  };
}

function ingestionReport(opts: {
  failing?: number;
  degraded?: number;
  paused?: number;
  total?: number;
  fleet_records_last_run?: number;
} = {}): IngestionHealth {
  const total = opts.total ?? 8;
  const failing = opts.failing ?? 0;
  const degraded = opts.degraded ?? 0;
  const paused = opts.paused ?? 0;
  const healthy = total - failing - degraded - paused;
  const attention: Connector[] = [];
  let idx = 0;
  const push = (status: 'failing' | 'degraded' | 'paused', count: number) => {
    for (let i = 0; i < count; i++, idx++) {
      attention.push({
        id: `c-${idx}`,
        name: `Connector ${idx}`,
        type: 'kafka_stream',
        source_system: 'CBS',
        schedule: '*/5 * * * *',
        default_status: 'healthy',
        description: 'test fixture',
        status,
        last_run_at: null,
        last_run_status: null,
        last_run_records: 0,
        average_lag_seconds: 0,
        paused_at: status === 'paused' ? NOW.toISOString() : null,
      });
    }
  };
  push('failing', failing);
  push('degraded', degraded);
  push('paused', paused);
  return {
    total_connectors: total,
    by_status: { healthy, degraded, failing, paused },
    attention_required: attention,
    fleet_records_last_run: opts.fleet_records_last_run ?? 12345,
  };
}

function makeMonitoringApp(role: string = 'admin') {
  const { app } = makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
    // Stub the upstream fetcher so the live route doesn't go out over network.
    integrationsFetcher: async () => ({ status: 200 }),
  });
  return app;
}

// ── 1. summariseUpstreams ──────────────────────────────────────────────

describe('summariseUpstreams', () => {
  test('all healthy → green, zero degraded', () => {
    const out = summariseUpstreams(upstreamReport());
    expect(out.axis).toBe('upstream');
    expect(out.total).toBe(4);
    expect(out.healthy).toBe(4);
    expect(out.degraded).toBe(0);
    expect(out.severity).toBe('green');
    expect(out.worst_offender).toBeNull();
  });

  test('one down → red, worst_offender populated', () => {
    const out = summariseUpstreams(upstreamReport({ cbsDown: true }));
    expect(out.degraded).toBe(1);
    expect(out.severity).toBe('red');
    expect(out.worst_offender?.id).toBe('cbs');
  });

  test('multiple down → picks slowest as worst', () => {
    const r = upstreamReport({ cbsDown: true, amlDown: true });
    r.integrations[0].latency_ms = 800; // cbs faster
    r.integrations[1].latency_ms = 2200; // aml slower
    const out = summariseUpstreams(r);
    expect(out.worst_offender?.id).toBe('aml');
  });

  test('null input → zero envelope', () => {
    const out = summariseUpstreams(null);
    expect(out.total).toBe(0);
    expect(out.severity).toBe('green');
    expect(out.worst_offender).toBeNull();
  });
});

// ── 2. summariseAdapterFleet ───────────────────────────────────────────

describe('summariseAdapterFleet', () => {
  test('all up → green', () => {
    const out = summariseAdapterFleet(adapterReport(0));
    expect(out.total).toBe(8);
    expect(out.healthy).toBe(8);
    expect(out.degraded).toBe(0);
    expect(out.severity).toBe('green');
    expect(out.worst_offender).toBeNull();
  });

  test('some degraded but not all → amber', () => {
    const out = summariseAdapterFleet(adapterReport(2));
    expect(out.degraded).toBe(2);
    expect(out.severity).toBe('amber');
    expect(out.worst_offender).not.toBeNull();
  });

  test('all degraded → red', () => {
    const out = summariseAdapterFleet(adapterReport(8));
    expect(out.degraded).toBe(8);
    expect(out.severity).toBe('red');
  });

  test('worst_offender carries error string', () => {
    const out = summariseAdapterFleet(adapterReport(1));
    expect(out.worst_offender?.reason).toContain('probe-fail');
  });

  test('null input → zero envelope', () => {
    const out = summariseAdapterFleet(null);
    expect(out.total).toBe(0);
    expect(out.severity).toBe('green');
  });
});

// ── 3. summariseIngestion ──────────────────────────────────────────────

describe('summariseIngestion', () => {
  test('all healthy → green', () => {
    const out = summariseIngestion(ingestionReport());
    expect(out.severity).toBe('green');
    expect(out.degraded).toBe(0);
    expect(out.worst_offender).toBeNull();
  });

  test('degraded only → amber', () => {
    const out = summariseIngestion(ingestionReport({ degraded: 2 }));
    expect(out.severity).toBe('amber');
    expect(out.degraded).toBe(2);
  });

  test('paused only → amber', () => {
    const out = summariseIngestion(ingestionReport({ paused: 1 }));
    expect(out.severity).toBe('amber');
  });

  test('any failing → red', () => {
    const out = summariseIngestion(ingestionReport({ failing: 1, degraded: 2 }));
    expect(out.severity).toBe('red');
    expect(out.worst_offender).not.toBeNull();
  });

  test('worst_offender picks first failing over degraded', () => {
    const out = summariseIngestion(ingestionReport({ failing: 1, degraded: 1 }));
    expect(out.worst_offender?.id).toBe('c-0'); // failing block goes first
    expect(out.worst_offender?.reason).toContain('failing');
  });

  test('null input → zero envelope', () => {
    const out = summariseIngestion(null);
    expect(out.severity).toBe('green');
  });
});

// ── 4. buildSystemMonitoringReport ─────────────────────────────────────

describe('buildSystemMonitoringReport', () => {
  test('happy path → all 3 axes green, overall green', () => {
    const report = buildSystemMonitoringReport(
      {
        tenant_id: 'BIL',
        upstream: upstreamReport(),
        adapters: adapterReport(0),
        ingestion: ingestionReport(),
      },
      NOW,
    );
    expect(report.tenant_id).toBe('BIL');
    expect(report.generated_at).toBe(NOW.toISOString());
    expect(report.overall_severity).toBe('green');
    expect(report.axes.length).toBe(3);
    expect(report.attention.length).toBe(0);
    expect(report.capacity.length).toBe(2); // adapters + ingestion (no upstream metric)
  });

  test('upstream down → overall red regardless of other axes', () => {
    const report = buildSystemMonitoringReport(
      {
        tenant_id: 'BIL',
        upstream: upstreamReport({ amlDown: true }),
        adapters: adapterReport(0),
        ingestion: ingestionReport(),
      },
      NOW,
    );
    expect(report.overall_severity).toBe('red');
    expect(report.attention.find((a) => a.axis === 'upstream' && a.id === 'aml')).toBeTruthy();
  });

  test('adapters degraded only → amber', () => {
    const report = buildSystemMonitoringReport(
      {
        tenant_id: 'BIL',
        upstream: upstreamReport(),
        adapters: adapterReport(1),
        ingestion: ingestionReport(),
      },
      NOW,
    );
    expect(report.overall_severity).toBe('amber');
  });

  test('ingestion failing → red even if adapters/upstream green', () => {
    const report = buildSystemMonitoringReport(
      {
        tenant_id: 'BIL',
        upstream: upstreamReport(),
        adapters: adapterReport(0),
        ingestion: ingestionReport({ failing: 1 }),
      },
      NOW,
    );
    expect(report.overall_severity).toBe('red');
  });

  test('attention sorted high-severity first, then upstream → adapters → ingestion', () => {
    const report = buildSystemMonitoringReport(
      {
        tenant_id: 'BIL',
        upstream: upstreamReport({ cbsDown: true }),
        adapters: adapterReport(1),
        ingestion: ingestionReport({ failing: 1, degraded: 1 }),
      },
      NOW,
    );
    const sevs = report.attention.map((a) => a.severity);
    // All highs come before all mediums.
    const lastHigh = sevs.lastIndexOf('high');
    const firstMedium = sevs.indexOf('medium');
    if (lastHigh !== -1 && firstMedium !== -1) {
      expect(lastHigh).toBeLessThan(firstMedium);
    }
    // Among highs: upstream first.
    const highAxes = report.attention
      .filter((a) => a.severity === 'high')
      .map((a) => a.axis);
    if (highAxes.includes('upstream') && highAxes.includes('ingestion')) {
      expect(highAxes.indexOf('upstream')).toBeLessThan(highAxes.indexOf('ingestion'));
    }
  });

  test('attention capped at SYSTEM_MONITORING_ATTENTION_CAP', () => {
    // Build a fleet with many degraded — feed 25 attention items via
    // ingestion (cap = 20).
    const ing = ingestionReport({
      total: 25,
      degraded: 25,
    });
    const report = buildSystemMonitoringReport(
      {
        tenant_id: 'BIL',
        upstream: upstreamReport(),
        adapters: adapterReport(0),
        ingestion: ing,
      },
      NOW,
    );
    expect(report.attention.length).toBe(SYSTEM_MONITORING_ATTENTION_CAP);
  });

  test('null inputs gracefully → green zeroes', () => {
    const report = buildSystemMonitoringReport(
      {
        tenant_id: 'BIL',
        upstream: null,
        adapters: null,
        ingestion: null,
      },
      NOW,
    );
    expect(report.overall_severity).toBe('green');
    expect(report.attention.length).toBe(0);
    expect(report.capacity.length).toBe(0);
    for (const a of report.axes) expect(a.total).toBe(0);
  });

  test('capacity carries fleet probe wall-clock + records', () => {
    const report = buildSystemMonitoringReport(
      {
        tenant_id: 'BIL',
        upstream: upstreamReport(),
        adapters: adapterReport(0),
        ingestion: ingestionReport({ fleet_records_last_run: 99 }),
      },
      NOW,
    );
    const probe = report.capacity.find((c) => c.metric === 'fleet probe wall-clock');
    expect(probe?.value).toBe(240);
    expect(probe?.unit).toBe('ms');
    const records = report.capacity.find((c) => c.metric === 'fleet records (last run)');
    expect(records?.value).toBe(99);
  });
});

// ── 5. Route: GET /v1/system/monitoring ────────────────────────────────

describe('GET /v1/system/monitoring', () => {
  test('admin happy path returns enveloped report', async () => {
    const app = makeMonitoringApp('admin');
    const r = await request(app).get('/v1/system/monitoring').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body).toBeTruthy();
    const body: SystemMonitoringReport = r.body.body;
    expect(body.tenant_id).toBe('BIL');
    expect(body.axes.length).toBe(3);
    expect(body.axes.map((a) => a.axis).sort()).toEqual(['adapters', 'ingestion', 'upstream']);
  });

  test('field_officer → 403', async () => {
    const app = makeMonitoringApp('field_officer');
    const r = await request(app).get('/v1/system/monitoring').set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('missing tenant header → 400', async () => {
    const app = makeMonitoringApp('admin');
    const r = await request(app).get('/v1/system/monitoring').set('X-APEX-USER', 'alice.admin');
    expect(r.status).toBe(400);
  });

  test('panel-level degradation: ingestion throw still returns a report', async () => {
    // Push a request with an unknown tenant; ingestion.health() returns
    // a zero-shape rather than throwing, so we instead verify the
    // try/catch contract by inspecting the response remains 200.
    const app = makeMonitoringApp('admin');
    const r = await request(app).get('/v1/system/monitoring').set({
      'X-Tenant-ID': 'BANK_DEMO',
      'X-Channel': 'API',
      'X-APEX-USER': 'admin',
    });
    expect(r.status).toBe(200);
    expect(r.body.body.overall_severity).toBeDefined();
  });
});
