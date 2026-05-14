// services/bff/__tests__/scenario_clone_analysis.test.ts
//
// T6 M16.14 — Library scenario preset clone-from back-reference.

import request from 'supertest';
import { analyseScenarioCloneHistory } from '../src/scenario_clone_analysis';
import {
  InMemoryAuditTrailStore,
  type AuditEvent,
} from '../src/audit_trail';
import { listScenarioPresets } from '../src/scenario_library';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-14T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

let seq = 0;
function mkEvent(o: Partial<AuditEvent> & { action: string }): AuditEvent {
  seq += 1;
  return {
    event_id: o.event_id ?? `evt-${seq}`,
    ts: o.ts ?? NOW.toISOString(),
    tenant_id: o.tenant_id ?? 'BIL',
    actor_username: o.actor_username ?? 'alice',
    actor_role: o.actor_role ?? 'admin',
    action: o.action,
    resource_type: o.resource_type ?? 'scenario',
    resource_id: o.resource_id ?? 'sc-1',
    outcome: o.outcome ?? 'success',
    severity: o.severity ?? 'info',
    correlation_id: o.correlation_id ?? '',
    ip_address: o.ip_address ?? '',
    metadata: o.metadata ?? {},
    prev_hash: o.prev_hash ?? 'GENESIS',
    hash: o.hash ?? 'h' + seq,
  };
}

beforeEach(() => {
  seq = 0;
});

// ─── analyseScenarioCloneHistory — pure ──────────────────────────────

describe('M16.14 — empty audit chain', () => {
  test('no events → zero envelope', () => {
    const out = analyseScenarioCloneHistory([], 'lib_sc_baseline');
    expect(out.library_preset_id).toBe('lib_sc_baseline');
    expect(out.total_clones).toBe(0);
    expect(out.clones).toEqual([]);
    expect(out.latest_clone_at).toBeNull();
    expect(out.latest_cloner).toBeNull();
  });
});

describe('M16.14 — filter behaviour', () => {
  test('only scenario.create events with matching cloned_from contribute', () => {
    const events: AuditEvent[] = [
      // matching
      mkEvent({
        action: 'scenario.create',
        resource_id: 'sc_custom_1',
        metadata: { cloned_from: 'lib_a', name: 'Custom A', category: 'recession' },
      }),
      // wrong source
      mkEvent({
        action: 'scenario.create',
        resource_id: 'sc_custom_2',
        metadata: { cloned_from: 'lib_b' },
      }),
      // wrong action
      mkEvent({
        action: 'scenario.update',
        resource_id: 'sc_custom_3',
        metadata: { cloned_from: 'lib_a' },
      }),
      // wrong resource_type
      mkEvent({
        action: 'scenario.create',
        resource_type: 'rule',
        resource_id: 'r_1',
        metadata: { cloned_from: 'lib_a' },
      }),
      // no metadata
      mkEvent({ action: 'scenario.create', resource_id: 'sc_custom_4', metadata: {} }),
    ];
    const out = analyseScenarioCloneHistory(events, 'lib_a');
    expect(out.total_clones).toBe(1);
    expect(out.clones[0]!.custom_preset_id).toBe('sc_custom_1');
    expect(out.clones[0]!.name).toBe('Custom A');
    expect(out.clones[0]!.category).toBe('recession');
  });
});

describe('M16.14 — ordering', () => {
  test('newest-first by cloned_at; tie-break by custom_preset_id asc', () => {
    const ts = '2026-05-14T10:00:00.000Z';
    const events: AuditEvent[] = [
      mkEvent({ action: 'scenario.create', resource_id: 'sc_old', ts: '2026-05-01T10:00:00.000Z', metadata: { cloned_from: 'lib' } }),
      mkEvent({ action: 'scenario.create', resource_id: 'sc_new_b', ts, metadata: { cloned_from: 'lib' } }),
      mkEvent({ action: 'scenario.create', resource_id: 'sc_new_a', ts, metadata: { cloned_from: 'lib' } }),
    ];
    const out = analyseScenarioCloneHistory(events, 'lib');
    expect(out.clones.map((c) => c.custom_preset_id)).toEqual(['sc_new_a', 'sc_new_b', 'sc_old']);
    expect(out.latest_clone_at).toBe(ts);
  });
});

