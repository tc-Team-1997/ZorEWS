// T6 M9.18 — Investigation note daily volume tests.

import request from 'supertest';
import {
  DEFAULT_NOTE_DAILY_WINDOW,
  drainTenantNotes,
  InvestigationNoteDailyVolumeError,
  MAX_NOTE_DAILY_WINDOW,
  MIN_NOTE_DAILY_WINDOW,
  summarizeInvestigationNoteDailyVolume,
  type NoteWithInvestigation,
} from '../src/investigation_note_daily_volume';
import {
  InMemoryCaseInvestigationStore,
} from '../src/case_investigation';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-21T18:00:00.000Z');
const H_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function note(
  ts: string,
  author: string,
  investigation_id: string = 'inv-1',
): NoteWithInvestigation {
  return {
    note_id: `n-${ts}-${author}`,
    ts,
    author,
    body: 'note body',
    investigation_id,
  };
}

describe('summarizeInvestigationNoteDailyVolume — validation', () => {
  test('rejects days < MIN', () => {
    expect(() =>
      summarizeInvestigationNoteDailyVolume('BIL', [], 0, NOW),
    ).toThrow(InvestigationNoteDailyVolumeError);
  });

  test('rejects days > MAX', () => {
    expect(() =>
      summarizeInvestigationNoteDailyVolume('BIL', [], MAX_NOTE_DAILY_WINDOW + 1, NOW),
    ).toThrow(InvestigationNoteDailyVolumeError);
  });

  test('rejects non-integer', () => {
    expect(() =>
      summarizeInvestigationNoteDailyVolume('BIL', [], 30.5, NOW),
    ).toThrow(InvestigationNoteDailyVolumeError);
  });

  test('accepts MIN + MAX boundaries', () => {
    expect(() =>
      summarizeInvestigationNoteDailyVolume('BIL', [], MIN_NOTE_DAILY_WINDOW, NOW),
    ).not.toThrow();
    expect(() =>
      summarizeInvestigationNoteDailyVolume('BIL', [], MAX_NOTE_DAILY_WINDOW, NOW),
    ).not.toThrow();
  });

  test('threshold constants exported', () => {
    expect(MIN_NOTE_DAILY_WINDOW).toBe(1);
    expect(MAX_NOTE_DAILY_WINDOW).toBe(365);
    expect(DEFAULT_NOTE_DAILY_WINDOW).toBe(30);
  });
});

describe('summarizeInvestigationNoteDailyVolume — empty input', () => {
  test('30 zero buckets + null leaderboards', () => {
    const r = summarizeInvestigationNoteDailyVolume('BIL', [], 30, NOW);
    expect(r.tenant_id).toBe('BIL');
    expect(r.days).toBe(30);
    expect(r.by_day).toHaveLength(30);
    expect(r.total_notes_in_window).toBe(0);
    expect(r.total_notes_observed).toBe(0);
    expect(r.peak_day).toBeNull();
    expect(r.peak_count).toBe(0);
    expect(r.mean_per_day).toBe(0);
    expect(r.growth_rate).toBeNull();
    expect(r.busiest_author).toBeNull();
    for (const b of r.by_day) {
      expect(b.total).toBe(0);
      expect(b.distinct_investigations).toBe(0);
      expect(b.distinct_authors).toBe(0);
    }
  });

  test('window_start = now - (days-1) days; window_end = today UTC', () => {
    const r = summarizeInvestigationNoteDailyVolume('BIL', [], 30, NOW);
    expect(r.window_end).toBe('2026-05-21');
    expect(r.window_start).toBe('2026-04-22');
  });

  test('days=1 → 1 bucket today', () => {
    const r = summarizeInvestigationNoteDailyVolume('BIL', [], 1, NOW);
    expect(r.by_day).toHaveLength(1);
    expect(r.by_day[0].date).toBe('2026-05-21');
    expect(r.window_start).toBe('2026-05-21');
  });

  test('by_day oldest-first', () => {
    const r = summarizeInvestigationNoteDailyVolume('BIL', [], 7, NOW);
    expect(r.by_day[0].date).toBe('2026-05-15');
    expect(r.by_day[6].date).toBe('2026-05-21');
  });
});

