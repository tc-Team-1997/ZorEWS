// services/bff/__tests__/ews_rules_versions.test.ts
//
// Rules-Plus RP-1 — versions store + helpers + routes.

import request from 'supertest';
import {
  InMemoryEwsRuleVersionsStore,
  RULE_VERSIONS_CAP_PER_RULE,
  SEMVER_INITIAL,
  approveWithFourEyes,
  bumpSemver,
  buildCloneInput,
  classifyEditBump,
  compareSemver,
  diffRuleSnapshots,
  isSemver,
  parseSemver,
  rejectWithFourEyes,
} from '../src/ews_rules_versions';
import {
  EwsRuleError,
  InMemoryEwsRuleStore,
  type EwsRule,
} from '../src/ews_rules';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-06T15:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

const VALID = {
  rule_id: 'RULE_CREDIT_001',
  name: 'High EMI Bounce Risk',
  category: 'credit',
  description: '3+ EMI bounces in 90 days',
  conditions: [{ field: 'emi_bounce_count_90d', operator: '>=', value: 3 }],
  logic: 'AND',
  action: { alert_severity: 'RED', weight: 25 },
};

// ─── SemVer ──────────────────────────────────────────────────────────

describe('RP-1 — SemVer helpers', () => {
  test('isSemver guard', () => {
    expect(isSemver('0.1.0')).toBe(true);
    expect(isSemver('1.4.0')).toBe(true);
    expect(isSemver('10.20.30')).toBe(true);
    expect(isSemver('1.0')).toBe(false);
    expect(isSemver('v1.0.0')).toBe(false);
    expect(isSemver('1.0.0-rc1')).toBe(false);
    expect(isSemver(undefined)).toBe(false);
  });

  test('parseSemver', () => {
    expect(parseSemver('1.4.0')).toEqual({ major: 1, minor: 4, patch: 0 });
    expect(() => parseSemver('bad')).toThrow(/SemVer/);
  });

  test('bumpSemver: minor zeroes patch; major zeroes minor + patch', () => {
    expect(bumpSemver('1.4.0', 'minor')).toBe('1.5.0');
    expect(bumpSemver('1.4.7', 'minor')).toBe('1.5.0');
    expect(bumpSemver('1.4.0', 'patch')).toBe('1.4.1');
    expect(bumpSemver('1.4.0', 'major')).toBe('2.0.0');
    expect(bumpSemver('0.1.0', 'major')).toBe('1.0.0');
  });

  test('compareSemver', () => {
    expect(compareSemver('1.4.0', '1.5.0')).toBe(-1);
    expect(compareSemver('1.5.0', '1.4.0')).toBe(1);
    expect(compareSemver('1.4.0', '1.4.0')).toBe(0);
    expect(compareSemver('2.0.0', '1.99.99')).toBe(1);
  });

  test('SEMVER_INITIAL = 0.1.0', () => {
    expect(SEMVER_INITIAL).toBe('0.1.0');
  });
});

// ─── classifyEditBump ────────────────────────────────────────────────

function mkRule(over: Partial<EwsRule> = {}): EwsRule {
  return {
    rule_id: 'RULE_X_001',
    tenant_id: 'BIL',
    name: 'r',
    category: 'credit',
    description: 'd',
    conditions: [{ field: 'emi_bounce_count_90d', operator: '>=', value: 3 }],
    logic: 'AND',
    action: { alert_severity: 'RED', weight: 25 },
    is_active: true,
    state: 'active',
    version: 1,
    tags: [],
    created_by: 'admin',
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
    deprecated_at: null,
    ...over,
  };
}

