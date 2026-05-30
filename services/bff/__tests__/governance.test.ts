// Enterprise Tenant Governance — backend test.
//
// Covers:
//   1. BranchStore CRUD + unique(tenant, code) + filters
//   2. ComplianceRuleStore CRUD + unique(country, regulator, code) + filters
//   3. requireBranchAccess middleware composability
//   4. Routes: /v1/governance/me + branches CRUD + compliance-rules CRUD

import express from 'express';
import request from 'supertest';
import {
  InMemoryBranchStore,
  buildDefaultBranchSeed,
} from '../src/governance/branch_store';
import {
  InMemoryComplianceRuleStore,
  buildDefaultComplianceSeed,
} from '../src/governance/compliance_store';
import {
  GovernanceError,
  isGovernanceDomain,
  isComplianceSeverity,
  isComplianceRequirementKind,
  COMPLIANCE_REQUIREMENT_KINDS,
  COMPLIANCE_SEVERITIES,
  GOVERNANCE_DOMAINS,
} from '../src/governance/types';
import { requireBranchAccess, extractBranchFromParam, extractBranchFromQuery } from '../src/governance/access_middleware';
import { makeApp } from '../src/server';

const NOW = new Date('2026-05-31T00:00:00Z');
const TH_BANK = { 'x-tenant-id': 'BANK_DEMO', 'x-channel': 'API', 'x-apex-user': 'alice.admin', 'x-apex-role': 'admin' };

// ── Constants + guards ───────────────────────────────────────────────

describe('Governance enums + guards', () => {
  test('GOVERNANCE_DOMAINS is exactly the closed 3', () => {
    expect([...GOVERNANCE_DOMAINS]).toEqual(['banking', 'insurance', 'both']);
  });
  test('COMPLIANCE_SEVERITIES is exactly 3', () => {
    expect([...COMPLIANCE_SEVERITIES]).toEqual(['mandatory', 'recommended', 'advisory']);
  });
  test('COMPLIANCE_REQUIREMENT_KINDS is exactly 7', () => {
    expect(COMPLIANCE_REQUIREMENT_KINDS.length).toBe(7);
    expect([...COMPLIANCE_REQUIREMENT_KINDS]).toContain('reporting');
    expect([...COMPLIANCE_REQUIREMENT_KINDS]).toContain('data_residency');
  });
  test('isGovernanceDomain accepts the 3, rejects others', () => {
    expect(isGovernanceDomain('banking')).toBe(true);
    expect(isGovernanceDomain('insurance')).toBe(true);
    expect(isGovernanceDomain('both')).toBe(true);
    expect(isGovernanceDomain('platform')).toBe(false);
    expect(isGovernanceDomain('')).toBe(false);
    expect(isGovernanceDomain(undefined)).toBe(false);
  });
  test('isComplianceSeverity + isComplianceRequirementKind', () => {
    expect(isComplianceSeverity('mandatory')).toBe(true);
    expect(isComplianceSeverity('garbage')).toBe(false);
    expect(isComplianceRequirementKind('kyc')).toBe(true);
    expect(isComplianceRequirementKind('garbage')).toBe(false);
  });
});

// ── BranchStore ─────────────────────────────────────────────────────

