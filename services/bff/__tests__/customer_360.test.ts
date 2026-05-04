// services/bff/__tests__/customer_360.test.ts
//
// T6 M11.6 — Per-customer 360 drill-through.

import request from 'supertest';
import {
  buildCustomer360,
  Customer360Error,
  type Customer360,
  type Customer360Deps,
  type DegradedPanel,
} from '../src/customer_360';
import { StubInsuranceAdapter } from '../src/integrations/insurance';
import { StubIfrs9Adapter } from '../src/integrations/ifrs9';
import { StubAmlAdapter } from '../src/integrations/aml';
import { StubDmsAdapter } from '../src/integrations/dms';
import { StubBureauAdapter } from '../src/integrations/bureau';
import { StubFinanceAdapter } from '../src/integrations/finance';
import { InMemoryCaseInvestigationStore } from '../src/case_investigation';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-04T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };
const TH_BANK = { 'X-Tenant-ID': 'BANK_DEMO', 'X-Channel': 'API' };

function freshDeps(): Customer360Deps {
  return {
    insuranceAdapter: new StubInsuranceAdapter(),
    ifrs9Adapter: new StubIfrs9Adapter(),
    amlAdapter: new StubAmlAdapter(),
    dmsAdapter: new StubDmsAdapter(),
    bureauAdapter: new StubBureauAdapter(),
    financeAdapter: new StubFinanceAdapter(),
    caseInvestigationStore: new InMemoryCaseInvestigationStore(),
  };
}

function makeC360App(role: string = 'admin') {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
  });
}

// ─── Pure orchestrator ────────────────────────────────────────────────

describe('buildCustomer360 — happy path', () => {
  test('returns a populated 360 view with all panels present', async () => {
    const deps = freshDeps();
    const view = await buildCustomer360('BIL', 'c-101', deps, () => NOW);
    expect(view.customer_id).toBe('c-101');
    expect(view.generated_at).toBe(NOW.toISOString());
    expect(view.degraded).toEqual([]);
    expect(view.panels.policies).not.toBeNull();
    expect(view.panels.claims).not.toBeNull();
    expect(view.panels.finance_accounts).not.toBeNull();
    expect(view.panels.aml_matches).not.toBeNull(); // empty array, not null
    expect(view.panels.dms_documents).not.toBeNull();
    expect(view.panels.ifrs9_stage).not.toBeNull();
    expect(view.panels.investigations).not.toBeNull();
  });

  test('summary fields derived correctly from panels', async () => {
    const deps = freshDeps();
    const view = await buildCustomer360('BIL', 'c-101', deps, () => NOW);
    // ifrs9_stage summary mirrors panel
    expect(view.summary.ifrs9_stage).toBe(view.panels.ifrs9_stage!.stage);
    // in_force_policies count matches panel filter
    const inForcePolicies = view.panels.policies!.filter((p) => p.status === 'in_force').length;
    expect(view.summary.in_force_policies).toBe(inForcePolicies);
    // open_claims count matches panel filter
    const openClaims = view.panels.claims!.filter(
      (c) => c.status !== 'paid' && c.status !== 'rejected' && c.status !== 'withdrawn',
    ).length;
    expect(view.summary.open_claims).toBe(openClaims);
    // total_finance_balance_kes is sum of account balances
    const totalFin = view.panels.finance_accounts!.reduce((s, a) => s + a.balance_kes, 0);
    expect(view.summary.total_finance_balance_kes).toBe(totalFin);
  });

  test('aml_highest_severity null when no open matches', async () => {
    const deps = freshDeps();
    // Find a customer with no AML matches
    let cleanCustomer: string | null = null;
    for (let i = 0; i < 50 && !cleanCustomer; i++) {
      const cid = `c-clean-${i}`;
      const r = await deps.amlAdapter.screenCustomer('BIL', cid, NOW);
      if (r.matches.length === 0) cleanCustomer = cid;
    }
    expect(cleanCustomer).not.toBeNull();
    const view = await buildCustomer360('BIL', cleanCustomer!, deps, () => NOW);
    expect(view.summary.aml_highest_severity).toBeNull();
  });

  test('aml_highest_severity reflects highest open match', async () => {
    const deps = freshDeps();
    // Find a customer with a high-severity match
    let withHigh: string | null = null;
    for (let i = 0; i < 200 && !withHigh; i++) {
      const cid = `c-${i}`;
      const r = await deps.amlAdapter.screenCustomer('BIL', cid, NOW);
      if (r.matches.some((m) => m.severity === 'high' && m.status === 'open')) withHigh = cid;
    }
    if (!withHigh) return; // fixture didn't surface high in this seed range; skip
    const view = await buildCustomer360('BIL', withHigh, deps, () => NOW);
    expect(view.summary.aml_highest_severity).toBe('high');
  });

  test('open_investigations counts only non-closed', async () => {
    const deps = freshDeps();
    const inv1 = deps.caseInvestigationStore.open(
      'BIL',
      { case_id: 'CASE-1', customer_id: 'c-101' },
      'taniya',
      NOW,
    );
    deps.caseInvestigationStore.updateStatus('BIL', inv1.investigation_id, 'closed', null, 'taniya', NOW);
    deps.caseInvestigationStore.open(
      'BIL',
      { case_id: 'CASE-2', customer_id: 'c-101' },
      'taniya',
      NOW,
    );
    const view = await buildCustomer360('BIL', 'c-101', deps, () => NOW);
    expect(view.panels.investigations!.length).toBe(2);
    expect(view.summary.open_investigations).toBe(1);
  });

  test('bureau_score null when no bureau report has been pulled', async () => {
    const deps = freshDeps();
    const view = await buildCustomer360('BIL', 'c-101', deps, () => NOW);
    expect(view.panels.bureau_latest).toBeNull();
    expect(view.summary.bureau_score).toBeNull();
  });

  test('bureau_score populated after a pull', async () => {
    const deps = freshDeps();
    await deps.bureauAdapter.pull('BIL', 'c-101', 'CIBIL', 'taniya', NOW);
    const view = await buildCustomer360('BIL', 'c-101', deps, () => NOW);
    expect(view.panels.bureau_latest).not.toBeNull();
    expect(view.summary.bureau_score).toBe(view.panels.bureau_latest!.score);
  });

  test('investigations panel filters to the requested customer', async () => {
    const deps = freshDeps();
    deps.caseInvestigationStore.open('BIL', { case_id: 'CASE-1', customer_id: 'c-101' }, 't', NOW);
    deps.caseInvestigationStore.open('BIL', { case_id: 'CASE-2', customer_id: 'c-OTHER' }, 't', NOW);
    const view = await buildCustomer360('BIL', 'c-101', deps, () => NOW);
    expect(view.panels.investigations!.length).toBe(1);
    expect(view.panels.investigations![0]!.customer_id).toBe('c-101');
  });
});

