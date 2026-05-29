import request from 'supertest';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';
import {
  buildAccessControlOverview,
  buildRoleAccess,
  buildAccessMatrix,
  resourceOf,
  actionOf,
  AccessControlError,
} from '../src/access_control_view';
import { loadMatrix } from '../../../infra/rbac/lib/dist/src/index';

const NOW = new Date('2026-05-29T12:00:00.000Z');
const TENANT = 'BANK_DEMO';
const H = { 'X-Tenant-ID': TENANT, 'X-Channel': 'API', 'x-apex-user': 'alice.admin' };

function app(role = 'admin') {
  const { app } = makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
  });
  return app;
}

// ─── Helpers ─────────────────────────────────────────────────────────

describe('access_control_view — resource/action split', () => {
  it('splits on the first colon', () => {
    expect(resourceOf('alerts:list')).toBe('alerts');
    expect(actionOf('alerts:list')).toBe('list');
    expect(resourceOf('cases:maker_checker:approve')).toBe('cases');
    expect(actionOf('cases:maker_checker:approve')).toBe('maker_checker:approve');
    expect(resourceOf('noColon')).toBe('noColon');
    expect(actionOf('noColon')).toBe('noColon');
  });
});

// ─── Pure projections ────────────────────────────────────────────────

describe('access_control_view — buildAccessControlOverview', () => {
  it('matches the canonical matrix totals + shape', () => {
    const m = loadMatrix();
    const o = buildAccessControlOverview();
    expect(o.version).toBe(m.version);
    expect(o.total_roles).toBe(m.roles.length);
    expect(o.total_operations).toBe(Object.keys(m.operations).length);
    expect(o.roles).toEqual(m.roles);
    // resources sorted asc + sum to total_operations
    const sorted = [...o.resources].sort((a, b) => a.resource.localeCompare(b.resource));
    expect(o.resources).toEqual(sorted);
    expect(o.total_resources).toBe(o.resources.length);
    expect(o.resources.reduce((s, r) => s + r.operation_count, 0)).toBe(o.total_operations);
    // every resource group's operation_count matches its list length
    for (const r of o.resources) expect(r.operations.length).toBe(r.operation_count);
  });

  it('role_summaries carry description + operation_count in matrix order', () => {
    const m = loadMatrix();
    const o = buildAccessControlOverview();
    expect(o.role_summaries.map((s) => s.role)).toEqual(m.roles);
    const admin = o.role_summaries.find((s) => s.role === 'admin')!;
    // admin is granted at least one operation; description present
    expect(admin.operation_count).toBeGreaterThan(0);
    expect(typeof admin.description).toBe('string');
    // admin should hold the most operations (superset role)
    for (const s of o.role_summaries) expect(admin.operation_count).toBeGreaterThanOrEqual(s.operation_count);
  });
});

describe('access_control_view — buildRoleAccess', () => {
  it('returns only resources the role can touch', () => {
    const r = buildRoleAccess('risk_analyst');
    expect(r.role).toBe('risk_analyst');
    expect(r.total_operations).toBeGreaterThan(0);
    expect(r.total_resources).toBe(r.resources.length);
    expect(r.resources.reduce((s, g) => s + g.operation_count, 0)).toBe(r.total_operations);
    // every op listed is genuinely granted to the role
    const m = loadMatrix();
    for (const g of r.resources) {
      for (const op of g.operations) {
        expect(m.operations[op]).toContain('risk_analyst');
      }
    }
  });

  it('field_officer has fewer ops than admin', () => {
    expect(buildRoleAccess('field_officer').total_operations).toBeLessThan(
      buildRoleAccess('admin').total_operations,
    );
  });

  it('throws unknown_role on a bogus role', () => {
    expect(() => buildRoleAccess('superuser')).toThrow(/unknown role/);
    try {
      buildRoleAccess('superuser');
    } catch (e) {
      expect(e).toBeInstanceOf(AccessControlError);
      expect((e as AccessControlError).code).toBe('unknown_role');
    }
  });
});

describe('access_control_view — buildAccessMatrix', () => {
  it('row per operation with a by_role flag for every role', () => {
    const m = loadMatrix();
    const grid = buildAccessMatrix();
    expect(grid.total_operations).toBe(Object.keys(m.operations).length);
    expect(grid.rows.length).toBe(grid.total_operations);
    for (const row of grid.rows) {
      // every role keyed
      expect(Object.keys(row.by_role).sort()).toEqual([...m.roles].sort());
      // by_role matches the matrix exactly
      const allowed = m.operations[row.operation];
      for (const role of m.roles) {
        expect(row.by_role[role]).toBe(allowed.includes(role));
      }
      // allowed_role_count is the count of true flags
      expect(row.allowed_role_count).toBe(Object.values(row.by_role).filter(Boolean).length);
      expect(row.resource).toBe(resourceOf(row.operation));
    }
  });
});

// ─── Routes ──────────────────────────────────────────────────────────

describe('access_control_view — routes', () => {
  it('GET /v1/config/access-control returns the overview (admin)', async () => {
    const res = await request(app('admin')).get('/v1/config/access-control').set(H);
    expect(res.status).toBe(200);
    expect(res.body.body.total_roles).toBeGreaterThan(0);
    expect(res.body.body.resources.length).toBeGreaterThan(0);
    expect(res.body.body.role_summaries.length).toBe(res.body.body.total_roles);
  });

  it('GET /v1/config/access-control/matrix returns the grid (admin)', async () => {
    const res = await request(app('admin')).get('/v1/config/access-control/matrix').set(H);
    expect(res.status).toBe(200);
    expect(res.body.body.rows.length).toBe(res.body.body.total_operations);
    expect(res.body.body.rows[0].by_role).toBeDefined();
  });

  it('GET /v1/config/access-control/roles/:role returns role access (admin)', async () => {
    const res = await request(app('admin')).get('/v1/config/access-control/roles/supervisor').set(H);
    expect(res.status).toBe(200);
    expect(res.body.body.role).toBe('supervisor');
    expect(res.body.body.total_operations).toBeGreaterThan(0);
  });

  it('GET /v1/config/access-control/roles/:role 404s on unknown role', async () => {
    const res = await request(app('admin')).get('/v1/config/access-control/roles/superuser').set(H);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('EWS_404_unknown_role');
  });

  it('matrix literal is not shadowed by roles/:role wildcard', async () => {
    // /matrix must resolve to the grid, never be treated as role='matrix'
    const res = await request(app('admin')).get('/v1/config/access-control/matrix').set(H);
    expect(res.status).toBe(200);
    expect(res.body.body.rows).toBeDefined();
  });

  it('403s a non-privileged role', async () => {
    const res = await request(app('field_officer')).get('/v1/config/access-control').set(H);
    expect(res.status).toBe(403);
  });

  it('platform-static — identical across tenants', async () => {
    const a = await request(app('admin')).get('/v1/config/access-control').set(H);
    const b = await request(app('admin'))
      .get('/v1/config/access-control')
      .set({ ...H, 'X-Tenant-ID': 'BIL' });
    expect(a.body.body).toEqual(b.body.body);
  });
});
