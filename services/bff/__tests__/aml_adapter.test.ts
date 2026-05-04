// services/bff/__tests__/aml_adapter.test.ts
//
// T6 M14.3 — AML Watchlist adapter.

import request from 'supertest';
import {
  AmlError,
  StubAmlAdapter,
  isAmlMatchStatus,
  type AmlAdapter,
  type AmlMatch,
  type AmlMatchStatus,
} from '../src/integrations/aml';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-04T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };
const TH_BANK = { 'X-Tenant-ID': 'BANK_DEMO', 'X-Channel': 'API' };

function makeAmlApp(role: string = 'admin', amlAdapter?: AmlAdapter) {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
    amlAdapter,
  });
}

// ─── Type guards ───────────────────────────────────────────────────────

describe('isAmlMatchStatus', () => {
  test('accepts the 4 valid statuses', () => {
    expect(isAmlMatchStatus('open')).toBe(true);
    expect(isAmlMatchStatus('cleared')).toBe(true);
    expect(isAmlMatchStatus('escalated')).toBe(true);
    expect(isAmlMatchStatus('false_positive')).toBe(true);
  });
  test('rejects everything else', () => {
    expect(isAmlMatchStatus('OPEN')).toBe(false);
    expect(isAmlMatchStatus('done')).toBe(false);
    expect(isAmlMatchStatus(null)).toBe(false);
  });
});

// ─── StubAmlAdapter — screenCustomer ───────────────────────────────────

describe('StubAmlAdapter — screenCustomer', () => {
  test('shape: customer_id, screened_at, matches[], totals, requires_review', async () => {
    const a = new StubAmlAdapter();
    const r = await a.screenCustomer('BIL', 'c-101', NOW);
    expect(r.customer_id).toBe('c-101');
    expect(r.screened_at).toBe(NOW.toISOString());
    expect(Array.isArray(r.matches)).toBe(true);
    expect(r.total_matches).toBe(r.matches.length);
    expect(typeof r.requires_review).toBe('boolean');
  });

  test('deterministic — same (tenant, customer, day) → identical match ids', async () => {
    const a = new StubAmlAdapter();
    const r1 = await a.screenCustomer('BIL', 'c-101', NOW);
    const r2 = await a.screenCustomer('BIL', 'c-101', NOW);
    expect(r1.matches.map((m) => m.match_id)).toEqual(r2.matches.map((m) => m.match_id));
  });

  test('different tenants for same customer → different match ids', async () => {
    const a = new StubAmlAdapter();
    let differs = false;
    for (let i = 0; i < 50; i++) {
      const bil = await a.screenCustomer('BIL', `c-${i}`, NOW);
      const bank = await a.screenCustomer('BANK_DEMO', `c-${i}`, NOW);
      const bilIds = bil.matches.map((m) => m.match_id).join(',');
      const bankIds = bank.matches.map((m) => m.match_id).join(',');
      if (bilIds !== bankIds) {
        differs = true;
        break;
      }
    }
    expect(differs).toBe(true);
  });

  test('majority of customers come back clean (no matches)', async () => {
    const a = new StubAmlAdapter();
    let cleanCount = 0;
    const N = 100;
    for (let i = 0; i < N; i++) {
      const r = await a.screenCustomer('BIL', `c-${i}`, NOW);
      if (r.total_matches === 0) cleanCount++;
    }
    // ~85% clean per the distribution; loose ≥70% to avoid statistical flake
    expect(cleanCount).toBeGreaterThanOrEqual(70);
  });

  test('every match has required fields with valid types', async () => {
    const a = new StubAmlAdapter();
    for (let i = 0; i < 200; i++) {
      const r = await a.screenCustomer('BIL', `c-${i}`, NOW);
      for (const m of r.matches) {
        expect(m.match_id).toMatch(/^aml-bil-\d{7}$/);
        expect(m.customer_id).toBe(`c-${i}`);
        expect(['sanctions', 'pep', 'adverse_media', 'internal_watchlist']).toContain(m.match_type);
        expect(['high', 'medium', 'low']).toContain(m.severity);
        expect(typeof m.list_name).toBe('string');
        expect(typeof m.list_entry_id).toBe('string');
        expect(m.match_score).toBeGreaterThanOrEqual(0);
        expect(m.match_score).toBeLessThanOrEqual(1);
        expect(m.status).toBe('open');
      }
    }
  });

  test('matches sorted highest-severity first', async () => {
    const a = new StubAmlAdapter();
    // Find a customer with multiple matches
    for (let i = 0; i < 500; i++) {
      const r = await a.screenCustomer('BIL', `c-${i}`, NOW);
      if (r.matches.length >= 2) {
        const rank = (s: string) => (s === 'high' ? 3 : s === 'medium' ? 2 : 1);
        for (let j = 1; j < r.matches.length; j++) {
          expect(rank(r.matches[j - 1]!.severity) >= rank(r.matches[j]!.severity)).toBe(true);
        }
        return;
      }
    }
  });

  test('requires_review=true when any high-severity match present', async () => {
    const a = new StubAmlAdapter();
    let saw = false;
    for (let i = 0; i < 500; i++) {
      const r = await a.screenCustomer('BIL', `c-${i}`, NOW);
      if (r.matches.some((m) => m.severity === 'high')) {
        saw = true;
        expect(r.requires_review).toBe(true);
        expect(r.highest_severity).toBe('high');
        break;
      }
    }
    expect(saw).toBe(true);
  });

  test('clean customer → highest_severity=null, requires_review=false', async () => {
    const a = new StubAmlAdapter();
    // Find clean customer
    for (let i = 0; i < 50; i++) {
      const r = await a.screenCustomer('BIL', `c-${i}`, NOW);
      if (r.total_matches === 0) {
        expect(r.highest_severity).toBeNull();
        expect(r.requires_review).toBe(false);
        return;
      }
    }
  });

  test('empty customer_id → empty result, requires_review=false', async () => {
    const a = new StubAmlAdapter();
    const r = await a.screenCustomer('BIL', '', NOW);
    expect(r.total_matches).toBe(0);
    expect(r.requires_review).toBe(false);
  });
});

