// In-memory store contract for case_scenarios + case_scenario_history (T6 M14.18).
// Mirrors the M14.16/M14.17 test shapes plus FK validation, lifecycle
// transitions, history fan-out, and the soft-delete + restore round-trip.

import {
  CaseScenarioError,
  InMemoryCaseScenarioStore,
  validateCreate,
  validateUpdate,
  type CaseScenarioStoreDeps,
} from '../src/admin/case_scenarios_store';
import { InMemoryCaseScenarioHistoryStore } from '../src/admin/case_scenario_history_store';

const NOW1 = new Date('2026-05-09T10:00:00Z');
const NOW2 = new Date('2026-05-09T11:00:00Z');
const NOW3 = new Date('2026-05-09T12:00:00Z');
const ACTOR = { actor_id: 'alice.admin' };

const ESC_OK = '11111111-1111-1111-1111-111111111111';
const ESC_ARCHIVED = '22222222-2222-2222-2222-222222222222';
const ESC_OTHER_TENANT = '33333333-3333-3333-3333-333333333333';

const TPL_OK = '44444444-4444-4444-4444-444444444444';
const TPL_DELETED = '55555555-5555-5555-5555-555555555555';

function deps(history?: InMemoryCaseScenarioHistoryStore): CaseScenarioStoreDeps {
  return {
    resolveEscalation: async (tenant_id, id) => {
      if (id === ESC_OK && tenant_id === 'BANK_DEMO') return { status: 'ACTIVE' };
      if (id === ESC_ARCHIVED && tenant_id === 'BANK_DEMO') return { status: 'ARCHIVED' };
      if (id === ESC_OTHER_TENANT && tenant_id === 'BIL') return { status: 'ACTIVE' };
      return null;
    },
    resolveTemplate: async (tenant_id, id) => {
      if (id === TPL_OK && tenant_id === 'BANK_DEMO') return { status: 'ACTIVE', deleted_at: null };
      if (id === TPL_DELETED && tenant_id === 'BANK_DEMO')
        return { status: 'ARCHIVED', deleted_at: '2026-05-08T00:00:00Z' };
      return null;
    },
    history,
  };
}

const FRAUD_INPUT = validateCreate({
  name: 'Fraud P1 sudden DPD',
  case_category: 'fraud',
  priority: 'P1',
  trigger_indicator_id: 'FRD-001',
  trigger_threshold: 0.85,
  default_escalation_id: ESC_OK,
  notification_template_id: TPL_OK,
  checklist: [{ title: 'Verify with customer', required: true }],
});

describe('validateCreate (M14.18)', () => {
  it('accepts a minimal scenario without trigger or template', () => {
    const out = validateCreate({
      name: 'KYC P3',
      case_category: 'kyc',
      priority: 'P3',
      default_escalation_id: ESC_OK,
    });
    expect(out.trigger_indicator_id).toBeNull();
    expect(out.trigger_threshold).toBeNull();
    expect(out.notification_template_id).toBeNull();
    expect(out.checklist).toEqual([]);
  });

  it('rejects half-open trigger pair', () => {
    expect(() =>
      validateCreate({
        name: 'X', case_category: 'fraud', priority: 'P1',
        default_escalation_id: ESC_OK,
        trigger_indicator_id: 'FRD-001',
      }),
    ).toThrow(/trigger_indicator_id and trigger_threshold must be set together/);
  });

  it('rejects unknown priority', () => {
    expect(() =>
      validateCreate({
        name: 'X', case_category: 'fraud', priority: 'P9',
        default_escalation_id: ESC_OK,
      }),
    ).toThrow(/priority must be one of/);
  });

  it('rejects non-UUID escalation_id', () => {
    expect(() =>
      validateCreate({
        name: 'X', case_category: 'fraud', priority: 'P1',
        default_escalation_id: 'not-uuid',
      }),
    ).toThrow(/default_escalation_id must be a UUID/);
  });

  it('rejects malformed checklist item', () => {
    expect(() =>
      validateCreate({
        name: 'X', case_category: 'fraud', priority: 'P1',
        default_escalation_id: ESC_OK,
        checklist: [{ title: 'OK', required: 'yes' }],
      }),
    ).toThrow(/checklist\[0\].required must be a boolean/);
  });

  it('rejects empty checklist title', () => {
    expect(() =>
      validateCreate({
        name: 'X', case_category: 'fraud', priority: 'P1',
        default_escalation_id: ESC_OK,
        checklist: [{ title: '   ', required: true }],
      }),
    ).toThrow(/checklist\[0\].title length must be 1..200/);
  });

  it('rounds trigger_threshold to 4 decimals', () => {
    const out = validateCreate({
      name: 'X', case_category: 'fraud', priority: 'P1',
      default_escalation_id: ESC_OK,
      trigger_indicator_id: 'FRD-001',
      trigger_threshold: 0.123456789,
    });
    expect(out.trigger_threshold).toBe(0.1235);
  });
});

