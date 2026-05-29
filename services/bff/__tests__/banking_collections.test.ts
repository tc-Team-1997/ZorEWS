// services/bff/__tests__/banking_collections.test.ts

import {
  ALL_DPD_BUCKETS,
  ALL_RECOVERY_STAGES,
  ALL_PTP_STATUSES,
  ALL_CONTACT_CHANNELS,
  COLLECTION_SECTORS,
  buildCollectionsSummary,
  buildCollectionsQueue,
  buildCollectionAccountDetail,
  recordPtp,
  logContact,
  _resetCollectionsOverlay,
  CollectionsError,
} from '../src/banking_collections';

const NOW = new Date('2026-05-28T12:00:00.000Z');

beforeEach(() => _resetCollectionsOverlay());

describe('enums', () => {
  it('DPD buckets = 4-value enum in escalation order', () => {
    expect(ALL_DPD_BUCKETS).toEqual(['dpd_1_30', 'dpd_31_60', 'dpd_61_90', 'dpd_90_plus']);
  });
  it('recovery stages = 5-value enum (soft → legal)', () => {
    expect(ALL_RECOVERY_STAGES).toEqual([
      'soft_reminder',
      'hard_reminder',
      'field_visit',
      'legal_notice',
      'settlement_offer',
    ]);
  });
  it('PTP statuses = 4-value enum', () => {
    expect(ALL_PTP_STATUSES).toEqual(['none', 'active', 'kept', 'broken']);
  });
  it('contact channels = 4-value enum', () => {
    expect(ALL_CONTACT_CHANNELS).toEqual(['call', 'sms', 'email', 'field_visit']);
  });
});

describe('buildCollectionsSummary', () => {
  it('returns KPIs with full DPD-bucket + stage partitions', () => {
    const s = buildCollectionsSummary('BANK_DEMO', NOW);
    expect(s.tenant_id).toBe('BANK_DEMO');
    expect(s.total_accounts).toBeGreaterThan(0);
    // every bucket key present
    for (const b of ALL_DPD_BUCKETS) expect(s.by_dpd_bucket[b]).toBeDefined();
    for (const st of ALL_RECOVERY_STAGES) expect(s.by_stage[st]).toBeDefined();
  });

  it('DPD-bucket counts partition the account total', () => {
    const s = buildCollectionsSummary('BANK_DEMO', NOW);
    const bucketSum = ALL_DPD_BUCKETS.reduce((a, b) => a + s.by_dpd_bucket[b].count, 0);
    expect(bucketSum).toBe(s.total_accounts);
  });

  it('stage counts partition the account total', () => {
    const s = buildCollectionsSummary('BANK_DEMO', NOW);
    const stageSum = ALL_RECOVERY_STAGES.reduce((a, st) => a + s.by_stage[st], 0);
    expect(stageSum).toBe(s.total_accounts);
  });

  it('expected recovery never exceeds total overdue', () => {
    const s = buildCollectionsSummary('BANK_DEMO', NOW);
    expect(s.total_expected_recovery_kes).toBeLessThanOrEqual(s.total_overdue_kes);
    expect(s.recovery_rate_pct).toBeGreaterThanOrEqual(0);
    expect(s.recovery_rate_pct).toBeLessThanOrEqual(100);
  });

  it('per-bucket overdue sums to total_overdue', () => {
    const s = buildCollectionsSummary('BANK_DEMO', NOW);
    const overdueSum = ALL_DPD_BUCKETS.reduce((a, b) => a + s.by_dpd_bucket[b].overdue_kes, 0);
    expect(overdueSum).toBe(s.total_overdue_kes);
  });

  it('ptp_kept_rate_pct in [0,100]', () => {
    const s = buildCollectionsSummary('BANK_DEMO', NOW);
    expect(s.ptp_kept_rate_pct).toBeGreaterThanOrEqual(0);
    expect(s.ptp_kept_rate_pct).toBeLessThanOrEqual(100);
  });

  it('deterministic per (tenant, day)', () => {
    const a = buildCollectionsSummary('BANK_DEMO', NOW);
    const b = buildCollectionsSummary('BANK_DEMO', NOW);
    expect(a).toEqual(b);
  });

  it('BIL scaled below BANK_DEMO', () => {
    const bank = buildCollectionsSummary('BANK_DEMO', NOW);
    const bil = buildCollectionsSummary('BIL', NOW);
    expect(bil.total_overdue_kes).toBeLessThan(bank.total_overdue_kes);
  });

  it('empty tenant_id throws', () => {
    expect(() => buildCollectionsSummary('', NOW)).toThrow(CollectionsError);
  });
});

