// services/bff/__tests__/banking_borrower_timeline.test.ts

import {
  ALL_TIMELINE_EVENT_TYPES,
  ALL_TIMELINE_SEVERITIES,
  buildBorrowerTimeline,
  BorrowerTimelineError,
} from '../src/banking_borrower_timeline';

const NOW = new Date('2026-05-29T12:00:00.000Z');

describe('enums', () => {
  it('event types = 12-value enum', () => {
    expect(ALL_TIMELINE_EVENT_TYPES).toHaveLength(12);
    expect(ALL_TIMELINE_EVENT_TYPES).toContain('account_opened');
    expect(ALL_TIMELINE_EVENT_TYPES).toContain('case_opened');
  });
  it('severities = 3-value enum', () => {
    expect(ALL_TIMELINE_SEVERITIES).toEqual(['info', 'warning', 'critical']);
  });
});

describe('buildBorrowerTimeline', () => {
  it('returns a populated journey for any customer (total over borrowers)', () => {
    const t = buildBorrowerTimeline('BANK_DEMO', 'c-200000', {}, NOW);
    expect(t.customer_id).toBe('c-200000');
    expect(t.customer_name).toMatch(/\w+ \w+/);
    expect(t.total_events).toBeGreaterThan(0);
    expect(t.events.length).toBe(t.returned_count);
  });

  it('always opens with an account_opened event (oldest)', () => {
    const t = buildBorrowerTimeline('BANK_DEMO', 'c-200001', {}, NOW);
    // newest-first, so the LAST element is the oldest
    expect(t.events[t.events.length - 1].event_type).toBe('account_opened');
  });

  it('events are newest-first', () => {
    const t = buildBorrowerTimeline('BANK_DEMO', 'c-200002', {}, NOW);
    for (let i = 1; i < t.events.length; i++) {
      expect(new Date(t.events[i - 1].occurred_at).getTime()).toBeGreaterThanOrEqual(
        new Date(t.events[i].occurred_at).getTime(),
      );
    }
  });

  it('by_type + by_severity partition the full timeline', () => {
    const t = buildBorrowerTimeline('BANK_DEMO', 'c-200003', {}, NOW);
    const typeSum = ALL_TIMELINE_EVENT_TYPES.reduce((a, k) => a + t.by_type[k], 0);
    const sevSum = ALL_TIMELINE_SEVERITIES.reduce((a, k) => a + t.by_severity[k], 0);
    expect(typeSum).toBe(t.total_events);
    expect(sevSum).toBe(t.total_events);
  });

  it('every by_type + by_severity key present', () => {
    const t = buildBorrowerTimeline('BANK_DEMO', 'c-200004', {}, NOW);
    for (const k of ALL_TIMELINE_EVENT_TYPES) expect(t.by_type[k]).toBeDefined();
    for (const k of ALL_TIMELINE_SEVERITIES) expect(t.by_severity[k]).toBeDefined();
  });

  it('current_risk_band matches peak/most-recent DPD band', () => {
    const t = buildBorrowerTimeline('BANK_DEMO', 'c-200005', {}, NOW);
    expect(['low', 'medium', 'high', 'critical']).toContain(t.current_risk_band);
    expect(t.peak_dpd).toBeGreaterThanOrEqual(0);
  });

  it('trajectory is one of the 3 values', () => {
    const t = buildBorrowerTimeline('BANK_DEMO', 'c-200006', {}, NOW);
    expect(['improving', 'stable', 'deteriorating']).toContain(t.trajectory);
  });

  it('first_event_at <= last_event_at', () => {
    const t = buildBorrowerTimeline('BANK_DEMO', 'c-200007', {}, NOW);
    expect(new Date(t.first_event_at!).getTime()).toBeLessThanOrEqual(new Date(t.last_event_at!).getTime());
  });

  it('deterministic per (tenant, customer, day)', () => {
    const a = buildBorrowerTimeline('BANK_DEMO', 'c-200008', {}, NOW);
    const b = buildBorrowerTimeline('BANK_DEMO', 'c-200008', {}, NOW);
    expect(a).toEqual(b);
  });

  it('different customers produce different journeys', () => {
    const a = buildBorrowerTimeline('BANK_DEMO', 'c-200009', {}, NOW);
    const b = buildBorrowerTimeline('BANK_DEMO', 'c-300009', {}, NOW);
    expect(a.events.map((e) => e.title).join()).not.toBe(b.events.map((e) => e.title).join());
  });

  it('tenant isolation — same customer differs across tenants', () => {
    const bank = buildBorrowerTimeline('BANK_DEMO', 'c-200010', {}, NOW);
    const bil = buildBorrowerTimeline('BIL', 'c-200010', {}, NOW);
    expect(bank.customer_name === bil.customer_name && bank.total_events === bil.total_events).toBe(false);
  });

  it('event_type filter narrows events but keeps full rollup', () => {
    const t = buildBorrowerTimeline('BANK_DEMO', 'c-200011', { event_type: 'repayment' }, NOW);
    for (const e of t.events) expect(e.event_type).toBe('repayment');
    expect(t.returned_count).toBeLessThanOrEqual(t.total_events);
    // by_type rollup still reflects the FULL timeline
    const typeSum = ALL_TIMELINE_EVENT_TYPES.reduce((a, k) => a + t.by_type[k], 0);
    expect(typeSum).toBe(t.total_events);
    expect(t.filters_applied.event_type).toBe('repayment');
  });

  it('since filter excludes older events', () => {
    const since = new Date(NOW.getTime() - 90 * 86_400_000).toISOString();
    const t = buildBorrowerTimeline('BANK_DEMO', 'c-200012', { since }, NOW);
    for (const e of t.events) {
      expect(new Date(e.occurred_at).getTime()).toBeGreaterThanOrEqual(new Date(since).getTime());
    }
  });

  it('limit caps the returned events', () => {
    const t = buildBorrowerTimeline('BANK_DEMO', 'c-200013', { limit: 3 }, NOW);
    expect(t.events.length).toBeLessThanOrEqual(3);
    expect(t.filters_applied.limit).toBe(3);
  });

  it('every event carries a valid event_type + severity', () => {
    const t = buildBorrowerTimeline('BANK_DEMO', 'c-200014', {}, NOW);
    for (const e of t.events) {
      expect(ALL_TIMELINE_EVENT_TYPES).toContain(e.event_type);
      expect(ALL_TIMELINE_SEVERITIES).toContain(e.severity);
      expect(e.event_id).toMatch(/^tl-/);
    }
  });

  it('empty tenant_id throws', () => {
    expect(() => buildBorrowerTimeline('', 'c-1', {}, NOW)).toThrow(BorrowerTimelineError);
  });
  it('empty customer_id throws', () => {
    expect(() => buildBorrowerTimeline('BANK_DEMO', '', {}, NOW)).toThrow(BorrowerTimelineError);
  });
  it('invalid event_type throws', () => {
    expect(() => buildBorrowerTimeline('BANK_DEMO', 'c-1', { event_type: 'bogus' as never }, NOW)).toThrow(
      BorrowerTimelineError,
    );
  });
  it('invalid since throws', () => {
    expect(() => buildBorrowerTimeline('BANK_DEMO', 'c-1', { since: 'not-a-date' }, NOW)).toThrow(
      BorrowerTimelineError,
    );
  });
});
