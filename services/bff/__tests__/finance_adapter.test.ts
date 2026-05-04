// services/bff/__tests__/finance_adapter.test.ts
//
// T6 M14.7 — Finance / Treasury adapter.

import request from 'supertest';
import {
  FinanceError,
  StubFinanceAdapter,
  type FinanceAccount,
  type FinanceAdapter,
  type LedgerEntry,
} from '../src/integrations/finance';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-04T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };
const TH_BANK = { 'X-Tenant-ID': 'BANK_DEMO', 'X-Channel': 'API' };

function makeFinApp(role: string = 'admin', financeAdapter?: FinanceAdapter) {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
    financeAdapter,
  });
}

// ─── StubFinanceAdapter — listAccountsForCustomer ──────────────────────

describe('StubFinanceAdapter — listAccountsForCustomer', () => {
  test('returns 0-7 accounts with valid types and statuses', async () => {
    const a = new StubFinanceAdapter();
    const out = await a.listAccountsForCustomer('BIL', 'c-101', NOW);
    expect(out.length).toBeGreaterThanOrEqual(0);
    expect(out.length).toBeLessThanOrEqual(7);
    for (const acct of out) {
      expect(acct.account_id).toMatch(/^ACC-BIL-\d{7}$/);
      expect(acct.customer_id).toBe('c-101');
      expect(['savings', 'current', 'loan', 'credit_card']).toContain(acct.account_type);
      expect(['active', 'frozen', 'closed']).toContain(acct.status);
      expect(acct.currency).toBe('KES');
    }
  });

  test('deterministic — same (tenant, customer) → identical accounts', async () => {
    const a = new StubFinanceAdapter();
    const a1 = await a.listAccountsForCustomer('BIL', 'c-101', NOW);
    const a2 = await a.listAccountsForCustomer('BIL', 'c-101', NOW);
    expect(a1.map((x) => x.account_id)).toEqual(a2.map((x) => x.account_id));
  });

  test('different tenants → disjoint account_ids', async () => {
    const a = new StubFinanceAdapter();
    let differs = false;
    for (let i = 0; i < 30 && !differs; i++) {
      const bil = await a.listAccountsForCustomer('BIL', `c-${i}`, NOW);
      const bank = await a.listAccountsForCustomer('BANK_DEMO', `c-${i}`, NOW);
      const bilIds = new Set(bil.map((x) => x.account_id));
      for (const x of bank) expect(bilIds.has(x.account_id)).toBe(false);
      if (bil.length > 0 || bank.length > 0) differs = true;
    }
    expect(differs).toBe(true);
  });

  test('sorted newest-activity-first', async () => {
    const a = new StubFinanceAdapter();
    for (let i = 0; i < 50; i++) {
      const accts = await a.listAccountsForCustomer('BIL', `c-${i}`, NOW);
      if (accts.length >= 2) {
        for (let j = 1; j < accts.length; j++) {
          expect(accts[j - 1]!.last_activity_at >= accts[j]!.last_activity_at).toBe(true);
        }
        return;
      }
    }
  });

  test('balance sign respects account type', async () => {
    const a = new StubFinanceAdapter();
    let sawLoan = false;
    let sawSavings = false;
    let sawCard = false;
    for (let i = 0; i < 80 && !(sawLoan && sawSavings && sawCard); i++) {
      const accts = await a.listAccountsForCustomer('BIL', `c-${i}`, NOW);
      for (const acct of accts) {
        if (acct.account_type === 'loan') {
          // loans always negative (debt owed)
          expect(acct.balance_kes).toBeLessThan(0);
          sawLoan = true;
        } else if (acct.account_type === 'savings') {
          // savings always positive
          expect(acct.balance_kes).toBeGreaterThan(0);
          sawSavings = true;
        } else if (acct.account_type === 'credit_card') {
          // credit_card always 0 or negative (utilised)
          expect(acct.balance_kes).toBeLessThanOrEqual(0);
          sawCard = true;
        }
      }
    }
    expect(sawLoan && sawSavings && sawCard).toBe(true);
  });

  test('closed accounts have last_activity_at older than 90 days', async () => {
    const a = new StubFinanceAdapter();
    let saw = false;
    const cutoff = new Date(NOW.getTime() - 90 * 86_400_000).toISOString();
    for (let i = 0; i < 100 && !saw; i++) {
      const accts = await a.listAccountsForCustomer('BIL', `c-${i}`, NOW);
      for (const acct of accts) {
        if (acct.status === 'closed') {
          saw = true;
          expect(acct.last_activity_at < cutoff).toBe(true);
        }
      }
    }
    expect(saw).toBe(true);
  });

  test('empty customer_id → empty list', async () => {
    const a = new StubFinanceAdapter();
    expect(await a.listAccountsForCustomer('BIL', '', NOW)).toEqual([]);
  });
});

