// services/bff/__tests__/audit_resource_severity_matrix.test.ts
//
// T6 M15.14 — Audit resource_type × severity cross-tab matrix.

import request from 'supertest';
import {
  buildAuditResourceSeverityMatrix,
  ALL_AUDIT_RESOURCE_TYPES,
  ALL_AUDIT_SEVERITIES,
} from '../src/audit_resource_severity_matrix';
import {
  InMemoryAuditTrailStore,
  type AuditEvent,
  type AuditEventInput,
} from '../src/audit_trail';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-17T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function listAll(store: InMemoryAuditTrailStore, tenant: string): AuditEvent[] {
  return store.list(tenant, { page_size: 1000 }).items;
}

const baseInput = (overrides: Partial<AuditEventInput> = {}): AuditEventInput => ({
  actor_username: 'alice',
  actor_role: 'admin',
  action: 'config.update',
  resource_type: 'config',
  resource_id: 'k1',
  outcome: 'success',
  severity: 'info',
  ...overrides,
});

function makeRsApp(role: string = 'admin') {
  const auditTrailStore = new InMemoryAuditTrailStore();
  const built = makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    auditTrailStore,
    now: () => NOW,
    getRole: () => role,
  });
  return { ...built, auditTrailStore };
}

// ─── buildAuditResourceSeverityMatrix — pure ─────────────────────────

describe('M15.14 — empty input', () => {
  test('zero events → every row × col at 0, null leaderboards', () => {
    const m = buildAuditResourceSeverityMatrix('BIL', [], NOW);
    expect(m.tenant_id).toBe('BIL');
    expect(m.generated_at).toBe(NOW.toISOString());
    expect(m.total_events).toBe(0);
    expect(m.rows.length).toBe(ALL_AUDIT_RESOURCE_TYPES.length);
    expect(m.columns.length).toBe(ALL_AUDIT_SEVERITIES.length);
    expect(m.peak_cell).toBeNull();
    expect(m.most_severity_spread_type).toBeNull();
    expect(m.most_resource_spread_severity).toBeNull();
    expect(m.total_critical).toBe(0);
    expect(m.resource_types_with_critical).toEqual([]);
    expect(m.empty_cells.length).toBe(ALL_AUDIT_RESOURCE_TYPES.length * ALL_AUDIT_SEVERITIES.length);
  });
});

describe('M15.14 — rows in canonical resource_type order', () => {
  test('rows[] follows ALL_AUDIT_RESOURCE_TYPES', () => {
    const m = buildAuditResourceSeverityMatrix('BIL', [], NOW);
    expect(m.rows.map((r) => r.resource_type)).toEqual([...ALL_AUDIT_RESOURCE_TYPES]);
  });
});

describe('M15.14 — columns in canonical severity order', () => {
  test('columns[] follows ALL_AUDIT_SEVERITIES (critical → warning → info)', () => {
    const m = buildAuditResourceSeverityMatrix('BIL', [], NOW);
    expect(m.columns.map((c) => c.severity)).toEqual([...ALL_AUDIT_SEVERITIES]);
  });
});

describe('M15.14 — single event placement', () => {
  test('1 config/info event → that cell populated', () => {
    const store = new InMemoryAuditTrailStore();
    store.record('BIL', baseInput({ resource_type: 'config', severity: 'info' }), NOW);
    const events = listAll(store, 'BIL');
    const m = buildAuditResourceSeverityMatrix('BIL', events, NOW);
    expect(m.total_events).toBe(1);
    const config = m.rows.find((r) => r.resource_type === 'config')!;
    expect(config.by_severity.info).toBe(1);
    expect(config.total).toBe(1);
    const info = m.columns.find((c) => c.severity === 'info')!;
    expect(info.by_resource_type.config).toBe(1);
    expect(info.total).toBe(1);
    expect(m.peak_cell).toEqual({ resource_type: 'config', severity: 'info', count: 1 });
  });
});