describe('InMemoryBranchStore', () => {
  test('list with empty store returns []', () => {
    const s = new InMemoryBranchStore();
    expect(s.list()).toEqual([]);
  });

  test('default seed has 11 branches across 7 tenants in IN + BT', () => {
    const seed = buildDefaultBranchSeed(NOW);
    expect(seed.length).toBe(11);
    const tenants = new Set(seed.map((b) => b.tenant_id));
    expect(tenants.size).toBe(7);
    const countries = new Set(seed.map((b) => b.country_code));
    expect([...countries].sort()).toEqual(['BT', 'IN']);
  });

  test('create + get round-trip', () => {
    const s = new InMemoryBranchStore();
    const b = s.create(
      { tenant_id: 'HDFC_BANK', country_code: 'IN', code: 'HDFC999', name: 'Test Branch' },
      NOW,
    );
    expect(b.branch_id).toBeTruthy();
    expect(b.code).toBe('HDFC999');
    expect(b.active).toBe(true);
    expect(s.get(b.branch_id)).toEqual(b);
  });

  test('create rejects duplicate (tenant_id, code)', () => {
    const s = new InMemoryBranchStore();
    s.create({ tenant_id: 'HDFC_BANK', country_code: 'IN', code: 'DUP', name: 'first' }, NOW);
    expect(() => s.create({ tenant_id: 'HDFC_BANK', country_code: 'IN', code: 'DUP', name: 'second' }, NOW)).toThrow(
      GovernanceError,
    );
  });

  test('same code OK across different tenants', () => {
    const s = new InMemoryBranchStore();
    s.create({ tenant_id: 'HDFC_BANK', country_code: 'IN', code: 'X1', name: 'a' }, NOW);
    expect(() =>
      s.create({ tenant_id: 'ICICI_BANK', country_code: 'IN', code: 'X1', name: 'b' }, NOW),
    ).not.toThrow();
  });

  test('create rejects missing required fields', () => {
    const s = new InMemoryBranchStore();
    expect(() => s.create({ tenant_id: '', country_code: 'IN', code: 'A', name: 'n' }, NOW)).toThrow();
    expect(() => s.create({ tenant_id: 'X', country_code: '', code: 'A', name: 'n' }, NOW)).toThrow();
    expect(() => s.create({ tenant_id: 'X', country_code: 'IN', code: '', name: 'n' }, NOW)).toThrow();
    expect(() => s.create({ tenant_id: 'X', country_code: 'IN', code: 'A', name: '' }, NOW)).toThrow();
  });

  test('list filters by tenant + country + active_only', () => {
    const s = new InMemoryBranchStore(buildDefaultBranchSeed(NOW));
    expect(s.list({ tenant_id: 'HDFC_BANK' }).length).toBe(3);
    expect(s.list({ country_code: 'BT' }).length).toBe(1);
    expect(s.list({ tenant_id: 'HDFC_BANK', country_code: 'IN' }).length).toBe(3);
    expect(s.list({ active_only: true }).length).toBe(11);
  });

  test('update + delete', () => {
    const s = new InMemoryBranchStore();
    const b = s.create({ tenant_id: 'HDFC_BANK', country_code: 'IN', code: 'U1', name: 'Original' }, NOW);
    const u = s.update(b.branch_id, { name: 'Updated', city: 'Pune' }, NOW);
    expect(u.name).toBe('Updated');
    expect(u.city).toBe('Pune');
    expect(s.delete(b.branch_id)).toBe(true);
    expect(s.delete(b.branch_id)).toBe(false);
    expect(s.get(b.branch_id)).toBeNull();
  });

  test('update unknown_branch throws', () => {
    const s = new InMemoryBranchStore();
    expect(() => s.update('does-not-exist', { name: 'X' }, NOW)).toThrow(GovernanceError);
  });

  test('update rejects duplicate code', () => {
    const s = new InMemoryBranchStore();
    s.create({ tenant_id: 'HDFC_BANK', country_code: 'IN', code: 'A', name: 'a' }, NOW);
    const b2 = s.create({ tenant_id: 'HDFC_BANK', country_code: 'IN', code: 'B', name: 'b' }, NOW);
    expect(() => s.update(b2.branch_id, { code: 'A' }, NOW)).toThrow();
  });
});

// ── ComplianceRuleStore ─────────────────────────────────────────────

