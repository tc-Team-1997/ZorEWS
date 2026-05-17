// services/bff/__tests__/investigation_note_authorship.test.ts
//
// T6 M9.14 — Investigation note authoring activity rollup.

import request from 'supertest';
import { summarizeInvestigationNoteAuthorship } from '../src/investigation_note_authorship';
import {
  InMemoryCaseInvestigationStore,
  INVESTIGATION_STATUSES,
} from '../src/case_investigation';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-17T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function makeNaApp(role: string = 'admin') {
  const caseInvestigationStore = new InMemoryCaseInvestigationStore();
  const built = makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    caseInvestigationStore,
    now: () => NOW,
    getRole: () => role,
  });
  return { ...built, caseInvestigationStore };
}

// ─── summarizeInvestigationNoteAuthorship — pure ─────────────────────

describe('M9.14 — empty store', () => {
  test('no investigations → zero envelope', () => {
    const store = new InMemoryCaseInvestigationStore();
    const s = summarizeInvestigationNoteAuthorship('BIL', store, NOW);
    expect(s.tenant_id).toBe('BIL');
    expect(s.generated_at).toBe(NOW.toISOString());
    expect(s.total_notes).toBe(0);
    expect(s.total_distinct_authors).toBe(0);
    expect(s.authors).toEqual([]);
    expect(s.most_active_author).toBeNull();
  });

  test('investigation with no notes → zero envelope', () => {
    const store = new InMemoryCaseInvestigationStore();
    store.open('BIL', { case_id: 'C1', customer_id: 'cust-1' }, 'alice', NOW);
    const s = summarizeInvestigationNoteAuthorship('BIL', store, NOW);
    expect(s.total_notes).toBe(0);
    expect(s.authors).toEqual([]);
    expect(s.most_active_author).toBeNull();
  });
});

describe('M9.14 — single author single note', () => {
  test('1 note by alice → 1 row total_notes=1', () => {
    const store = new InMemoryCaseInvestigationStore();
    const inv = store.open('BIL', { case_id: 'C1', customer_id: 'cust-1' }, 'alice', NOW);
    store.addNote('BIL', inv.investigation_id, 'alice', 'first observation', NOW);
    const s = summarizeInvestigationNoteAuthorship('BIL', store, NOW);
    expect(s.total_notes).toBe(1);
    expect(s.total_distinct_authors).toBe(1);
    expect(s.authors).toHaveLength(1);
    const alice = s.authors[0]!;
    expect(alice.author_username).toBe('alice');
    expect(alice.total_notes).toBe(1);
    expect(alice.distinct_investigations).toBe(1);
    expect(alice.first_note_at).toBe(NOW.toISOString());
    expect(alice.last_note_at).toBe(NOW.toISOString());
    // Status counts: investigation defaults to 'triage'.
    expect(alice.notes_per_investigation_status.triage).toBe(1);
    for (const s2 of INVESTIGATION_STATUSES) {
      if (s2 !== 'triage') expect(alice.notes_per_investigation_status[s2]).toBe(0);
    }
    expect(s.most_active_author).toEqual({ author_username: 'alice', total_notes: 1 });
  });
});

describe('M9.14 — multi-author', () => {
  test('alice 3 notes, bob 1 note → 2 rows ordered total_notes desc', () => {
    const store = new InMemoryCaseInvestigationStore();
    const inv = store.open('BIL', { case_id: 'C1', customer_id: 'cust-1' }, 'alice', NOW);
    store.addNote('BIL', inv.investigation_id, 'alice', 'note A1', NOW);
    store.addNote('BIL', inv.investigation_id, 'alice', 'note A2', NOW);
    store.addNote('BIL', inv.investigation_id, 'alice', 'note A3', NOW);
    store.addNote('BIL', inv.investigation_id, 'bob', 'note B1', NOW);
    const s = summarizeInvestigationNoteAuthorship('BIL', store, NOW);
    expect(s.total_notes).toBe(4);
    expect(s.total_distinct_authors).toBe(2);
    expect(s.authors[0]!.author_username).toBe('alice');
    expect(s.authors[0]!.total_notes).toBe(3);
    expect(s.authors[1]!.author_username).toBe('bob');
    expect(s.authors[1]!.total_notes).toBe(1);
  });

  test('total_notes desc + author_username asc tie-break', () => {
    const store = new InMemoryCaseInvestigationStore();
    const inv = store.open('BIL', { case_id: 'C1', customer_id: 'cust-1' }, 'alice', NOW);
    store.addNote('BIL', inv.investigation_id, 'zoe', 'note', NOW);
    store.addNote('BIL', inv.investigation_id, 'alice', 'note', NOW);
    store.addNote('BIL', inv.investigation_id, 'mike', 'note', NOW);
    const s = summarizeInvestigationNoteAuthorship('BIL', store, NOW);
    expect(s.authors.map((a) => a.author_username)).toEqual(['alice', 'mike', 'zoe']);
  });
});

