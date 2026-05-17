// services/bff/__tests__/audit_severity_outcome_matrix.test.ts
//
// T6 M15.15 — Audit severity × outcome cross-tab matrix.

import request from 'supertest';
import { buildAuditSeverityOutcomeMatrix } from '../src/audit_severity_outcome_matrix';
import {
  InMemoryAuditTrailStore,
  type AuditOutcome,
  type AuditSeverity,
  type AuditTrailStore,
} from '../src/audit_trail';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-17T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };
const TH_BANK = { 'X-Tenant-ID': 'BANK_DEMO', 'X-Channel': 'API' };

const EXPECTED_SEVS: AuditSeverity[] = ['critical', 'warning', 'info'];
const EXPECTED_OUTCOMES: AuditOutcome[] = ['success', 'failure', 'denied'];

function makeSomApp(role: string = 'admin', auditTrailStore?: AuditTrailStore) {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
    auditTrailStore: auditTrailStore ?? new InMemoryAuditTrailStore(),
  });
}

function record(
  store: AuditTrailStore,
  tenant: string,
  severity: AuditSeverity,
  outcome: AuditOutcome,
) {
  return store.record(
    tenant,
    {
      action: 'test.action',
      resource_type: 'system',
      resource_id: 'r1',
      outcome,
      severity,
      actor_username: 'u',
      actor_role: 'admin',
    },
    NOW,
  );
}

function drainList(store: AuditTrailStore, tenant: string) {
  return store.list(tenant, { page: 1, page_size: 500 }).items;
}

// ─── Pure resolver tests ─────────────────────────────────────────────

describe('M15.15 — empty input', () => {
  test('zero events → 3 rows × 3 cols at 0; empty_cells=9; leaderboards null', () => {
    const s = buildAuditSeverityOutcomeMatrix('BIL', [], NOW);
    expect(s.total_events).toBe(0);
    expect(s.rows.length).toBe(3);
    expect(s.columns.length).toBe(3);
    for (const r of s.rows) expect(r.total).toBe(0);
    for (const c of s.columns) expect(c.total).toBe(0);
    expect(s.empty_cells.length).toBe(9);
    expect(s.peak_cell).toBeNull();
    expect(s.most_failing_severity).toBeNull();
    expect(s.most_critical_outcome).toBeNull();
  });
});

describe('M15.15 — canonical row + column order', () => {
  test('rows in critical → warning → info order', () => {
    const s = buildAuditSeverityOutcomeMatrix('BIL', [], NOW);
    expect(s.rows.map((r) => r.severity)).toEqual(EXPECTED_SEVS);
  });

  test('columns in success → failure → denied order', () => {
    const s = buildAuditSeverityOutcomeMatrix('BIL', [], NOW);
    expect(s.columns.map((c) => c.outcome)).toEqual(EXPECTED_OUTCOMES);
  });
});

describe('M15.15 — every key always present per row + column', () => {
  test('row.by_outcome carries all 3 keys', () => {
    const s = buildAuditSeverityOutcomeMatrix('BIL', [], NOW);
    for (const r of s.rows) {
      expect(Object.keys(r.by_outcome).sort()).toEqual([...EXPECTED_OUTCOMES].sort());
    }
  });

  test('col.by_severity carries all 3 keys', () => {
    const s = buildAuditSeverityOutcomeMatrix('BIL', [], NOW);
    for (const c of s.columns) {
      expect(Object.keys(c.by_severity).sort()).toEqual([...EXPECTED_SEVS].sort());
    }
  });
});

describe('M15.15 — single event placement', () => {
  test('1 critical/failure → row[critical].by_outcome.failure=1, col[failure].by_severity.critical=1', () => {
    const store = new InMemoryAuditTrailStore();
    record(store, 'BIL', 'critical', 'failure');
    const s = buildAuditSeverityOutcomeMatrix('BIL', drainList(store, 'BIL'), NOW);
    const critRow = s.rows.find((r) => r.severity === 'critical')!;
    expect(critRow.total).toBe(1);
    expect(critRow.by_outcome.failure).toBe(1);
    expect(critRow.by_outcome.success).toBe(0);
    const failCol = s.columns.find((c) => c.outcome === 'failure')!;
    expect(failCol.total).toBe(1);
    expect(failCol.by_severity.critical).toBe(1);
    expect(failCol.by_severity.warning).toBe(0);
  });
});