describe('M15.14 — partition invariants', () => {
  test('Σ by_severity = row.total per row', () => {
    const store = new InMemoryAuditTrailStore();
    store.record('BIL', baseInput({ resource_type: 'config', severity: 'info' }), NOW);
    store.record('BIL', baseInput({ resource_type: 'config', severity: 'critical' }), NOW);
    store.record('BIL', baseInput({ resource_type: 'case', severity: 'warning' }), NOW);
    const m = buildAuditResourceSeverityMatrix('BIL', listAll(store, 'BIL'), NOW);
    for (const row of m.rows) {
      const sum = Object.values(row.by_severity).reduce((a, b) => a + b, 0);
      expect(row.total).toBe(sum);
    }
  });

  test('Σ by_resource_type = col.total per col', () => {
    const store = new InMemoryAuditTrailStore();
    store.record('BIL', baseInput({ resource_type: 'config', severity: 'info' }), NOW);
    store.record('BIL', baseInput({ resource_type: 'case', severity: 'info' }), NOW);
    const m = buildAuditResourceSeverityMatrix('BIL', listAll(store, 'BIL'), NOW);
    for (const col of m.columns) {
      const sum = Object.values(col.by_resource_type).reduce((a, b) => a + b, 0);
      expect(col.total).toBe(sum);
    }
  });

  test('Σ rows.total = Σ cols.total = total_events', () => {
    const store = new InMemoryAuditTrailStore();
    store.record('BIL', baseInput({ resource_type: 'user', severity: 'info' }), NOW);
    store.record('BIL', baseInput({ resource_type: 'config', severity: 'warning' }), NOW);
    store.record('BIL', baseInput({ resource_type: 'alert', severity: 'critical' }), NOW);
    const m = buildAuditResourceSeverityMatrix('BIL', listAll(store, 'BIL'), NOW);
    const rowSum = m.rows.reduce((acc, r) => acc + r.total, 0);
    const colSum = m.columns.reduce((acc, c) => acc + c.total, 0);
    expect(rowSum).toBe(m.total_events);
    expect(colSum).toBe(m.total_events);
    expect(m.total_events).toBe(3);
  });
});

describe('M15.14 — every-key-present invariants', () => {
  test('row.by_severity has every AuditSeverity key', () => {
    const m = buildAuditResourceSeverityMatrix('BIL', [], NOW);
    for (const row of m.rows) {
      for (const s of ALL_AUDIT_SEVERITIES) {
        expect(row.by_severity).toHaveProperty(s);
        expect(typeof row.by_severity[s]).toBe('number');
      }
    }
  });

  test('col.by_resource_type has every AuditResourceType key', () => {
    const m = buildAuditResourceSeverityMatrix('BIL', [], NOW);
    for (const col of m.columns) {
      for (const r of ALL_AUDIT_RESOURCE_TYPES) {
        expect(col.by_resource_type).toHaveProperty(r);
        expect(typeof col.by_resource_type[r]).toBe('number');
      }
    }
  });
});

describe('M15.14 — cell cross-check invariant', () => {
  test('row[rt].by_severity[s] === col[s].by_resource_type[rt] for every pair', () => {
    const store = new InMemoryAuditTrailStore();
    store.record('BIL', baseInput({ resource_type: 'config', severity: 'critical' }), NOW);
    store.record('BIL', baseInput({ resource_type: 'case', severity: 'warning' }), NOW);
    store.record('BIL', baseInput({ resource_type: 'alert', severity: 'info' }), NOW);
    const m = buildAuditResourceSeverityMatrix('BIL', listAll(store, 'BIL'), NOW);
    for (const row of m.rows) {
      for (const col of m.columns) {
        expect(row.by_severity[col.severity]).toBe(col.by_resource_type[row.resource_type]);
      }
    }
  });
});

describe('M15.14 — severities_without per row', () => {
  test('canonical severity order; entries have by_severity=0', () => {
    const store = new InMemoryAuditTrailStore();
    store.record('BIL', baseInput({ resource_type: 'config', severity: 'info' }), NOW);
    const m = buildAuditResourceSeverityMatrix('BIL', listAll(store, 'BIL'), NOW);
    const config = m.rows.find((r) => r.resource_type === 'config')!;
    expect(config.severities_without).toEqual(['critical', 'warning']);
  });
});

