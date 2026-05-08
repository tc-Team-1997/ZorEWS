// In-memory store contract — covers the supersede flow + duplicate
// guard + archive idempotency. PG-flavour tests are covered by the
// existing `__tests__/*_pg.test.ts` pattern (env-gated, run only when
// ADMIN_PG_URL is set) — not duplicated here.

import {
  InMemorySlaConfigStore,
  SlaConfigError,
  validateCreate,
  validateUpdate,
  type SlaConfigRow,
} from '../src/admin/sla_config_store';

const NOW1 = new Date('2026-05-08T10:00:00Z');
const NOW2 = new Date('2026-05-08T11:00:00Z');
const ACTOR = { actor_id: 'alice.admin' };

function fresh() {
  return new InMemorySlaConfigStore();
}

describe('InMemorySlaConfigStore', () => {
  it('create → list returns the row', async () => {
    const s = fresh();
    const row = await s.create('BANK_DEMO', {
      case_category: 'credit_risk',
      priority: 'P1',
      sla_target_days: 1,
    }, ACTOR, NOW1);
    expect(row.status).toBe('ACTIVE');
    expect(row.created_by).toBe('alice.admin');
    const out = await s.list('BANK_DEMO', {});
    expect(out.total).toBe(1);
    expect(out.items[0].sla_config_id).toBe(row.sla_config_id);
  });

  it('refuses a duplicate ACTIVE row for the same identity', async () => {
    const s = fresh();
    await s.create('BANK_DEMO', { case_category: 'credit_risk', priority: 'P1', sla_target_days: 1 }, ACTOR, NOW1);
    await expect(
      s.create('BANK_DEMO', { case_category: 'credit_risk', priority: 'P1', sla_target_days: 2 }, ACTOR, NOW2),
    ).rejects.toMatchObject({ status: 409, code: 'EWS_409_duplicate_active_sla_config' });
  });

  it('lets two tenants hold the same identity', async () => {
    const s = fresh();
    await s.create('BANK_DEMO', { case_category: 'credit_risk', priority: 'P1', sla_target_days: 1 }, ACTOR, NOW1);
    await expect(
      s.create('BIL', { case_category: 'credit_risk', priority: 'P1', sla_target_days: 1 }, ACTOR, NOW1),
    ).resolves.toBeDefined();
  });

  it('lets a BU-specific row coexist with the general (BU=null) row', async () => {
    const s = fresh();
    await s.create('BANK_DEMO', { case_category: 'credit_risk', priority: 'P1', sla_target_days: 1 }, ACTOR, NOW1);
    await expect(
      s.create('BANK_DEMO', { case_category: 'credit_risk', priority: 'P1', business_unit: 'CORPORATE', sla_target_days: 0.5 }, ACTOR, NOW1),
    ).resolves.toBeDefined();
  });

  it('supersede: old row → SUPERSEDED, new row → ACTIVE, both pointers set', async () => {
    const s = fresh();
    const original = await s.create(
      'BANK_DEMO', { case_category: 'fraud', priority: 'P1', sla_target_days: 0.5, notes: 'first' }, ACTOR, NOW1,
    );
    const next = await s.supersede(
      'BANK_DEMO', original.sla_config_id, { sla_target_days: 0.25, notes: 'tighter' }, ACTOR, NOW2,
    );
    expect(next.status).toBe('ACTIVE');
    expect(next.sla_target_days).toBe(0.25);
    expect(next.notes).toBe('tighter');
    expect(next.sla_config_id).not.toBe(original.sla_config_id);

    const old = await s.get('BANK_DEMO', original.sla_config_id);
    expect(old?.status).toBe('SUPERSEDED');
    expect(old?.superseded_by).toBe(next.sla_config_id);
    expect(old?.effective_till).toBe(NOW2.toISOString());
    // Identity is fixed — supersede preserves it
    expect(next.case_category).toBe('fraud');
    expect(next.priority).toBe('P1');
    expect(next.business_unit).toBe(null);
  });

  it('supersede: only ACTIVE rows are editable', async () => {
    const s = fresh();
    const original = await s.create('BANK_DEMO', { case_category: 'kyc', priority: 'P3', sla_target_days: 10 }, ACTOR, NOW1);
    await s.supersede('BANK_DEMO', original.sla_config_id, { sla_target_days: 7 }, ACTOR, NOW2);
    // Trying to supersede the original (now SUPERSEDED) again
    await expect(
      s.supersede('BANK_DEMO', original.sla_config_id, { sla_target_days: 5 }, ACTOR, NOW2),
    ).rejects.toMatchObject({ status: 409, code: 'EWS_409_invalid_state' });
  });

  it('supersede: 404 when id is unknown', async () => {
    const s = fresh();
    await expect(
      s.supersede('BANK_DEMO', 'no-such-id', { sla_target_days: 1 }, ACTOR, NOW1),
    ).rejects.toMatchObject({ status: 404, code: 'EWS_404_not_found' });
  });

  it('archive: ACTIVE → ARCHIVED', async () => {
    const s = fresh();
    const r = await s.create('BANK_DEMO', { case_category: 'lapse', priority: 'P4', sla_target_days: 10 }, ACTOR, NOW1);
    const archived = await s.archive('BANK_DEMO', r.sla_config_id, ACTOR, NOW2);
    expect(archived.status).toBe('ARCHIVED');
    expect(archived.effective_till).toBe(NOW2.toISOString());
  });

  it('archive: idempotent on ARCHIVED', async () => {
    const s = fresh();
    const r = await s.create('BANK_DEMO', { case_category: 'lapse', priority: 'P4', sla_target_days: 10 }, ACTOR, NOW1);
    await s.archive('BANK_DEMO', r.sla_config_id, ACTOR, NOW2);
    const again = await s.archive('BANK_DEMO', r.sla_config_id, ACTOR, NOW2);
    expect(again.status).toBe('ARCHIVED');
  });

  it('archive: refuses SUPERSEDED row (history is immutable)', async () => {
    const s = fresh();
    const r = await s.create('BANK_DEMO', { case_category: 'fraud', priority: 'P2', sla_target_days: 1 }, ACTOR, NOW1);
    await s.supersede('BANK_DEMO', r.sla_config_id, { sla_target_days: 0.5 }, ACTOR, NOW2);
    await expect(s.archive('BANK_DEMO', r.sla_config_id, ACTOR, NOW2)).rejects.toMatchObject({
      status: 409,
      code: 'EWS_409_invalid_state',
    });
  });

  it('archive after supersede: archives the new ACTIVE row, leaves the SUPERSEDED row untouched', async () => {
    const s = fresh();
    const r = await s.create('BANK_DEMO', { case_category: 'fraud', priority: 'P2', sla_target_days: 1 }, ACTOR, NOW1);
    const next = await s.supersede('BANK_DEMO', r.sla_config_id, { sla_target_days: 0.5 }, ACTOR, NOW2);
    const archived = await s.archive('BANK_DEMO', next.sla_config_id, ACTOR, NOW2);
    expect(archived.status).toBe('ARCHIVED');
    const old = await s.get('BANK_DEMO', r.sla_config_id);
    expect(old?.status).toBe('SUPERSEDED');
  });

  it('list filters by status', async () => {
    const s = fresh();
    const r1 = await s.create('BANK_DEMO', { case_category: 'a', priority: 'P1', sla_target_days: 1 }, ACTOR, NOW1);
    await s.create('BANK_DEMO', { case_category: 'b', priority: 'P1', sla_target_days: 1 }, ACTOR, NOW1);
    await s.archive('BANK_DEMO', r1.sla_config_id, ACTOR, NOW2);
    const active = await s.list('BANK_DEMO', { status: ['ACTIVE'] });
    expect(active.items).toHaveLength(1);
    expect(active.items[0].case_category).toBe('b');
    const archived = await s.list('BANK_DEMO', { status: ['ARCHIVED'] });
    expect(archived.items).toHaveLength(1);
    expect(archived.items[0].case_category).toBe('a');
  });

  it('list filters by category + priority', async () => {
    const s = fresh();
    await s.create('BANK_DEMO', { case_category: 'a', priority: 'P1', sla_target_days: 1 }, ACTOR, NOW1);
    await s.create('BANK_DEMO', { case_category: 'a', priority: 'P2', sla_target_days: 3 }, ACTOR, NOW1);
    await s.create('BANK_DEMO', { case_category: 'b', priority: 'P1', sla_target_days: 1 }, ACTOR, NOW1);
    const out = await s.list('BANK_DEMO', { case_category: 'a', priority: 'P1' });
    expect(out.items).toHaveLength(1);
    expect(out.items[0].case_category).toBe('a');
    expect(out.items[0].priority).toBe('P1');
  });
});

