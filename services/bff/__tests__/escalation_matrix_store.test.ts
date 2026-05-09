// In-memory store contract for escalation_matrix (T6 M14.17).
// Mirrors the notification_templates_store test shape.

import {
  ESCALATION_ROLES,
  EscalationMatrixError,
  InMemoryEscalationMatrixStore,
  validateCreate,
  validateUpdate,
} from '../src/admin/escalation_matrix_store';

const NOW1 = new Date('2026-05-09T10:00:00Z');
const NOW2 = new Date('2026-05-09T11:00:00Z');
const ACTOR = { actor_id: 'alice.admin' };

function fresh() {
  return new InMemoryEscalationMatrixStore();
}

const ONE_LEVEL = validateCreate({
  name: 'KYC P3 single-level',
  case_category: 'kyc',
  priority: 'P3',
  level_1_after_minutes: 480,
  level_1_role: 'supervisor',
});

const THREE_LEVEL = validateCreate({
  name: 'Fraud P1 fast-escalate',
  case_category: 'fraud',
  priority: 'P1',
  level_1_after_minutes: 15,
  level_1_role: 'supervisor',
  level_2_after_minutes: 60,
  level_2_role: 'risk_analyst',
  level_3_after_minutes: 240,
  level_3_role: 'admin',
});

describe('validateCreate (M14.17)', () => {
  it('accepts a single-level rule', () => {
    expect(ONE_LEVEL.level_2_after_minutes).toBeNull();
    expect(ONE_LEVEL.level_3_after_minutes).toBeNull();
  });

  it('accepts a 3-level rule', () => {
    expect(THREE_LEVEL.level_3_role).toBe('admin');
  });

  it('rejects unknown priority', () => {
    expect(() =>
      validateCreate({ ...ONE_LEVEL, priority: 'P9' as never }),
    ).toThrow(/priority must be one of P1\|P2\|P3\|P4/);
  });

  it('rejects unknown role at level_1', () => {
    expect(() =>
      validateCreate({ ...ONE_LEVEL, level_1_role: 'overlord' as never }),
    ).toThrow(/level_1_role must be one of/);
  });

  it('rejects negative minutes', () => {
    expect(() =>
      validateCreate({ ...ONE_LEVEL, level_1_after_minutes: -5 }),
    ).toThrow(/level_1_after_minutes must be a non-negative integer/);
  });

  it('rejects level_2 minutes set without role', () => {
    expect(() =>
      validateCreate({ ...ONE_LEVEL, level_2_after_minutes: 60 }),
    ).toThrow(/level_2_after_minutes and level_2_role must be set together/);
  });

  it('rejects level_2 role set without minutes', () => {
    expect(() =>
      validateCreate({ ...ONE_LEVEL, level_2_role: 'risk_analyst' }),
    ).toThrow(/level_2_after_minutes and level_2_role must be set together/);
  });

  it('rejects level_2 minutes <= level_1 minutes', () => {
    expect(() =>
      validateCreate({
        ...ONE_LEVEL,
        level_2_after_minutes: ONE_LEVEL.level_1_after_minutes,
        level_2_role: 'risk_analyst',
      }),
    ).toThrow(/level_2_after_minutes must be greater than level_1_after_minutes/);
  });

  it('rejects level_3 set without level_2', () => {
    expect(() =>
      validateCreate({
        ...ONE_LEVEL,
        level_3_after_minutes: 1000,
        level_3_role: 'admin',
      }),
    ).toThrow(/level_3 cannot be set without level_2/);
  });

  it('rejects level_3 minutes <= level_2 minutes', () => {
    expect(() =>
      validateCreate({
        ...THREE_LEVEL,
        level_3_after_minutes: THREE_LEVEL.level_2_after_minutes!,
      }),
    ).toThrow(/level_3_after_minutes must be greater than level_2_after_minutes/);
  });

  it('rejects name > 120 chars', () => {
    expect(() => validateCreate({ ...ONE_LEVEL, name: 'x'.repeat(121) })).toThrow(/name length must be 1..120/);
  });
});

describe('validateUpdate (M14.17)', () => {
  it('requires at least one field', () => {
    expect(() => validateUpdate({})).toThrow(/at least one field must be provided/);
  });
  it('accepts a name-only patch', () => {
    expect(validateUpdate({ name: 'Renamed' })).toEqual({ name: 'Renamed' });
  });
  it('accepts level_2 set to null (clearing it)', () => {
    expect(validateUpdate({ level_2_after_minutes: null, level_2_role: null })).toEqual({
      level_2_after_minutes: null,
      level_2_role: null,
    });
  });
});

