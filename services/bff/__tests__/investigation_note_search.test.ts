// services/bff/__tests__/investigation_note_search.test.ts
//
// T6 M9.10 — Investigation note search.

import request from 'supertest';
import {
  searchInvestigationNotes,
  NoteSearchError,
  type InvestigationNotesBundle,
} from '../src/investigation_note_search';
import {
  InMemoryCaseInvestigationStore,
  type CaseInvestigation,
  type InvestigationNote,
} from '../src/case_investigation';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-14T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

let invSeq = 0;
function mkInv(o: Partial<CaseInvestigation> & { case_id: string }): CaseInvestigation {
  invSeq += 1;
  return {
    investigation_id: o.investigation_id ?? `inv-${invSeq}`,
    tenant_id: o.tenant_id ?? 'BIL',
    case_id: o.case_id,
    customer_id: o.customer_id ?? 'cust-1',
    status: o.status ?? 'triage',
    decision: o.decision ?? null,
    opened_at: o.opened_at ?? NOW.toISOString(),
    opened_by: o.opened_by ?? 'alice',
    last_updated_at: o.last_updated_at ?? NOW.toISOString(),
    last_updated_by: o.last_updated_by ?? 'alice',
    closed_at: o.closed_at ?? null,
    steps: o.steps ?? [],
    notes_count: o.notes_count ?? 0,
    checklist_template_id: o.checklist_template_id ?? 'BUILT_IN',
  };
}

let noteSeq = 0;
function mkNote(o: Partial<InvestigationNote> & { body: string }): InvestigationNote {
  noteSeq += 1;
  return {
    note_id: o.note_id ?? `note-${noteSeq}`,
    ts: o.ts ?? NOW.toISOString(),
    author: o.author ?? 'alice',
    body: o.body,
  };
}

beforeEach(() => {
  invSeq = 0;
  noteSeq = 0;
});

// ─── searchInvestigationNotes — pure ─────────────────────────────────

describe('M9.10 — empty', () => {
  test('zero bundles → zero matches', () => {
    const r = searchInvestigationNotes([], 'fraud');
    expect(r.total_matches).toBe(0);
    expect(r.total_notes_searched).toBe(0);
    expect(r.matches).toEqual([]);
  });

  test('no matches → empty results array but non-zero search counters', () => {
    const bundles: InvestigationNotesBundle[] = [
      {
        investigation: mkInv({ case_id: 'C1' }),
        notes: [mkNote({ body: 'standard process complete' })],
      },
    ];
    const r = searchInvestigationNotes(bundles, 'fraud');
    expect(r.total_matches).toBe(0);
    expect(r.total_notes_searched).toBe(1);
    expect(r.total_investigations_searched).toBe(1);
  });
});

describe('M9.10 — single match', () => {
  test('matched note surfaces with correct fields', () => {
    const bundles: InvestigationNotesBundle[] = [
      {
        investigation: mkInv({ case_id: 'C1' }),
        notes: [mkNote({ body: 'Suspected fraud pattern observed' })],
      },
    ];
    const r = searchInvestigationNotes(bundles, 'fraud');
    expect(r.total_matches).toBe(1);
    expect(r.matches[0]!.case_id).toBe('C1');
    expect(r.matches[0]!.match_count_in_note).toBe(1);
    expect(r.matches[0]!.snippet).toContain('fraud');
  });
});

describe('M9.10 — case-insensitive', () => {
  test('uppercase query matches lowercase body', () => {
    const bundles: InvestigationNotesBundle[] = [
      {
        investigation: mkInv({ case_id: 'C1' }),
        notes: [mkNote({ body: 'fraud detected here' })],
      },
    ];
    const r = searchInvestigationNotes(bundles, 'FRAUD');
    expect(r.total_matches).toBe(1);
  });

  test('mixed-case body matches mixed-case query', () => {
    const bundles: InvestigationNotesBundle[] = [
      {
        investigation: mkInv({ case_id: 'C1' }),
        notes: [mkNote({ body: 'Fraud was reported via the BIL channel' })],
      },
    ];
    const r = searchInvestigationNotes(bundles, 'BIL');
    expect(r.total_matches).toBe(1);
  });
});

