// services/bff/__tests__/rbac_permission_matrix.test.ts
//
// Enterprise Permission Matrix — backend tests.
// Covers: pure store + default-seed shape + 8 BFF routes + the
// requireModulePermission middleware composability.

import express, { type Request, type Response } from 'express';
import request from 'supertest';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';
import {
  PERMISSION_ACTIONS,
  PERMISSION_ACTION_CATALOG,
  PERMISSION_MODULE_CATALOG,
  PERMISSION_MODULE_IDS,
  ENTERPRISE_ROLE_IDS,
  InMemoryPermissionMatrixStore,
  PermissionMatrixError,
  buildDefaultMatrixSeed,
  isPermissionAction,
  isPermissionModuleId,
  type IPermissionMatrixStore,
  type PermissionAction,
} from '../src/rbac/permission_matrix';
import { requireModulePermission } from '../src/rbac/permission_middleware';

const NOW = new Date('2026-05-30T15:00:00.000Z');
const TH_BANK = { 'X-Tenant-ID': 'BANK_DEMO', 'X-Channel': 'API' };

function makeRbacApp(role = 'super_admin', store?: IPermissionMatrixStore) {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
    permissionMatrixStore: store,
  });
}

// ── Closed enums + catalog shape ─────────────────────────────────────

describe('PERMISSION_ACTIONS / PERMISSION_ACTION_CATALOG', () => {
  test('exactly 7 actions in canonical order', () => {
    expect(PERMISSION_ACTIONS).toEqual(['view', 'create', 'edit', 'delete', 'approve', 'export', 'configure']);
  });

  test('catalog mirrors enum order + every entry has required fields', () => {
    expect(PERMISSION_ACTION_CATALOG).toHaveLength(PERMISSION_ACTIONS.length);
    const ids = PERMISSION_ACTION_CATALOG.map((a) => a.id);
    expect(ids).toEqual([...PERMISSION_ACTIONS]);
    for (const a of PERMISSION_ACTION_CATALOG) {
      expect(typeof a.label).toBe('string');
      expect(a.label.length).toBeGreaterThan(0);
      expect(typeof a.description).toBe('string');
      expect(typeof a.sort_order).toBe('number');
    }
  });

  test('isPermissionAction acts as a strict type guard', () => {
    for (const a of PERMISSION_ACTIONS) expect(isPermissionAction(a)).toBe(true);
    for (const bad of ['', 'destroy', 'View', 'EDIT', null, undefined, 42]) {
      expect(isPermissionAction(bad)).toBe(false);
    }
  });
});

describe('PERMISSION_MODULE_CATALOG', () => {
  test('all the user-named modules are present', () => {
    for (const expected of [
      'borrower_watch',
      'claims_anomaly',
      'policy_lapse_risk',
      'rules_engine',
      'users',
      'audit_trail',
    ]) {
      expect(PERMISSION_MODULE_IDS).toContain(expected);
    }
  });

  test('every catalog entry has the required envelope shape', () => {
    for (const m of PERMISSION_MODULE_CATALOG) {
      expect(typeof m.id).toBe('string');
      expect(typeof m.label).toBe('string');
      expect(typeof m.description).toBe('string');
      expect(['dashboard', 'banking', 'insurance', 'workflow', 'reporting', 'ai', 'admin', 'data']).toContain(m.category);
      expect(['banking', 'insurance', 'both']).toContain(m.domain);
      expect(typeof m.sort_order).toBe('number');
    }
  });

  test('module ids unique', () => {
    expect(new Set(PERMISSION_MODULE_IDS).size).toBe(PERMISSION_MODULE_IDS.length);
  });

  test('isPermissionModuleId guards correctly', () => {
    expect(isPermissionModuleId('borrower_watch')).toBe(true);
    expect(isPermissionModuleId('does-not-exist')).toBe(false);
    expect(isPermissionModuleId('')).toBe(false);
  });
});