describe('buildCollectionsQueue', () => {
  it('returns all accounts sorted by recovery priority (overdue × (1−recovery_prob)) desc', () => {
    const q = buildCollectionsQueue('BANK_DEMO', {}, NOW);
    expect(q.total).toBeGreaterThan(0);
    expect(q.accounts).toHaveLength(q.total);
    const priority = (a: { overdue_kes: number; recovery_probability: number }) =>
      a.overdue_kes * (1 - a.recovery_probability);
    for (let i = 1; i < q.accounts.length; i++) {
      expect(priority(q.accounts[i - 1])).toBeGreaterThanOrEqual(priority(q.accounts[i]) - 1e-6);
    }
  });

  it('every account carries a valid dpd_bucket matching its dpd', () => {
    const q = buildCollectionsQueue('BANK_DEMO', {}, NOW);
    for (const a of q.accounts) {
      expect(ALL_DPD_BUCKETS).toContain(a.dpd_bucket);
      if (a.dpd >= 91) expect(a.dpd_bucket).toBe('dpd_90_plus');
      else if (a.dpd >= 61) expect(a.dpd_bucket).toBe('dpd_61_90');
      else if (a.dpd >= 31) expect(a.dpd_bucket).toBe('dpd_31_60');
      else expect(a.dpd_bucket).toBe('dpd_1_30');
    }
  });

  it('expected_recovery_kes = round(overdue × recovery_probability)', () => {
    const q = buildCollectionsQueue('BANK_DEMO', {}, NOW);
    for (const a of q.accounts) {
      expect(a.expected_recovery_kes).toBe(Math.round(a.overdue_kes * a.recovery_probability));
      expect(a.recovery_probability).toBeGreaterThanOrEqual(0);
      expect(a.recovery_probability).toBeLessThanOrEqual(1);
    }
  });

  it('dpd_bucket filter narrows to that bucket', () => {
    const q = buildCollectionsQueue('BANK_DEMO', { dpd_bucket: 'dpd_90_plus' }, NOW);
    expect(q.filters_applied.dpd_bucket).toBe('dpd_90_plus');
    for (const a of q.accounts) expect(a.dpd_bucket).toBe('dpd_90_plus');
  });

  it('stage + ptp_status filters narrow correctly', () => {
    const q = buildCollectionsQueue('BANK_DEMO', { stage: 'legal_notice', ptp_status: 'active' }, NOW);
    for (const a of q.accounts) {
      expect(a.recovery_stage).toBe('legal_notice');
      expect(a.ptp_status).toBe('active');
    }
  });

  it('invalid dpd_bucket throws', () => {
    expect(() => buildCollectionsQueue('BANK_DEMO', { dpd_bucket: 'bogus' as never }, NOW)).toThrow(
      CollectionsError,
    );
  });
  it('invalid stage throws', () => {
    expect(() => buildCollectionsQueue('BANK_DEMO', { stage: 'bogus' as never }, NOW)).toThrow(
      CollectionsError,
    );
  });
  it('invalid ptp_status throws', () => {
    expect(() => buildCollectionsQueue('BANK_DEMO', { ptp_status: 'bogus' as never }, NOW)).toThrow(
      CollectionsError,
    );
  });

  it('tenant isolation — BIL account ids disjoint from BANK_DEMO', () => {
    const bank = new Set(buildCollectionsQueue('BANK_DEMO', {}, NOW).accounts.map((a) => a.account_id));
    const bil = buildCollectionsQueue('BIL', {}, NOW).accounts.map((a) => a.account_id);
    for (const id of bil) expect(bank.has(id)).toBe(false);
  });

  it('account sectors are from the closed enum', () => {
    const q = buildCollectionsQueue('BANK_DEMO', {}, NOW);
    for (const a of q.accounts) expect(COLLECTION_SECTORS).toContain(a.sector);
  });
});