// ─── StubAmlAdapter — listMatches / getMatch / updateMatchStatus ───────

describe('StubAmlAdapter — listMatches + getMatch', () => {
  test('listMatches returns persisted matches after screenCustomer', async () => {
    const a = new StubAmlAdapter();
    // Find a customer with matches
    let withMatches: { customer_id: string; first_id: string } | null = null;
    for (let i = 0; i < 50; i++) {
      const r = await a.screenCustomer('BIL', `c-${i}`, NOW);
      if (r.matches.length > 0) {
        withMatches = { customer_id: `c-${i}`, first_id: r.matches[0]!.match_id };
        break;
      }
    }
    expect(withMatches).not.toBeNull();
    const list = await a.listMatches('BIL', withMatches!.customer_id);
    expect(list.length).toBeGreaterThan(0);
    expect(list.find((m) => m.match_id === withMatches!.first_id)).toBeDefined();
  });

  test('listMatches before screening returns empty', async () => {
    const a = new StubAmlAdapter();
    expect(await a.listMatches('BIL', 'c-not-screened')).toEqual([]);
  });

  test('getMatch returns the persisted match, null on miss / cross-tenant', async () => {
    const a = new StubAmlAdapter();
    let id: string | null = null;
    for (let i = 0; i < 50 && !id; i++) {
      const r = await a.screenCustomer('BIL', `c-${i}`, NOW);
      if (r.matches.length > 0) id = r.matches[0]!.match_id;
    }
    expect(id).not.toBeNull();
    const m = await a.getMatch('BIL', id!);
    expect(m).not.toBeNull();
    expect(m!.match_id).toBe(id!);
    expect(await a.getMatch('BIL', 'aml-bil-9999999')).toBeNull();
    expect(await a.getMatch('BANK_DEMO', id!)).toBeNull();
  });
});