describe('ENTERPRISE_ROLE_IDS', () => {
  test('contains all 10 user-named roles', () => {
    expect(ENTERPRISE_ROLE_IDS).toEqual([
      'super_admin',
      'country_admin',
      'bank_admin',
      'insurance_admin',
      'risk_analyst',
      'fraud_analyst',
      'credit_officer',
      'operations_user',
      'auditor',
      'read_only_user',
    ]);
  });
});

// ── InMemoryPermissionMatrixStore + default seed ────────────────────

describe('InMemoryPermissionMatrixStore + buildDefaultMatrixSeed', () => {
  function freshStore(): InMemoryPermissionMatrixStore {
    return new InMemoryPermissionMatrixStore(buildDefaultMatrixSeed(NOW));
  }

  test('super_admin gets every action on every module', () => {
    const s = freshStore();
    const grid = s.gridForRole('super_admin');
    for (const m of PERMISSION_MODULE_IDS) {
      for (const a of PERMISSION_ACTIONS) {
        expect(grid.permissions[m][a]).toBe(true);
      }
    }
  });

  test('read_only_user has VIEW only — never create/edit/delete/configure', () => {
    const s = freshStore();
    const grid = s.gridForRole('read_only_user');
    for (const m of PERMISSION_MODULE_IDS) {
      for (const a of PERMISSION_ACTIONS) {
        if (a === 'view') continue;
        expect(grid.permissions[m][a]).toBe(false);
      }
    }
    // And view IS granted on the read-only modules.
    expect(grid.permissions.dashboard.view).toBe(true);
  });

  test('auditor → view + export on audit_trail, no edit anywhere', () => {
    const s = freshStore();
    expect(s.isGranted('auditor', 'audit_trail', 'view')).toBe(true);
    expect(s.isGranted('auditor', 'audit_trail', 'export')).toBe(true);
    expect(s.isGranted('auditor', 'audit_trail', 'edit')).toBe(false);
    expect(s.isGranted('auditor', 'borrower_watch', 'edit')).toBe(false);
  });

  test('fraud_analyst → fraud_detection + claims_anomaly with approve', () => {
    const s = freshStore();
    expect(s.isGranted('fraud_analyst', 'fraud_detection', 'view')).toBe(true);
    expect(s.isGranted('fraud_analyst', 'fraud_detection', 'approve')).toBe(true);
    expect(s.isGranted('fraud_analyst', 'claims_anomaly', 'view')).toBe(true);
  });

  test('snapshot is sparse (only granted=true cells)', () => {
    const s = freshStore();
    const snap = s.snapshot(NOW);
    expect(snap.total_roles).toBe(10);
    expect(snap.total_modules).toBe(PERMISSION_MODULE_CATALOG.length);
    expect(snap.total_actions).toBe(7);
    // No role should have an undefined entry; only granted ones present.
    expect(snap.matrix.super_admin).toBeDefined();
    expect(snap.matrix.read_only_user).toBeDefined();
    // Sparse invariant — every leaf is true.
    for (const role of Object.keys(snap.matrix)) {
      for (const module of Object.keys(snap.matrix[role])) {
        for (const action of Object.keys(snap.matrix[role][module])) {
          expect(snap.matrix[role][module][action as PermissionAction]).toBe(true);
        }
      }
    }
  });

  test('resolveForRoles OR-merges multiple roles', () => {
    const s = freshStore();
    const auditor = s.resolveForRoles(['auditor']);
    const merged = s.resolveForRoles(['auditor', 'risk_analyst']);
    // auditor has no rules_engine create; risk_analyst does.
    expect(auditor.permissions.rules_engine.create).toBe(false);
    expect(merged.permissions.rules_engine.create).toBe(true);
  });

  test('setCell flips a single grant + setRoleGrants bulk-applies', () => {
    const s = freshStore();
    expect(s.isGranted('read_only_user', 'reports', 'export')).toBe(false);
    s.setCell('read_only_user', 'reports', 'export', true, 'admin', NOW);
    expect(s.isGranted('read_only_user', 'reports', 'export')).toBe(true);
    // Toggle off
    s.setCell('read_only_user', 'reports', 'export', false, 'admin', NOW);
    expect(s.isGranted('read_only_user', 'reports', 'export')).toBe(false);

    // Bulk
    s.setRoleGrants(
      'operations_user',
      { borrower_watch: { view: true, edit: true }, reports: { export: true } },
      'admin',
      NOW,
    );
    expect(s.isGranted('operations_user', 'borrower_watch', 'view')).toBe(true);
    expect(s.isGranted('operations_user', 'borrower_watch', 'edit')).toBe(true);
    expect(s.isGranted('operations_user', 'reports', 'export')).toBe(true);
  });

  test('setRoleGrants validates input + throws PermissionMatrixError', () => {
    const s = freshStore();
    expect(() => s.setRoleGrants('', { dashboard: { view: true } }, 'admin', NOW)).toThrow(PermissionMatrixError);
    expect(() => s.setRoleGrants('auditor', null as unknown as never, 'admin', NOW)).toThrow(PermissionMatrixError);
    expect(() => s.setRoleGrants('auditor', { unknown_module: { view: true } }, 'admin', NOW)).toThrow(PermissionMatrixError);
    expect(() => s.setRoleGrants('auditor', { dashboard: { destroy: true } as never }, 'admin', NOW)).toThrow(PermissionMatrixError);
    // non-boolean grant
    expect(() => s.setRoleGrants('auditor', { dashboard: { view: 'yes' as unknown as boolean } }, 'admin', NOW)).toThrow(PermissionMatrixError);
  });
});

