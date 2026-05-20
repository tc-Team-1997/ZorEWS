// services/bff/__tests__/account_master.test.ts
//
// Phase B.3 — Account & Exposure Master Setup.

import request from 'supertest';
import {
  ACCOUNT_MASTER_CAP_PER_TENANT,
  ALL_ACCOUNT_CATEGORIES,
  ALL_REPAYMENT_FREQUENCIES,
  AccountMasterError,
  defaultAccountMasterStore,
  InMemoryAccountMasterStore,
  isAccountCategory,
  isRepaymentFrequency,
} from '../src/master/account_master';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';
import { InMemoryRecoveryStore } from '../src/recovery/store';

const NOW = new Date('2026-05-21T09:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API', 'X-APEX-USER': 'alice.admin' };
const TH_BANK = { 'X-Tenant-ID': 'BANK_DEMO', 'X-Channel': 'API', 'X-APEX-USER': 'admin' };

function makeAcctApp(role: string = 'admin', overrides: {
  accountMasterStore?: InMemoryAccountMasterStore;
  recoveryStore?: InMemoryRecoveryStore;
} = {}) {
  const { app } = makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
    accountMasterStore: overrides.accountMasterStore ?? new InMemoryAccountMasterStore(),
    recoveryStore: overrides.recoveryStore ?? new InMemoryRecoveryStore(),
  });
  return app;
}

const validInput = (over: Record<string, unknown> = {}) => ({
  account_type_id: 'PERSONAL_LOAN',
  display_name: 'Personal Loan',
  category: 'loan' as const,
  product_subtype: 'personal_loan',
  default_credit_limit: 500_000,
  max_exposure_cap: 1_000_000,
  repayment_frequency: 'monthly' as const,
  interest_rate_pct: 12.5,
  ...over,
});

// ─── Enums ─────────────────────────────────────────────────────────

describe('Account master enums', () => {
  test('4 categories', () => {
    expect(ALL_ACCOUNT_CATEGORIES).toEqual(['deposit', 'loan', 'credit_card', 'overdraft']);
  });
  test('6 repayment frequencies', () => {
    expect(ALL_REPAYMENT_FREQUENCIES.length).toBe(6);
  });
  test('type guards', () => {
    for (const c of ALL_ACCOUNT_CATEGORIES) expect(isAccountCategory(c)).toBe(true);
    expect(isAccountCategory('savings')).toBe(false);
    for (const f of ALL_REPAYMENT_FREQUENCIES) expect(isRepaymentFrequency(f)).toBe(true);
  });
});

// ─── Store validation + CRUD ─────────────────────────────────────────