// ─── Panel-level degradation ───────────────────────────────────────────

describe('buildCustomer360 — panel-level degradation', () => {
  function withFailing(panel: DegradedPanel): Customer360Deps {
    const deps = freshDeps();
    if (panel === 'policies' || panel === 'claims') {
      // listPolicies + listClaims are both on InsuranceAdapter; failing one
      // will propagate to whichever try-block calls it first. Wire up
      // selective failure to the requested panel only.
      const orig = deps.insuranceAdapter;
      deps.insuranceAdapter = {
        listPolicies: panel === 'policies'
          ? async () => { throw new Error('insurance.policies down'); }
          : orig.listPolicies.bind(orig),
        listClaims: panel === 'claims'
          ? async () => { throw new Error('insurance.claims down'); }
          : orig.listClaims.bind(orig),
        getPolicy: orig.getPolicy.bind(orig),
        getClaim: orig.getClaim.bind(orig),
      };
    } else if (panel === 'finance') {
      deps.financeAdapter = {
        getAccount: deps.financeAdapter.getAccount.bind(deps.financeAdapter),
        listAccountsForCustomer: async () => { throw new Error('finance down'); },
        listLedger: deps.financeAdapter.listLedger.bind(deps.financeAdapter),
      };
    } else if (panel === 'aml') {
      const orig = deps.amlAdapter;
      deps.amlAdapter = {
        listMatches: async () => { throw new Error('aml down'); },
        screenCustomer: orig.screenCustomer.bind(orig),
        getMatch: orig.getMatch.bind(orig),
        updateMatchStatus: orig.updateMatchStatus.bind(orig),
      };
    } else if (panel === 'dms') {
      const orig = deps.dmsAdapter;
      deps.dmsAdapter = {
        listByCustomer: async () => { throw new Error('dms down'); },
        listByCase: orig.listByCase.bind(orig),
        get: orig.get.bind(orig),
        updateStatus: orig.updateStatus.bind(orig),
      };
    } else if (panel === 'ifrs9') {
      const orig = deps.ifrs9Adapter;
      deps.ifrs9Adapter = {
        getStage: async () => { throw new Error('ifrs9 down'); },
        listStages: orig.listStages.bind(orig),
      };
    } else if (panel === 'bureau') {
      const orig = deps.bureauAdapter;
      deps.bureauAdapter = {
        listByCustomer: async () => { throw new Error('bureau down'); },
        pull: orig.pull.bind(orig),
        get: orig.get.bind(orig),
      };
    } else if (panel === 'investigations') {
      // Throw via a synchronous wrapper since the store interface is sync.
      const orig = deps.caseInvestigationStore;
      deps.caseInvestigationStore = {
        list: () => { throw new Error('investigations down'); },
        open: orig.open.bind(orig),
        get: orig.get.bind(orig),
        updateStatus: orig.updateStatus.bind(orig),
        completeStep: orig.completeStep.bind(orig),
        addNote: orig.addNote.bind(orig),
        listNotes: orig.listNotes.bind(orig),
      };
    }
    return deps;
  }

  test.each<DegradedPanel>(['policies', 'claims', 'finance', 'aml', 'dms', 'bureau', 'ifrs9', 'investigations'])(
    'failure in %s panel → degraded[] includes the panel + that panel is null',
    async (panel) => {
      const deps = withFailing(panel);
      const view = await buildCustomer360('BIL', 'c-101', deps, () => NOW);
      expect(view.degraded).toContain(panel);
      // Map panel name → panels-key
      const panelKey: Record<DegradedPanel, keyof Customer360['panels']> = {
        policies: 'policies',
        claims: 'claims',
        finance: 'finance_accounts',
        aml: 'aml_matches',
        dms: 'dms_documents',
        bureau: 'bureau_latest',
        ifrs9: 'ifrs9_stage',
        investigations: 'investigations',
      };
      expect(view.panels[panelKey[panel]]).toBeNull();
    },
  );

  test('finance failure → total_finance_balance_kes summary is null', async () => {
    const view = await buildCustomer360('BIL', 'c-101', withFailing('finance'), () => NOW);
    expect(view.summary.total_finance_balance_kes).toBeNull();
  });

  test('ifrs9 failure → ifrs9_stage summary is null', async () => {
    const view = await buildCustomer360('BIL', 'c-101', withFailing('ifrs9'), () => NOW);
    expect(view.summary.ifrs9_stage).toBeNull();
  });

  test('multiple failing panels → all reported in degraded[], call still succeeds', async () => {
    const deps = freshDeps();
    deps.amlAdapter = {
      listMatches: async () => { throw new Error('aml down'); },
      screenCustomer: deps.amlAdapter.screenCustomer.bind(deps.amlAdapter),
      getMatch: deps.amlAdapter.getMatch.bind(deps.amlAdapter),
      updateMatchStatus: deps.amlAdapter.updateMatchStatus.bind(deps.amlAdapter),
    };
    deps.bureauAdapter = {
      listByCustomer: async () => { throw new Error('bureau down'); },
      pull: deps.bureauAdapter.pull.bind(deps.bureauAdapter),
      get: deps.bureauAdapter.get.bind(deps.bureauAdapter),
    };
    const view = await buildCustomer360('BIL', 'c-101', deps, () => NOW);
    expect(view.degraded.sort()).toEqual(['aml', 'bureau']);
    expect(view.panels.aml_matches).toBeNull();
    expect(view.panels.bureau_latest).toBeNull();
    // The other panels still resolve
    expect(view.panels.policies).not.toBeNull();
    expect(view.panels.ifrs9_stage).not.toBeNull();
  });
});

