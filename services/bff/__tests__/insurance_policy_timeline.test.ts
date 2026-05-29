// services/bff/__tests__/insurance_policy_timeline.test.ts

import {
  ALL_POLICY_EVENT_TYPES,
  ALL_POLICY_EVENT_SEVERITIES,
  buildPolicyTimeline,
  PolicyTimelineError,
} from '../src/insurance_policy_timeline';

const NOW = new Date('2026-05-29T12:00:00.000Z');

describe('enums', () => {
  it('policy event types = 15-value enum', () => {
    expect(ALL_POLICY_EVENT_TYPES).toHaveLength(15);
    expect(ALL_POLICY_EVENT_TYPES).toContain('policy_issued');
    expect(ALL_POLICY_EVENT_TYPES).toContain('lapse_warning');
    expect(ALL_POLICY_EVENT_TYPES).toContain('surrender');
  });
  it('severities = 3-value enum', () => {
    expect(ALL_POLICY_EVENT_SEVERITIES).toEqual(['info', 'warning', 'critical']);
  });
});

describe('buildPolicyTimeline', () => {
  it('returns a populated lifecycle for any policy (total over policies)', () => {
    const t = buildPolicyTimeline('BANK_DEMO', 'POL-BANK_DEMO-100001', {}, NOW);
    expect(t.policy_id).toBe('POL-BANK_DEMO-100001');
    expect(t.policyholder_name).toMatch(/\w+ \w+/);
    expect(t.product).toBeTruthy();
    expect(t.channel).toBeTruthy();
    expect(t.total_events).toBeGreaterThan(0);
    expect(t.events.length).toBe(t.returned_count);
  });

  it('always opens with policy_issued (oldest event)', () => {
    const t = buildPolicyTimeline('BANK_DEMO', 'POL-BANK_DEMO-100002', {}, NOW);
    expect(t.events[t.events.length - 1].event_type).toBe('policy_issued');
  });

  it('events newest-first', () => {
    const t = buildPolicyTimeline('BANK_DEMO', 'POL-BANK_DEMO-100003', {}, NOW);
    for (let i = 1; i < t.events.length; i++) {
      expect(new Date(t.events[i - 1].occurred_at).getTime()).toBeGreaterThanOrEqual(
        new Date(t.events[i].occurred_at).getTime(),
      );
    }
  });

  it('by_type + by_severity partition the full timeline', () => {
    const t = buildPolicyTimeline('BANK_DEMO', 'POL-BANK_DEMO-100004', {}, NOW);
    const typeSum = ALL_POLICY_EVENT_TYPES.reduce((a, k) => a + t.by_type[k], 0);
    const sevSum = ALL_POLICY_EVENT_SEVERITIES.reduce((a, k) => a + t.by_severity[k], 0);
    expect(typeSum).toBe(t.total_events);
    expect(sevSum).toBe(t.total_events);
  });

  it('every by_type + by_severity key present', () => {
    const t = buildPolicyTimeline('BANK_DEMO', 'POL-BANK_DEMO-100005', {}, NOW);
    for (const k of ALL_POLICY_EVENT_TYPES) expect(t.by_type[k]).toBeDefined();
    for (const k of ALL_POLICY_EVENT_SEVERITIES) expect(t.by_severity[k]).toBeDefined();
  });

  it('policy_status + lapse_risk_band + trajectory in their enums', () => {
    const t = buildPolicyTimeline('BANK_DEMO', 'POL-BANK_DEMO-100006', {}, NOW);
    expect(['in_force', 'lapsed', 'surrendered', 'matured']).toContain(t.policy_status);
    expect(['low', 'medium', 'high', 'critical']).toContain(t.lapse_risk_band);
    expect(['improving', 'stable', 'deteriorating']).toContain(t.persistency_trajectory);
  });

  it('claims_settled never exceeds claims_filed; peak_anomaly in [0,1]', () => {
    for (let i = 0; i < 30; i++) {
      const t = buildPolicyTimeline('BANK_DEMO', `POL-BANK_DEMO-${100100 + i}`, {}, NOW);
      expect(t.claims_settled).toBeLessThanOrEqual(t.claims_filed);
      expect(t.peak_anomaly_score).toBeGreaterThanOrEqual(0);
      expect(t.peak_anomaly_score).toBeLessThanOrEqual(1);
      expect(t.total_premium_paid_kes).toBeGreaterThanOrEqual(0);
    }
  });

  it('deterministic per (tenant, policy, day)', () => {
    const a = buildPolicyTimeline('BANK_DEMO', 'POL-BANK_DEMO-100007', {}, NOW);
    const b = buildPolicyTimeline('BANK_DEMO', 'POL-BANK_DEMO-100007', {}, NOW);
    expect(a).toEqual(b);
  });

  it('different policies produce different lifecycles', () => {
    const a = buildPolicyTimeline('BANK_DEMO', 'POL-BANK_DEMO-100008', {}, NOW);
    const b = buildPolicyTimeline('BANK_DEMO', 'POL-BANK_DEMO-200008', {}, NOW);
    expect(a.events.map((e) => e.title).join()).not.toBe(b.events.map((e) => e.title).join());
  });

  it('tenant isolation — same policy differs across tenants', () => {
    const bank = buildPolicyTimeline('BANK_DEMO', 'POL-X-1', {}, NOW);
    const bil = buildPolicyTimeline('BIL', 'POL-X-1', {}, NOW);
    expect(bank.policyholder_name === bil.policyholder_name && bank.total_events === bil.total_events).toBe(false);
  });

  it('event_type filter narrows events but keeps full rollup', () => {
    const t = buildPolicyTimeline('BANK_DEMO', 'POL-BANK_DEMO-100009', { event_type: 'premium_paid' }, NOW);
    for (const e of t.events) expect(e.event_type).toBe('premium_paid');
    const typeSum = ALL_POLICY_EVENT_TYPES.reduce((a, k) => a + t.by_type[k], 0);
    expect(typeSum).toBe(t.total_events);
    expect(t.returned_count).toBeLessThanOrEqual(t.total_events);
    expect(t.filters_applied.event_type).toBe('premium_paid');
  });

  it('since filter excludes older events', () => {
    const since = new Date(NOW.getTime() - 180 * 86_400_000).toISOString();
    const t = buildPolicyTimeline('BANK_DEMO', 'POL-BANK_DEMO-100010', { since }, NOW);
    for (const e of t.events) {
      expect(new Date(e.occurred_at).getTime()).toBeGreaterThanOrEqual(new Date(since).getTime());
    }
  });

  it('limit caps returned events', () => {
    const t = buildPolicyTimeline('BANK_DEMO', 'POL-BANK_DEMO-100011', { limit: 3 }, NOW);
    expect(t.events.length).toBeLessThanOrEqual(3);
    expect(t.filters_applied.limit).toBe(3);
  });

  it('every event carries valid type + severity + pt- id', () => {
    const t = buildPolicyTimeline('BANK_DEMO', 'POL-BANK_DEMO-100012', {}, NOW);
    for (const e of t.events) {
      expect(ALL_POLICY_EVENT_TYPES).toContain(e.event_type);
      expect(ALL_POLICY_EVENT_SEVERITIES).toContain(e.severity);
      expect(e.event_id).toMatch(/^pt-/);
    }
  });

  it('empty tenant_id / policy_id throw; invalid filters throw', () => {
    expect(() => buildPolicyTimeline('', 'POL-1', {}, NOW)).toThrow(PolicyTimelineError);
    expect(() => buildPolicyTimeline('BANK_DEMO', '', {}, NOW)).toThrow(PolicyTimelineError);
    expect(() => buildPolicyTimeline('BANK_DEMO', 'POL-1', { event_type: 'bogus' as never }, NOW)).toThrow(
      PolicyTimelineError,
    );
    expect(() => buildPolicyTimeline('BANK_DEMO', 'POL-1', { since: 'not-a-date' }, NOW)).toThrow(
      PolicyTimelineError,
    );
  });
});