describe('summarizeInvestigationNoteDailyVolume — single note', () => {
  test('single note lands in correct UTC day bucket', () => {
    const r = summarizeInvestigationNoteDailyVolume(
      'BIL',
      [note('2026-05-20T14:00:00Z', 'alice', 'inv-1')],
      30,
      NOW,
    );
    expect(r.total_notes_in_window).toBe(1);
    const targetBucket = r.by_day.find((b) => b.date === '2026-05-20')!;
    expect(targetBucket.total).toBe(1);
    expect(targetBucket.distinct_investigations).toBe(1);
    expect(targetBucket.distinct_authors).toBe(1);
  });
});

describe('summarizeInvestigationNoteDailyVolume — window semantics', () => {
  test('notes outside window counted in observed but excluded from buckets', () => {
    const old = note('2026-01-01T10:00:00Z', 'alice', 'inv-1');
    const recent = note('2026-05-20T10:00:00Z', 'alice', 'inv-1');
    const r = summarizeInvestigationNoteDailyVolume('BIL', [old, recent], 30, NOW);
    expect(r.total_notes_observed).toBe(2);
    expect(r.total_notes_in_window).toBe(1);
  });
});

describe('summarizeInvestigationNoteDailyVolume — aggregation', () => {
  test('multi-author + multi-investigation on same day', () => {
    const r = summarizeInvestigationNoteDailyVolume(
      'BIL',
      [
        note('2026-05-20T09:00:00Z', 'alice', 'inv-1'),
        note('2026-05-20T10:00:00Z', 'alice', 'inv-2'),
        note('2026-05-20T11:00:00Z', 'bob', 'inv-1'),
      ],
      30,
      NOW,
    );
    const day = r.by_day.find((b) => b.date === '2026-05-20')!;
    expect(day.total).toBe(3);
    expect(day.distinct_investigations).toBe(2);
    expect(day.distinct_authors).toBe(2);
  });

  test('Σ by_day.total = total_notes_in_window', () => {
    const r = summarizeInvestigationNoteDailyVolume(
      'BIL',
      [
        note('2026-05-20T09:00:00Z', 'alice', 'inv-1'),
        note('2026-05-19T10:00:00Z', 'alice', 'inv-2'),
        note('2026-05-18T11:00:00Z', 'bob', 'inv-1'),
      ],
      30,
      NOW,
    );
    const sum = r.by_day.reduce((a, b) => a + b.total, 0);
    expect(sum).toBe(r.total_notes_in_window);
    expect(sum).toBe(3);
  });

  test('peak_day = highest-count day; earliest-day-wins tie-break', () => {
    const r = summarizeInvestigationNoteDailyVolume(
      'BIL',
      [
        note('2026-05-15T10:00:00Z', 'alice', 'inv-1'),
        note('2026-05-18T10:00:00Z', 'alice', 'inv-2'),
      ],
      7,
      NOW,
    );
    // Both have count=1 — earliest wins.
    expect(r.peak_day).toBe('2026-05-15');
    expect(r.peak_count).toBe(1);
  });

  test('mean_per_day = round(total / days)', () => {
    const r = summarizeInvestigationNoteDailyVolume(
      'BIL',
      [
        note('2026-05-19T09:00:00Z', 'alice', 'inv-1'),
        note('2026-05-20T10:00:00Z', 'alice', 'inv-2'),
        note('2026-05-21T11:00:00Z', 'alice', 'inv-3'),
      ],
      3,
      NOW,
    );
    expect(r.mean_per_day).toBe(1);
  });

  test('growth_rate positive when second half outweighs first', () => {
    // 4 buckets: first 2 days empty + last 2 days each 3 notes →
    // first-half mean = 0 → growth_rate null (divide-by-zero guard).
    // Use first-half=1, second-half=4 instead to get +ve growth.
    const r = summarizeInvestigationNoteDailyVolume(
      'BIL',
      [
        note('2026-05-18T09:00:00Z', 'alice', 'inv-1'), // first half
        note('2026-05-20T09:00:00Z', 'alice', 'inv-2'), // second half
        note('2026-05-20T10:00:00Z', 'alice', 'inv-3'),
        note('2026-05-21T09:00:00Z', 'alice', 'inv-4'),
        note('2026-05-21T10:00:00Z', 'alice', 'inv-5'),
      ],
      4,
      NOW,
    );
    expect(r.growth_rate).not.toBeNull();
    expect(r.growth_rate).toBeGreaterThan(0);
  });

  test('growth_rate null when first half = 0', () => {
    const r = summarizeInvestigationNoteDailyVolume(
      'BIL',
      [note('2026-05-21T09:00:00Z', 'alice', 'inv-1')],
      4,
      NOW,
    );
    expect(r.growth_rate).toBeNull();
  });

  test('growth_rate null when days < 2', () => {
    const r = summarizeInvestigationNoteDailyVolume(
      'BIL',
      [note('2026-05-21T09:00:00Z', 'alice', 'inv-1')],
      1,
      NOW,
    );
    expect(r.growth_rate).toBeNull();
  });

  test('busiest_author formula + canonical asc tie-break', () => {
    const r = summarizeInvestigationNoteDailyVolume(
      'BIL',
      [
        note('2026-05-20T09:00:00Z', 'zebra', 'inv-1'),
        note('2026-05-20T10:00:00Z', 'alpha', 'inv-2'),
      ],
      30,
      NOW,
    );
    // Both have 1 note — canonical asc tie-break: alpha wins.
    expect(r.busiest_author).toBe('alpha');
  });

  test('busiest_author null when window has no notes', () => {
    const r = summarizeInvestigationNoteDailyVolume('BIL', [], 30, NOW);
    expect(r.busiest_author).toBeNull();
  });

  test('empty author defensively skipped — does not affect distinct_authors', () => {
    const r = summarizeInvestigationNoteDailyVolume(
      'BIL',
      [
        note('2026-05-20T10:00:00Z', '', 'inv-1'),
        note('2026-05-20T11:00:00Z', 'alice', 'inv-1'),
      ],
      30,
      NOW,
    );
    const day = r.by_day.find((b) => b.date === '2026-05-20')!;
    expect(day.distinct_authors).toBe(1);
    expect(r.busiest_author).toBe('alice');
  });

  test('malformed ISO ts silently skipped from buckets but counted in observed', () => {
    const r = summarizeInvestigationNoteDailyVolume(
      'BIL',
      [
        { ...note('2026-05-20T10:00:00Z', 'alice'), ts: 'not-an-iso' } as NoteWithInvestigation,
        note('2026-05-20T11:00:00Z', 'alice', 'inv-1'),
      ],
      30,
      NOW,
    );
    expect(r.total_notes_observed).toBe(2);
    expect(r.total_notes_in_window).toBe(1);
  });
});