// ─── StubFinanceAdapter — getAccount ───────────────────────────────────

describe('StubFinanceAdapter — getAccount', () => {
  test('after listAccountsForCustomer, accounts are gettable by id', async () => {
    const a = new StubFinanceAdapter();
    let acct: FinanceAccount | null = null;
    for (let i = 0; i < 50 && !acct; i++) {
      const list = await a.listAccountsForCustomer('BIL', `c-${i}`, NOW);
      if (list.length > 0) acct = list[0]!;
    }
    expect(acct).not.toBeNull();
    const got = await a.getAccount('BIL', acct!.account_id, NOW);
    expect(got).toEqual(acct);
  });

  test('unknown account_id → null', async () => {
    const a = new StubFinanceAdapter();
    expect(await a.getAccount('BIL', 'ACC-BIL-9999999', NOW)).toBeNull();
  });

  test('cross-tenant lookup → null', async () => {
    const a = new StubFinanceAdapter();
    let acct: FinanceAccount | null = null;
    for (let i = 0; i < 50 && !acct; i++) {
      const list = await a.listAccountsForCustomer('BIL', `c-${i}`, NOW);
      if (list.length > 0) acct = list[0]!;
    }
    expect(await a.getAccount('BANK_DEMO', acct!.account_id, NOW)).toBeNull();
  });
});

// ─── StubFinanceAdapter — listLedger ───────────────────────────────────

describe('StubFinanceAdapter — listLedger', () => {
  async function findActiveAccount(a: StubFinanceAdapter): Promise<FinanceAccount> {
    for (let i = 0; i < 100; i++) {
      const list = await a.listAccountsForCustomer('BIL', `c-${i}`, NOW);
      const active = list.find((x) => x.status === 'active');
      if (active) return active;
    }
    throw new Error('fixture: no active account');
  }

  test('returns paginated ledger sorted newest-first', async () => {
    const a = new StubFinanceAdapter();
    const acct = await findActiveAccount(a);
    const out = await a.listLedger('BIL', acct.account_id, {}, NOW);
    expect(out.account_id).toBe(acct.account_id);
    expect(out.total).toBeGreaterThan(0);
    expect(out.items.length).toBeLessThanOrEqual(50);
    for (let i = 1; i < out.items.length; i++) {
      expect(out.items[i - 1]!.posted_at >= out.items[i]!.posted_at).toBe(true);
    }
  });

  test('every entry has valid type + currency + non-empty narrative', async () => {
    const a = new StubFinanceAdapter();
    const acct = await findActiveAccount(a);
    const out = await a.listLedger('BIL', acct.account_id, { page_size: 200 }, NOW);
    for (const e of out.items) {
      expect(['credit', 'debit']).toContain(e.type);
      expect(e.currency).toBe('KES');
      expect(typeof e.narrative).toBe('string');
      expect(e.narrative.length).toBeGreaterThan(0);
      expect(e.account_id).toBe(acct.account_id);
      expect(e.amount_kes).toBeGreaterThan(0);
    }
  });

  test('newest entry balance_kes_after equals current balance', async () => {
    const a = new StubFinanceAdapter();
    const acct = await findActiveAccount(a);
    const out = await a.listLedger('BIL', acct.account_id, {}, NOW);
    expect(out.items[0]!.balance_kes_after).toBe(acct.balance_kes);
  });

  test('since filter narrows to entries posted on/after the threshold', async () => {
    const a = new StubFinanceAdapter();
    const acct = await findActiveAccount(a);
    const cutoff = '2026-01-01T00:00:00.000Z';
    const out = await a.listLedger('BIL', acct.account_id, { since: cutoff }, NOW);
    for (const e of out.items) {
      expect(e.posted_at >= cutoff).toBe(true);
    }
  });

  test('until filter narrows to entries posted on/before the threshold', async () => {
    const a = new StubFinanceAdapter();
    const acct = await findActiveAccount(a);
    const cutoff = '2026-03-01T00:00:00.000Z';
    const out = await a.listLedger('BIL', acct.account_id, { until: cutoff }, NOW);
    for (const e of out.items) {
      expect(e.posted_at <= cutoff).toBe(true);
    }
  });

  test('pagination disjoint, page_size clamped to [1, 200]', async () => {
    const a = new StubFinanceAdapter();
    const acct = await findActiveAccount(a);
    const p1 = await a.listLedger('BIL', acct.account_id, { page: 1, page_size: 5 }, NOW);
    const p2 = await a.listLedger('BIL', acct.account_id, { page: 2, page_size: 5 }, NOW);
    const ids1 = new Set(p1.items.map((x) => x.entry_id));
    for (const x of p2.items) expect(ids1.has(x.entry_id)).toBe(false);
    expect((await a.listLedger('BIL', acct.account_id, { page_size: 99999 }, NOW)).page_size).toBe(200);
  });

  test('unknown account → FinanceError(unknown_account)', async () => {
    const a = new StubFinanceAdapter();
    try {
      await a.listLedger('BIL', 'ACC-BIL-9999999', {}, NOW);
      fail('expected throw');
    } catch (e) {
      expect((e as FinanceError).code).toBe('unknown_account');
    }
  });

  test('invalid since → FinanceError(invalid_since)', async () => {
    const a = new StubFinanceAdapter();
    const acct = await findActiveAccount(a);
    try {
      await a.listLedger('BIL', acct.account_id, { since: 'not-a-date' }, NOW);
      fail('expected throw');
    } catch (e) {
      expect((e as FinanceError).code).toBe('invalid_since');
    }
  });

  test('cross-tenant ledger → unknown_account throw', async () => {
    const a = new StubFinanceAdapter();
    const acct = await findActiveAccount(a);
    try {
      await a.listLedger('BANK_DEMO', acct.account_id, {}, NOW);
      fail('expected throw');
    } catch (e) {
      expect((e as FinanceError).code).toBe('unknown_account');
    }
  });
});