describe('M15.14 — resource_types_without per column', () => {
  test('canonical resource-type order; entries have by_resource_type=0', () => {
    const store = new InMemoryAuditTrailStore();
    store.record('BIL', baseInput({ resource_type: 'config', severity: 'info' }), NOW);
    const m = buildAuditResourceSeverityMatrix('BIL', listAll(store, 'BIL'), NOW);
    const info = m.columns.find((c) => c.severity === 'info')!;
    expect(info.resource_types_without).toEqual([
      'user', 'session', 'case', 'alert', 'report', 'scenario', 'rule', 'integration', 'system',
    ]);
  });
});

describe('M15.14 — peak_cell formula', () => {
  test('points at highest-count cell', () => {
    const store = new InMemoryAuditTrailStore();
    // (config, critical) = 3
    store.record('BIL', baseInput({ resource_type: 'config', severity: 'critical' }), NOW);
    store.record('BIL', baseInput({ resource_type: 'config', severity: 'critical' }), NOW);
    store.record('BIL', baseInput({ resource_type: 'config', severity: 'critical' }), NOW);
    // (alert, warning) = 1
    store.record('BIL', baseInput({ resource_type: 'alert', severity: 'warning' }), NOW);
    const m = buildAuditResourceSeverityMatrix('BIL', listAll(store, 'BIL'), NOW);
    expect(m.peak_cell).toEqual({
      resource_type: 'config',
      severity: 'critical',
      count: 3,
    });
  });

  test('canonical iteration tie-break: user/critical wins over user/warning at tied count', () => {
    const store = new InMemoryAuditTrailStore();
    store.record('BIL', baseInput({ resource_type: 'user', severity: 'critical' }), NOW);
    store.record('BIL', baseInput({ resource_type: 'user', severity: 'warning' }), NOW);
    const m = buildAuditResourceSeverityMatrix('BIL', listAll(store, 'BIL'), NOW);
    expect(m.peak_cell!.resource_type).toBe('user');
    expect(m.peak_cell!.severity).toBe('critical');
  });

  test('null on empty', () => {
    const m = buildAuditResourceSeverityMatrix('BIL', [], NOW);
    expect(m.peak_cell).toBeNull();
  });
});

describe('M15.14 — empty_cells', () => {
  test('every empty_cell has count=0 on both axes', () => {
    const store = new InMemoryAuditTrailStore();
    store.record('BIL', baseInput({ resource_type: 'config', severity: 'info' }), NOW);
    const m = buildAuditResourceSeverityMatrix('BIL', listAll(store, 'BIL'), NOW);
    for (const ec of m.empty_cells) {
      const row = m.rows.find((r) => r.resource_type === ec.resource_type)!;
      expect(row.by_severity[ec.severity]).toBe(0);
    }
  });

  test('canonical row-major order (resource_type asc index, then severity asc index)', () => {
    const store = new InMemoryAuditTrailStore();
    store.record('BIL', baseInput({ resource_type: 'config', severity: 'info' }), NOW);
    const m = buildAuditResourceSeverityMatrix('BIL', listAll(store, 'BIL'), NOW);
    for (let i = 1; i < m.empty_cells.length; i++) {
      const prev = m.empty_cells[i - 1]!;
      const curr = m.empty_cells[i]!;
      const prevRIdx = ALL_AUDIT_RESOURCE_TYPES.indexOf(prev.resource_type);
      const currRIdx = ALL_AUDIT_RESOURCE_TYPES.indexOf(curr.resource_type);
      if (prevRIdx !== currRIdx) {
        expect(currRIdx).toBeGreaterThan(prevRIdx);
      } else {
        const prevSIdx = ALL_AUDIT_SEVERITIES.indexOf(prev.severity);
        const currSIdx = ALL_AUDIT_SEVERITIES.indexOf(curr.severity);
        expect(currSIdx).toBeGreaterThan(prevSIdx);
      }
    }
  });

  test('partition: empty + non_empty = 30 (10 × 3)', () => {
    const store = new InMemoryAuditTrailStore();
    store.record('BIL', baseInput({ resource_type: 'config', severity: 'info' }), NOW);
    const m = buildAuditResourceSeverityMatrix('BIL', listAll(store, 'BIL'), NOW);
    const total_cells = ALL_AUDIT_RESOURCE_TYPES.length * ALL_AUDIT_SEVERITIES.length;
    let non_empty = 0;
    for (const row of m.rows) {
      for (const s of ALL_AUDIT_SEVERITIES) {
        if (row.by_severity[s] > 0) non_empty++;
      }
    }
    expect(m.empty_cells.length + non_empty).toBe(total_cells);
  });
});