describe('M9.14 — distinct_investigations', () => {
  test('counts distinct investigation_ids per author', () => {
    const store = new InMemoryCaseInvestigationStore();
    const inv1 = store.open('BIL', { case_id: 'C1', customer_id: 'cust-1' }, 'alice', NOW);
    const inv2 = store.open('BIL', { case_id: 'C2', customer_id: 'cust-2' }, 'alice', NOW);
    store.addNote('BIL', inv1.investigation_id, 'alice', 'n1', NOW);
    store.addNote('BIL', inv1.investigation_id, 'alice', 'n2', NOW); // same inv
    store.addNote('BIL', inv2.investigation_id, 'alice', 'n3', NOW); // different inv
    const s = summarizeInvestigationNoteAuthorship('BIL', store, NOW);
    expect(s.authors[0]!.total_notes).toBe(3);
    expect(s.authors[0]!.distinct_investigations).toBe(2);
  });
});

describe('M9.14 — first/last_note_at', () => {
  test('first = oldest ts; last = newest ts', () => {
    const store = new InMemoryCaseInvestigationStore();
    const inv = store.open('BIL', { case_id: 'C1', customer_id: 'cust-1' }, 'alice', NOW);
    const t1 = new Date('2026-05-10T10:00:00.000Z');
    const t2 = new Date('2026-05-12T10:00:00.000Z');
    const t3 = new Date('2026-05-15T10:00:00.000Z');
    store.addNote('BIL', inv.investigation_id, 'alice', 'mid', t2);
    store.addNote('BIL', inv.investigation_id, 'alice', 'old', t1);
    store.addNote('BIL', inv.investigation_id, 'alice', 'new', t3);
    const s = summarizeInvestigationNoteAuthorship('BIL', store, NOW);
    expect(s.authors[0]!.first_note_at).toBe(t1.toISOString());
    expect(s.authors[0]!.last_note_at).toBe(t3.toISOString());
  });
});

describe('M9.14 — notes_per_investigation_status', () => {
  test('counts notes against the CURRENT status of each investigation', () => {
    const store = new InMemoryCaseInvestigationStore();
    const inv1 = store.open('BIL', { case_id: 'C1', customer_id: 'cust-1' }, 'alice', NOW);
    const inv2 = store.open('BIL', { case_id: 'C2', customer_id: 'cust-2' }, 'alice', NOW);
    // inv1 stays in triage; inv2 moves to gathering_evidence
    store.updateStatus('BIL', inv2.investigation_id, 'gathering_evidence', null, 'alice', NOW);
    store.addNote('BIL', inv1.investigation_id, 'alice', 'n1', NOW);
    store.addNote('BIL', inv2.investigation_id, 'alice', 'n2', NOW);
    store.addNote('BIL', inv2.investigation_id, 'alice', 'n3', NOW);
    const s = summarizeInvestigationNoteAuthorship('BIL', store, NOW);
    const alice = s.authors[0]!;
    expect(alice.notes_per_investigation_status.triage).toBe(1);
    expect(alice.notes_per_investigation_status.gathering_evidence).toBe(2);
    expect(alice.notes_per_investigation_status.closed).toBe(0);
  });

  test('every InvestigationStatus key present at 0 when no notes on that status', () => {
    const store = new InMemoryCaseInvestigationStore();
    const inv = store.open('BIL', { case_id: 'C1', customer_id: 'cust-1' }, 'alice', NOW);
    store.addNote('BIL', inv.investigation_id, 'alice', 'n', NOW);
    const s = summarizeInvestigationNoteAuthorship('BIL', store, NOW);
    for (const status of INVESTIGATION_STATUSES) {
      expect(s.authors[0]!.notes_per_investigation_status).toHaveProperty(status);
    }
  });
});

describe('M9.14 — most_active_author', () => {
  test('points at top row total_notes', () => {
    const store = new InMemoryCaseInvestigationStore();
    const inv = store.open('BIL', { case_id: 'C1', customer_id: 'cust-1' }, 'alice', NOW);
    store.addNote('BIL', inv.investigation_id, 'bob', 'n', NOW);
    store.addNote('BIL', inv.investigation_id, 'alice', 'n', NOW);
    store.addNote('BIL', inv.investigation_id, 'alice', 'n', NOW);
    const s = summarizeInvestigationNoteAuthorship('BIL', store, NOW);
    expect(s.most_active_author).toEqual({ author_username: 'alice', total_notes: 2 });
  });

  test('null on empty', () => {
    const store = new InMemoryCaseInvestigationStore();
    const s = summarizeInvestigationNoteAuthorship('BIL', store, NOW);
    expect(s.most_active_author).toBeNull();
  });
});

