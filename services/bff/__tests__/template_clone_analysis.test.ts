// services/bff/__tests__/template_clone_analysis.test.ts
//
// T6 M5.13 — Rule template clone-from-library back-reference.

import request from 'supertest';
import { analyseTemplateCloneHistory } from '../src/template_clone_analysis';
import {
  InMemoryAuditTrailStore,
  type AuditEvent,
} from '../src/audit_trail';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';
import {
  defaultCustomRuleTemplateStore,
  InMemoryCustomRuleTemplateStore,
} from '../src/rule_templates_custom';
import { listTemplates as listRuleTemplates } from '../src/rule_templates';

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
    resource_type: o.resource_type ?? 'rule',
    resource_id: o.resource_id ?? 'custom-1',
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

// ─── analyseTemplateCloneHistory — pure ──────────────────────────────

describe('M5.13 — empty audit chain', () => {
  test('no events → zero envelope', () => {
    const out = analyseTemplateCloneHistory([], 'tpl_lib_a');
    expect(out.library_template_id).toBe('tpl_lib_a');
    expect(out.total_clones).toBe(0);
    expect(out.clones).toEqual([]);
    expect(out.latest_clone_at).toBeNull();
    expect(out.latest_cloner).toBeNull();
  });
});

describe('M5.13 — filter behaviour', () => {
  test('only rule.create events with matching cloned_from contribute', () => {
    const events: AuditEvent[] = [
      // matching
      mkEvent({
        action: 'rule.create',
        resource_id: 'tpl_custom_1',
        metadata: { cloned_from: 'tpl_lib_a', name: 'Custom A', vertical: 'banking', category: 'fraud' },
      }),
      // wrong source template
      mkEvent({
        action: 'rule.create',
        resource_id: 'tpl_custom_2',
        metadata: { cloned_from: 'tpl_lib_b' },
      }),
      // wrong action
      mkEvent({
        action: 'rule.update',
        resource_id: 'tpl_custom_3',
        metadata: { cloned_from: 'tpl_lib_a' },
      }),
      // wrong resource_type
      mkEvent({
        action: 'rule.create',
        resource_type: 'scenario',
        resource_id: 'sc_1',
        metadata: { cloned_from: 'tpl_lib_a' },
      }),
      // no metadata
      mkEvent({ action: 'rule.create', resource_id: 'tpl_custom_4', metadata: {} }),
    ];
    const out = analyseTemplateCloneHistory(events, 'tpl_lib_a');
    expect(out.total_clones).toBe(1);
    expect(out.clones[0]!.custom_template_id).toBe('tpl_custom_1');
    expect(out.clones[0]!.name).toBe('Custom A');
    expect(out.clones[0]!.vertical).toBe('banking');
    expect(out.clones[0]!.category).toBe('fraud');
  });
});

describe('M5.13 — ordering', () => {
  test('clones sorted newest-first by cloned_at', () => {
    const events: AuditEvent[] = [
      mkEvent({
        action: 'rule.create',
        resource_id: 'tpl_old',
        ts: '2026-05-01T10:00:00.000Z',
        metadata: { cloned_from: 'tpl_lib_a' },
      }),
      mkEvent({
        action: 'rule.create',
        resource_id: 'tpl_new',
        ts: '2026-05-14T10:00:00.000Z',
        metadata: { cloned_from: 'tpl_lib_a' },
      }),
      mkEvent({
        action: 'rule.create',
        resource_id: 'tpl_mid',
        ts: '2026-05-07T10:00:00.000Z',
        metadata: { cloned_from: 'tpl_lib_a' },
      }),
    ];
    const out = analyseTemplateCloneHistory(events, 'tpl_lib_a');
    expect(out.clones.map((c) => c.custom_template_id)).toEqual([
      'tpl_new',
      'tpl_mid',
      'tpl_old',
    ]);
    expect(out.latest_clone_at).toBe('2026-05-14T10:00:00.000Z');
  });

  test('ties on cloned_at broken by custom_template_id asc', () => {
    const ts = '2026-05-14T10:00:00.000Z';
    const events: AuditEvent[] = [
      mkEvent({ action: 'rule.create', resource_id: 'tpl_b', ts, metadata: { cloned_from: 'lib' } }),
      mkEvent({ action: 'rule.create', resource_id: 'tpl_a', ts, metadata: { cloned_from: 'lib' } }),
      mkEvent({ action: 'rule.create', resource_id: 'tpl_c', ts, metadata: { cloned_from: 'lib' } }),
    ];
    const out = analyseTemplateCloneHistory(events, 'lib');
    expect(out.clones.map((c) => c.custom_template_id)).toEqual(['tpl_a', 'tpl_b', 'tpl_c']);
  });
});

