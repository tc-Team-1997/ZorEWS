// Domain Based Access Control (DBAC) — backend test.
//
// Covers:
//   1. resolveEffectiveDomain — pure precedence rules
//   2. canAccessDomain — banking/insurance/both/null matrix
//   3. requireDomain middleware — header reads, super-admin bypass, 403 envelope
//   4. /v1/dbac/me route — introspection contract

import express, { type Request } from 'express';
import request from 'supertest';
import {
  resolveEffectiveDomain,
  canAccessDomain,
  isDbacDomain,
  isSuperAdminRole,
  DBAC_DOMAINS,
  DBAC_SUPER_ADMIN_ROLES,
} from '../src/dbac/domain_resolver';
import { requireDomain } from '../src/dbac/domain_middleware';
import { makeApp } from '../src/server';

const TH_BANK = { 'x-tenant-id': 'BANK_DEMO', 'x-channel': 'API', 'x-apex-user': 'alice.admin', 'x-apex-role': 'admin' };
const TH_BIL = { 'x-tenant-id': 'BIL', 'x-channel': 'API', 'x-apex-user': 'alice.admin', 'x-apex-role': 'admin' };

// ── Pure resolver ─────────────────────────────────────────────────────

describe('isDbacDomain type guard', () => {
  test('accepts banking + insurance', () => {
    expect(isDbacDomain('banking')).toBe(true);
    expect(isDbacDomain('insurance')).toBe(true);
  });
  test('rejects everything else', () => {
    expect(isDbacDomain('both')).toBe(false);
    expect(isDbacDomain('BANKING')).toBe(false);
    expect(isDbacDomain('')).toBe(false);
    expect(isDbacDomain(null)).toBe(false);
    expect(isDbacDomain(undefined)).toBe(false);
    expect(isDbacDomain(123)).toBe(false);
  });
});

describe('DBAC_DOMAINS + DBAC_SUPER_ADMIN_ROLES constants', () => {
  test('DBAC_DOMAINS has exactly banking + insurance in canonical order', () => {
    expect([...DBAC_DOMAINS]).toEqual(['banking', 'insurance']);
  });
  test('super-admin set covers admin + super_admin', () => {
    expect(DBAC_SUPER_ADMIN_ROLES.has('admin')).toBe(true);
    expect(DBAC_SUPER_ADMIN_ROLES.has('super_admin')).toBe(true);
    expect(DBAC_SUPER_ADMIN_ROLES.has('risk_analyst')).toBe(false);
  });
});

describe('isSuperAdminRole', () => {
  test('accepts admin + super_admin as string or array', () => {
    expect(isSuperAdminRole('admin')).toBe(true);
    expect(isSuperAdminRole('super_admin')).toBe(true);
    expect(isSuperAdminRole(['risk_analyst', 'super_admin'])).toBe(true);
  });
  test('rejects non-admin roles', () => {
    expect(isSuperAdminRole('risk_analyst')).toBe(false);
    expect(isSuperAdminRole(['risk_analyst', 'field_officer'])).toBe(false);
    expect(isSuperAdminRole(undefined)).toBe(false);
  });
});

describe('resolveEffectiveDomain — precedence rules', () => {
  test('super-admin always returns both regardless of pin / tenant', () => {
    expect(resolveEffectiveDomain({ role: 'admin' }, { vertical: 'banking' })).toBe('both');
    expect(resolveEffectiveDomain({ role: 'super_admin', domain: 'banking' }, { vertical: 'insurance' })).toBe('both');
  });
  test('user.domain explicit wins over tenant.vertical', () => {
    expect(resolveEffectiveDomain({ role: 'risk_analyst', domain: 'insurance' }, { vertical: 'banking' })).toBe('insurance');
  });
  test('tenant.vertical fallback when user.domain is null', () => {
    expect(resolveEffectiveDomain({ role: 'risk_analyst' }, { vertical: 'banking' })).toBe('banking');
    expect(resolveEffectiveDomain({ role: 'risk_analyst', domain: null }, { vertical: 'insurance' })).toBe('insurance');
  });
  test('null when no input', () => {
    expect(resolveEffectiveDomain(null, null)).toBeNull();
    expect(resolveEffectiveDomain(undefined, undefined)).toBeNull();
    expect(resolveEffectiveDomain({ role: 'risk_analyst' }, { vertical: undefined })).toBeNull();
  });
  test('tenant.vertical=both propagates through', () => {
    expect(resolveEffectiveDomain({ role: 'risk_analyst' }, { vertical: 'both' })).toBe('both');
  });
  test('garbage user.domain is ignored, falls back to tenant', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(resolveEffectiveDomain({ role: 'risk_analyst', domain: 'garbage' as any }, { vertical: 'banking' })).toBe('banking');
  });
});

describe('canAccessDomain', () => {
  test('both effective passes every target', () => {
    expect(canAccessDomain('both', 'banking')).toBe(true);
    expect(canAccessDomain('both', 'insurance')).toBe(true);
  });
  test('exact match passes', () => {
    expect(canAccessDomain('banking', 'banking')).toBe(true);
    expect(canAccessDomain('insurance', 'insurance')).toBe(true);
  });
  test('mismatch denied', () => {
    expect(canAccessDomain('banking', 'insurance')).toBe(false);
    expect(canAccessDomain('insurance', 'banking')).toBe(false);
  });
  test('null denied', () => {
    expect(canAccessDomain(null, 'banking')).toBe(false);
    expect(canAccessDomain(null, 'insurance')).toBe(false);
  });
});

// ── requireDomain middleware ─────────────────────────────────────────