// ─── Routes ────────────────────────────────────────────────────────────

describe('GET /v1/integrations/finance/accounts', () => {
  test('admin: 200 with enveloped list', async () => {
    const { app } = makeFinApp('admin');
    const r = await request(app)
      .get('/v1/integrations/finance/accounts?customer_id=c-101')
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.customer_id).toBe('c-101');
    expect(Array.isArray(r.body.body.items)).toBe(true);
  });

  test('missing customer_id → 400', async () => {
    const { app } = makeFinApp('admin');
    const r = await request(app).get('/v1/integrations/finance/accounts').set(TH_BIL);
    expect(r.status).toBe(400);
  });

  test('different tenants get disjoint accounts for same customer', async () => {
    const { app } = makeFinApp('admin');
    const bil = await request(app)
      .get('/v1/integrations/finance/accounts?customer_id=c-101')
      .set(TH_BIL);
    const bank = await request(app)
      .get('/v1/integrations/finance/accounts?customer_id=c-101')
      .set(TH_BANK);
    const bilIds: string[] = (bil.body.body.items as FinanceAccount[]).map((x) => x.account_id);
    for (const x of bank.body.body.items as FinanceAccount[]) {
      expect(bilIds).not.toContain(x.account_id);
    }
  });

  test('unknown role → 403', async () => {
    const { app } = makeFinApp('case_owner');
    const r = await request(app)
      .get('/v1/integrations/finance/accounts?customer_id=c-101')
      .set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('adapter throwing → 502 envelope', async () => {
    const exploding: FinanceAdapter = {
      async getAccount() {
        return null;
      },
      async listAccountsForCustomer() {
        throw new Error('upstream timeout');
      },
      async listLedger() {
        return {
          items: [],
          account_id: '',
          page: 1,
          page_size: 50,
          total: 0,
          since: null,
          until: null,
        };
      },
    };
    const { app } = makeFinApp('admin', exploding);
    const r = await request(app)
      .get('/v1/integrations/finance/accounts?customer_id=c-101')
      .set(TH_BIL);
    expect(r.status).toBe(502);
  });
});

describe('GET /v1/integrations/finance/accounts/:account_id', () => {
  test('valid id (after listing) → 200', async () => {
    const adapter = new StubFinanceAdapter();
    const { app } = makeFinApp('admin', adapter);
    let target_id: string | null = null;
    for (let i = 0; i < 50 && !target_id; i++) {
      const list = await adapter.listAccountsForCustomer('BIL', `c-${i}`, NOW);
      if (list.length > 0) target_id = list[0]!.account_id;
    }
    const r = await request(app)
      .get(`/v1/integrations/finance/accounts/${target_id}`)
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.account_id).toBe(target_id);
  });

  test('unknown id → 404', async () => {
    const { app } = makeFinApp('admin');
    const r = await request(app)
      .get('/v1/integrations/finance/accounts/ACC-BIL-9999999')
      .set(TH_BIL);
    expect(r.status).toBe(404);
  });

  test('cross-tenant lookup → 404', async () => {
    const adapter = new StubFinanceAdapter();
    const { app } = makeFinApp('admin', adapter);
    let target_id: string | null = null;
    for (let i = 0; i < 50 && !target_id; i++) {
      const list = await adapter.listAccountsForCustomer('BIL', `c-${i}`, NOW);
      if (list.length > 0) target_id = list[0]!.account_id;
    }
    const r = await request(app)
      .get(`/v1/integrations/finance/accounts/${target_id}`)
      .set(TH_BANK);
    expect(r.status).toBe(404);
  });
});