describe('InMemoryComplianceRuleStore', () => {
  test('default seed has 9 rules across RBI/IRDAI/RMA/CBK/FIU', () => {
    const seed = buildDefaultComplianceSeed(NOW);
    expect(seed.length).toBe(9);
    const regulators = new Set(seed.map((r) => r.regulator));
    expect([...regulators].sort()).toEqual(['CBK', 'FIU', 'IRDAI', 'RBI', 'RMA']);
  });

  test('create + duplicate rejection', () => {
    const s = new InMemoryComplianceRuleStore();
    s.create(
      { country_code: 'IN', regulator: 'RBI', domain: 'banking', rule_code: 'X1', title: 't', description: 'd', requirement_kind: 'reporting' },
      NOW,
    );
    expect(() =>
      s.create(
        { country_code: 'IN', regulator: 'RBI', domain: 'banking', rule_code: 'X1', title: 't', description: 'd', requirement_kind: 'reporting' },
        NOW,
      ),
    ).toThrow();
  });

  test('list filters by country / regulator / domain / active', () => {
    const s = new InMemoryComplianceRuleStore(buildDefaultComplianceSeed(NOW));
    expect(s.list({ country_code: 'IN' }).length).toBeGreaterThan(0);
    expect(s.list({ regulator: 'IRDAI' }).length).toBe(2);
    expect(s.list({ domain: 'banking' }).length).toBeGreaterThan(0);
    expect(s.list({ country_code: 'BT' }).length).toBe(1);
    expect(s.list({ active_only: true }).length).toBe(9);
  });

  test('create rejects invalid domain / severity / requirement_kind', () => {
    const s = new InMemoryComplianceRuleStore();
    expect(() =>
      s.create(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { country_code: 'IN', regulator: 'RBI', domain: 'platform' as any, rule_code: 'A', title: 't', description: 'd', requirement_kind: 'reporting' },
        NOW,
      ),
    ).toThrow();
    expect(() =>
      s.create(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { country_code: 'IN', regulator: 'RBI', domain: 'banking', rule_code: 'A', title: 't', description: 'd', requirement_kind: 'garbage' as any },
        NOW,
      ),
    ).toThrow();
  });

  test('update + delete', () => {
    const s = new InMemoryComplianceRuleStore();
    const r = s.create(
      { country_code: 'IN', regulator: 'RBI', domain: 'banking', rule_code: 'U', title: 'Original', description: 'd', requirement_kind: 'reporting' },
      NOW,
    );
    const u = s.update(r.rule_id, { title: 'Updated', severity: 'recommended' }, NOW);
    expect(u.title).toBe('Updated');
    expect(u.severity).toBe('recommended');
    expect(s.delete(r.rule_id)).toBe(true);
    expect(s.delete(r.rule_id)).toBe(false);
  });
});

// ── requireBranchAccess middleware ───────────────────────────────────

function makeBranchMiniApp() {
  const app = express();
  app.get(
    '/branch/:branch_id',
    requireBranchAccess({ extractBranch: extractBranchFromParam('branch_id'), now: () => NOW }),
    (_req, res) => res.json({ ok: true }),
  );
  app.get(
    '/q',
    requireBranchAccess({ extractBranch: extractBranchFromQuery('branch'), now: () => NOW }),
    (_req, res) => res.json({ ok: true }),
  );
  app.get(
    '/strict/:branch_id',
    requireBranchAccess({ extractBranch: extractBranchFromParam('branch_id'), strict: true, now: () => NOW }),
    (_req, res) => res.json({ ok: true }),
  );
  return app;
}

describe('requireBranchAccess', () => {
  test('passes when user pin matches target', async () => {
    const app = makeBranchMiniApp();
    const r = await request(app).get('/branch/br-1').set({ 'x-apex-role': 'risk_analyst', 'x-apex-user-branch': 'br-1' });
    expect(r.status).toBe(200);
  });

  test('denies when user pin differs from target', async () => {
    const app = makeBranchMiniApp();
    const r = await request(app).get('/branch/br-1').set({ 'x-apex-role': 'risk_analyst', 'x-apex-user-branch': 'br-2' });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('EWS_403_wrong_branch');
    expect(r.body.error.detail).toEqual(expect.objectContaining({ user_branch: 'br-2', target_branch: 'br-1' }));
  });

  test('super-admin bypasses', async () => {
    const app = makeBranchMiniApp();
    const r = await request(app).get('/branch/br-9').set({ 'x-apex-role': 'admin', 'x-apex-user-branch': 'br-1' });
    expect(r.status).toBe(200);
  });

  test('permissive default: no pin → passes', async () => {
    const app = makeBranchMiniApp();
    const r = await request(app).get('/branch/br-1').set({ 'x-apex-role': 'risk_analyst' });
    expect(r.status).toBe(200);
  });

  test('strict mode rejects when no pin', async () => {
    const app = makeBranchMiniApp();
    const r = await request(app).get('/strict/br-1').set({ 'x-apex-role': 'risk_analyst' });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('EWS_403_branch_not_pinned');
  });

  test('query extractor works', async () => {
    const app = makeBranchMiniApp();
    const r = await request(app).get('/q?branch=br-q').set({ 'x-apex-role': 'risk_analyst', 'x-apex-user-branch': 'br-q' });
    expect(r.status).toBe(200);
  });

  test('throws at construction time on missing extractor', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => requireBranchAccess({ extractBranch: undefined as any })).toThrow();
  });
});

// ── /v1/governance/me ───────────────────────────────────────────────