describe('InMemoryAccountMasterStore — create', () => {
  test('happy path', () => {
    const s = new InMemoryAccountMasterStore();
    const e = s.create('BIL', validInput(), 'alice.admin', NOW);
    expect(e.account_type_id).toBe('PERSONAL_LOAN');
    expect(e.category).toBe('loan');
    expect(e.default_credit_limit).toBe(500_000);
    expect(e.max_exposure_cap).toBe(1_000_000);
    expect(e.repayment_frequency).toBe('monthly');
    expect(e.active).toBe(true);
    expect(e.tenant_id).toBe('BIL');
  });

  test('default repayment_frequency = monthly when omitted', () => {
    const s = new InMemoryAccountMasterStore();
    const { repayment_frequency: _f, ...rest } = validInput();
    void _f;
    const e = s.create('BIL', rest as never, 'a', NOW);
    expect(e.repayment_frequency).toBe('monthly');
  });

  test('invalid account_type_id rejected', () => {
    const s = new InMemoryAccountMasterStore();
    expect(() =>
      s.create('BIL', validInput({ account_type_id: 'lowercase' }), 'a', NOW),
    ).toThrow(AccountMasterError);
    expect(() =>
      s.create('BIL', validInput({ account_type_id: 'AB' }), 'a', NOW),
    ).toThrow(AccountMasterError);
    expect(() =>
      s.create('BIL', validInput({ account_type_id: '1STARTS_DIGIT' }), 'a', NOW),
    ).toThrow(AccountMasterError);
  });

  test('blank/overlong display_name rejected', () => {
    const s = new InMemoryAccountMasterStore();
    expect(() =>
      s.create('BIL', validInput({ display_name: '' }), 'a', NOW),
    ).toThrow(AccountMasterError);
    expect(() =>
      s.create('BIL', validInput({ display_name: 'x'.repeat(201) }), 'a', NOW),
    ).toThrow(AccountMasterError);
  });

  test('invalid category rejected', () => {
    const s = new InMemoryAccountMasterStore();
    expect(() =>
      s.create('BIL', validInput({ category: 'savings' }), 'a', NOW),
    ).toThrow(AccountMasterError);
  });

  test('negative amounts rejected', () => {
    const s = new InMemoryAccountMasterStore();
    expect(() =>
      s.create('BIL', validInput({ default_credit_limit: -1 }), 'a', NOW),
    ).toThrow(AccountMasterError);
    expect(() =>
      s.create('BIL', validInput({ max_exposure_cap: -1 }), 'a', NOW),
    ).toThrow(AccountMasterError);
  });

  test('max_exposure_cap < default_credit_limit rejected', () => {
    const s = new InMemoryAccountMasterStore();
    expect(() =>
      s.create('BIL', validInput({ default_credit_limit: 1_000_000, max_exposure_cap: 500_000 }), 'a', NOW),
    ).toThrow(AccountMasterError);
  });

  test('interest_rate_pct out of [0, 100] rejected', () => {
    const s = new InMemoryAccountMasterStore();
    expect(() =>
      s.create('BIL', validInput({ interest_rate_pct: -0.1 }), 'a', NOW),
    ).toThrow(AccountMasterError);
    expect(() =>
      s.create('BIL', validInput({ interest_rate_pct: 100.1 }), 'a', NOW),
    ).toThrow(AccountMasterError);
  });

  test('interest_rate_pct boundary 0 and 100 accepted', () => {
    const s = new InMemoryAccountMasterStore();
    expect(s.create('BIL', validInput({ interest_rate_pct: 0 }), 'a', NOW).interest_rate_pct).toBe(0);
    s.softDelete('BIL', 'PERSONAL_LOAN', 'a', NOW);
    expect(s.create('BIL', validInput({ interest_rate_pct: 100 }), 'a', NOW).interest_rate_pct).toBe(100);
  });

  test('null amount fields accepted (no defaults)', () => {
    const s = new InMemoryAccountMasterStore();
    const e = s.create(
      'BIL',
      validInput({ default_credit_limit: null, max_exposure_cap: null, interest_rate_pct: null }),
      'a',
      NOW,
    );
    expect(e.default_credit_limit).toBeNull();
    expect(e.max_exposure_cap).toBeNull();
    expect(e.interest_rate_pct).toBeNull();
  });

  test('duplicate id rejected', () => {
    const s = new InMemoryAccountMasterStore();
    s.create('BIL', validInput(), 'a', NOW);
    expect(() => s.create('BIL', validInput(), 'a', NOW)).toThrow(AccountMasterError);
  });

  test('missing actor rejected', () => {
    const s = new InMemoryAccountMasterStore();
    expect(() => s.create('BIL', validInput(), '', NOW)).toThrow(AccountMasterError);
  });
});