describe('validateUpdate (M14.18)', () => {
  it('requires at least one field', () => {
    expect(() => validateUpdate({})).toThrow(/at least one field must be provided/);
  });

  it('accepts a name-only patch', () => {
    expect(validateUpdate({ name: 'New' })).toEqual({ name: 'New' });
  });

  it('accepts trigger nulling (whole pair)', () => {
    expect(validateUpdate({ trigger_indicator_id: null, trigger_threshold: null })).toEqual({
      trigger_indicator_id: null,
      trigger_threshold: null,
    });
  });

  it('rejects non-UUID notification_template_id', () => {
    expect(() => validateUpdate({ notification_template_id: 'no' })).toThrow(/notification_template_id must be a UUID/);
  });
});

describe('InMemoryCaseScenarioStore (M14.18)', () => {
  it('create → DRAFT row, history append "create"', async () => {
    const h = new InMemoryCaseScenarioHistoryStore();
    const s = new InMemoryCaseScenarioStore(deps(h));
    const row = await s.create('BANK_DEMO', FRAUD_INPUT, ACTOR, NOW1);
    expect(row.status).toBe('DRAFT');
    expect(row.deleted_at).toBeNull();
    const log = await h.list('BANK_DEMO', { scenario_id: row.scenario_id });
    expect(log.total).toBe(1);
    expect(log.items[0]!.action).toBe('create');
    expect(log.items[0]!.diff.length).toBeGreaterThan(0);
    expect(log.items[0]!.after_state.name).toBe(FRAUD_INPUT.name);
  });

  it('rejects 400 when escalation_id is unknown', async () => {
    const s = new InMemoryCaseScenarioStore(deps());
    await expect(
      s.create('BANK_DEMO', { ...FRAUD_INPUT, default_escalation_id: '99999999-9999-9999-9999-999999999999' }, ACTOR, NOW1),
    ).rejects.toMatchObject({ status: 400, code: 'EWS_400_invalid_fk' });
  });

  it('rejects 400 when escalation_id is ARCHIVED', async () => {
    const s = new InMemoryCaseScenarioStore(deps());
    await expect(
      s.create('BANK_DEMO', { ...FRAUD_INPUT, default_escalation_id: ESC_ARCHIVED }, ACTOR, NOW1),
    ).rejects.toMatchObject({ status: 400, code: 'EWS_400_invalid_fk' });
  });

  it('rejects 400 when escalation_id belongs to another tenant', async () => {
    const s = new InMemoryCaseScenarioStore(deps());
    // ESC_OTHER_TENANT resolves only for BIL — calling against BANK_DEMO must 400
    await expect(
      s.create('BANK_DEMO', { ...FRAUD_INPUT, default_escalation_id: ESC_OTHER_TENANT }, ACTOR, NOW1),
    ).rejects.toMatchObject({ status: 400, code: 'EWS_400_invalid_fk' });
  });

  it('rejects 400 when notification_template_id is archived/deleted', async () => {
    const s = new InMemoryCaseScenarioStore(deps());
    await expect(
      s.create('BANK_DEMO', { ...FRAUD_INPUT, notification_template_id: TPL_DELETED }, ACTOR, NOW1),
    ).rejects.toMatchObject({ status: 400, code: 'EWS_400_invalid_fk' });
  });

  it('refuses duplicate name in same tenant (not deleted)', async () => {
    const s = new InMemoryCaseScenarioStore(deps());
    await s.create('BANK_DEMO', FRAUD_INPUT, ACTOR, NOW1);
    await expect(
      s.create('BANK_DEMO', { ...FRAUD_INPUT, name: 'fraud p1 sudden dpd' }, ACTOR, NOW2),
    ).rejects.toMatchObject({ status: 409, code: 'EWS_409_duplicate_scenario_name' });
  });

  it('update bumps updated_by + writes "update" history', async () => {
    const h = new InMemoryCaseScenarioHistoryStore();
    const s = new InMemoryCaseScenarioStore(deps(h));
    const row = await s.create('BANK_DEMO', FRAUD_INPUT, ACTOR, NOW1);
    const next = await s.update(
      'BANK_DEMO',
      row.scenario_id,
      { checklist: [{ title: 'Updated step', required: true }] },
      { actor_id: 'bob.admin' },
      NOW2,
    );
    expect(next.updated_by).toBe('bob.admin');
    const log = await h.list('BANK_DEMO', { scenario_id: row.scenario_id });
    expect(log.items.map((e) => e.action)).toEqual(['update', 'create']);
  });

  it('update refuses to half-open the trigger pair', async () => {
    const s = new InMemoryCaseScenarioStore(deps());
    const row = await s.create('BANK_DEMO', FRAUD_INPUT, ACTOR, NOW1);
    await expect(
      s.update(
        'BANK_DEMO',
        row.scenario_id,
        { trigger_indicator_id: null }, // leaves threshold set → half-open
        ACTOR,
        NOW2,
      ),
    ).rejects.toThrow(/trigger_indicator_id and trigger_threshold must be set together/);
  });

  it('activate moves DRAFT → ACTIVE; idempotent re-activate emits no extra history', async () => {
    const h = new InMemoryCaseScenarioHistoryStore();
    const s = new InMemoryCaseScenarioStore(deps(h));
    const row = await s.create('BANK_DEMO', FRAUD_INPUT, ACTOR, NOW1);
    const a1 = await s.activate('BANK_DEMO', row.scenario_id, ACTOR, NOW2);
    expect(a1.status).toBe('ACTIVE');
    const a2 = await s.activate('BANK_DEMO', row.scenario_id, ACTOR, NOW3);
    expect(a2.status).toBe('ACTIVE');
    // create + activate (no second activate)
    const log = await h.list('BANK_DEMO', { scenario_id: row.scenario_id });
    expect(log.items.map((e) => e.action)).toEqual(['activate', 'create']);
  });

  it('archive sets deleted_at + ARCHIVED + writes history', async () => {
    const h = new InMemoryCaseScenarioHistoryStore();
    const s = new InMemoryCaseScenarioStore(deps(h));
    const row = await s.create('BANK_DEMO', FRAUD_INPUT, ACTOR, NOW1);
    const arch = await s.archive('BANK_DEMO', row.scenario_id, ACTOR, NOW2);
    expect(arch.status).toBe('ARCHIVED');
    expect(arch.deleted_at).toBe(NOW2.toISOString());
    const log = await h.list('BANK_DEMO', { scenario_id: row.scenario_id });
    expect(log.items.map((e) => e.action)).toEqual(['archive', 'create']);
  });

  it('restore brings ARCHIVED → DRAFT; clears deleted_at', async () => {
    const h = new InMemoryCaseScenarioHistoryStore();
    const s = new InMemoryCaseScenarioStore(deps(h));
    const row = await s.create('BANK_DEMO', FRAUD_INPUT, ACTOR, NOW1);
    await s.archive('BANK_DEMO', row.scenario_id, ACTOR, NOW2);
    const restored = await s.restore('BANK_DEMO', row.scenario_id, ACTOR, NOW3);
    expect(restored.status).toBe('DRAFT');
    expect(restored.deleted_at).toBeNull();
    const log = await h.list('BANK_DEMO', { scenario_id: row.scenario_id });
    expect(log.items.map((e) => e.action)).toEqual(['restore', 'archive', 'create']);
  });

  it('restore refuses if a name collision was created during the absence', async () => {
    const s = new InMemoryCaseScenarioStore(deps());
    const a = await s.create('BANK_DEMO', FRAUD_INPUT, ACTOR, NOW1);
    await s.archive('BANK_DEMO', a.scenario_id, ACTOR, NOW2);
    // Reuse the now-free name on a fresh row
    await s.create('BANK_DEMO', FRAUD_INPUT, ACTOR, NOW2);
    await expect(s.restore('BANK_DEMO', a.scenario_id, ACTOR, NOW3))
      .rejects.toMatchObject({ status: 409, code: 'EWS_409_duplicate_scenario_name' });
  });

  it('restore on a non-archived row → 409', async () => {
    const s = new InMemoryCaseScenarioStore(deps());
    const row = await s.create('BANK_DEMO', FRAUD_INPUT, ACTOR, NOW1);
    await expect(s.restore('BANK_DEMO', row.scenario_id, ACTOR, NOW2))
      .rejects.toMatchObject({ status: 409, code: 'EWS_409_invalid_state' });
  });

  it('list hides soft-deleted rows by default', async () => {
    const s = new InMemoryCaseScenarioStore(deps());
    const row = await s.create('BANK_DEMO', FRAUD_INPUT, ACTOR, NOW1);
    await s.archive('BANK_DEMO', row.scenario_id, ACTOR, NOW2);
    expect((await s.list('BANK_DEMO', {})).total).toBe(0);
    expect((await s.list('BANK_DEMO', { include_deleted: true })).total).toBe(1);
  });

  it('list filters by trigger_indicator_id', async () => {
    const s = new InMemoryCaseScenarioStore(deps());
    await s.create('BANK_DEMO', FRAUD_INPUT, ACTOR, NOW1);
    await s.create(
      'BANK_DEMO',
      { ...FRAUD_INPUT, name: 'No trigger', trigger_indicator_id: null, trigger_threshold: null },
      ACTOR,
      NOW1,
    );
    const got = await s.list('BANK_DEMO', { trigger_indicator_id: 'FRD-001' });
    expect(got.total).toBe(1);
  });

  it('history fan-out is silent when no history store wired', async () => {
    const s = new InMemoryCaseScenarioStore(deps());
    const row = await s.create('BANK_DEMO', FRAUD_INPUT, ACTOR, NOW1);
    expect(row.scenario_id).toBeDefined();
  });

  it('archive is idempotent + does not duplicate history', async () => {
    const h = new InMemoryCaseScenarioHistoryStore();
    const s = new InMemoryCaseScenarioStore(deps(h));
    const row = await s.create('BANK_DEMO', FRAUD_INPUT, ACTOR, NOW1);
    await s.archive('BANK_DEMO', row.scenario_id, ACTOR, NOW2);
    const before = (await h.list('BANK_DEMO', { scenario_id: row.scenario_id })).total;
    await s.archive('BANK_DEMO', row.scenario_id, ACTOR, NOW3);
    const after = (await h.list('BANK_DEMO', { scenario_id: row.scenario_id })).total;
    expect(after).toBe(before);
  });

  it('not-found ops throw 404', async () => {
    const s = new InMemoryCaseScenarioStore(deps());
    await expect(s.update('BANK_DEMO', 'no-such', { name: 'x' }, ACTOR, NOW1))
      .rejects.toMatchObject({ status: 404 });
    await expect(s.activate('BANK_DEMO', 'no-such', ACTOR, NOW1))
      .rejects.toMatchObject({ status: 404 });
    await expect(s.archive('BANK_DEMO', 'no-such', ACTOR, NOW1))
      .rejects.toMatchObject({ status: 404 });
    await expect(s.restore('BANK_DEMO', 'no-such', ACTOR, NOW1))
      .rejects.toMatchObject({ status: 404 });
  });
});