describe('M9.10 — multiple matches per note', () => {
  test('match_count_in_note counts every occurrence', () => {
    const bundles: InvestigationNotesBundle[] = [
      {
        investigation: mkInv({ case_id: 'C1' }),
        notes: [mkNote({ body: 'fraud detected. fraud confirmed. fraud reported.' })],
      },
    ];
    const r = searchInvestigationNotes(bundles, 'fraud');
    expect(r.matches[0]!.match_count_in_note).toBe(3);
  });
});

describe('M9.10 — sort order', () => {
  test('matches sorted by ts desc', () => {
    const bundles: InvestigationNotesBundle[] = [
      {
        investigation: mkInv({ case_id: 'C1' }),
        notes: [
          mkNote({ body: 'fraud old', ts: '2026-05-10T08:00:00Z' }),
          mkNote({ body: 'fraud new', ts: '2026-05-14T08:00:00Z' }),
          mkNote({ body: 'fraud mid', ts: '2026-05-12T08:00:00Z' }),
        ],
      },
    ];
    const r = searchInvestigationNotes(bundles, 'fraud');
    expect(r.matches.map((m) => m.ts)).toEqual([
      '2026-05-14T08:00:00Z',
      '2026-05-12T08:00:00Z',
      '2026-05-10T08:00:00Z',
    ]);
  });
});

describe('M9.10 — cross-investigation', () => {
  test('matches surface across multiple investigations', () => {
    const bundles: InvestigationNotesBundle[] = [
      {
        investigation: mkInv({ case_id: 'C1' }),
        notes: [mkNote({ body: 'fraud at branch X' })],
      },
      {
        investigation: mkInv({ case_id: 'C2' }),
        notes: [mkNote({ body: 'fraud at branch Y' })],
      },
      {
        investigation: mkInv({ case_id: 'C3' }),
        notes: [mkNote({ body: 'no concerns here' })],
      },
    ];
    const r = searchInvestigationNotes(bundles, 'fraud');
    expect(r.total_matches).toBe(2);
    expect(r.total_investigations_searched).toBe(3);
    const caseIds = r.matches.map((m) => m.case_id).sort();
    expect(caseIds).toEqual(['C1', 'C2']);
  });
});

describe('M9.10 — limit cap', () => {
  test('limit clamps the returned list but total_matches is the unclamped count', () => {
    const bundles: InvestigationNotesBundle[] = [];
    for (let i = 0; i < 10; i += 1) {
      bundles.push({
        investigation: mkInv({ case_id: `C${i}` }),
        notes: [mkNote({ body: 'fraud detected' })],
      });
    }
    const r = searchInvestigationNotes(bundles, 'fraud', 3);
    expect(r.total_matches).toBe(10);
    expect(r.matches).toHaveLength(3);
  });
});

describe('M9.10 — snippet', () => {
  test('snippet has ellipsis padding when match is in the middle of a long body', () => {
    const longBody = 'x'.repeat(500) + 'fraud' + 'y'.repeat(500);
    const bundles: InvestigationNotesBundle[] = [
      {
        investigation: mkInv({ case_id: 'C1' }),
        notes: [mkNote({ body: longBody })],
      },
    ];
    const r = searchInvestigationNotes(bundles, 'fraud');
    expect(r.matches[0]!.snippet.length).toBeLessThanOrEqual(202); // 200 + 2 ellipses
    expect(r.matches[0]!.snippet.toLowerCase()).toContain('fraud');
    expect(r.matches[0]!.snippet.startsWith('…')).toBe(true);
    expect(r.matches[0]!.snippet.endsWith('…')).toBe(true);
  });

  test('short body → no ellipsis', () => {
    const bundles: InvestigationNotesBundle[] = [
      {
        investigation: mkInv({ case_id: 'C1' }),
        notes: [mkNote({ body: 'short fraud note' })],
      },
    ];
    const r = searchInvestigationNotes(bundles, 'fraud');
    expect(r.matches[0]!.snippet.startsWith('…')).toBe(false);
    expect(r.matches[0]!.snippet.endsWith('…')).toBe(false);
  });
});