describe('validators', () => {
  it('validateCreate trims strings + rounds NUMERIC(5,2)', () => {
    const v = validateCreate({
      case_category: '  fraud  ',
      priority: 'P1',
      business_unit: '  CORPORATE  ',
      sla_target_days: 0.123456,
      notes: '  tighter  ',
    });
    expect(v.case_category).toBe('fraud');
    expect(v.business_unit).toBe('CORPORATE');
    expect(v.sla_target_days).toBe(0.12);
    expect(v.notes).toBe('tighter');
  });

  it('validateCreate: priority must be P1..P4', () => {
    expect(() =>
      validateCreate({ case_category: 'x', priority: 'BAD', sla_target_days: 1 }),
    ).toThrow(/priority/);
  });

  it.each([0, -1, 366, NaN, 'abc'])('validateCreate: rejects out-of-range target %s', (n) => {
    expect(() =>
      validateCreate({ case_category: 'x', priority: 'P1', sla_target_days: n }),
    ).toThrow(/sla_target_days/);
  });

  it('validateUpdate: at least one field required', () => {
    expect(() => validateUpdate({})).toThrow(/at least one/);
  });

  it('validateUpdate: notes can be set to null to clear', () => {
    expect(validateUpdate({ notes: null })).toEqual({ notes: null });
  });
});

// Type-only smoke (compile-time): SlaConfigError + SlaConfigRow exports
const _typeRefs: [SlaConfigError, SlaConfigRow] | null = null;
void _typeRefs;
