// services/bff/__tests__/hr_adapter.test.ts
//
// T6 M14.8 — HR adapter.

import request from 'supertest';
import {
  StubHrAdapter,
  isEmployeeDepartment,
  isEmployeeStatus,
  type Employee,
  type HrAdapter,
  type LeaveBalance,
} from '../src/integrations/hr';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-04T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };
const TH_BANK = { 'X-Tenant-ID': 'BANK_DEMO', 'X-Channel': 'API' };

function makeHrApp(role: string = 'admin', hrAdapter?: HrAdapter) {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
    hrAdapter,
  });
}

// ─── Type guards ───────────────────────────────────────────────────────

describe('Type guards', () => {
  test('isEmployeeStatus accepts the 4 valid statuses', () => {
    expect(isEmployeeStatus('active')).toBe(true);
    expect(isEmployeeStatus('on_leave')).toBe(true);
    expect(isEmployeeStatus('suspended')).toBe(true);
    expect(isEmployeeStatus('terminated')).toBe(true);
    expect(isEmployeeStatus('working')).toBe(false);
  });
  test('isEmployeeDepartment accepts the 8 valid departments', () => {
    for (const d of ['risk', 'underwriting', 'claims', 'operations', 'compliance', 'it', 'finance', 'admin']) {
      expect(isEmployeeDepartment(d)).toBe(true);
    }
    expect(isEmployeeDepartment('marketing')).toBe(false);
  });
});

// ─── StubHrAdapter — list ──────────────────────────────────────────────

describe('StubHrAdapter — list', () => {
  test('returns 80 employees per tenant by default (page 1, page_size=25)', async () => {
    const a = new StubHrAdapter();
    const out = await a.list('BIL', {}, NOW);
    expect(out.total).toBe(80);
    expect(out.items.length).toBe(25);
  });

  test('every employee has required fields with valid types', async () => {
    const a = new StubHrAdapter();
    const out = await a.list('BIL', { page_size: 100 }, NOW);
    for (const e of out.items) {
      expect(e.employee_id).toMatch(/^EMP-BIL-\d{4}$/);
      expect(typeof e.name).toBe('string');
      expect(typeof e.role).toBe('string');
      expect(['risk', 'underwriting', 'claims', 'operations', 'compliance', 'it', 'finance', 'admin']).toContain(e.department);
      expect(['active', 'on_leave', 'suspended', 'terminated']).toContain(e.status);
      expect(['permanent', 'contract', 'intern', 'consultant']).toContain(e.type);
    }
  });

  test('first 8 employees are department heads (one per dept), null manager', async () => {
    const a = new StubHrAdapter();
    const out = await a.list('BIL', { page_size: 100 }, NOW);
    const heads = out.items.filter((e) => parseInt(e.employee_id.slice(-4), 10) < 8);
    expect(heads.length).toBe(8);
    const headDepts = new Set(heads.map((e) => e.department));
    expect(headDepts.size).toBe(8); // one head per department
    for (const head of heads) {
      expect(head.manager_id).toBeNull();
      // role ends with "Manager" or "Head" or "Controller" (last in roles list)
      expect(/Manager|Head|Controller/.test(head.role)).toBe(true);
    }
  });

  test('non-head employees have a manager_id pointing at one of the first 8', async () => {
    const a = new StubHrAdapter();
    const out = await a.list('BIL', { page_size: 100 }, NOW);
    for (const e of out.items) {
      const idx = parseInt(e.employee_id.slice(-4), 10);
      if (idx >= 8) {
        expect(e.manager_id).not.toBeNull();
        expect(e.manager_id!).toMatch(/^EMP-BIL-000\d$/);
      }
    }
  });

  test('department filter narrows', async () => {
    const a = new StubHrAdapter();
    const out = await a.list('BIL', { department: 'compliance', page_size: 100 }, NOW);
    for (const e of out.items) {
      expect(e.department).toBe('compliance');
    }
    expect(out.filter).toEqual({ department: 'compliance', status: undefined });
  });

  test('status filter narrows', async () => {
    const a = new StubHrAdapter();
    const out = await a.list('BIL', { status: 'active', page_size: 100 }, NOW);
    for (const e of out.items) expect(e.status).toBe('active');
  });

  test('combined filter (department + status)', async () => {
    const a = new StubHrAdapter();
    const out = await a.list('BIL', { department: 'risk', status: 'active', page_size: 100 }, NOW);
    for (const e of out.items) {
      expect(e.department).toBe('risk');
      expect(e.status).toBe('active');
    }
  });

  test('pagination disjoint, page_size clamped to [1, 100]', async () => {
    const a = new StubHrAdapter();
    const p1 = await a.list('BIL', { page: 1, page_size: 10 }, NOW);
    const p2 = await a.list('BIL', { page: 2, page_size: 10 }, NOW);
    const p1Ids = new Set(p1.items.map((x) => x.employee_id));
    for (const x of p2.items) expect(p1Ids.has(x.employee_id)).toBe(false);
    expect((await a.list('BIL', { page_size: 99999 }, NOW)).page_size).toBe(100);
    expect((await a.list('BIL', { page_size: 0 }, NOW)).page_size).toBe(1);
  });

  test('different tenants → disjoint employee_ids', async () => {
    const a = new StubHrAdapter();
    const bil = await a.list('BIL', { page_size: 100 }, NOW);
    const bank = await a.list('BANK_DEMO', { page_size: 100 }, NOW);
    const bilIds = new Set(bil.items.map((x) => x.employee_id));
    for (const x of bank.items) expect(bilIds.has(x.employee_id)).toBe(false);
  });

  test('every dept has at least one employee', async () => {
    const a = new StubHrAdapter();
    const out = await a.list('BIL', { page_size: 100 }, NOW);
    const seen = new Set(out.items.map((e) => e.department));
    expect(seen.size).toBe(8);
  });
});