describe('StubAmlAdapter — updateMatchStatus', () => {
  async function findMatch(a: StubAmlAdapter): Promise<AmlMatch> {
    for (let i = 0; i < 200; i++) {
      const r = await a.screenCustomer('BIL', `c-${i}`, NOW);
      if (r.matches.length > 0) return r.matches[0]!;
    }
    throw new Error('test fixture: no matches found');
  }

  test('updates status, sets status_changed_at + status_changed_by', async () => {
    const a = new StubAmlAdapter();
    const m = await findMatch(a);
    const updated = await a.updateMatchStatus('BIL', m.match_id, 'cleared', 'taniya', NOW);
    expect(updated.status).toBe('cleared');
    expect(updated.status_changed_at).toBe(NOW.toISOString());
    expect(updated.status_changed_by).toBe('taniya');
  });

  test('subsequent get reflects the new status', async () => {
    const a = new StubAmlAdapter();
    const m = await findMatch(a);
    await a.updateMatchStatus('BIL', m.match_id, 'escalated', 'taniya', NOW);
    const fresh = await a.getMatch('BIL', m.match_id);
    expect(fresh!.status).toBe('escalated');
  });

  test('listMatches reflects the new status (mirrored across both maps)', async () => {
    const a = new StubAmlAdapter();
    const m = await findMatch(a);
    await a.updateMatchStatus('BIL', m.match_id, 'false_positive', 'taniya', NOW);
    const list = await a.listMatches('BIL', m.customer_id);
    const fromList = list.find((x) => x.match_id === m.match_id);
    expect(fromList!.status).toBe('false_positive');
  });

  test('unknown match_id throws AmlError(unknown_match)', async () => {
    const a = new StubAmlAdapter();
    try {
      await a.updateMatchStatus('BIL', 'aml-bil-9999999', 'cleared', 't', NOW);
      fail('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(AmlError);
      expect((e as AmlError).code).toBe('unknown_match');
    }
  });

  test('invalid status throws AmlError(invalid_status)', async () => {
    const a = new StubAmlAdapter();
    const m = await findMatch(a);
    try {
      await a.updateMatchStatus('BIL', m.match_id, 'done' as never, 't', NOW);
      fail('expected throw');
    } catch (e) {
      expect((e as AmlError).code).toBe('invalid_status');
    }
  });
});

// ─── Routes ────────────────────────────────────────────────────────────

describe('POST /v1/integrations/aml/screen', () => {
  test('admin: 200 with enveloped result', async () => {
    const { app } = makeAmlApp('admin');
    const r = await request(app)
      .post('/v1/integrations/aml/screen')
      .set(TH_BIL)
      .send({ customer_id: 'c-101' });
    expect(r.status).toBe(200);
    expect(r.body.body.customer_id).toBe('c-101');
    expect(typeof r.body.body.requires_review).toBe('boolean');
  });

  test('accepts an enveloped request body', async () => {
    const { app } = makeAmlApp('admin');
    const r = await request(app)
      .post('/v1/integrations/aml/screen')
      .set(TH_BIL)
      .send({ header: { requestId: 'r-1' }, body: { customer_id: 'c-101' } });
    expect(r.status).toBe(200);
    expect(r.body.body.customer_id).toBe('c-101');
  });

  test('missing customer_id → 400', async () => {
    const { app } = makeAmlApp('admin');
    const r = await request(app).post('/v1/integrations/aml/screen').set(TH_BIL).send({});
    expect(r.status).toBe(400);
  });

  test('risk_analyst accepted', async () => {
    const { app } = makeAmlApp('risk_analyst');
    const r = await request(app)
      .post('/v1/integrations/aml/screen')
      .set(TH_BIL)
      .send({ customer_id: 'c-101' });
    expect(r.status).toBe(200);
  });

  test('unknown role → 403', async () => {
    const { app } = makeAmlApp('case_owner');
    const r = await request(app)
      .post('/v1/integrations/aml/screen')
      .set(TH_BIL)
      .send({ customer_id: 'c-101' });
    expect(r.status).toBe(403);
  });

  test('adapter throwing → 502 envelope', async () => {
    const exploding: AmlAdapter = {
      async screenCustomer() {
        throw new Error('hub timeout');
      },
      async listMatches() {
        return [];
      },
      async getMatch() {
        return null;
      },
      async updateMatchStatus() {
        return {} as AmlMatch;
      },
    };
    const { app } = makeAmlApp('admin', exploding);
    const r = await request(app)
      .post('/v1/integrations/aml/screen')
      .set(TH_BIL)
      .send({ customer_id: 'c-101' });
    expect(r.status).toBe(502);
    expect(r.body.error.code).toBe('EWS_502');
  });
});

describe('GET /v1/integrations/aml/matches', () => {
  test('returns persisted matches after screening', async () => {
    const adapter = new StubAmlAdapter();
    const { app } = makeAmlApp('admin', adapter);
    // Screen many customers; pick the first with matches
    let target: string | null = null;
    for (let i = 0; i < 50 && !target; i++) {
      await request(app)
        .post('/v1/integrations/aml/screen')
        .set(TH_BIL)
        .send({ customer_id: `c-${i}` });
      const list = await adapter.listMatches('BIL', `c-${i}`);
      if (list.length > 0) target = `c-${i}`;
    }
    expect(target).not.toBeNull();
    const r = await request(app)
      .get(`/v1/integrations/aml/matches?customer_id=${target}`)
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.customer_id).toBe(target);
    expect(r.body.body.total).toBeGreaterThan(0);
  });

  test('missing customer_id → 400', async () => {
    const { app } = makeAmlApp('admin');
    const r = await request(app).get('/v1/integrations/aml/matches').set(TH_BIL);
    expect(r.status).toBe(400);
  });

  test('unknown role → 403', async () => {
    const { app } = makeAmlApp('case_owner');
    const r = await request(app)
      .get('/v1/integrations/aml/matches?customer_id=c-1')
      .set(TH_BIL);
    expect(r.status).toBe(403);
  });
});