describe('M15.15 — partition invariants', () => {
  test('Σ rows.total = Σ columns.total = total_events', () => {
    const store = new InMemoryAuditTrailStore();
    record(store, 'BIL', 'critical', 'failure');
    record(store, 'BIL', 'critical', 'success');
    record(store, 'BIL', 'warning', 'failure');
    record(store, 'BIL', 'info', 'denied');
    const s = buildAuditSeverityOutcomeMatrix('BIL', drainList(store, 'BIL'), NOW);
    const rowSum = s.rows.reduce((a, r) => a + r.total, 0);
    const colSum = s.columns.reduce((a, c) => a + c.total, 0);
    expect(rowSum).toBe(4);
    expect(colSum).toBe(4);
    expect(s.total_events).toBe(4);
  });

  test('Σ row.by_outcome = row.total per row', () => {
    const store = new InMemoryAuditTrailStore();
    record(store, 'BIL', 'critical', 'failure');
    record(store, 'BIL', 'critical', 'success');
    const s = buildAuditSeverityOutcomeMatrix('BIL', drainList(store, 'BIL'), NOW);
    for (const r of s.rows) {
      const sum = EXPECTED_OUTCOMES.reduce((a, oc) => a + r.by_outcome[oc], 0);
      expect(sum).toBe(r.total);
    }
  });

  test('Σ col.by_severity = col.total per column', () => {
    const store = new InMemoryAuditTrailStore();
    record(store, 'BIL', 'critical', 'failure');
    record(store, 'BIL', 'warning', 'failure');
    const s = buildAuditSeverityOutcomeMatrix('BIL', drainList(store, 'BIL'), NOW);
    for (const c of s.columns) {
      const sum = EXPECTED_SEVS.reduce((a, sev) => a + c.by_severity[sev], 0);
      expect(sum).toBe(c.total);
    }
  });
});

describe('M15.15 — cell cross-check invariant', () => {
  test('row[sev].by_outcome[oc] === col[oc].by_severity[sev] for every cell', () => {
    const store = new InMemoryAuditTrailStore();
    record(store, 'BIL', 'critical', 'failure');
    record(store, 'BIL', 'critical', 'success');
    record(store, 'BIL', 'warning', 'denied');
    const s = buildAuditSeverityOutcomeMatrix('BIL', drainList(store, 'BIL'), NOW);
    for (const sev of EXPECTED_SEVS) {
      for (const oc of EXPECTED_OUTCOMES) {
        const fromRow = s.rows.find((r) => r.severity === sev)!.by_outcome[oc];
        const fromCol = s.columns.find((c) => c.outcome === oc)!.by_severity[sev];
        expect(fromRow).toBe(fromCol);
      }
    }
  });
});

describe('M15.15 — outcomes_without per row', () => {
  test('row.outcomes_without lists outcomes with 0 count in canonical order', () => {
    const store = new InMemoryAuditTrailStore();
    record(store, 'BIL', 'critical', 'failure'); // only critical/failure
    const s = buildAuditSeverityOutcomeMatrix('BIL', drainList(store, 'BIL'), NOW);
    const crit = s.rows.find((r) => r.severity === 'critical')!;
    expect(crit.outcomes_without).toEqual(['success', 'denied']);
    const warn = s.rows.find((r) => r.severity === 'warning')!;
    expect(warn.outcomes_without).toEqual(['success', 'failure', 'denied']);
  });

  test('outcomes_without empty when every outcome has events for that severity', () => {
    const store = new InMemoryAuditTrailStore();
    record(store, 'BIL', 'critical', 'success');
    record(store, 'BIL', 'critical', 'failure');
    record(store, 'BIL', 'critical', 'denied');
    const s = buildAuditSeverityOutcomeMatrix('BIL', drainList(store, 'BIL'), NOW);
    const crit = s.rows.find((r) => r.severity === 'critical')!;
    expect(crit.outcomes_without).toEqual([]);
  });
});