// ─── drainTenantNotes helper ─────────────────────────────────────────

describe('drainTenantNotes', () => {
  test('flattens notes across multiple investigations', () => {
    const store = new InMemoryCaseInvestigationStore();
    const inv1 = store.open(
      'BIL',
      { case_id: 'c-1', customer_id: 'CUST-1' },
      'alice',
      new Date('2026-05-20T08:00:00Z'),
    );
    store.addNote(
      'BIL',
      inv1.investigation_id,
      'alice',
      'first',
      new Date('2026-05-20T09:00:00Z'),
    );
    store.addNote(
      'BIL',
      inv1.investigation_id,
      'bob',
      'second',
      new Date('2026-05-20T10:00:00Z'),
    );
    const out = drainTenantNotes(store, 'BIL');
    expect(out).toHaveLength(2);
    expect(out[0].investigation_id).toBe(inv1.investigation_id);
  });

  test('tenant-scoped — empty for other tenant', () => {
    const store = new InMemoryCaseInvestigationStore();
    const inv1 = store.open(
      'BIL',
      { case_id: 'c-1', customer_id: 'CUST-1' },
      'alice',
      new Date('2026-05-20T08:00:00Z'),
    );
    store.addNote(
      'BIL',
      inv1.investigation_id,
      'alice',
      'note',
      new Date('2026-05-20T09:00:00Z'),
    );
    expect(drainTenantNotes(store, 'BANK_DEMO')).toEqual([]);
  });
});