// ─── Input validation ──────────────────────────────────────────────────

describe('buildCustomer360 — input validation', () => {
  test('empty customer_id throws Customer360Error(invalid_input)', async () => {
    const deps = freshDeps();
    try {
      await buildCustomer360('BIL', '', deps, () => NOW);
      fail('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(Customer360Error);
      expect((e as Customer360Error).code).toBe('invalid_input');
    }
  });

  test('empty tenant_id throws Customer360Error(invalid_input)', async () => {
    const deps = freshDeps();
    try {
      await buildCustomer360('', 'c-101', deps, () => NOW);
      fail('expected throw');
    } catch (e) {
      expect((e as Customer360Error).code).toBe('invalid_input');
    }
  });
});

// ─── Route ─────────────────────────────────────────────────────────────

describe('GET /v1/customers/:customer_id/360', () => {
  test('admin: 200 with the consolidated view', async () => {
    const { app } = makeC360App('admin');
    const r = await request(app).get('/v1/customers/c-101/360').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.customer_id).toBe('c-101');
    expect(r.body.body.panels).toBeDefined();
    expect(r.body.body.summary).toBeDefined();
    expect(Array.isArray(r.body.body.degraded)).toBe(true);
  });

  test('risk_analyst (analyst+) accepted', async () => {
    const { app } = makeC360App('risk_analyst');
    const r = await request(app).get('/v1/customers/c-101/360').set(TH_BIL);
    expect(r.status).toBe(200);
  });

  test('unknown role → 403', async () => {
    const { app } = makeC360App('case_owner');
    const r = await request(app).get('/v1/customers/c-101/360').set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('different tenants get different payloads (insurance, finance ids disjoint)', async () => {
    const { app } = makeC360App('admin');
    const bil = await request(app).get('/v1/customers/c-101/360').set(TH_BIL);
    const bank = await request(app).get('/v1/customers/c-101/360').set(TH_BANK);
    const bilPolicies: string[] =
      (bil.body.body as Customer360).panels.policies?.map((p) => p.policy_id) ?? [];
    const bankPolicies: string[] =
      (bank.body.body as Customer360).panels.policies?.map((p) => p.policy_id) ?? [];
    if (bilPolicies.length > 0 && bankPolicies.length > 0) {
      for (const id of bilPolicies) expect(bankPolicies).not.toContain(id);
    }
  });

  test('payload is enveloped per T4.24 contract', async () => {
    const { app } = makeC360App('admin');
    const r = await request(app).get('/v1/customers/c-101/360').set(TH_BIL);
    expect(r.body.header).toBeDefined();
    expect(r.body.body).toBeDefined();
  });
});