describe('RP-1 — classifyEditBump', () => {
  test('substantive condition change → MINOR', () => {
    const a = mkRule();
    const b = mkRule({
      conditions: [{ field: 'emi_bounce_count_90d', operator: '>=', value: 5 }],
    });
    expect(classifyEditBump(a, b)).toBe('minor');
  });

  test('action weight change → MINOR', () => {
    const a = mkRule();
    const b = mkRule({ action: { alert_severity: 'RED', weight: 50 } });
    expect(classifyEditBump(a, b)).toBe('minor');
  });

  test('name-only change → PATCH', () => {
    const a = mkRule();
    const b = mkRule({ name: 'Renamed' });
    expect(classifyEditBump(a, b)).toBe('patch');
  });

  test('description-only change → PATCH', () => {
    const a = mkRule();
    const b = mkRule({ description: 'd2' });
    expect(classifyEditBump(a, b)).toBe('patch');
  });

  test('tag set change → PATCH', () => {
    const a = mkRule();
    const b = mkRule({ tags: ['urgent'] });
    expect(classifyEditBump(a, b)).toBe('patch');
  });

  test('logic AND → OR → MINOR', () => {
    const a = mkRule();
    const b = mkRule({ logic: 'OR' });
    expect(classifyEditBump(a, b)).toBe('minor');
  });
});

// ─── diffRuleSnapshots ───────────────────────────────────────────────

describe('RP-1 — diffRuleSnapshots', () => {
  test('no change → empty diff', () => {
    expect(diffRuleSnapshots(mkRule(), mkRule())).toEqual([]);
  });

  test('lists changed fields with before/after', () => {
    const a = mkRule({ name: 'Old' });
    const b = mkRule({
      name: 'New',
      action: { alert_severity: 'ORANGE', weight: 30 },
    });
    const diff = diffRuleSnapshots(a, b);
    const fields = diff.map((d) => d.field).sort();
    expect(fields).toEqual(['action', 'name']);
    const nameDiff = diff.find((d) => d.field === 'name');
    expect(nameDiff?.before).toBe('Old');
    expect(nameDiff?.after).toBe('New');
  });

  test('does NOT include identical fields', () => {
    const diff = diffRuleSnapshots(mkRule({ name: 'X' }), mkRule({ name: 'X' }));
    expect(diff).toEqual([]);
  });
});

// ─── buildCloneInput ─────────────────────────────────────────────────

describe('RP-1 — buildCloneInput', () => {
  test('happy: copies all fields with new id + name prefix', () => {
    const src = mkRule({ name: 'Original', tags: ['x', 'y'] });
    const out = buildCloneInput(src, { new_rule_id: 'RULE_CLONE_001' });
    expect(out.rule_id).toBe('RULE_CLONE_001');
    expect(out.name).toBe('Copy of Original');
    expect(out.category).toBe(src.category);
    expect(out.tags).toEqual(['x', 'y']);
    expect(out.action).toEqual(src.action);
  });

  test('custom new_name honoured', () => {
    const out = buildCloneInput(mkRule(), {
      new_rule_id: 'RULE_X_002',
      new_name: 'Renamed clone',
    });
    expect(out.name).toBe('Renamed clone');
  });

  test('rejects bad new_rule_id format', () => {
    expect(() => buildCloneInput(mkRule(), { new_rule_id: 'bad-id' })).toThrow(
      /new_rule_id/,
    );
  });

  test('cloned condition arrays are independent', () => {
    const src = mkRule();
    const out = buildCloneInput(src, { new_rule_id: 'RULE_X_002' });
    out.conditions[0]!.value = 999;
    expect(src.conditions[0]!.value).toBe(3);
  });
});

// ─── InMemoryEwsRuleVersionsStore ────────────────────────────────────