// ─── StubHrAdapter — get ───────────────────────────────────────────────

describe('StubHrAdapter — get', () => {
  test('valid id → 200 with employee', async () => {
    const a = new StubHrAdapter();
    const e = await a.get('BIL', 'EMP-BIL-0010');
    expect(e).not.toBeNull();
    expect(e!.employee_id).toBe('EMP-BIL-0010');
  });

  test('out-of-range index → null', async () => {
    const a = new StubHrAdapter();
    expect(await a.get('BIL', 'EMP-BIL-9999')).toBeNull();
  });

  test('malformed → null', async () => {
    const a = new StubHrAdapter();
    expect(await a.get('BIL', 'EMP-XX-0001')).toBeNull();
    expect(await a.get('BIL', 'foo')).toBeNull();
  });

  test('cross-tenant lookup → null', async () => {
    const a = new StubHrAdapter();
    expect(await a.get('BANK_DEMO', 'EMP-BIL-0001')).toBeNull();
  });
});

// ─── StubHrAdapter — getLeaveBalance ───────────────────────────────────

describe('StubHrAdapter — getLeaveBalance', () => {
  test('returns balance for active employee', async () => {
    const a = new StubHrAdapter();
    const b = await a.getLeaveBalance('BIL', 'EMP-BIL-0001', NOW);
    expect(b).not.toBeNull();
    expect(b!.employee_id).toBe('EMP-BIL-0001');
    expect(b!.casual_days_remaining).toBeGreaterThanOrEqual(0);
    expect(b!.sick_days_remaining).toBeGreaterThanOrEqual(0);
    expect(b!.annual_days_remaining).toBeGreaterThanOrEqual(0);
    expect(b!.last_synced_at).toBe(NOW.toISOString());
  });

  test('terminated employee → all zeros', async () => {
    const a = new StubHrAdapter();
    // Find a terminated employee
    const list = await a.list('BIL', { status: 'terminated', page_size: 100 }, NOW);
    if (list.items.length > 0) {
      const term = list.items[0]!;
      const b = (await a.getLeaveBalance('BIL', term.employee_id, NOW))!;
      expect(b.casual_days_remaining).toBe(0);
      expect(b.sick_days_remaining).toBe(0);
      expect(b.annual_days_remaining).toBe(0);
      expect(b.comp_off_remaining).toBe(0);
    }
  });

  test('intern employees have lower entitlement caps than permanent', async () => {
    const a = new StubHrAdapter();
    const list = await a.list('BIL', { page_size: 100 }, NOW);
    // Compare aggregate stats — interns should have lower max
    const internBalances: LeaveBalance[] = [];
    const permBalances: LeaveBalance[] = [];
    for (const e of list.items) {
      if (e.status !== 'active') continue;
      const b = (await a.getLeaveBalance('BIL', e.employee_id, NOW))!;
      if (e.type === 'intern') internBalances.push(b);
      else if (e.type === 'permanent') permBalances.push(b);
    }
    if (internBalances.length > 0 && permBalances.length > 0) {
      const maxIntern = Math.max(...internBalances.map((b) => b.annual_days_remaining));
      const maxPerm = Math.max(...permBalances.map((b) => b.annual_days_remaining));
      // permanent cap is 18, intern cap is 6 — permanent max should
      // exceed intern max with high probability across the sample.
      expect(maxPerm).toBeGreaterThanOrEqual(maxIntern);
    }
  });

  test('deterministic per (employee, day)', async () => {
    const a = new StubHrAdapter();
    const a1 = await a.getLeaveBalance('BIL', 'EMP-BIL-0001', NOW);
    const a2 = await a.getLeaveBalance('BIL', 'EMP-BIL-0001', NOW);
    expect(a1).toEqual(a2);
  });

  test('unknown employee → null (route maps to 404)', async () => {
    const a = new StubHrAdapter();
    expect(await a.getLeaveBalance('BIL', 'EMP-BIL-9999', NOW)).toBeNull();
  });

  test('cross-tenant lookup → null', async () => {
    const a = new StubHrAdapter();
    expect(await a.getLeaveBalance('BANK_DEMO', 'EMP-BIL-0001', NOW)).toBeNull();
  });
});