describe('M15.15 — severities_without per column', () => {
  test('col.severities_without lists severities with 0 count in canonical order', () => {
    const store = new InMemoryAuditTrailStore();
    record(store, 'BIL', 'critical', 'failure'); // only critical
    const s = buildAuditSeverityOutcomeMatrix('BIL', drainList(store, 'BIL'), NOW);
    const fail = s.columns.find((c) => c.outcome === 'failure')!;
    expect(fail.severities_without).toEqual(['warning', 'info']);
  });
});

describe('M15.15 — peak_cell', () => {
  test('highest-count cell wins; canonical iteration tie-break', () => {
    const store = new InMemoryAuditTrailStore();
    record(store, 'BIL', 'critical', 'success');
    record(store, 'BIL', 'critical', 'success');
    record(store, 'BIL', 'critical', 'failure');
    const s = buildAuditSeverityOutcomeMatrix('BIL', drainList(store, 'BIL'), NOW);
    expect(s.peak_cell).toEqual({ severity: 'critical', outcome: 'success', count: 2 });
  });

  test('canonical tie-break: critical/success wins over critical/failure at tied 1', () => {
    const store = new InMemoryAuditTrailStore();
    record(store, 'BIL', 'critical', 'success');
    record(store, 'BIL', 'critical', 'failure');
    const s = buildAuditSeverityOutcomeMatrix('BIL', drainList(store, 'BIL'), NOW);
    // iteration order: critical first, success first
    expect(s.peak_cell?.severity).toBe('critical');
    expect(s.peak_cell?.outcome).toBe('success');
  });

  test('null when zero events', () => {
    const s = buildAuditSeverityOutcomeMatrix('BIL', [], NOW);
    expect(s.peak_cell).toBeNull();
  });
});

describe('M15.15 — empty_cells', () => {
  test('canonical row-major order (severity outer × outcome inner)', () => {
    const store = new InMemoryAuditTrailStore();
    // Hit only critical/success — leaves 8 empty cells
    record(store, 'BIL', 'critical', 'success');
    const s = buildAuditSeverityOutcomeMatrix('BIL', drainList(store, 'BIL'), NOW);
    expect(s.empty_cells.length).toBe(8);
    // First empty should be (critical, failure)
    expect(s.empty_cells[0]).toEqual({ severity: 'critical', outcome: 'failure' });
    // Last empty should be (info, denied)
    expect(s.empty_cells[s.empty_cells.length - 1]).toEqual({
      severity: 'info',
      outcome: 'denied',
    });
  });

  test('Σ empty + non-empty = 9 partition invariant', () => {
    const store = new InMemoryAuditTrailStore();
    record(store, 'BIL', 'critical', 'success');
    record(store, 'BIL', 'warning', 'failure');
    const s = buildAuditSeverityOutcomeMatrix('BIL', drainList(store, 'BIL'), NOW);
    const nonEmpty = 9 - s.empty_cells.length;
    expect(nonEmpty).toBe(2);
  });
});

describe('M15.15 — most_failing_severity', () => {
  test('severity with most failure+denied combined', () => {
    const store = new InMemoryAuditTrailStore();
    // critical: 1 failure + 1 denied = 2
    // warning: 3 failure = 3
    // info: 1 denied = 1
    record(store, 'BIL', 'critical', 'failure');
    record(store, 'BIL', 'critical', 'denied');
    record(store, 'BIL', 'warning', 'failure');
    record(store, 'BIL', 'warning', 'failure');
    record(store, 'BIL', 'warning', 'failure');
    record(store, 'BIL', 'info', 'denied');
    const s = buildAuditSeverityOutcomeMatrix('BIL', drainList(store, 'BIL'), NOW);
    expect(s.most_failing_severity).toBe('warning');
  });

  test('success-only events → most_failing_severity null', () => {
    const store = new InMemoryAuditTrailStore();
    record(store, 'BIL', 'critical', 'success');
    record(store, 'BIL', 'warning', 'success');
    const s = buildAuditSeverityOutcomeMatrix('BIL', drainList(store, 'BIL'), NOW);
    expect(s.most_failing_severity).toBeNull();
  });

  test('canonical tie-break: critical wins over warning at tied failure-count', () => {
    const store = new InMemoryAuditTrailStore();
    record(store, 'BIL', 'critical', 'failure');
    record(store, 'BIL', 'warning', 'failure');
    const s = buildAuditSeverityOutcomeMatrix('BIL', drainList(store, 'BIL'), NOW);
    expect(s.most_failing_severity).toBe('critical');
  });
});