describe('RP-1 — InMemoryEwsRuleVersionsStore', () => {
  test('recordVersion + listVersions newest-first', () => {
    const s = new InMemoryEwsRuleVersionsStore();
    s.recordVersion({ tenant_id: 'BIL', rule: mkRule(), semver: '0.1.0', created_by: 'admin', now: NOW });
    s.recordVersion({ tenant_id: 'BIL', rule: mkRule(), semver: '0.2.0', created_by: 'admin', now: NOW });
    s.recordVersion({ tenant_id: 'BIL', rule: mkRule(), semver: '1.0.0', created_by: 'admin', now: NOW });
    const items = s.listVersions('BIL', 'RULE_X_001');
    expect(items.map((v) => v.semver)).toEqual(['1.0.0', '0.2.0', '0.1.0']);
  });

  test('latestSemver returns highest by SemVer order', () => {
    const s = new InMemoryEwsRuleVersionsStore();
    s.recordVersion({ tenant_id: 'BIL', rule: mkRule(), semver: '0.1.0', created_by: 'a', now: NOW });
    s.recordVersion({ tenant_id: 'BIL', rule: mkRule(), semver: '0.10.0', created_by: 'a', now: NOW });
    expect(s.latestSemver('BIL', 'RULE_X_001')).toBe('0.10.0');
  });

  test('duplicate semver rejected', () => {
    const s = new InMemoryEwsRuleVersionsStore();
    s.recordVersion({ tenant_id: 'BIL', rule: mkRule(), semver: '0.1.0', created_by: 'a', now: NOW });
    try {
      s.recordVersion({ tenant_id: 'BIL', rule: mkRule(), semver: '0.1.0', created_by: 'a', now: NOW });
      fail('expected throw');
    } catch (e) {
      expect((e as EwsRuleError).code).toBe('duplicate_semver');
    }
  });

  test('FIFO eviction at cap', () => {
    const s = new InMemoryEwsRuleVersionsStore();
    for (let i = 1; i <= RULE_VERSIONS_CAP_PER_RULE + 5; i++) {
      s.recordVersion({
        tenant_id: 'BIL',
        rule: mkRule(),
        semver: `0.${i}.0`,
        created_by: 'a',
        now: NOW,
      });
    }
    expect(s.listVersions('BIL', 'RULE_X_001').length).toBe(RULE_VERSIONS_CAP_PER_RULE);
  });

  test('cross-tenant isolation', () => {
    const s = new InMemoryEwsRuleVersionsStore();
    s.recordVersion({ tenant_id: 'BIL', rule: mkRule(), semver: '0.1.0', created_by: 'a', now: NOW });
    expect(s.listVersions('BANK_DEMO', 'RULE_X_001')).toEqual([]);
  });
});

describe('RP-1 — approval ledger', () => {
  test('recordSubmission creates a pending row', () => {
    const s = new InMemoryEwsRuleVersionsStore();
    const a = s.recordSubmission({ tenant_id: 'BIL', rule_id: 'R', maker_username: 'jane', now: NOW });
    expect(a.decision).toBe('pending');
    expect(a.maker_username).toBe('jane');
    expect(a.approver_username).toBeNull();
    expect(s.pendingApproval('BIL', 'R')?.maker_username).toBe('jane');
  });

  test('re-submitting withdraws prior pending', () => {
    const s = new InMemoryEwsRuleVersionsStore();
    s.recordSubmission({ tenant_id: 'BIL', rule_id: 'R', maker_username: 'jane', now: NOW });
    s.recordSubmission({
      tenant_id: 'BIL',
      rule_id: 'R',
      maker_username: 'jane',
      now: new Date(NOW.getTime() + 60_000),
    });
    const list = s.listApprovals('BIL', 'R');
    expect(list.find((a) => a.decision === 'pending')).toBeDefined();
    expect(list.find((a) => a.decision === 'withdrawn')).toBeDefined();
  });

  test('recordDecision: approved + approver stamped', () => {
    const s = new InMemoryEwsRuleVersionsStore();
    s.recordSubmission({ tenant_id: 'BIL', rule_id: 'R', maker_username: 'jane', now: NOW });
    const a = s.recordDecision({
      tenant_id: 'BIL',
      rule_id: 'R',
      approver_username: 'bob',
      decision: 'approved',
      now: NOW,
    });
    expect(a.decision).toBe('approved');
    expect(a.approver_username).toBe('bob');
  });

  test('recordDecision: 4-eyes refusal when approver === maker', () => {
    const s = new InMemoryEwsRuleVersionsStore();
    s.recordSubmission({ tenant_id: 'BIL', rule_id: 'R', maker_username: 'jane', now: NOW });
    try {
      s.recordDecision({
        tenant_id: 'BIL',
        rule_id: 'R',
        approver_username: 'jane',
        decision: 'approved',
        now: NOW,
      });
      fail('expected throw');
    } catch (e) {
      expect((e as EwsRuleError).code).toBe('self_approval_refused');
    }
  });

  test('recordDecision with no pending → no_pending_approval', () => {
    const s = new InMemoryEwsRuleVersionsStore();
    try {
      s.recordDecision({
        tenant_id: 'BIL',
        rule_id: 'R',
        approver_username: 'bob',
        decision: 'approved',
        now: NOW,
      });
      fail('expected throw');
    } catch (e) {
      expect((e as EwsRuleError).code).toBe('no_pending_approval');
    }
  });
});