describe('GET /v1/integrations/aml/matches/:match_id', () => {
  test('valid id → 200 with the match', async () => {
    const adapter = new StubAmlAdapter();
    const { app } = makeAmlApp('admin', adapter);
    let id: string | null = null;
    for (let i = 0; i < 50 && !id; i++) {
      const r = await adapter.screenCustomer('BIL', `c-${i}`, NOW);
      if (r.matches.length > 0) id = r.matches[0]!.match_id;
    }
    const r = await request(app).get(`/v1/integrations/aml/matches/${id}`).set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.match_id).toBe(id);
  });

  test('unknown id → 404', async () => {
    const { app } = makeAmlApp('admin');
    const r = await request(app).get('/v1/integrations/aml/matches/aml-bil-9999999').set(TH_BIL);
    expect(r.status).toBe(404);
  });

  test('cross-tenant lookup → 404', async () => {
    const adapter = new StubAmlAdapter();
    const { app } = makeAmlApp('admin', adapter);
    let id: string | null = null;
    for (let i = 0; i < 50 && !id; i++) {
      const r = await adapter.screenCustomer('BIL', `c-${i}`, NOW);
      if (r.matches.length > 0) id = r.matches[0]!.match_id;
    }
    const r = await request(app).get(`/v1/integrations/aml/matches/${id}`).set(TH_BANK);
    expect(r.status).toBe(404);
  });
});

describe('PATCH /v1/integrations/aml/matches/:match_id', () => {
  async function seedMatch(adapter: StubAmlAdapter): Promise<{ id: string; customer: string }> {
    for (let i = 0; i < 50; i++) {
      const r = await adapter.screenCustomer('BIL', `c-${i}`, NOW);
      if (r.matches.length > 0) return { id: r.matches[0]!.match_id, customer: `c-${i}` };
    }
    throw new Error('fixture: no matches');
  }

  test('valid status → 200 with updated fields', async () => {
    const adapter = new StubAmlAdapter();
    const { app } = makeAmlApp('admin', adapter);
    const { id } = await seedMatch(adapter);
    const r = await request(app)
      .patch(`/v1/integrations/aml/matches/${id}`)
      .set(TH_BIL)
      .set('x-apex-user', 'taniya')
      .send({ status: 'cleared' });
    expect(r.status).toBe(200);
    expect(r.body.body.status).toBe('cleared');
    expect(r.body.body.status_changed_by).toBe('taniya');
  });

  test('default changed_by is "admin" when no x-apex-user header', async () => {
    const adapter = new StubAmlAdapter();
    const { app } = makeAmlApp('admin', adapter);
    const { id } = await seedMatch(adapter);
    const r = await request(app)
      .patch(`/v1/integrations/aml/matches/${id}`)
      .set(TH_BIL)
      .send({ status: 'cleared' });
    expect(r.body.body.status_changed_by).toBe('admin');
  });

  test('accepts an enveloped request body', async () => {
    const adapter = new StubAmlAdapter();
    const { app } = makeAmlApp('admin', adapter);
    const { id } = await seedMatch(adapter);
    const r = await request(app)
      .patch(`/v1/integrations/aml/matches/${id}`)
      .set(TH_BIL)
      .send({ header: { requestId: 'r-1' }, body: { status: 'escalated' } });
    expect(r.status).toBe(200);
    expect(r.body.body.status).toBe('escalated');
  });

  test('invalid status → 400 EWS_400_invalid_status', async () => {
    const adapter = new StubAmlAdapter();
    const { app } = makeAmlApp('admin', adapter);
    const { id } = await seedMatch(adapter);
    const r = await request(app)
      .patch(`/v1/integrations/aml/matches/${id}`)
      .set(TH_BIL)
      .send({ status: 'done' });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_status');
  });

  test('unknown match_id → 404 EWS_404_unknown_match', async () => {
    const { app } = makeAmlApp('admin');
    const r = await request(app)
      .patch('/v1/integrations/aml/matches/aml-bil-9999999')
      .set(TH_BIL)
      .send({ status: 'cleared' });
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('EWS_404_unknown_match');
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeAmlApp('case_owner');
    const r = await request(app)
      .patch('/v1/integrations/aml/matches/aml-bil-1234567')
      .set(TH_BIL)
      .send({ status: 'cleared' });
    expect(r.status).toBe(403);
  });
});

describe('Tenant isolation through routes', () => {
  test('BIL screen does not leak to BANK_DEMO listMatches', async () => {
    const adapter = new StubAmlAdapter();
    const { app } = makeAmlApp('admin', adapter);
    await request(app)
      .post('/v1/integrations/aml/screen')
      .set(TH_BIL)
      .send({ customer_id: 'c-101' });
    const bank = await request(app)
      .get('/v1/integrations/aml/matches?customer_id=c-101')
      .set(TH_BANK);
    expect(bank.status).toBe(200);
    expect(bank.body.body.total).toBe(0);
  });
});
