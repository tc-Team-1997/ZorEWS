// @ts-nocheck
// services/bff/__tests__/connector_uptime_stats.test.ts
// T6 M3.26 — Connector uptime statistics tests

import { buildConnectorUptimeStats } from '../src/connector_uptime_stats';
import { InMemoryIngestionRegistry } from '../src/ingestion';

const NOW = new Date('2026-05-22T12:00:00.000Z');

function mockRegistry(connectors, runsByConnector) {
  return {
    list: (tenant_id) => connectors,
    listRuns: (tenant_id, connector_id, limit) => {
      const runs = runsByConnector[connector_id] ?? [];
      return runs.slice(0, limit);
    },
    get: () => null,
    runNow: () => null,
    health: () => ({ total_connectors: 0, by_status: {}, attention_required: [], fleet_records_last_run: 0 }),
    setPaused: () => null,
  };
}

function mkConnector(id, source_system = 'CBS') {
  return {
    id,
    name: `Connector ${id}`,
    source_system,
    type: 'kafka_stream',
    schedule: 'continuous',
    status: 'healthy',
    last_run_at: null,
    last_run_status: null,
    last_run_records: null,
    paused_at: null,
  };
}

function mkRun(status, started_at = NOW.toISOString()) {
  return {
    run_id: `r-${Math.random()}`,
    connector_id: 'n/a',
    started_at,
    finished_at: new Date(new Date(started_at).getTime() + 60000).toISOString(),
    status,
    records_processed: status === 'success' ? 100 : 0,
    records_failed: status === 'failure' ? 100 : 0,
    error_message: status === 'failure' ? 'timeout' : null,
    triggered_manually: false,
    triggered_by: 'system',
  };
}

describe('buildConnectorUptimeStats — pure resolver', () => {
  test('empty registry → report with empty connectors, all_sla_met=true', () => {
    const reg = mockRegistry([], {});
    const r = buildConnectorUptimeStats(reg, 'BANK_DEMO', NOW);
    expect(r.tenant_id).toBe('BANK_DEMO');
    expect(r.connectors).toEqual([]);
    expect(r.all_sla_met).toBe(true);
    expect(r.fleet_avg_uptime_pct).toBe(100);
    expect(r.connectors_below_sla).toEqual([]);
  });

  test('all success runs → uptime_pct 100, sla_met=true', () => {
    const connectors = [mkConnector('cbs')];
    const runs = Array.from({ length: 10 }, () => mkRun('success'));
    const reg = mockRegistry(connectors, { cbs: runs });
    const r = buildConnectorUptimeStats(reg, 'BANK_DEMO', NOW);
    expect(r.connectors[0].uptime_pct).toBe(100);
    expect(r.connectors[0].sla_met).toBe(true);
    expect(r.connectors[0].failure_count).toBe(0);
  });

  test('connector with failures → uptime_pct < 100', () => {
    const connectors = [mkConnector('cbs')];
    const runs = [
      ...Array.from({ length: 9 }, () => mkRun('success')),
      mkRun('failure'),
    ];
    const reg = mockRegistry(connectors, { cbs: runs });
    const r = buildConnectorUptimeStats(reg, 'BANK_DEMO', NOW);
    const stats = r.connectors[0];
    expect(stats.uptime_pct).toBeLessThan(100);
    expect(stats.failure_count).toBe(1);
  });

  test('connectors sorted by uptime_pct asc (worst first)', () => {
    const c1 = mkConnector('c1');
    const c2 = mkConnector('c2');
    const runs1 = [mkRun('success'), mkRun('success'), mkRun('failure')];
    const runs2 = Array.from({ length: 3 }, () => mkRun('success'));
    const reg = mockRegistry([c1, c2], { c1: runs1, c2: runs2 });
    const r = buildConnectorUptimeStats(reg, 'BANK_DEMO', NOW);
    expect(r.connectors[0].uptime_pct).toBeLessThanOrEqual(r.connectors[1].uptime_pct);
  });

  test('connectors_below_sla populated when uptime_pct < 99.0', () => {
    const connectors = [mkConnector('bad')];
    const runs = [mkRun('success'), mkRun('failure'), mkRun('failure')];
    const reg = mockRegistry(connectors, { bad: runs });
    const r = buildConnectorUptimeStats(reg, 'BANK_DEMO', NOW);
    expect(r.connectors_below_sla).toContain('bad');
    expect(r.all_sla_met).toBe(false);
  });

  test('mtbf_hours computed when >= 2 failures', () => {
    const connectors = [mkConnector('cbs')];
    const t1 = new Date('2026-05-21T00:00:00.000Z').toISOString();
    const t2 = new Date('2026-05-21T02:00:00.000Z').toISOString();
    const runs = [mkRun('failure', t1), mkRun('failure', t2), mkRun('success')];
    const reg = mockRegistry(connectors, { cbs: runs });
    const r = buildConnectorUptimeStats(reg, 'BANK_DEMO', NOW);
    expect(r.connectors[0].mtbf_hours).toBe(2);
  });

  test('no runs → uptime_pct 100, still_running_count 0', () => {
    const connectors = [mkConnector('empty')];
    const reg = mockRegistry(connectors, {});
    const r = buildConnectorUptimeStats(reg, 'BANK_DEMO', NOW);
    expect(r.connectors[0].uptime_pct).toBe(100);
    expect(r.connectors[0].total_runs_sampled).toBe(0);
    expect(r.connectors[0].mtbf_hours).toBeNull();
  });

  test('throws on empty tenant_id', () => {
    const reg = mockRegistry([], {});
    expect(() => buildConnectorUptimeStats(reg, '', NOW)).toThrow();
  });
});

// ─── Route tests ──────────────────────────────────────────────────────

import request from 'supertest';
import { makeApp } from '../src/server';

const HEADERS_ADMIN = {
  'X-Tenant-ID': 'BIL',
  'X-Channel': 'API',
  'X-APEX-USER': 'alice.admin',
  'X-Apex-Role': 'admin',
};

describe('GET /v1/ingestion/connectors/uptime-stats', () => {
  test('admin 200 with envelope', async () => {
    const { app } = makeApp({});
    const r = await request(app)
      .get('/v1/ingestion/connectors/uptime-stats')
      .set(HEADERS_ADMIN);
    expect(r.status).toBe(200);
    expect(r.body.header.status).toBe('SUCCESS');
    expect(r.body.body.tenant_id).toBe('BIL');
    expect(Array.isArray(r.body.body.connectors)).toBe(true);
  });

  test('403 for field_officer', async () => {
    const { app } = makeApp({});
    const r = await request(app)
      .get('/v1/ingestion/connectors/uptime-stats')
      .set({ ...HEADERS_ADMIN, 'X-Apex-Role': 'field_officer' });
    expect(r.status).toBe(403);
  });

  test('400 missing tenant header', async () => {
    const { app } = makeApp({});
    const r = await request(app)
      .get('/v1/ingestion/connectors/uptime-stats')
      .set({ 'X-Apex-Role': 'admin' });
    expect(r.status).toBe(400);
  });
});