describe('buildCollectionAccountDetail', () => {
  const firstId = () => buildCollectionsQueue('BANK_DEMO', {}, NOW).accounts[0].account_id;

  it('returns account 360 with histories + recovery factors', () => {
    const d = buildCollectionAccountDetail('BANK_DEMO', firstId(), NOW);
    expect(d.account_id).toBe(firstId());
    expect(Array.isArray(d.ptp_history)).toBe(true);
    expect(Array.isArray(d.contact_history)).toBe(true);
    expect(d.recovery_factors.length).toBeGreaterThan(0);
  });

  it('contact_history newest-first', () => {
    // find an account with >= 2 contacts
    const q = buildCollectionsQueue('BANK_DEMO', {}, NOW);
    const target = q.accounts.find((a) => a.contact_attempts_30d >= 2);
    if (!target) return; // synthesis may not produce one; skip silently
    const d = buildCollectionAccountDetail('BANK_DEMO', target.account_id, NOW);
    for (let i = 1; i < d.contact_history.length; i++) {
      expect(new Date(d.contact_history[i - 1].contacted_at).getTime()).toBeGreaterThanOrEqual(
        new Date(d.contact_history[i].contacted_at).getTime(),
      );
    }
  });

  it('unknown account throws', () => {
    expect(() => buildCollectionAccountDetail('BANK_DEMO', 'acc-bd-999999', NOW)).toThrow(CollectionsError);
  });
});

describe('recordPtp', () => {
  const firstId = () => buildCollectionsQueue('BANK_DEMO', {}, NOW).accounts[0].account_id;

  it('records a PTP that surfaces newest-first in detail', () => {
    const id = firstId();
    const entry = recordPtp(
      'BANK_DEMO',
      id,
      { amount_kes: 5_000_000, promised_date: '2026-06-10', recorded_by: 'ravi.collector' },
      NOW,
    );
    expect(entry.status).toBe('active');
    expect(entry.amount_kes).toBe(5_000_000);
    const d = buildCollectionAccountDetail('BANK_DEMO', id, NOW);
    expect(d.ptp_history[0]).toEqual(entry);
  });

  it('rejects non-positive amount', () => {
    expect(() =>
      recordPtp('BANK_DEMO', firstId(), { amount_kes: 0, promised_date: '2026-06-10', recorded_by: 'x' }, NOW),
    ).toThrow(CollectionsError);
  });
  it('rejects malformed promised_date', () => {
    expect(() =>
      recordPtp('BANK_DEMO', firstId(), { amount_kes: 1000, promised_date: '10/06/2026', recorded_by: 'x' }, NOW),
    ).toThrow(CollectionsError);
  });
  it('unknown account throws', () => {
    expect(() =>
      recordPtp('BANK_DEMO', 'acc-bd-999999', { amount_kes: 1000, promised_date: '2026-06-10', recorded_by: 'x' }, NOW),
    ).toThrow(CollectionsError);
  });
});

describe('logContact', () => {
  const firstId = () => buildCollectionsQueue('BANK_DEMO', {}, NOW).accounts[0].account_id;

  it('logs a contact that surfaces newest-first in detail', () => {
    const id = firstId();
    const entry = logContact(
      'BANK_DEMO',
      id,
      { channel: 'call', outcome: 'promised_payment', contacted_by: 'ravi.collector' },
      NOW,
    );
    expect(entry.channel).toBe('call');
    const d = buildCollectionAccountDetail('BANK_DEMO', id, NOW);
    expect(d.contact_history[0]).toEqual(entry);
  });

  it('rejects invalid channel', () => {
    expect(() =>
      logContact('BANK_DEMO', firstId(), { channel: 'pigeon' as never, outcome: 'x', contacted_by: 'y' }, NOW),
    ).toThrow(CollectionsError);
  });
  it('rejects empty outcome', () => {
    expect(() =>
      logContact('BANK_DEMO', firstId(), { channel: 'call', outcome: '  ', contacted_by: 'y' }, NOW),
    ).toThrow(CollectionsError);
  });
  it('unknown account throws', () => {
    expect(() =>
      logContact('BANK_DEMO', 'acc-bd-999999', { channel: 'call', outcome: 'x', contacted_by: 'y' }, NOW),
    ).toThrow(CollectionsError);
  });

  it('overlay reset clears recorded mutations', () => {
    const id = firstId();
    logContact('BANK_DEMO', id, { channel: 'sms', outcome: 'no_answer', contacted_by: 'z' }, NOW);
    _resetCollectionsOverlay();
    const d = buildCollectionAccountDetail('BANK_DEMO', id, NOW);
    // only seeded contacts remain — no overlay entry with contacted_by 'z'
    expect(d.contact_history.some((c) => c.contacted_by === 'z')).toBe(false);
  });
});