describe('InMemoryEscalationMatrixStore (M14.17)', () => {
  it('create → list returns the row, status ACTIVE', async () => {
    const s = fresh();
    const row = await s.create('BANK_DEMO', ONE_LEVEL, ACTOR, NOW1);
    expect(row.status).toBe('ACTIVE');
    expect(row.created_by).toBe('alice.admin');
    const out = await s.list('BANK_DEMO', {});
    expect(out.total).toBe(1);
  });

  it('refuses duplicate (tenant, lower(name))', async () => {
    const s = fresh();
    await s.create('BANK_DEMO', ONE_LEVEL, ACTOR, NOW1);
    await expect(
      s.create('BANK_DEMO', { ...ONE_LEVEL, name: 'kyc p3 single-level' }, ACTOR, NOW2),
    ).rejects.toMatchObject({ status: 409, code: 'EWS_409_duplicate_escalation_name' });
  });

  it('lets two tenants reuse the name', async () => {
    const s = fresh();
    await s.create('BANK_DEMO', ONE_LEVEL, ACTOR, NOW1);
    await expect(s.create('BIL', ONE_LEVEL, ACTOR, NOW1)).resolves.toBeDefined();
  });

  it('list filters by case_category + priority', async () => {
    const s = fresh();
    await s.create('BANK_DEMO', ONE_LEVEL, ACTOR, NOW1);
    await s.create('BANK_DEMO', THREE_LEVEL, ACTOR, NOW1);
    const fraud = await s.list('BANK_DEMO', { case_category: 'fraud', priority: 'P1' });
    expect(fraud.total).toBe(1);
    expect(fraud.items[0]!.name).toBe('Fraud P1 fast-escalate');
  });

  it('resolveFor returns the most recently updated ACTIVE rule', async () => {
    const s = fresh();
    await s.create('BANK_DEMO', { ...THREE_LEVEL, name: 'Old Fraud P1' }, ACTOR, NOW1);
    const newer = await s.create('BANK_DEMO', { ...THREE_LEVEL, name: 'New Fraud P1' }, ACTOR, NOW2);
    const got = await s.resolveFor('BANK_DEMO', 'fraud', 'P1');
    expect(got?.escalation_id).toBe(newer.escalation_id);
  });

  it('resolveFor returns null when no ACTIVE match', async () => {
    const s = fresh();
    await s.create('BANK_DEMO', ONE_LEVEL, ACTOR, NOW1);
    expect(await s.resolveFor('BANK_DEMO', 'fraud', 'P1')).toBeNull();
  });

  it('resolveFor ignores ARCHIVED rules', async () => {
    const s = fresh();
    const row = await s.create('BANK_DEMO', ONE_LEVEL, ACTOR, NOW1);
    await s.archive('BANK_DEMO', row.escalation_id, ACTOR, NOW2);
    expect(await s.resolveFor('BANK_DEMO', 'kyc', 'P3')).toBeNull();
  });

  it('update bumps updated_by/updated_at + can clear level_2 + level_3', async () => {
    const s = fresh();
    const row = await s.create('BANK_DEMO', THREE_LEVEL, ACTOR, NOW1);
    const next = await s.update(
      'BANK_DEMO',
      row.escalation_id,
      {
        level_2_after_minutes: null,
        level_2_role: null,
        level_3_after_minutes: null,
        level_3_role: null,
      },
      { actor_id: 'bob.admin' },
      NOW2,
    );
    expect(next.level_2_after_minutes).toBeNull();
    expect(next.level_3_after_minutes).toBeNull();
    expect(next.updated_by).toBe('bob.admin');
  });

  it('update refuses an inconsistent partial patch (level_2 minutes <= level_1)', async () => {
    const s = fresh();
    const row = await s.create('BANK_DEMO', THREE_LEVEL, ACTOR, NOW1);
    await expect(
      s.update('BANK_DEMO', row.escalation_id, { level_1_after_minutes: 100 }, ACTOR, NOW2),
    ).rejects.toThrow(/level_2_after_minutes must be greater than level_1_after_minutes/);
  });

  it('update refuses to clear level_2 while leaving level_3 set', async () => {
    const s = fresh();
    const row = await s.create('BANK_DEMO', THREE_LEVEL, ACTOR, NOW1);
    await expect(
      s.update(
        'BANK_DEMO',
        row.escalation_id,
        { level_2_after_minutes: null, level_2_role: null },
        ACTOR,
        NOW2,
      ),
    ).rejects.toThrow(/level_3 cannot be set without level_2/);
  });

  it('update refuses an archived row', async () => {
    const s = fresh();
    const row = await s.create('BANK_DEMO', ONE_LEVEL, ACTOR, NOW1);
    await s.archive('BANK_DEMO', row.escalation_id, ACTOR, NOW2);
    await expect(
      s.update('BANK_DEMO', row.escalation_id, { name: 'rename' }, ACTOR, NOW2),
    ).rejects.toMatchObject({ status: 409, code: 'EWS_409_invalid_state' });
  });

  it('archive is idempotent', async () => {
    const s = fresh();
    const row = await s.create('BANK_DEMO', ONE_LEVEL, ACTOR, NOW1);
    const a = await s.archive('BANK_DEMO', row.escalation_id, ACTOR, NOW2);
    expect(a.status).toBe('ARCHIVED');
    const again = await s.archive('BANK_DEMO', row.escalation_id, ACTOR, NOW2);
    expect(again.status).toBe('ARCHIVED');
  });

  it('not-found ops throw 404', async () => {
    const s = fresh();
    await expect(s.update('BANK_DEMO', 'no-such', { name: 'x' }, ACTOR, NOW1))
      .rejects.toMatchObject({ status: 404 });
    await expect(s.archive('BANK_DEMO', 'no-such', ACTOR, NOW1))
      .rejects.toMatchObject({ status: 404 });
  });

  it('ESCALATION_ROLES exposes all 5 RBAC roles', () => {
    // Lint guard against drift — if a new role lands in matrix.json,
    // bump this list (and the validator) deliberately.
    expect(ESCALATION_ROLES).toEqual([
      'admin',
      'risk_analyst',
      'supervisor',
      'collection_officer',
      'field_officer',
    ]);
  });
});