describe('M15.14 — most_severity_spread_type', () => {
  test('points at resource_type with most distinct non-zero severities', () => {
    const store = new InMemoryAuditTrailStore();
    // config spans 3 severities
    store.record('BIL', baseInput({ resource_type: 'config', severity: 'critical' }), NOW);
    store.record('BIL', baseInput({ resource_type: 'config', severity: 'warning' }), NOW);
    store.record('BIL', baseInput({ resource_type: 'config', severity: 'info' }), NOW);
    // alert spans 1
    store.record('BIL', baseInput({ resource_type: 'alert', severity: 'warning' }), NOW);
    const m = buildAuditResourceSeverityMatrix('BIL', listAll(store, 'BIL'), NOW);
    expect(m.most_severity_spread_type!.resource_type).toBe('config');
    expect(m.most_severity_spread_type!.severities_seen).toBe(3);
  });

  test('canonical-order tie-break: user wins over session at same span', () => {
    const store = new InMemoryAuditTrailStore();
    store.record('BIL', baseInput({ resource_type: 'user', severity: 'info' }), NOW);
    store.record('BIL', baseInput({ resource_type: 'session', severity: 'info' }), NOW);
    const m = buildAuditResourceSeverityMatrix('BIL', listAll(store, 'BIL'), NOW);
    expect(m.most_severity_spread_type!.resource_type).toBe('user');
  });

  test('null on empty', () => {
    const m = buildAuditResourceSeverityMatrix('BIL', [], NOW);
    expect(m.most_severity_spread_type).toBeNull();
  });
});

describe('M15.14 — most_resource_spread_severity', () => {
  test('points at severity with most distinct non-zero resource types', () => {
    const store = new InMemoryAuditTrailStore();
    // info spans user + config + alert (3 types)
    store.record('BIL', baseInput({ resource_type: 'user', severity: 'info' }), NOW);
    store.record('BIL', baseInput({ resource_type: 'config', severity: 'info' }), NOW);
    store.record('BIL', baseInput({ resource_type: 'alert', severity: 'info' }), NOW);
    // critical spans 1
    store.record('BIL', baseInput({ resource_type: 'session', severity: 'critical' }), NOW);
    const m = buildAuditResourceSeverityMatrix('BIL', listAll(store, 'BIL'), NOW);
    expect(m.most_resource_spread_severity!.severity).toBe('info');
    expect(m.most_resource_spread_severity!.resource_types_seen).toBe(3);
  });

  test('canonical-order tie-break: critical wins over warning at same span', () => {
    const store = new InMemoryAuditTrailStore();
    store.record('BIL', baseInput({ resource_type: 'config', severity: 'critical' }), NOW);
    store.record('BIL', baseInput({ resource_type: 'config', severity: 'warning' }), NOW);
    const m = buildAuditResourceSeverityMatrix('BIL', listAll(store, 'BIL'), NOW);
    expect(m.most_resource_spread_severity!.severity).toBe('critical');
  });

  test('null on empty', () => {
    const m = buildAuditResourceSeverityMatrix('BIL', [], NOW);
    expect(m.most_resource_spread_severity).toBeNull();
  });
});