// ── requireModulePermission middleware ──────────────────────────────

describe('requireModulePermission middleware', () => {
  function buildMwApp(role: string | undefined, module: string, action: PermissionAction) {
    const app = express();
    const store = new InMemoryPermissionMatrixStore(buildDefaultMatrixSeed(NOW));
    app.get(
      '/protected',
      (req, _res, next) => {
        // Stub: forward role from header into req.user for middleware to read.
        const r = req.header('x-test-role');
        if (r) (req as Request & { user?: { role?: string } }).user = { role: r };
        next();
      },
      requireModulePermission(module, action, { store, now: () => NOW }),
      (_req: Request, res: Response) => res.json({ ok: true }),
    );
    return { app, role };
  }

  test('super_admin always allowed (fast-path)', async () => {
    const { app } = buildMwApp('super_admin', 'audit_trail', 'configure');
    const r = await request(app).get('/protected').set('x-test-role', 'super_admin');
    expect(r.status).toBe(200);
  });

  test('granted via matrix → 200', async () => {
    const { app } = buildMwApp('auditor', 'audit_trail', 'view');
    const r = await request(app).get('/protected').set('x-test-role', 'auditor');
    expect(r.status).toBe(200);
  });

  test('not granted → 403 with code', async () => {
    const { app } = buildMwApp('auditor', 'borrower_watch', 'edit');
    const r = await request(app).get('/protected').set('x-test-role', 'auditor');
    expect(r.status).toBe(403);
    expect(r.body?.error?.code).toBe('EWS_403_missing_module_permission');
    expect(r.body?.error?.detail?.module).toBe('borrower_watch');
    expect(r.body?.error?.detail?.action).toBe('edit');
  });

  test('no role → 401', async () => {
    const { app } = buildMwApp(undefined, 'audit_trail', 'view');
    const r = await request(app).get('/protected');
    expect(r.status).toBe(401);
    expect(r.body?.error?.code).toBe('EWS_401');
  });

  test('factory rejects unknown module + unknown action at construction', () => {
    expect(() => requireModulePermission('not-real', 'view')).toThrow(/unknown module/);
    expect(() => requireModulePermission('dashboard', 'destroy' as PermissionAction)).toThrow(/unknown action/);
  });
});