describe('M9.10 — validation', () => {
  test('query length < 2 → 400', () => {
    expect(() => searchInvestigationNotes([], 'a')).toThrow(NoteSearchError);
  });

  test('query length > 200 → 400', () => {
    const long = 'a'.repeat(201);
    expect(() => searchInvestigationNotes([], long)).toThrow(/200/);
  });

  test('limit out of [1, 200] → 400', () => {
    expect(() => searchInvestigationNotes([], 'fraud', 0)).toThrow(/limit/);
    expect(() => searchInvestigationNotes([], 'fraud', 999)).toThrow(/limit/);
  });

  test('non-string query → 400', () => {
    expect(() => searchInvestigationNotes([], 42 as never)).toThrow(/string/);
  });
});

// ─── GET /v1/investigations/notes/search ─────────────────────────────

function makeSearchApp(role = 'admin') {
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

describe('M9.10 — GET /v1/investigations/notes/search', () => {
  test('admin → 200 with matches surfacing recent notes', async () => {
    const { app, caseInvestigationStore } = makeSearchApp('admin');
    const inv = caseInvestigationStore.open(
      'BIL',
      { case_id: 'C1', customer_id: 'cust-1' },
      'alice',
      NOW,
    );
    caseInvestigationStore.addNote(
      'BIL',
      inv.investigation_id,
      'alice',
      'fraud confirmed during interview',
      NOW,
    );
    const r = await request(app)
      .get('/v1/investigations/notes/search?q=fraud')
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_matches).toBe(1);
    expect(r.body.body.matches[0].case_id).toBe('C1');
  });

  test('missing q → 400', async () => {
    const { app } = makeSearchApp('admin');
    const r = await request(app).get('/v1/investigations/notes/search').set(TH_BIL);
    expect(r.status).toBe(400);
  });

  test('q too short → 400', async () => {
    const { app } = makeSearchApp('admin');
    const r = await request(app).get('/v1/investigations/notes/search?q=a').set(TH_BIL);
    expect(r.status).toBe(400);
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeSearchApp('case_owner');
    const r = await request(app).get('/v1/investigations/notes/search?q=fraud').set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('cross-tenant: BIL note invisible to BANK_DEMO', async () => {
    const { app, caseInvestigationStore } = makeSearchApp('admin');
    const inv = caseInvestigationStore.open(
      'BIL',
      { case_id: 'C1', customer_id: 'cust-1' },
      'alice',
      NOW,
    );
    caseInvestigationStore.addNote(
      'BIL',
      inv.investigation_id,
      'alice',
      'fraud confirmed',
      NOW,
    );
    const r = await request(app)
      .get('/v1/investigations/notes/search?q=fraud')
      .set('X-Tenant-ID', 'BANK_DEMO')
      .set('X-Channel', 'API');
    expect(r.status).toBe(200);
    expect(r.body.body.total_matches).toBe(0);
  });

  test('?limit=N honoured', async () => {
    const { app, caseInvestigationStore } = makeSearchApp('admin');
    for (let i = 0; i < 5; i += 1) {
      const inv = caseInvestigationStore.open(
        'BIL',
        { case_id: `C${i}`, customer_id: 'cust-1' },
        'alice',
        NOW,
      );
      caseInvestigationStore.addNote(
        'BIL',
        inv.investigation_id,
        'alice',
        'fraud detected',
        NOW,
      );
    }
    const r = await request(app)
      .get('/v1/investigations/notes/search?q=fraud&limit=2')
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_matches).toBe(5);
    expect(r.body.body.matches).toHaveLength(2);
  });
});