describe('M15.14 — total_critical', () => {
  test('Σ critical column = total_critical', () => {
    const store = new InMemoryAuditTrailStore();
    store.record('BIL', baseInput({ resource_type: 'config', severity: 'critical' }), NOW);
    store.record('BIL', baseInput({ resource_type: 'user', severity: 'critical' }), NOW);
    store.record('BIL', baseInput({ resource_type: 'case', severity: 'warning' }), NOW);
    const m = buildAuditResourceSeverityMatrix('BIL', listAll(store, 'BIL'), NOW);
    expect(m.total_critical).toBe(2);
  });

  test('0 when no critical events', () => {
    const store = new InMemoryAuditTrailStore();
    store.record('BIL', baseInput({ resource_type: 'config', severity: 'info' }), NOW);
    const m = buildAuditResourceSeverityMatrix('BIL', listAll(store, 'BIL'), NOW);
    expect(m.total_critical).toBe(0);
  });
});

describe('M15.14 — resource_types_with_critical', () => {
  test('lists resource_types with ≥1 critical event in canonical order', () => {
    const store = new InMemoryAuditTrailStore();
    store.record('BIL', baseInput({ resource_type: 'session', severity: 'critical' }), NOW);
    store.record('BIL', baseInput({ resource_type: 'user', severity: 'critical' }), NOW);
    store.record('BIL', baseInput({ resource_type: 'case', severity: 'warning' }), NOW);
    const m = buildAuditResourceSeverityMatrix('BIL', listAll(store, 'BIL'), NOW);
    // canonical order: user before session
    expect(m.resource_types_with_critical).toEqual(['user', 'session']);
  });

  test('empty when no critical events', () => {
    const store = new InMemoryAuditTrailStore();
    store.record('BIL', baseInput({ resource_type: 'config', severity: 'info' }), NOW);
    const m = buildAuditResourceSeverityMatrix('BIL', listAll(store, 'BIL'), NOW);
    expect(m.resource_types_with_critical).toEqual([]);
  });
});

// ─── GET /v1/audit/resource-severity-matrix ──────────────────────────

describe('M15.14 — GET /v1/audit/resource-severity-matrix', () => {
  test('admin → 200 with empty matrix', async () => {
    const { app } = makeRsApp('admin');
    const r = await request(app).get('/v1/audit/resource-severity-matrix').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_events).toBe(0);
    expect(r.body.body.rows.length).toBe(ALL_AUDIT_RESOURCE_TYPES.length);
    expect(r.body.body.columns.length).toBe(ALL_AUDIT_SEVERITIES.length);
  });

  test('populated matrix reflects events', async () => {
    const { app, auditTrailStore } = makeRsApp('admin');
    auditTrailStore.record('BIL', baseInput({ resource_type: 'config', severity: 'critical' }), NOW);
    auditTrailStore.record('BIL', baseInput({ resource_type: 'user', severity: 'critical' }), NOW);
    auditTrailStore.record('BIL', baseInput({ resource_type: 'case', severity: 'warning' }), NOW);
    const r = await request(app).get('/v1/audit/resource-severity-matrix').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_events).toBe(3);
    expect(r.body.body.total_critical).toBe(2);
    expect(r.body.body.resource_types_with_critical).toEqual(['user', 'config']);
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeRsApp('case_owner');
    const r = await request(app).get('/v1/audit/resource-severity-matrix').set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('cross-tenant: BIL events invisible to BANK_DEMO', async () => {
    const { app, auditTrailStore } = makeRsApp('admin');
    auditTrailStore.record('BIL', baseInput({ resource_type: 'config', severity: 'critical' }), NOW);
    const bank = await request(app)
      .get('/v1/audit/resource-severity-matrix')
      .set('X-Tenant-ID', 'BANK_DEMO')
      .set('X-Channel', 'API');
    expect(bank.status).toBe(200);
    expect(bank.body.body.total_events).toBe(0);
  });

  test('M15.12 /v1/audit/resource-type-distribution still 200 (sibling regression)', async () => {
    const { app } = makeRsApp('admin');
    const r = await request(app).get('/v1/audit/resource-type-distribution').set(TH_BIL);
    expect(r.status).toBe(200);
  });
});