function makeMiniApp(target: 'banking' | 'insurance') {
  const app = express();
  app.use(express.json());
  // Mimic the existing requireTenant injection — minimal shim.
  app.use((req, _res, next) => {
    // Real Tenant.vertical is 'banking' | 'insurance' only; mini-shim mirrors.
    const v = req.header('x-test-vertical') as 'banking' | 'insurance' | undefined;
    const vertical: 'banking' | 'insurance' = v === 'insurance' ? 'insurance' : 'banking';
    const tenant_id = req.header('x-tenant-id') ?? 'BANK_DEMO';
    // Full Tenant shape required by the global Request augmentation.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (req as any).tenant = {
      tenant_id,
      name: tenant_id,
      vertical,
      channels_allowed: ['API'],
      active: true,
    };
    next();
  });
  app.get('/probe', requireDomain(target, { now: () => new Date('2026-05-30T00:00:00Z') }), (_req, res) => {
    res.json({ ok: true });
  });
  return app;
}

describe('requireDomain middleware', () => {
  test('passes when effective matches target', async () => {
    const app = makeMiniApp('banking');
    const r = await request(app).get('/probe').set({ 'x-apex-role': 'risk_analyst', 'x-test-vertical': 'banking' });
    expect(r.status).toBe(200);
  });

  test('passes when user pin matches even when tenant vertical does not', async () => {
    const app = makeMiniApp('insurance');
    const r = await request(app)
      .get('/probe')
      .set({ 'x-apex-role': 'risk_analyst', 'x-apex-user-domain': 'insurance', 'x-test-vertical': 'banking' });
    expect(r.status).toBe(200);
  });

  test('super-admin bypasses domain check', async () => {
    const app = makeMiniApp('insurance');
    const r = await request(app).get('/probe').set({ 'x-apex-role': 'admin', 'x-test-vertical': 'banking' });
    expect(r.status).toBe(200);
  });

  test('denies when effective conflicts with target', async () => {
    const app = makeMiniApp('insurance');
    const r = await request(app).get('/probe').set({ 'x-apex-role': 'risk_analyst', 'x-test-vertical': 'banking' });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('EWS_403_wrong_domain');
    expect(r.body.error.detail).toEqual(
      expect.objectContaining({ required_domain: 'insurance', effective_domain: 'banking' }),
    );
  });

  test('user pin works without the role header (anonymous insurance pin → insurance route)', async () => {
    const app = makeMiniApp('insurance');
    const r = await request(app)
      .get('/probe')
      .set({ 'x-apex-user-domain': 'insurance', 'x-test-vertical': 'banking' });
    // user pin wins over tenant fallback; role missing — still passes.
    expect(r.status).toBe(200);
  });

  test('throws at construction time on invalid target', () => {
    expect(() => requireDomain('garbage' as 'banking')).toThrow();
  });
});

// ── /v1/dbac/me route ────────────────────────────────────────────────

describe('GET /v1/dbac/me', () => {
  test('admin in BANK_DEMO → effective both (super-admin bypass)', async () => {
    const { app } = makeApp({});
    const r = await request(app).get('/v1/dbac/me').set(TH_BANK);
    expect(r.status).toBe(200);
    expect(r.body.body.effective_domain).toBe('both');
    expect(r.body.body.inputs.role).toBe('admin');
    expect(r.body.body.inputs.tenant_vertical).toBe('banking');
  });

  test('admin in BIL → effective both', async () => {
    const { app } = makeApp({});
    const r = await request(app).get('/v1/dbac/me').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.effective_domain).toBe('both');
    expect(r.body.body.inputs.tenant_vertical).toBe('insurance');
  });

  test('non-admin in BANK_DEMO → inherits banking from tenant', async () => {
    const { app } = makeApp({});
    const r = await request(app)
      .get('/v1/dbac/me')
      .set({ ...TH_BANK, 'x-apex-role': 'risk_analyst' });
    expect(r.status).toBe(200);
    expect(r.body.body.effective_domain).toBe('banking');
    expect(r.body.body.inputs.user_domain).toBeNull();
    expect(r.body.body.inputs.tenant_vertical).toBe('banking');
  });

  test('non-admin in BIL → inherits insurance from tenant', async () => {
    const { app } = makeApp({});
    const r = await request(app)
      .get('/v1/dbac/me')
      .set({ ...TH_BIL, 'x-apex-role': 'risk_analyst' });
    expect(r.status).toBe(200);
    expect(r.body.body.effective_domain).toBe('insurance');
  });

  test('user pin (x-apex-user-domain) overrides tenant vertical', async () => {
    const { app } = makeApp({});
    const r = await request(app)
      .get('/v1/dbac/me')
      .set({ ...TH_BANK, 'x-apex-role': 'risk_analyst', 'x-apex-user-domain': 'insurance' });
    expect(r.status).toBe(200);
    expect(r.body.body.effective_domain).toBe('insurance');
    expect(r.body.body.inputs.user_domain).toBe('insurance');
  });

  test('garbage user pin is ignored, falls back to tenant', async () => {
    const { app } = makeApp({});
    const r = await request(app)
      .get('/v1/dbac/me')
      .set({ ...TH_BANK, 'x-apex-role': 'risk_analyst', 'x-apex-user-domain': 'platform' });
    expect(r.status).toBe(200);
    expect(r.body.body.effective_domain).toBe('banking');
    expect(r.body.body.inputs.user_domain).toBeNull();
  });

  test('missing tenant header → 400 envelope', async () => {
    const { app } = makeApp({});
    const r = await request(app).get('/v1/dbac/me').set({ 'x-apex-user': 'alice', 'x-apex-role': 'admin' });
    expect(r.status).toBe(400);
  });
});