describe('InMemoryAccountMasterStore — list/update/delete/restore', () => {
  test('list orders by canonical category then display_name', () => {
    const s = new InMemoryAccountMasterStore();
    s.create('BIL', validInput({ account_type_id: 'OD_PERSONAL', display_name: 'OD', category: 'overdraft' }), 'a', NOW);
    s.create('BIL', validInput({ account_type_id: 'CC_GOLD', display_name: 'Gold', category: 'credit_card' }), 'a', NOW);
    s.create('BIL', validInput({ account_type_id: 'SAV_BASIC', display_name: 'Basic Savings', category: 'deposit' }), 'a', NOW);
    s.create('BIL', validInput({ account_type_id: 'PL_RETAIL', display_name: 'PL Retail', category: 'loan' }), 'a', NOW);
    const items = s.list('BIL');
    expect(items.map((e) => e.account_type_id)).toEqual([
      'SAV_BASIC', // deposit (first canonical)
      'PL_RETAIL', // loan
      'CC_GOLD',   // credit_card
      'OD_PERSONAL', // overdraft
    ]);
  });

  test('filter by category narrows', () => {
    const s = new InMemoryAccountMasterStore();
    s.create('BIL', validInput({ account_type_id: 'PL_A', category: 'loan' }), 'a', NOW);
    s.create('BIL', validInput({ account_type_id: 'CC_A', category: 'credit_card' }), 'a', NOW);
    expect(s.list('BIL', { category: 'loan' }).map((e) => e.account_type_id)).toEqual(['PL_A']);
  });

  test('filter active=false includes only inactive', () => {
    const s = new InMemoryAccountMasterStore();
    s.create('BIL', validInput({ account_type_id: 'A_ACTIVE', active: true }), 'a', NOW);
    s.create('BIL', validInput({ account_type_id: 'B_INACTIVE', active: false }), 'a', NOW);
    expect(s.list('BIL', { active: false }).map((e) => e.account_type_id)).toEqual(['B_INACTIVE']);
  });

  test('update applies patch', () => {
    const s = new InMemoryAccountMasterStore();
    s.create('BIL', validInput(), 'alice', NOW);
    const later = new Date(NOW.getTime() + 60_000);
    const u = s.update(
      'BIL',
      'PERSONAL_LOAN',
      { interest_rate_pct: 15.0, active: false },
      'bob',
      later,
    );
    expect(u.interest_rate_pct).toBe(15.0);
    expect(u.active).toBe(false);
    expect(u.updated_by).toBe('bob');
  });

  test('update rejects max_exposure_cap < effective default_credit_limit', () => {
    const s = new InMemoryAccountMasterStore();
    s.create('BIL', validInput({ default_credit_limit: 1_000_000, max_exposure_cap: 1_500_000 }), 'a', NOW);
    expect(() =>
      s.update('BIL', 'PERSONAL_LOAN', { max_exposure_cap: 500_000 }, 'a', NOW),
    ).toThrow(AccountMasterError);
  });

  test('softDelete + restore', () => {
    const s = new InMemoryAccountMasterStore();
    s.create('BIL', validInput(), 'a', NOW);
    const t = s.softDelete('BIL', 'PERSONAL_LOAN', 'b', NOW);
    expect(t.deleted_at).toBe(NOW.toISOString());
    expect(s.get('BIL', 'PERSONAL_LOAN')).toBeNull();
    expect(s.restore(t)).toBe(true);
    expect(s.get('BIL', 'PERSONAL_LOAN')?.deleted_at).toBeNull();
  });

  test('restore conflict on live row', () => {
    const s = new InMemoryAccountMasterStore();
    const e = s.create('BIL', validInput(), 'a', NOW);
    expect(s.restore(e)).toBe(false);
  });

  test('tenant scoping', () => {
    const s = new InMemoryAccountMasterStore();
    s.create('BIL', validInput(), 'a', NOW);
    s.create('BANK_DEMO', validInput({ account_type_id: 'OTHER' }), 'a', NOW);
    expect(s.list('BIL').map((e) => e.account_type_id)).toEqual(['PERSONAL_LOAN']);
    expect(s.list('BANK_DEMO').map((e) => e.account_type_id)).toEqual(['OTHER']);
  });
});

// ─── Routes ─────────────────────────────────────────────────────────

describe('GET /v1/master/accounts/categories', () => {
  test('admin happy', async () => {
    const app = makeAcctApp('admin');
    const r = await request(app).get('/v1/master/accounts/categories').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.categories).toEqual([...ALL_ACCOUNT_CATEGORIES]);
    expect(r.body.body.repayment_frequencies).toEqual([...ALL_REPAYMENT_FREQUENCIES]);
  });
  test('non-admin → 403', async () => {
    const app = makeAcctApp('field_officer');
    expect((await request(app).get('/v1/master/accounts/categories').set(TH_BIL)).status).toBe(403);
  });
});

describe('POST /v1/master/accounts', () => {
  test('happy 201', async () => {
    const app = makeAcctApp('admin');
    const r = await request(app).post('/v1/master/accounts').set(TH_BIL).send(validInput());
    expect(r.status).toBe(201);
    expect(r.body.body.account_type_id).toBe('PERSONAL_LOAN');
  });

  test('enveloped body honoured', async () => {
    const app = makeAcctApp('admin');
    const r = await request(app)
      .post('/v1/master/accounts')
      .set(TH_BIL)
      .send({ header: {}, body: validInput() });
    expect(r.status).toBe(201);
  });

  test('duplicate → 409', async () => {
    const store = new InMemoryAccountMasterStore();
    const app = makeAcctApp('admin', { accountMasterStore: store });
    await request(app).post('/v1/master/accounts').set(TH_BIL).send(validInput());
    const r = await request(app).post('/v1/master/accounts').set(TH_BIL).send(validInput());
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('EWS_409_duplicate_account_type_id');
  });

  test('invalid category → 400', async () => {
    const app = makeAcctApp('admin');
    const r = await request(app)
      .post('/v1/master/accounts')
      .set(TH_BIL)
      .send(validInput({ category: 'savings' }));
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_category');
  });

  test('cap < credit_limit → 400', async () => {
    const app = makeAcctApp('admin');
    const r = await request(app)
      .post('/v1/master/accounts')
      .set(TH_BIL)
      .send(validInput({ default_credit_limit: 1_000_000, max_exposure_cap: 500_000 }));
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_amount');
  });

  test('non-admin → 403', async () => {
    const app = makeAcctApp('field_officer');
    expect((await request(app).post('/v1/master/accounts').set(TH_BIL).send(validInput())).status).toBe(403);
  });
});