// ─── approveWithFourEyes / rejectWithFourEyes ────────────────────────

describe('RP-1 — 4-eyes wrappers', () => {
  function setup() {
    const ruleStore = new InMemoryEwsRuleStore();
    const versionsStore = new InMemoryEwsRuleVersionsStore();
    const r = ruleStore.create('BIL', VALID, 'jane', NOW);
    versionsStore.recordSubmission({ tenant_id: 'BIL', rule_id: r.rule_id, maker_username: 'jane', now: NOW });
    return { ruleStore, versionsStore };
  }

  test('approve: bob approves jane\'s rule → ACTIVE', () => {
    const { ruleStore, versionsStore } = setup();
    const out = approveWithFourEyes(ruleStore, versionsStore, {
      tenant_id: 'BIL',
      rule_id: 'RULE_CREDIT_001',
      approver_username: 'bob',
      now: NOW,
    });
    expect(out.rule.state).toBe('active');
    expect(out.rule.is_active).toBe(true);
    expect(out.approval.approver_username).toBe('bob');
  });

  test('approve: jane self-approves → 4-eyes refused', () => {
    const { ruleStore, versionsStore } = setup();
    try {
      approveWithFourEyes(ruleStore, versionsStore, {
        tenant_id: 'BIL',
        rule_id: 'RULE_CREDIT_001',
        approver_username: 'jane',
        now: NOW,
      });
      fail('expected throw');
    } catch (e) {
      expect((e as EwsRuleError).code).toBe('self_approval_refused');
    }
  });

  test('reject: requires reason', () => {
    const { ruleStore, versionsStore } = setup();
    expect(() =>
      rejectWithFourEyes(ruleStore, versionsStore, {
        tenant_id: 'BIL',
        rule_id: 'RULE_CREDIT_001',
        approver_username: 'bob',
        reason: '',
        now: NOW,
      }),
    ).toThrow(/reason/);
  });

  test('reject: records decision + rule stays in pending_review', () => {
    const { ruleStore, versionsStore } = setup();
    // Existing store auto-flipped to ASSIGNED on create with assignee — no, it
    // only flips on assigned_to. Without it the rule is in 'draft'. Submit it.
    ruleStore.submit('BIL', 'RULE_CREDIT_001', NOW);
    const out = rejectWithFourEyes(ruleStore, versionsStore, {
      tenant_id: 'BIL',
      rule_id: 'RULE_CREDIT_001',
      approver_username: 'bob',
      reason: 'too aggressive — relax weight',
      now: NOW,
    });
    expect(out.approval.decision).toBe('rejected');
    expect(out.approval.reason).toContain('relax weight');
    expect(out.rule.state).toBe('pending_review');
  });

  test('reject: 4-eyes refused on self', () => {
    const { ruleStore, versionsStore } = setup();
    ruleStore.submit('BIL', 'RULE_CREDIT_001', NOW);
    try {
      rejectWithFourEyes(ruleStore, versionsStore, {
        tenant_id: 'BIL',
        rule_id: 'RULE_CREDIT_001',
        approver_username: 'jane',
        reason: 'changed my mind',
        now: NOW,
      });
      fail('expected throw');
    } catch (e) {
      expect((e as EwsRuleError).code).toBe('self_approval_refused');
    }
  });
});