// ─── Route tests ─────────────────────────────────────────────────────

function makeRouteApp(
  role: string = 'admin',
  investigationStore?: InMemoryCaseInvestigationStore,
) {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
    caseInvestigationStore: investigationStore,
  });
}

describe('GET /v1/investigations/notes/daily-volume', () => {
  test('admin happy path with empty store', async () => {
    const store = new InMemoryCaseInvestigationStore();
    const { app } = makeRouteApp('admin', store);
    const r = await request(app)
      .get('/v1/investigations/notes/daily-volume')
      .set(H_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_notes_in_window).toBe(0);
    expect(r.body.body.days).toBe(30);
    expect(r.body.body.by_day).toHaveLength(30);
  });

  test('?days=7 narrows window', async () => {
    const { app } = makeRouteApp('admin');
    const r = await request(app)
      .get('/v1/investigations/notes/daily-volume?days=7')
      .set(H_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.days).toBe(7);
    expect(r.body.body.by_day).toHaveLength(7);
  });

  test('?days=0 → 400 EWS_400_invalid_input', async () => {
    const { app } = makeRouteApp('admin');
    const r = await request(app)
      .get('/v1/investigations/notes/daily-volume?days=0')
      .set(H_BIL);
    expect(r.status).toBe(400);
    expect(r.body.error?.code).toBe('EWS_400_invalid_input');
  });

  test('?days=abc → 400', async () => {
    const { app } = makeRouteApp('admin');
    const r = await request(app)
      .get('/v1/investigations/notes/daily-volume?days=abc')
      .set(H_BIL);
    expect(r.status).toBe(400);
  });

  test('populated reflects added notes', async () => {
    const store = new InMemoryCaseInvestigationStore();
    const inv = store.open(
      'BIL',
      { case_id: 'c-1', customer_id: 'CUST-1' },
      'alice',
      new Date('2026-05-20T08:00:00Z'),
    );
    store.addNote(
      'BIL',
      inv.investigation_id,
      'alice',
      'investigated',
      new Date('2026-05-20T09:00:00Z'),
    );
    const { app } = makeRouteApp('admin', store);
    const r = await request(app)
      .get('/v1/investigations/notes/daily-volume?days=7')
      .set(H_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_notes_in_window).toBe(1);
    expect(r.body.body.busiest_author).toBe('alice');
    const day = r.body.body.by_day.find(
      (b: { date: string }) => b.date === '2026-05-20',
    );
    expect(day?.total).toBe(1);
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeRouteApp('field_officer');
    const r = await request(app)
      .get('/v1/investigations/notes/daily-volume')
      .set(H_BIL);
    expect(r.status).toBe(403);
  });

  test('tenant-scoped — BIL store invisible to BANK_DEMO request', async () => {
    const store = new InMemoryCaseInvestigationStore();
    const inv = store.open(
      'BIL',
      { case_id: 'c-1', customer_id: 'CUST-1' },
      'alice',
      new Date('2026-05-20T08:00:00Z'),
    );
    store.addNote('BIL', inv.investigation_id, 'alice', 'note', new Date('2026-05-20T09:00:00Z'));
    const { app } = makeRouteApp('admin', store);
    const r = await request(app)
      .get('/v1/investigations/notes/daily-volume')
      .set({ 'X-Tenant-ID': 'BANK_DEMO', 'X-Channel': 'API' });
    expect(r.status).toBe(200);
    expect(r.body.body.total_notes_in_window).toBe(0);
  });
});