// ── HTTP routes ──────────────────────────────────────────────────────

describe('GET /v1/rbac/actions', () => {
  test('returns 7 actions in canonical order', async () => {
    const { app } = makeRbacApp('admin');
    const r = await request(app).get('/v1/rbac/actions').set(TH_BANK);
    expect(r.status).toBe(200);
    expect(r.body.body.total).toBe(7);
    expect(r.body.body.actions.map((a: { id: string }) => a.id)).toEqual([...PERMISSION_ACTIONS]);
  });

  test('non-admin (audit:read missing) → 403', async () => {
    const { app } = makeRbacApp('case_owner_unknown');
    const r = await request(app).get('/v1/rbac/actions').set(TH_BANK);
    expect(r.status).toBe(403);
  });
});

describe('GET /v1/rbac/modules', () => {
  test('returns full catalog', async () => {
    const { app } = makeRbacApp('admin');
    const r = await request(app).get('/v1/rbac/modules').set(TH_BANK);
    expect(r.status).toBe(200);
    expect(r.body.body.total).toBe(PERMISSION_MODULE_CATALOG.length);
    expect(r.body.body.modules.some((m: { id: string }) => m.id === 'borrower_watch')).toBe(true);
    expect(r.body.body.modules.some((m: { id: string }) => m.id === 'permission_matrix')).toBe(true);
  });
});

describe('GET /v1/rbac/roles', () => {
  test('returns the 10 enterprise role ids', async () => {
    const { app } = makeRbacApp('admin');
    const r = await request(app).get('/v1/rbac/roles').set(TH_BANK);
    expect(r.status).toBe(200);
    expect(r.body.body.total).toBe(10);
    expect(r.body.body.roles).toEqual([...ENTERPRISE_ROLE_IDS]);
  });
});

describe('GET /v1/rbac/matrix', () => {
  test('admin → 200 with sparse matrix', async () => {
    const { app } = makeRbacApp('admin');
    const r = await request(app).get('/v1/rbac/matrix').set(TH_BANK);
    expect(r.status).toBe(200);
    expect(r.body.body.total_actions).toBe(7);
    expect(r.body.body.total_roles).toBe(10);
    expect(r.body.body.matrix.super_admin).toBeDefined();
    expect(r.body.body.matrix.auditor.audit_trail.view).toBe(true);
  });
});

describe('GET /v1/rbac/matrix/:role', () => {
  test('returns full grid (every module × action key present)', async () => {
    const { app } = makeRbacApp('admin');
    const r = await request(app).get('/v1/rbac/matrix/auditor').set(TH_BANK);
    expect(r.status).toBe(200);
    expect(r.body.body.role_id).toBe('auditor');
    // Stable grid invariant — every module slot present
    for (const m of PERMISSION_MODULE_IDS) {
      expect(r.body.body.permissions[m]).toBeDefined();
      for (const a of PERMISSION_ACTIONS) {
        expect(typeof r.body.body.permissions[m][a]).toBe('boolean');
      }
    }
  });

  test('unknown role → 404', async () => {
    const { app } = makeRbacApp('admin');
    const r = await request(app).get('/v1/rbac/matrix/nope').set(TH_BANK);
    expect(r.status).toBe(404);
    expect(r.body?.error?.code).toBe('EWS_404_unknown_role');
  });
});