describe('GET /v1/governance/me', () => {
  test('admin in BANK_DEMO sees full context', async () => {
    const { app } = makeApp({});
    const r = await request(app).get('/v1/governance/me').set(TH_BANK);
    expect(r.status).toBe(200);
    expect(r.body.body.tenant_id).toBe('BANK_DEMO');
    expect(r.body.body.tenant_vertical).toBe('banking');
    expect(r.body.body.role).toBe('admin');
  });

  test('branch pin echoed back via x-apex-user-branch header', async () => {
    const { app } = makeApp({});
    const r = await request(app)
      .get('/v1/governance/me')
      .set({ ...TH_BANK, 'x-apex-user-branch': 'br-hdfc-mumbai-fort' });
    expect(r.status).toBe(200);
    expect(r.body.body.branch_id).toBe('br-hdfc-mumbai-fort');
  });

  test('missing tenant header → 400', async () => {
    const { app } = makeApp({});
    const r = await request(app).get('/v1/governance/me').set({ 'x-apex-user': 'alice', 'x-apex-role': 'admin' });
    expect(r.status).toBe(400);
  });
});

// ── /v1/governance/branches CRUD ────────────────────────────────────

describe('Branches CRUD routes', () => {
  test('GET /branches with seeded store returns the 11 default branches', async () => {
    const branchStore = new InMemoryBranchStore(buildDefaultBranchSeed(NOW));
    const { app } = makeApp({ branchStore });
    const r = await request(app).get('/v1/governance/branches').set(TH_BANK);
    expect(r.status).toBe(200);
    expect(r.body.body.total).toBe(11);
  });

  test('GET /branches?tenant_id=HDFC_BANK narrows', async () => {
    const branchStore = new InMemoryBranchStore(buildDefaultBranchSeed(NOW));
    const { app } = makeApp({ branchStore });
    const r = await request(app).get('/v1/governance/branches?tenant_id=HDFC_BANK').set(TH_BANK);
    expect(r.status).toBe(200);
    expect(r.body.body.total).toBe(3);
  });

  test('GET /branches/:id with 404 envelope on miss', async () => {
    const branchStore = new InMemoryBranchStore();
    const { app } = makeApp({ branchStore });
    const r = await request(app).get('/v1/governance/branches/does-not-exist').set(TH_BANK);
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('EWS_404_unknown_branch');
  });

  test('POST + GET + PATCH + DELETE happy path', async () => {
    const branchStore = new InMemoryBranchStore();
    const { app } = makeApp({ branchStore });
    const create = await request(app)
      .post('/v1/governance/branches')
      .set({ ...TH_BANK, 'content-type': 'application/json' })
      .send({ tenant_id: 'HDFC_BANK', country_code: 'IN', code: 'NEW1', name: 'New One' });
    expect(create.status).toBe(201);
    const id = create.body.body.branch_id;
    const get = await request(app).get(`/v1/governance/branches/${id}`).set(TH_BANK);
    expect(get.status).toBe(200);
    const patch = await request(app)
      .patch(`/v1/governance/branches/${id}`)
      .set({ ...TH_BANK, 'content-type': 'application/json' })
      .send({ city: 'Pune' });
    expect(patch.status).toBe(200);
    expect(patch.body.body.city).toBe('Pune');
    const del = await request(app).delete(`/v1/governance/branches/${id}`).set(TH_BANK);
    expect(del.status).toBe(204);
    const get404 = await request(app).get(`/v1/governance/branches/${id}`).set(TH_BANK);
    expect(get404.status).toBe(404);
  });

  test('POST returns 409 on duplicate code', async () => {
    const branchStore = new InMemoryBranchStore();
    const { app } = makeApp({ branchStore });
    await request(app)
      .post('/v1/governance/branches')
      .set({ ...TH_BANK, 'content-type': 'application/json' })
      .send({ tenant_id: 'HDFC_BANK', country_code: 'IN', code: 'DUP', name: 'first' });
    const r = await request(app)
      .post('/v1/governance/branches')
      .set({ ...TH_BANK, 'content-type': 'application/json' })
      .send({ tenant_id: 'HDFC_BANK', country_code: 'IN', code: 'DUP', name: 'second' });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('EWS_409_duplicate_branch_code');
  });

  test('POST returns 400 on missing required field', async () => {
    const branchStore = new InMemoryBranchStore();
    const { app } = makeApp({ branchStore });
    const r = await request(app)
      .post('/v1/governance/branches')
      .set({ ...TH_BANK, 'content-type': 'application/json' })
      .send({ tenant_id: 'HDFC_BANK', code: 'X', name: 'X' });
    expect(r.status).toBe(400);
  });

  test('non-admin role → 403', async () => {
    const branchStore = new InMemoryBranchStore(buildDefaultBranchSeed(NOW));
    const { app } = makeApp({ branchStore });
    const r = await request(app)
      .get('/v1/governance/branches')
      .set({ ...TH_BANK, 'x-apex-role': 'field_officer' });
    expect(r.status).toBe(403);
  });
});