// ─── Routes ──────────────────────────────────────────────────────────

function makeAppR(role = 'admin') {
  const ewsRuleStore = new InMemoryEwsRuleStore();
  const ewsRuleVersionsStore = new InMemoryEwsRuleVersionsStore();
  const built = makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    ewsRuleStore,
    ewsRuleVersionsStore,
    now: () => NOW,
    getRole: () => role,
  });
  return { ...built, ewsRuleStore, ewsRuleVersionsStore };
}

async function createRule(app: Parameters<typeof request>[0], maker = 'jane', body = VALID) {
  const r = await request(app)
    .post('/v1/ews/rules')
    .set(TH_BIL)
    .set('X-APEX-USER', maker)
    .send(body);
  return r.body.body.rule_id as string;
}

describe('RP-1 — POST /v1/ews/rules/:id/clone', () => {
  test('happy: 201 fresh DRAFT v0.1.0', async () => {
    const { app, ewsRuleVersionsStore } = makeAppR('admin');
    await createRule(app);
    const r = await request(app)
      .post('/v1/ews/rules/RULE_CREDIT_001/clone')
      .set(TH_BIL)
      .set('X-APEX-USER', 'taniya')
      .send({ new_rule_id: 'RULE_CREDIT_002', new_name: 'My clone' });
    expect(r.status).toBe(201);
    expect(r.body.body.rule.rule_id).toBe('RULE_CREDIT_002');
    expect(r.body.body.rule.state).toBe('draft');
    expect(r.body.body.rule.name).toBe('My clone');
    expect(r.body.body.semver).toBe('0.1.0');
    const versions = ewsRuleVersionsStore.listVersions('BIL', 'RULE_CREDIT_002');
    expect(versions).toHaveLength(1);
    expect(versions[0]!.semver).toBe('0.1.0');
  });

  test('clone of unknown rule → 404', async () => {
    const { app } = makeAppR('admin');
    const r = await request(app)
      .post('/v1/ews/rules/RULE_NONE/clone')
      .set(TH_BIL)
      .send({ new_rule_id: 'RULE_X_002' });
    expect(r.status).toBe(404);
  });

  test('clone duplicate rule_id → 409', async () => {
    const { app } = makeAppR('admin');
    await createRule(app);
    const r = await request(app)
      .post('/v1/ews/rules/RULE_CREDIT_001/clone')
      .set(TH_BIL)
      .send({ new_rule_id: 'RULE_CREDIT_001' });
    expect(r.status).toBe(409);
  });

  test('missing new_rule_id → 400', async () => {
    const { app } = makeAppR('admin');
    await createRule(app);
    const r = await request(app)
      .post('/v1/ews/rules/RULE_CREDIT_001/clone')
      .set(TH_BIL)
      .send({});
    expect(r.status).toBe(400);
  });
});

