import { dedupeByAlertId, mapAlertEvent, mapAlertList } from '../src/mapping';
import { makeSeedLookups } from '../src/lookups';
import type { CanonicalAlert, Lookups } from '../src/types';

const NOW = new Date('2026-04-27T12:00:00.000Z');
const now = () => NOW;

function alert(overrides: Partial<CanonicalAlert> = {}): CanonicalAlert {
  return {
    alert_id: 'a-1001',
    raised_at: '2026-04-27T11:30:00.000Z',
    customer_id: 'c-101',
    severity: 'CRITICAL',
    rule_id: 'r-22',
    indicators_fired: ['IND_BEH_03', 'IND_TXN_07'],
    reason_summary: '[CRITICAL] Salary inflow halted (IND_BEH_03, IND_TXN_07).',
    ...overrides,
  };
}

describe('mapAlertEvent — pure transform', () => {
  test('lowercases severity', () => {
    for (const [wire, ui] of [
      ['LOW', 'low'],
      ['MEDIUM', 'medium'],
      ['HIGH', 'high'],
      ['CRITICAL', 'critical'],
    ] as const) {
      const r = mapAlertEvent(alert({ severity: wire }), makeSeedLookups(), now);
      expect(r.severity).toBe(ui);
    }
  });

  test('joins customer + rule names from lookups', () => {
    const r = mapAlertEvent(alert(), makeSeedLookups(), now);
    expect(r.customer).toEqual({ id: 'c-101', name: 'Achieng Otieno' });
    expect(r.rule).toEqual({ id: 'r-22', name: 'Salary inflow stopped 60d' });
  });

  test('falls back to id when customer/rule are not in the lookup', () => {
    const lookups: Lookups = { customers: {}, rules: {} };
    const r = mapAlertEvent(alert({ customer_id: 'c-unknown', rule_id: 'r-unknown' }), lookups, now);
    expect(r.customer).toEqual({ id: 'c-unknown', name: 'c-unknown' });
    expect(r.rule).toEqual({ id: 'r-unknown', name: 'r-unknown' });
  });

  test('computes age_min as floor((now - raised_at) / 60000)', () => {
    const r = mapAlertEvent(alert({ raised_at: '2026-04-27T11:30:00.000Z' }), makeSeedLookups(), now);
    expect(r.age_min).toBe(30);
  });

  test('clamps age_min to 0 when raised_at is in the future (clock skew)', () => {
    const r = mapAlertEvent(
      alert({ raised_at: '2026-04-27T12:30:00.000Z' }),
      makeSeedLookups(),
      now,
    );
    expect(r.age_min).toBe(0);
  });

  test('passes assignee from lookup when present, null when absent', () => {
    const lookups = makeSeedLookups();
    lookups.assignees = { 'a-1001': 'fiona.field' };
    const a = mapAlertEvent(alert(), lookups, now);
    expect(a.assignee).toBe('fiona.field');

    const b = mapAlertEvent(alert({ alert_id: 'a-9999' }), lookups, now);
    expect(b.assignee).toBeNull();
  });

  test('renames alert_id → id and raised_at → created_at; copies indicators_fired', () => {
    const r = mapAlertEvent(alert(), makeSeedLookups(), now);
    expect(r.id).toBe('a-1001');
    expect(r.created_at).toBe('2026-04-27T11:30:00.000Z');
    expect(r.indicators).toEqual(['IND_BEH_03', 'IND_TXN_07']);
  });

  test('rejects an unknown wire severity', () => {
    expect(() =>
      // @ts-expect-error -- deliberately bad input
      mapAlertEvent(alert({ severity: 'URGENT' }), makeSeedLookups(), now),
    ).toThrow(/unknown wire severity/);
  });
});

describe('mapAlertList — sort + filter', () => {
  test('returns newest-first by created_at, with tie-break on id', () => {
    const events = [
      alert({ alert_id: 'a-2', raised_at: '2026-04-27T10:00:00.000Z' }),
      alert({ alert_id: 'a-1', raised_at: '2026-04-27T11:00:00.000Z' }),
      alert({ alert_id: 'a-3', raised_at: '2026-04-27T11:00:00.000Z' }),
    ];
    const rows = mapAlertList(events, makeSeedLookups(), {}, now);
    expect(rows.map((r) => r.id)).toEqual(['a-1', 'a-3', 'a-2']);
  });

  test('filters by severity', () => {
    const events = [
      alert({ alert_id: 'a-c', severity: 'CRITICAL' }),
      alert({ alert_id: 'a-h', severity: 'HIGH' }),
      alert({ alert_id: 'a-l', severity: 'LOW' }),
    ];
    const rows = mapAlertList(events, makeSeedLookups(), { severity: 'high' }, now);
    expect(rows.map((r) => r.id)).toEqual(['a-h']);
  });

  test('filters by assignee', () => {
    const lookups = makeSeedLookups();
    lookups.assignees = { 'a-1': 'fiona.field', 'a-2': 'ravi.risk' };
    const events = [alert({ alert_id: 'a-1' }), alert({ alert_id: 'a-2' })];
    const rows = mapAlertList(events, lookups, { assignee: 'fiona.field' }, now);
    expect(rows.map((r) => r.id)).toEqual(['a-1']);
  });
});

describe('dedupeByAlertId — last-write-wins', () => {
  test('keeps the last occurrence per alert_id', () => {
    const events = [
      alert({ alert_id: 'a-1', severity: 'LOW' }),
      alert({ alert_id: 'a-2', severity: 'HIGH' }),
      alert({ alert_id: 'a-1', severity: 'CRITICAL' }),
    ];
    const out = dedupeByAlertId(events);
    expect(out).toHaveLength(2);
    expect(out.find((e) => e.alert_id === 'a-1')?.severity).toBe('CRITICAL');
  });
});