// ── /v1/governance/compliance-rules CRUD ────────────────────────────

describe('Compliance Rules CRUD routes', () => {
  test('GET /compliance-rules with seed returns 9 rules', async () => {
    const complianceRuleStore = new InMemoryComplianceRuleStore(buildDefaultComplianceSeed(NOW));
    const { app } = makeApp({ complianceRuleStore });
    const r = await request(app).get('/v1/governance/compliance-rules').set(TH_BANK);
    expect(r.status).toBe(200);
    expect(r.body.body.total).toBe(9);
  });

  test('GET filters by country + regulator + domain', async () => {
    const complianceRuleStore = new InMemoryComplianceRuleStore(buildDefaultComplianceSeed(NOW));
    const { app } = makeApp({ complianceRuleStore });
    const inOnly = await request(app).get('/v1/governance/compliance-rules?country_code=IN').set(TH_BANK);
    expect(inOnly.body.body.total).toBeGreaterThan(0);
    const irdai = await request(app).get('/v1/governance/compliance-rules?regulator=IRDAI').set(TH_BANK);
    expect(irdai.body.body.total).toBe(2);
    const insurance = await request(app).get('/v1/governance/compliance-rules?domain=insurance').set(TH_BANK);
    expect(insurance.body.body.total).toBeGreaterThan(0);
  });

  test('GET ?domain=garbage → 400 envelope', async () => {
    const complianceRuleStore = new InMemoryComplianceRuleStore();
    const { app } = makeApp({ complianceRuleStore });
    const r = await request(app).get('/v1/governance/compliance-rules?domain=platform').set(TH_BANK);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_domain');
  });

  test('POST + PATCH + DELETE happy path', async () => {
    const complianceRuleStore = new InMemoryComplianceRuleStore();
    const { app } = makeApp({ complianceRuleStore });
    const create = await request(app)
      .post('/v1/governance/compliance-rules')
      .set({ ...TH_BANK, 'content-type': 'application/json' })
      .send({
        country_code: 'IN',
        regulator: 'RBI',
        domain: 'banking',
        rule_code: 'TST-1',
        title: 'Test rule',
        description: 'd',
        requirement_kind: 'reporting',
      });
    expect(create.status).toBe(201);
    const id = create.body.body.rule_id;
    const patch = await request(app)
      .patch(`/v1/governance/compliance-rules/${id}`)
      .set({ ...TH_BANK, 'content-type': 'application/json' })
      .send({ severity: 'recommended' });
    expect(patch.status).toBe(200);
    expect(patch.body.body.severity).toBe('recommended');
    const del = await request(app).delete(`/v1/governance/compliance-rules/${id}`).set(TH_BANK);
    expect(del.status).toBe(204);
  });

  test('POST returns 409 on duplicate', async () => {
    const complianceRuleStore = new InMemoryComplianceRuleStore();
    const { app } = makeApp({ complianceRuleStore });
    const body = {
      country_code: 'IN',
      regulator: 'RBI',
      domain: 'banking',
      rule_code: 'DUP',
      title: 't',
      description: 'd',
      requirement_kind: 'reporting',
    };
    await request(app)
      .post('/v1/governance/compliance-rules')
      .set({ ...TH_BANK, 'content-type': 'application/json' })
      .send(body);
    const r = await request(app)
      .post('/v1/governance/compliance-rules')
      .set({ ...TH_BANK, 'content-type': 'application/json' })
      .send(body);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('EWS_409_duplicate_compliance_rule');
  });

  test('non-admin → 403', async () => {
    const complianceRuleStore = new InMemoryComplianceRuleStore();
    const { app } = makeApp({ complianceRuleStore });
    const r = await request(app)
      .get('/v1/governance/compliance-rules')
      .set({ ...TH_BANK, 'x-apex-role': 'field_officer' });
    expect(r.status).toBe(403);
  });
});