describe('GET /v1/master/accounts list', () => {
  test('?category=loan narrows', async () => {
    const store = new InMemoryAccountMasterStore();
    const app = makeAcctApp('admin', { accountMasterStore: store });
    await request(app).post('/v1/master/accounts').set(TH_BIL).send(validInput());
    await request(app)
      .post('/v1/master/accounts')
      .set(TH_BIL)
      .send(validInput({ account_type_id: 'CC_PLATINUM', display_name: 'Platinum CC', category: 'credit_card' }));
    const r = await request(app).get('/v1/master/accounts?category=loan').set(TH_BIL);
    expect(r.body.body.total).toBe(1);
    expect(r.body.body.items[0].account_type_id).toBe('PERSONAL_LOAN');
  });

  test('?category=bogus → 400', async () => {
    const app = makeAcctApp('admin');
    const r = await request(app).get('/v1/master/accounts?category=bogus').set(TH_BIL);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_category');
  });

  test('?active=foo → 400', async () => {
    const app = makeAcctApp('admin');
    const r = await request(app).get('/v1/master/accounts?active=foo').set(TH_BIL);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_active');
  });

  test('tenant scoping', async () => {
    const store = new InMemoryAccountMasterStore();
    const app = makeAcctApp('admin', { accountMasterStore: store });
    await request(app).post('/v1/master/accounts').set(TH_BIL).send(validInput());
    expect((await request(app).get('/v1/master/accounts').set(TH_BANK)).body.body.total).toBe(0);
  });
});

describe('GET single + PATCH + DELETE', () => {
  test('get unknown → 404', async () => {
    const app = makeAcctApp('admin');
    expect((await request(app).get('/v1/master/accounts/GHOST').set(TH_BIL)).status).toBe(404);
  });

  test('patch happy', async () => {
    const store = new InMemoryAccountMasterStore();
    const app = makeAcctApp('admin', { accountMasterStore: store });
    await request(app).post('/v1/master/accounts').set(TH_BIL).send(validInput());
    const r = await request(app)
      .patch('/v1/master/accounts/PERSONAL_LOAN')
      .set(TH_BIL)
      .send({ active: false, interest_rate_pct: 14 });
    expect(r.status).toBe(200);
    expect(r.body.body.active).toBe(false);
    expect(r.body.body.interest_rate_pct).toBe(14);
  });

  test('patch unknown → 404', async () => {
    const app = makeAcctApp('admin');
    expect(
      (await request(app).patch('/v1/master/accounts/GHOST').set(TH_BIL).send({ active: false })).status,
    ).toBe(404);
  });

  test('delete + archive', async () => {
    const store = new InMemoryAccountMasterStore();
    const recovery = new InMemoryRecoveryStore();
    const app = makeAcctApp('admin', { accountMasterStore: store, recoveryStore: recovery });
    await request(app).post('/v1/master/accounts').set(TH_BIL).send(validInput());
    const r = await request(app).delete('/v1/master/accounts/PERSONAL_LOAN').set(TH_BIL);
    expect(r.status).toBe(204);
    const archived = await recovery.list({ tenant_id: 'BIL', entity_type: 'account_master' });
    expect(archived.items.length).toBe(1);
    expect(archived.items[0].original_table).toBe('app_master.accounts');
  });
});

describe('singleton + cap', () => {
  test('cap exported sensibly', () => {
    expect(ACCOUNT_MASTER_CAP_PER_TENANT).toBeGreaterThan(0);
    expect(ACCOUNT_MASTER_CAP_PER_TENANT).toBeLessThan(10_000);
  });
  test('default store interface', () => {
    expect(typeof defaultAccountMasterStore.create).toBe('function');
    expect(typeof defaultAccountMasterStore.restore).toBe('function');
  });
});