describe('M5.13 — missing optional metadata', () => {
  test('absent name / vertical / category surface as null', () => {
    const events: AuditEvent[] = [
      mkEvent({
        action: 'rule.create',
        resource_id: 'tpl_1',
        metadata: { cloned_from: 'lib' },
      }),
    ];
    const out = analyseTemplateCloneHistory(events, 'lib');
    expect(out.clones[0]!.name).toBeNull();
    expect(out.clones[0]!.vertical).toBeNull();
    expect(out.clones[0]!.category).toBeNull();
    expect(out.clones[0]!.cloned_by).toBe('alice');
  });
});

// ─── GET /v1/rules/templates/:template_id/clones-in-tenant ────────────

function makeCloneApp(role = 'admin') {
  const auditTrailStore = new InMemoryAuditTrailStore();
  const customRuleTemplateStore = new InMemoryCustomRuleTemplateStore();
  const built = makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    auditTrailStore,
    customRuleTemplateStore,
    now: () => NOW,
    getRole: () => role,
  });
  return { ...built, auditTrailStore, customRuleTemplateStore };
}

describe('M5.13 — GET /v1/rules/templates/:template_id/clones-in-tenant', () => {
  test('unknown library template → 404 unknown_template', async () => {
    const { app } = makeCloneApp('admin');
    const r = await request(app)
      .get('/v1/rules/templates/totally-not-a-template/clones-in-tenant')
      .set(TH_BIL);
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('EWS_404_unknown_template');
  });

  test('known library template with zero clones → 200 zero envelope', async () => {
    const { app } = makeCloneApp('admin');
    const libTpl = listRuleTemplates()[0]!;
    const r = await request(app)
      .get(`/v1/rules/templates/${libTpl.id}/clones-in-tenant`)
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.library_template_id).toBe(libTpl.id);
    expect(r.body.body.total_clones).toBe(0);
    expect(r.body.body.clones).toEqual([]);
  });

  test('clone-from-library surfaces in the back-reference', async () => {
    const { app } = makeCloneApp('admin');
    const libTpl = listRuleTemplates()[0]!;
    // Use the existing M5.9 clone-from-library route to record a clone
    // (which also writes the rule.create audit event).
    const cloneResp = await request(app)
      .post('/v1/rules/templates/custom/clone-from-library')
      .set(TH_BIL)
      .set('x-apex-user', 'alice')
      .send({ source_template_id: libTpl.id, name: 'M5.13 clone test' });
    expect(cloneResp.status).toBe(201);
    const customId = cloneResp.body.body.id;
    const r = await request(app)
      .get(`/v1/rules/templates/${libTpl.id}/clones-in-tenant`)
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_clones).toBe(1);
    expect(r.body.body.clones[0].custom_template_id).toBe(customId);
    expect(r.body.body.clones[0].cloned_by).toBe('alice');
    expect(r.body.body.latest_cloner).toBe('alice');
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeCloneApp('case_owner');
    const libTpl = listRuleTemplates()[0]!;
    const r = await request(app)
      .get(`/v1/rules/templates/${libTpl.id}/clones-in-tenant`)
      .set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('cross-tenant: BIL clones invisible to BANK_DEMO', async () => {
    const { app } = makeCloneApp('admin');
    const libTpl = listRuleTemplates()[0]!;
    await request(app)
      .post('/v1/rules/templates/custom/clone-from-library')
      .set(TH_BIL)
      .set('x-apex-user', 'alice')
      .send({ source_template_id: libTpl.id });
    const r = await request(app)
      .get(`/v1/rules/templates/${libTpl.id}/clones-in-tenant`)
      .set('X-Tenant-ID', 'BANK_DEMO')
      .set('X-Channel', 'API');
    expect(r.status).toBe(200);
    expect(r.body.body.total_clones).toBe(0);
  });
});

// reference the import so eslint doesn't strip it; used implicitly
// via the shared singleton in default store paths
void defaultCustomRuleTemplateStore;