describe('RP-1 — POST /submit + /approve + /reject', () => {
  test('full happy path: submit by jane → approve by bob → ACTIVE', async () => {
    const { app, ewsRuleStore } = makeAppR('admin');
    await createRule(app, 'jane');
    const sub = await request(app)
      .post('/v1/ews/rules/RULE_CREDIT_001/submit')
      .set(TH_BIL)
      .set('X-APEX-USER', 'jane')
      .send({ reason: 'ready for review' });
    expect(sub.status).toBe(200);
    expect(sub.body.body.approval.decision).toBe('pending');
    const app1 = await request(app)
      .post('/v1/ews/rules/RULE_CREDIT_001/approve')
      .set(TH_BIL)
      .set('X-APEX-USER', 'bob')
      .send({});
    expect(app1.status).toBe(200);
    expect(app1.body.body.rule.state).toBe('active');
    expect(app1.body.body.approval.approver_username).toBe('bob');
    expect(ewsRuleStore.get('BIL', 'RULE_CREDIT_001')!.is_active).toBe(true);
  });

  test('self-approval refused: jane submits → jane approves → 403', async () => {
    const { app } = makeAppR('admin');
    await createRule(app, 'jane');
    await request(app)
      .post('/v1/ews/rules/RULE_CREDIT_001/submit')
      .set(TH_BIL)
      .set('X-APEX-USER', 'jane')
      .send({});
    const r = await request(app)
      .post('/v1/ews/rules/RULE_CREDIT_001/approve')
      .set(TH_BIL)
      .set('X-APEX-USER', 'jane')
      .send({});
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('EWS_403_self_approval_refused');
  });

  test('reject: bob rejects jane\'s submission with reason', async () => {
    const { app } = makeAppR('admin');
    await createRule(app, 'jane');
    await request(app)
      .post('/v1/ews/rules/RULE_CREDIT_001/submit')
      .set(TH_BIL)
      .set('X-APEX-USER', 'jane')
      .send({});
    const r = await request(app)
      .post('/v1/ews/rules/RULE_CREDIT_001/reject')
      .set(TH_BIL)
      .set('X-APEX-USER', 'bob')
      .send({ reason: 'too aggressive — relax weight' });
    expect(r.status).toBe(200);
    expect(r.body.body.approval.decision).toBe('rejected');
    expect(r.body.body.approval.reason).toContain('relax weight');
  });

  test('reject without reason → 400', async () => {
    const { app } = makeAppR('admin');
    await createRule(app, 'jane');
    await request(app)
      .post('/v1/ews/rules/RULE_CREDIT_001/submit')
      .set(TH_BIL)
      .set('X-APEX-USER', 'jane')
      .send({});
    const r = await request(app)
      .post('/v1/ews/rules/RULE_CREDIT_001/reject')
      .set(TH_BIL)
      .set('X-APEX-USER', 'bob')
      .send({});
    expect(r.status).toBe(400);
  });

  test('approve without pending submission → 409', async () => {
    const { app } = makeAppR('admin');
    await createRule(app, 'jane');
    const r = await request(app)
      .post('/v1/ews/rules/RULE_CREDIT_001/approve')
      .set(TH_BIL)
      .set('X-APEX-USER', 'bob')
      .send({});
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('EWS_409_no_pending_approval');
  });
});

