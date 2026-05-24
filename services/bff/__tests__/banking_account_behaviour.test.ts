// services/bff/__tests__/banking_account_behaviour.test.ts

import {
  ALL_SIGNAL_SEVERITIES,
  ACCOUNT_SIGNAL_TYPES,
  buildAccountSignals,
  buildAccountPatterns,
  proposeAccountBlock,
  reviewBlockRequest,
  listBlockRequests,
  _resetBlockStore,
  AccountBehaviourError,
} from '../src/banking_account_behaviour';

const NOW = new Date('2026-05-23T12:00:00.000Z');

beforeEach(() => _resetBlockStore());

describe('catalog + enums', () => {
  it('ALL_SIGNAL_SEVERITIES is the canonical 4-value enum', () => {
    expect(ALL_SIGNAL_SEVERITIES).toEqual(['low', 'medium', 'high', 'critical']);
  });
  it('ACCOUNT_SIGNAL_TYPES has the BIL signal types', () => {
    // M2.2 extended from 10 to 14 — keep the assertion forward-compatible.
    expect(ACCOUNT_SIGNAL_TYPES.length).toBeGreaterThanOrEqual(10);
    expect(ACCOUNT_SIGNAL_TYPES).toContain('salary_disappeared');
    expect(ACCOUNT_SIGNAL_TYPES).toContain('cheque_bounce_repeated');
    // M2.2 spec-mandated additions
    expect(ACCOUNT_SIGNAL_TYPES).toContain('cash_flow_drop_mom');
    expect(ACCOUNT_SIGNAL_TYPES).toContain('od_frequency_high');
    expect(ACCOUNT_SIGNAL_TYPES).toContain('eod_balance_trend_negative');
    expect(ACCOUNT_SIGNAL_TYPES).toContain('large_unusual_debit');
  });
});

describe('buildAccountSignals', () => {
  it('returns canonical envelope', () => {
    const out = buildAccountSignals('BANK_DEMO', {}, NOW);
    expect(out.tenant_id).toBe('BANK_DEMO');
    expect(out.total).toBe(out.signals.length);
    expect(out.by_severity).toEqual(expect.objectContaining({ low: expect.any(Number), medium: expect.any(Number), high: expect.any(Number), critical: expect.any(Number) }));
  });

  it('deterministic per (tenant, day)', () => {
    const a = buildAccountSignals('BANK_DEMO', {}, NOW);
    const b = buildAccountSignals('BANK_DEMO', {}, NOW);
    expect(a.total).toBe(b.total);
    expect(a.signals[0]?.signal_id).toBe(b.signals[0]?.signal_id);
  });

  it('customer_id filter narrows signals', () => {
    const all = buildAccountSignals('BANK_DEMO', {}, NOW);
    if (all.signals.length === 0) return;
    const target = all.signals[0].customer_id;
    const filtered = buildAccountSignals('BANK_DEMO', { customer_id: target }, NOW);
    expect(filtered.signals.every((s) => s.customer_id === target)).toBe(true);
  });

  it('watchlist_only narrows to is_watchlisted=true', () => {
    const out = buildAccountSignals('BANK_DEMO', { watchlist_only: true }, NOW);
    expect(out.signals.every((s) => s.is_watchlisted)).toBe(true);
    expect(out.watchlist_only).toBe(true);
  });

  it('signals sorted severity-desc then score-desc', () => {
    const out = buildAccountSignals('BANK_DEMO', {}, NOW);
    const sevRank: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
    for (let i = 1; i < out.signals.length; i++) {
      const prev = sevRank[out.signals[i - 1].severity];
      const cur = sevRank[out.signals[i].severity];
      expect(prev).toBeLessThanOrEqual(cur);
      if (prev === cur) {
        expect(out.signals[i - 1].score).toBeGreaterThanOrEqual(out.signals[i].score);
      }
    }
  });

  it('rejects empty tenant', () => {
    expect(() => buildAccountSignals('', {}, NOW)).toThrow(AccountBehaviourError);
  });
});