describe('M16.14 — null optional metadata', () => {
  test('absent name / category surface as null', () => {
    const events: AuditEvent[] = [
      mkEvent({
        action: 'scenario.create',
        resource_id: 'sc_1',
        metadata: { cloned_from: 'lib' },
      }),
    ];
    const out = analyseScenarioCloneHistory(events, 'lib');
    expect(out.clones[0]!.name).toBeNull();
    expect(out.clones[0]!.category).toBeNull();
  });
});

// ─── GET /v1/scenarios/library/:preset_id/clones-in-tenant ───────────

function makeCloneApp(role = 'admin') {
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

describe('M16.14 — GET /v1/scenarios/library/:preset_id/clones-in-tenant', () => {
  test('unknown library preset → 404 unknown_preset', async () => {
    const { app } = makeCloneApp('admin');
    const r = await request(app)
      .get('/v1/scenarios/library/not-a-real-preset/clones-in-tenant')
      .set(TH_BIL);
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('EWS_404_unknown_preset');
  });

  test('known library preset with zero clones → 200 zero envelope', async () => {
    const { app } = makeCloneApp('admin');
    const libPreset = listScenarioPresets()[0]!;
    const r = await request(app)
      .get(`/v1/scenarios/library/${libPreset.id}/clones-in-tenant`)
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.library_preset_id).toBe(libPreset.id);
    expect(r.body.body.total_clones).toBe(0);
  });

  test('manually-recorded clone event surfaces in back-reference', async () => {
    const { app, auditTrailStore } = makeCloneApp('admin');
    const libPreset = listScenarioPresets()[0]!;
    // Hand-record a scenario.create event with cloned_from metadata
    // (simulating what the M16.8/M16.9 clone routes write).
    auditTrailStore.record(
      'BIL',
      {
        actor_username: 'alice',
        actor_role: 'admin',
        action: 'scenario.create',
        resource_type: 'scenario',
        resource_id: 'sc_custom_xyz',
        outcome: 'success',
        severity: 'info',
        metadata: { cloned_from: libPreset.id, name: 'My recession variant' },
      },
      NOW,
    );
    const r = await request(app)
      .get(`/v1/scenarios/library/${libPreset.id}/clones-in-tenant`)
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_clones).toBe(1);
    expect(r.body.body.clones[0].custom_preset_id).toBe('sc_custom_xyz');
    expect(r.body.body.clones[0].name).toBe('My recession variant');
    expect(r.body.body.latest_cloner).toBe('alice');
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeCloneApp('case_owner');
    const libPreset = listScenarioPresets()[0]!;
    const r = await request(app)
      .get(`/v1/scenarios/library/${libPreset.id}/clones-in-tenant`)
      .set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('cross-tenant: BIL clone invisible to BANK_DEMO', async () => {
    const { app, auditTrailStore } = makeCloneApp('admin');
    const libPreset = listScenarioPresets()[0]!;
    auditTrailStore.record(
      'BIL',
      {
        actor_username: 'alice',
        actor_role: 'admin',
        action: 'scenario.create',
        resource_type: 'scenario',
        resource_id: 'sc_bil_only',
        outcome: 'success',
        severity: 'info',
        metadata: { cloned_from: libPreset.id },
      },
      NOW,
    );
    const r = await request(app)
      .get(`/v1/scenarios/library/${libPreset.id}/clones-in-tenant`)
      .set('X-Tenant-ID', 'BANK_DEMO')
      .set('X-Channel', 'API');
    expect(r.status).toBe(200);
    expect(r.body.body.total_clones).toBe(0);
  });
});