describe('M9.14 — tenant scoping', () => {
  test('BIL notes invisible to BANK_DEMO', () => {
    const store = new InMemoryCaseInvestigationStore();
    const inv = store.open('BIL', { case_id: 'C1', customer_id: 'cust-1' }, 'alice', NOW);
    store.addNote('BIL', inv.investigation_id, 'alice', 'n', NOW);
    const bil = summarizeInvestigationNoteAuthorship('BIL', store, NOW);
    const bank = summarizeInvestigationNoteAuthorship('BANK_DEMO', store, NOW);
    expect(bil.total_notes).toBe(1);
    expect(bank.total_notes).toBe(0);
  });
});

describe('M9.14 — partition invariant', () => {
  test('Σ author.total_notes = total_notes; each row Σ status counts = total_notes', () => {
    const store = new InMemoryCaseInvestigationStore();
    const inv1 = store.open('BIL', { case_id: 'C1', customer_id: 'cust-1' }, 'alice', NOW);
    const inv2 = store.open('BIL', { case_id: 'C2', customer_id: 'cust-2' }, 'bob', NOW);
    store.addNote('BIL', inv1.investigation_id, 'alice', 'n', NOW);
    store.addNote('BIL', inv1.investigation_id, 'alice', 'n', NOW);
    store.addNote('BIL', inv2.investigation_id, 'bob', 'n', NOW);
    store.addNote('BIL', inv2.investigation_id, 'alice', 'n', NOW);
    const s = summarizeInvestigationNoteAuthorship('BIL', store, NOW);
    const totalSum = s.authors.reduce((acc, a) => acc + a.total_notes, 0);
    expect(totalSum).toBe(s.total_notes);
    for (const a of s.authors) {
      const statusSum = Object.values(a.notes_per_investigation_status).reduce(
        (acc, c) => acc + c,
        0,
      );
      expect(statusSum).toBe(a.total_notes);
    }
  });
});

// ─── GET /v1/investigations/note-authorship ──────────────────────────

describe('M9.14 — GET /v1/investigations/note-authorship', () => {
  test('admin → 200 with empty rollup', async () => {
    const { app } = makeNaApp('admin');
    const r = await request(app).get('/v1/investigations/note-authorship').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_notes).toBe(0);
    expect(r.body.body.total_distinct_authors).toBe(0);
    expect(r.body.body.most_active_author).toBeNull();
  });

  test('populated rollup reflects notes across investigations', async () => {
    const { app, caseInvestigationStore } = makeNaApp('admin');
    const inv1 = caseInvestigationStore.open(
      'BIL', { case_id: 'C1', customer_id: 'cust-1' }, 'alice', NOW);
    const inv2 = caseInvestigationStore.open(
      'BIL', { case_id: 'C2', customer_id: 'cust-2' }, 'bob', NOW);
    caseInvestigationStore.addNote('BIL', inv1.investigation_id, 'alice', 'n1', NOW);
    caseInvestigationStore.addNote('BIL', inv1.investigation_id, 'alice', 'n2', NOW);
    caseInvestigationStore.addNote('BIL', inv2.investigation_id, 'bob', 'n3', NOW);
    const r = await request(app).get('/v1/investigations/note-authorship').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_notes).toBe(3);
    expect(r.body.body.total_distinct_authors).toBe(2);
    expect(r.body.body.most_active_author.author_username).toBe('alice');
    expect(r.body.body.most_active_author.total_notes).toBe(2);
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeNaApp('case_owner');
    const r = await request(app).get('/v1/investigations/note-authorship').set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('cross-tenant invisibility: BIL notes invisible to BANK_DEMO', async () => {
    const { app, caseInvestigationStore } = makeNaApp('admin');
    const inv = caseInvestigationStore.open(
      'BIL', { case_id: 'C1', customer_id: 'cust-1' }, 'alice', NOW);
    caseInvestigationStore.addNote('BIL', inv.investigation_id, 'alice', 'n', NOW);
    const bank = await request(app)
      .get('/v1/investigations/note-authorship')
      .set('X-Tenant-ID', 'BANK_DEMO')
      .set('X-Channel', 'API');
    expect(bank.status).toBe(200);
    expect(bank.body.body.total_notes).toBe(0);
  });

  test('literal `/note-authorship` not captured as :id wildcard', async () => {
    const { app } = makeNaApp('admin');
    // If shadowed by `/:id`, would 404 EWS_404_unknown_investigation.
    const r = await request(app).get('/v1/investigations/note-authorship').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.tenant_id).toBe('BIL');
  });

  test('M9.13 /v1/investigations/age-status-matrix still 200 (sibling regression)', async () => {
    const { app } = makeNaApp('admin');
    const r = await request(app).get('/v1/investigations/age-status-matrix').set(TH_BIL);
    expect(r.status).toBe(200);
  });
});