describe('buildAccountPatterns', () => {
  it('returns 4 patterns with 12-point series each', () => {
    const out = buildAccountPatterns('BANK_DEMO', 'a-100001-00', NOW);
    expect(out.patterns).toHaveLength(4);
    for (const p of out.patterns) {
      expect(p.series).toHaveLength(12);
      expect(p.anomaly_score).toBeGreaterThanOrEqual(0);
      expect(p.anomaly_score).toBeLessThanOrEqual(1);
    }
  });

  it('customer_id derived from account_id pattern', () => {
    const out = buildAccountPatterns('BANK_DEMO', 'a-100042-00', NOW);
    expect(out.customer_id).toBe('c-100042');
  });

  it('deterministic per (tenant, account)', () => {
    const a = buildAccountPatterns('BANK_DEMO', 'a-100001-00', NOW);
    const b = buildAccountPatterns('BANK_DEMO', 'a-100001-00', NOW);
    expect(a.patterns[0].series[0].value).toBe(b.patterns[0].series[0].value);
  });

  it('rejects empty inputs', () => {
    expect(() => buildAccountPatterns('', 'a-1-1', NOW)).toThrow(AccountBehaviourError);
    expect(() => buildAccountPatterns('BANK_DEMO', '', NOW)).toThrow(AccountBehaviourError);
  });
});

describe('4-eyes block workflow', () => {
  it('proposeAccountBlock creates pending request', () => {
    const r = proposeAccountBlock('BANK_DEMO', 'a-100001-00', 'Suspicious withdrawals', 'alice', NOW);
    expect(r.status).toBe('pending');
    expect(r.requested_by).toBe('alice');
    expect(r.customer_id).toBe('c-100001');
    expect(r.request_id).toMatch(/^blk-BANK_DEMO-\d{8}-\d{4}$/);
  });

  it('reviewBlockRequest approve flips status', () => {
    const r = proposeAccountBlock('BANK_DEMO', 'a-100001-00', 'Risk threshold', 'alice', NOW);
    const reviewed = reviewBlockRequest('BANK_DEMO', r.request_id, 'approve', 'bob', NOW);
    expect(reviewed.status).toBe('approved');
    expect(reviewed.reviewed_by).toBe('bob');
  });

  it('self-approval forbidden (maker = checker)', () => {
    const r = proposeAccountBlock('BANK_DEMO', 'a-100001-00', 'Reason XYZ', 'alice', NOW);
    expect(() => reviewBlockRequest('BANK_DEMO', r.request_id, 'approve', 'alice', NOW)).toThrow(
      /4-eyes/,
    );
  });

  it('already-decided cannot be re-reviewed', () => {
    const r = proposeAccountBlock('BANK_DEMO', 'a-100001-00', 'Reason', 'alice', NOW);
    reviewBlockRequest('BANK_DEMO', r.request_id, 'reject', 'bob', NOW);
    expect(() => reviewBlockRequest('BANK_DEMO', r.request_id, 'approve', 'bob', NOW)).toThrow(
      /already/,
    );
  });

  it('cross-tenant lookup throws unknown', () => {
    const r = proposeAccountBlock('BANK_DEMO', 'a-100001-00', 'Reason', 'alice', NOW);
    expect(() => reviewBlockRequest('BIL', r.request_id, 'approve', 'bob', NOW)).toThrow(/unknown/);
  });

  it('listBlockRequests returns newest-first + tenant-scoped', () => {
    proposeAccountBlock('BANK_DEMO', 'a-100001-00', 'r1abcdef', 'alice', new Date(NOW.getTime() - 1000));
    proposeAccountBlock('BANK_DEMO', 'a-100002-00', 'r2abcdef', 'alice', NOW);
    proposeAccountBlock('BIL', 'a-100003-00', 'r3abcdef', 'alice', NOW);
    const list = listBlockRequests('BANK_DEMO');
    expect(list).toHaveLength(2);
    expect(list[0].requested_at >= list[1].requested_at).toBe(true);
  });

  it('reason < 5 chars rejected', () => {
    expect(() => proposeAccountBlock('BANK_DEMO', 'a-1-0', 'no', 'alice', NOW)).toThrow(/reason/);
  });
});