describe('GET /v1/integrations/finance/accounts/:account_id/ledger', () => {
  async function seedLedger(): Promise<{ adapter: StubFinanceAdapter; account_id: string }> {
    const adapter = new StubFinanceAdapter();
    for (let i = 0; i < 100; i++) {
      const list = await adapter.listAccountsForCustomer('BIL', `c-${i}`, NOW);
      const active = list.find((x) => x.status === 'active');
      if (active) return { adapter, account_id: active.account_id };
    }
    throw new Error('fixture: no active account');
  }

  test('returns paginated ledger newest-first', async () => {
    const { adapter, account_id } = await seedLedger();
    const { app } = makeFinApp('admin', adapter);
    const r = await request(app)
      .get(`/v1/integrations/finance/accounts/${account_id}/ledger`)
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.account_id).toBe(account_id);
    expect(r.body.body.total).toBeGreaterThan(0);
    const items = r.body.body.items as LedgerEntry[];
    for (let i = 1; i < items.length; i++) {
      expect(items[i - 1]!.posted_at >= items[i]!.posted_at).toBe(true);
    }
  });

  test('?since + ?until filter', async () => {
    const { adapter, account_id } = await seedLedger();
    const { app } = makeFinApp('admin', adapter);
    const r = await request(app)
      .get(
        `/v1/integrations/finance/accounts/${account_id}/ledger?since=2026-01-01T00:00:00.000Z&until=2026-03-01T00:00:00.000Z`,
      )
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.since).toBe('2026-01-01T00:00:00.000Z');
    expect(r.body.body.until).toBe('2026-03-01T00:00:00.000Z');
    for (const e of r.body.body.items as LedgerEntry[]) {
      expect(e.posted_at >= '2026-01-01T00:00:00.000Z').toBe(true);
      expect(e.posted_at <= '2026-03-01T00:00:00.000Z').toBe(true);
    }
  });

  test('?since=invalid → 400 EWS_400_invalid_since', async () => {
    const { adapter, account_id } = await seedLedger();
    const { app } = makeFinApp('admin', adapter);
    const r = await request(app)
      .get(`/v1/integrations/finance/accounts/${account_id}/ledger?since=garbage`)
      .set(TH_BIL);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_since');
  });

  test('unknown account → 404 EWS_404_unknown_account', async () => {
    const { app } = makeFinApp('admin');
    const r = await request(app)
      .get('/v1/integrations/finance/accounts/ACC-BIL-9999999/ledger')
      .set(TH_BIL);
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('EWS_404_unknown_account');
  });

  test('cross-tenant ledger → 404 EWS_404_unknown_account', async () => {
    const { adapter, account_id } = await seedLedger();
    const { app } = makeFinApp('admin', adapter);
    const r = await request(app)
      .get(`/v1/integrations/finance/accounts/${account_id}/ledger`)
      .set(TH_BANK);
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('EWS_404_unknown_account');
  });

  test('?page=2&page_size=5 disjoint from page 1', async () => {
    const { adapter, account_id } = await seedLedger();
    const { app } = makeFinApp('admin', adapter);
    const p1 = await request(app)
      .get(`/v1/integrations/finance/accounts/${account_id}/ledger?page=1&page_size=5`)
      .set(TH_BIL);
    const p2 = await request(app)
      .get(`/v1/integrations/finance/accounts/${account_id}/ledger?page=2&page_size=5`)
      .set(TH_BIL);
    const ids1 = new Set((p1.body.body.items as LedgerEntry[]).map((x) => x.entry_id));
    for (const x of p2.body.body.items as LedgerEntry[]) {
      expect(ids1.has(x.entry_id)).toBe(false);
    }
  });
});

describe('Tenant isolation through routes', () => {
  test('BIL accounts list does not leak to BANK_DEMO', async () => {
    const { app } = makeFinApp('admin');
    const bil = await request(app)
      .get('/v1/integrations/finance/accounts?customer_id=c-101')
      .set(TH_BIL);
    const bank = await request(app)
      .get('/v1/integrations/finance/accounts?customer_id=c-101')
      .set(TH_BANK);
    const bilIds = new Set(
      (bil.body.body.items as FinanceAccount[]).map((x) => x.account_id),
    );
    for (const x of bank.body.body.items as FinanceAccount[]) {
      expect(bilIds.has(x.account_id)).toBe(false);
    }
  });
});