describe('PUT /v1/rbac/matrix/:role', () => {
  test('updates grants + returns refreshed grid', async () => {
    const store = new InMemoryPermissionMatrixStore(buildDefaultMatrixSeed(NOW));
    const { app } = makeRbacApp('admin', store);
    // operations_user starts WITHOUT borrower_watch.view.
    expect(store.isGranted('operations_user', 'borrower_watch', 'view')).toBe(false);
    const r = await request(app)
      .put('/v1/rbac/matrix/operations_user')
      .set(TH_BANK)
      .send({ grants: { borrower_watch: { view: true } } });
    expect(r.status).toBe(200);
    expect(r.body.body.cells_touched).toBe(1);
    expect(store.isGranted('operations_user', 'borrower_watch', 'view')).toBe(true);
    expect(r.body.body.grid.permissions.borrower_watch.view).toBe(true);
  });

  test('rejects unknown module with 400', async () => {
    const { app } = makeRbacApp('admin');
    const r = await request(app)
      .put('/v1/rbac/matrix/auditor')
      .set(TH_BANK)
      .send({ grants: { fake_module: { view: true } } });
    expect(r.status).toBe(400);
    expect(r.body?.error?.code).toContain('EWS_400');
  });

  test('rejects missing grants body with 400', async () => {
    const { app } = makeRbacApp('admin');
    const r = await request(app).put('/v1/rbac/matrix/auditor').set(TH_BANK).send({});
    expect(r.status).toBe(400);
    expect(r.body?.error?.code).toBe('EWS_400_invalid_grants');
  });

  test('unknown role → 404', async () => {
    const { app } = makeRbacApp('admin');
    const r = await request(app).put('/v1/rbac/matrix/nope').set(TH_BANK).send({ grants: {} });
    expect(r.status).toBe(404);
  });
});

describe('GET /v1/rbac/me/permissions', () => {
  test('returns the caller-role grid', async () => {
    const { app } = makeRbacApp('auditor');
    const r = await request(app).get('/v1/rbac/me/permissions').set({ ...TH_BANK, 'x-apex-role': 'auditor' });
    expect(r.status).toBe(200);
    expect(r.body.body.permissions.audit_trail.view).toBe(true);
    expect(r.body.body.permissions.borrower_watch.edit).toBe(false);
  });

  test('empty role still returns a fully-zeroed stable grid', async () => {
    const { app } = makeRbacApp('admin');
    const r = await request(app).get('/v1/rbac/me/permissions').set(TH_BANK);
    expect(r.status).toBe(200);
    // No grants resolved — every cell false.
    for (const m of PERMISSION_MODULE_IDS) {
      for (const a of PERMISSION_ACTIONS) {
        expect(r.body.body.permissions[m][a]).toBe(false);
      }
    }
  });
});

describe('POST /v1/rbac/check', () => {
  test('granted → granted:true', async () => {
    const { app } = makeRbacApp('admin');
    const r = await request(app).post('/v1/rbac/check').set(TH_BANK).send({ role: 'auditor', module: 'audit_trail', action: 'view' });
    expect(r.status).toBe(200);
    expect(r.body.body.granted).toBe(true);
  });

  test('denied → granted:false', async () => {
    const { app } = makeRbacApp('admin');
    const r = await request(app).post('/v1/rbac/check').set(TH_BANK).send({ role: 'auditor', module: 'borrower_watch', action: 'edit' });
    expect(r.status).toBe(200);
    expect(r.body.body.granted).toBe(false);
  });

  test('bad action → 400', async () => {
    const { app } = makeRbacApp('admin');
    const r = await request(app).post('/v1/rbac/check').set(TH_BANK).send({ role: 'auditor', module: 'audit_trail', action: 'destroy' });
    expect(r.status).toBe(400);
  });

  test('bad module → 400', async () => {
    const { app } = makeRbacApp('admin');
    const r = await request(app).post('/v1/rbac/check').set(TH_BANK).send({ role: 'auditor', module: 'not-a-module', action: 'view' });
    expect(r.status).toBe(400);
  });

  test('missing fields → 400', async () => {
    const { app } = makeRbacApp('admin');
    const r = await request(app).post('/v1/rbac/check').set(TH_BANK).send({ role: 'auditor' });
    expect(r.status).toBe(400);
  });
});