describe('RP-1 — versions + diff routes', () => {
  test('GET /versions returns the snapshots', async () => {
    const { app, ewsRuleVersionsStore } = makeAppR('admin');
    await createRule(app);
    // Stamp two snapshots under the rule_id we just created
    ewsRuleVersionsStore.recordVersion({
      tenant_id: 'BIL',
      rule: mkRule({ rule_id: 'RULE_CREDIT_001' }),
      semver: '0.1.0',
      created_by: 'jane',
      now: NOW,
    });
    ewsRuleVersionsStore.recordVersion({
      tenant_id: 'BIL',
      rule: mkRule({ rule_id: 'RULE_CREDIT_001', name: 'Renamed' }),
      semver: '0.1.1',
      created_by: 'jane',
      now: NOW,
    });
    const r = await request(app)
      .get('/v1/ews/rules/RULE_CREDIT_001/versions')
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total).toBe(2);
    expect(r.body.body.latest_semver).toBe('0.1.1');
  });

  test('GET /versions/:semver single snapshot', async () => {
    const { app, ewsRuleVersionsStore } = makeAppR('admin');
    await createRule(app);
    ewsRuleVersionsStore.recordVersion({
      tenant_id: 'BIL',
      rule: mkRule({ rule_id: 'RULE_CREDIT_001' }),
      semver: '1.4.0',
      created_by: 'jane',
      now: NOW,
    });
    const r = await request(app)
      .get('/v1/ews/rules/RULE_CREDIT_001/versions/1.4.0')
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.semver).toBe('1.4.0');
  });

  test('GET /versions/:bad → 400', async () => {
    const { app } = makeAppR('admin');
    await createRule(app);
    const r = await request(app)
      .get('/v1/ews/rules/RULE_CREDIT_001/versions/bad')
      .set(TH_BIL);
    expect(r.status).toBe(400);
  });

  test('GET /versions/:missing → 404', async () => {
    const { app } = makeAppR('admin');
    await createRule(app);
    const r = await request(app)
      .get('/v1/ews/rules/RULE_CREDIT_001/versions/9.9.9')
      .set(TH_BIL);
    expect(r.status).toBe(404);
  });

  test('POST /versions/diff returns field-by-field diff', async () => {
    const { app, ewsRuleVersionsStore } = makeAppR('admin');
    await createRule(app);
    ewsRuleVersionsStore.recordVersion({
      tenant_id: 'BIL',
      rule: mkRule({ rule_id: 'RULE_CREDIT_001', name: 'A' }),
      semver: '1.0.0',
      created_by: 'jane',
      now: NOW,
    });
    ewsRuleVersionsStore.recordVersion({
      tenant_id: 'BIL',
      rule: mkRule({
        rule_id: 'RULE_CREDIT_001',
        name: 'B',
        action: { alert_severity: 'ORANGE', weight: 30 },
      }),
      semver: '1.1.0',
      created_by: 'jane',
      now: NOW,
    });
    const r = await request(app)
      .post('/v1/ews/rules/RULE_CREDIT_001/versions/diff')
      .set(TH_BIL)
      .send({ from: '1.0.0', to: '1.1.0' });
    expect(r.status).toBe(200);
    expect(r.body.body.change_count).toBe(2);
    const fields = r.body.body.diff.map((d: { field: string }) => d.field).sort();
    expect(fields).toEqual(['action', 'name']);
  });

  test('POST /versions/diff bad semver → 400', async () => {
    const { app } = makeAppR('admin');
    await createRule(app);
    const r = await request(app)
      .post('/v1/ews/rules/RULE_CREDIT_001/versions/diff')
      .set(TH_BIL)
      .send({ from: 'bad', to: '1.0.0' });
    expect(r.status).toBe(400);
  });
});

describe('RP-1 — GET /approvals', () => {
  test('returns full approval ledger newest-first + pending pointer', async () => {
    const { app } = makeAppR('admin');
    await createRule(app, 'jane');
    await request(app)
      .post('/v1/ews/rules/RULE_CREDIT_001/submit')
      .set(TH_BIL)
      .set('X-APEX-USER', 'jane')
      .send({});
    await request(app)
      .post('/v1/ews/rules/RULE_CREDIT_001/reject')
      .set(TH_BIL)
      .set('X-APEX-USER', 'bob')
      .send({ reason: 'r' });
    await request(app)
      .post('/v1/ews/rules/RULE_CREDIT_001/submit')
      .set(TH_BIL)
      .set('X-APEX-USER', 'jane')
      .send({});
    const r = await request(app)
      .get('/v1/ews/rules/RULE_CREDIT_001/approvals')
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total).toBe(2);
    expect(r.body.body.pending).not.toBeNull();
    expect(r.body.body.pending.maker_username).toBe('jane');
  });
});

describe('RP-1 — no-regression on existing EWS routes', () => {
  test('/v1/ews/rules/:id/test still works (untouched)', async () => {
    const { app } = makeAppR('admin');
    await createRule(app);
    const r = await request(app)
      .post('/v1/ews/rules/RULE_CREDIT_001/test')
      .set(TH_BIL)
      .send({ values: { emi_bounce_count_90d: 5 } });
    expect(r.status).toBe(200);
    expect(r.body.body.matched).toBe(true);
  });

  test('/v1/ews/rules/:id/activate still works (legacy path)', async () => {
    const { app } = makeAppR('admin');
    await createRule(app);
    const r = await request(app)
      .post('/v1/ews/rules/RULE_CREDIT_001/activate')
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.state).toBe('active');
  });
});