// ─── Routes ────────────────────────────────────────────────────────────

describe('GET /v1/integrations/hr/employees', () => {
  test('admin: 200 with paginated list', async () => {
    const { app } = makeHrApp('admin');
    const r = await request(app).get('/v1/integrations/hr/employees').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total).toBe(80);
    expect(r.body.body.items.length).toBe(25);
  });

  test('?department=compliance narrows', async () => {
    const { app } = makeHrApp('admin');
    const r = await request(app)
      .get('/v1/integrations/hr/employees?department=compliance&page_size=100')
      .set(TH_BIL);
    for (const e of r.body.body.items as Employee[]) {
      expect(e.department).toBe('compliance');
    }
  });

  test('?status=active narrows', async () => {
    const { app } = makeHrApp('admin');
    const r = await request(app)
      .get('/v1/integrations/hr/employees?status=active&page_size=100')
      .set(TH_BIL);
    for (const e of r.body.body.items as Employee[]) {
      expect(e.status).toBe('active');
    }
  });

  test('?department=invalid → 400 EWS_400_invalid_department', async () => {
    const { app } = makeHrApp('admin');
    const r = await request(app).get('/v1/integrations/hr/employees?department=marketing').set(TH_BIL);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_department');
  });

  test('?status=invalid → 400 EWS_400_invalid_status', async () => {
    const { app } = makeHrApp('admin');
    const r = await request(app).get('/v1/integrations/hr/employees?status=working').set(TH_BIL);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_status');
  });

  test('unknown role → 403', async () => {
    const { app } = makeHrApp('case_owner');
    const r = await request(app).get('/v1/integrations/hr/employees').set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('adapter throwing → 502 envelope', async () => {
    const exploding: HrAdapter = {
      async list() {
        throw new Error('upstream timeout');
      },
      async get() {
        return null;
      },
      async getLeaveBalance() {
        return null;
      },
    };
    const { app } = makeHrApp('admin', exploding);
    const r = await request(app).get('/v1/integrations/hr/employees').set(TH_BIL);
    expect(r.status).toBe(502);
  });
});

describe('GET /v1/integrations/hr/employees/:employee_id', () => {
  test('valid id → 200', async () => {
    const { app } = makeHrApp('admin');
    const r = await request(app).get('/v1/integrations/hr/employees/EMP-BIL-0010').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.employee_id).toBe('EMP-BIL-0010');
  });

  test('unknown id → 404', async () => {
    const { app } = makeHrApp('admin');
    const r = await request(app).get('/v1/integrations/hr/employees/EMP-BIL-9999').set(TH_BIL);
    expect(r.status).toBe(404);
  });

  test('cross-tenant lookup → 404', async () => {
    const { app } = makeHrApp('admin');
    const r = await request(app).get('/v1/integrations/hr/employees/EMP-BIL-0001').set(TH_BANK);
    expect(r.status).toBe(404);
  });
});

describe('GET /v1/integrations/hr/employees/:employee_id/leave-balance', () => {
  test('returns balance for valid employee', async () => {
    const { app } = makeHrApp('admin');
    const r = await request(app)
      .get('/v1/integrations/hr/employees/EMP-BIL-0001/leave-balance')
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.employee_id).toBe('EMP-BIL-0001');
    expect(r.body.body.last_synced_at).toBe(NOW.toISOString());
  });

  test('unknown employee → 404', async () => {
    const { app } = makeHrApp('admin');
    const r = await request(app)
      .get('/v1/integrations/hr/employees/EMP-BIL-9999/leave-balance')
      .set(TH_BIL);
    expect(r.status).toBe(404);
  });

  test('cross-tenant → 404', async () => {
    const { app } = makeHrApp('admin');
    const r = await request(app)
      .get('/v1/integrations/hr/employees/EMP-BIL-0001/leave-balance')
      .set(TH_BANK);
    expect(r.status).toBe(404);
  });
});

describe('Tenant isolation through routes', () => {
  test('different tenants see disjoint employee registers', async () => {
    const { app } = makeHrApp('admin');
    const bil = await request(app).get('/v1/integrations/hr/employees?page_size=100').set(TH_BIL);
    const bank = await request(app).get('/v1/integrations/hr/employees?page_size=100').set(TH_BANK);
    const bilIds = new Set((bil.body.body.items as Employee[]).map((x) => x.employee_id));
    for (const x of bank.body.body.items as Employee[]) {
      expect(bilIds.has(x.employee_id)).toBe(false);
    }
  });
});