describe('InMemoryCaseScenarioHistoryStore (M14.18)', () => {
  it('append → list newest-first', async () => {
    const h = new InMemoryCaseScenarioHistoryStore();
    await h.append('BANK_DEMO', { scenario_id: 's-1', action: 'create', diff: [], after_state: {}, performed_by: 'a' }, NOW1);
    await h.append('BANK_DEMO', { scenario_id: 's-1', action: 'update', diff: [], after_state: {}, performed_by: 'a' }, NOW2);
    const out = await h.list('BANK_DEMO', { scenario_id: 's-1' });
    expect(out.items.map((r) => r.action)).toEqual(['update', 'create']);
  });

  it('list filters by scenario_id', async () => {
    const h = new InMemoryCaseScenarioHistoryStore();
    await h.append('BANK_DEMO', { scenario_id: 's-1', action: 'create', diff: [], after_state: {}, performed_by: 'a' }, NOW1);
    await h.append('BANK_DEMO', { scenario_id: 's-2', action: 'create', diff: [], after_state: {}, performed_by: 'a' }, NOW1);
    expect((await h.list('BANK_DEMO', { scenario_id: 's-1' })).total).toBe(1);
    expect((await h.list('BANK_DEMO', {})).total).toBe(2);
  });

  it('isolates tenants', async () => {
    const h = new InMemoryCaseScenarioHistoryStore();
    await h.append('BANK_DEMO', { scenario_id: 's-1', action: 'create', diff: [], after_state: {}, performed_by: 'a' }, NOW1);
    expect((await h.list('BIL', {})).total).toBe(0);
  });
});