describe('M15.15 — most_critical_outcome', () => {
  test('outcome with most critical-severity events', () => {
    const store = new InMemoryAuditTrailStore();
    record(store, 'BIL', 'critical', 'success');
    record(store, 'BIL', 'critical', 'failure');
    record(store, 'BIL', 'critical', 'failure');
    const s = buildAuditSeverityOutcomeMatrix('BIL', drainList(store, 'BIL'), NOW);
    expect(s.most_critical_outcome).toBe('failure');
  });

  test('null when no critical-severity events', () => {
    const store = new InMemoryAuditTrailStore();
    record(store, 'BIL', 'warning', 'failure');
    const s = buildAuditSeverityOutcomeMatrix('BIL', drainList(store, 'BIL'), NOW);
    expect(s.most_critical_outcome).toBeNull();
  });

  test('canonical tie-break: success wins over failure at tied critical-count', () => {
    const store = new InMemoryAuditTrailStore();
    record(store, 'BIL', 'critical', 'success');
    record(store, 'BIL', 'critical', 'failure');
    const s = buildAuditSeverityOutcomeMatrix('BIL', drainList(store, 'BIL'), NOW);
    expect(s.most_critical_outcome).toBe('success');
  });
});

describe('M15.15 — tenant scoping', () => {
  test('BIL events invisible to BANK_DEMO', () => {
    const store = new InMemoryAuditTrailStore();
    record(store, 'BIL', 'critical', 'failure');
    const bilEvents = drainList(store, 'BIL');
    const bankEvents = drainList(store, 'BANK_DEMO');
    const bil = buildAuditSeverityOutcomeMatrix('BIL', bilEvents, NOW);
    const bank = buildAuditSeverityOutcomeMatrix('BANK_DEMO', bankEvents, NOW);
    expect(bil.total_events).toBe(1);
    expect(bank.total_events).toBe(0);
  });
});

describe('M15.15 — tenant_id + generated_at echo', () => {
  test('envelope echoes inputs', () => {
    const s = buildAuditSeverityOutcomeMatrix('BIL', [], NOW);
    expect(s.tenant_id).toBe('BIL');
    expect(s.generated_at).toBe(NOW.toISOString());
  });
});

// ─── Route tests ─────────────────────────────────────────────────────

describe('M15.15 — GET /v1/audit/severity-outcome-matrix', () => {
  test('admin → 200 with empty store', async () => {
    const { app } = makeSomApp('admin');
    const r = await request(app)
      .get('/v1/audit/severity-outcome-matrix')
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_events).toBe(0);
    expect(r.body.body.rows.length).toBe(3);
    expect(r.body.body.columns.length).toBe(3);
  });

  test('populated → reflects recorded events', async () => {
    const store = new InMemoryAuditTrailStore();
    record(store, 'BIL', 'critical', 'failure');
    record(store, 'BIL', 'critical', 'success');
    record(store, 'BIL', 'warning', 'failure');
    const { app } = makeSomApp('admin', store);
    const r = await request(app)
      .get('/v1/audit/severity-outcome-matrix')
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_events).toBe(3);
    expect(r.body.body.peak_cell).not.toBeNull();
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeSomApp('case_owner');
    const r = await request(app)
      .get('/v1/audit/severity-outcome-matrix')
      .set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('cross-tenant invisibility via HTTP', async () => {
    const store = new InMemoryAuditTrailStore();
    record(store, 'BIL', 'critical', 'failure');
    const { app } = makeSomApp('admin', store);
    const bankR = await request(app)
      .get('/v1/audit/severity-outcome-matrix')
      .set(TH_BANK);
    expect(bankR.status).toBe(200);
    expect(bankR.body.body.total_events).toBe(0);
    const bilR = await request(app)
      .get('/v1/audit/severity-outcome-matrix')
      .set(TH_BIL);
    expect(bilR.body.body.total_events).toBe(1);
  });

  test('M15.14 /v1/audit/resource-severity-matrix sibling regression still 200', async () => {
    const { app } = makeSomApp('admin');
    const r = await request(app)
      .get('/v1/audit/resource-severity-matrix')
      .set(TH_BIL);
    expect(r.status).toBe(200);
  });
});
