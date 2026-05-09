// In-memory store contract for notification_templates (T6 M14.16).
// Mirrors the sla_config_store test shape.

import {
  InMemoryNotificationTemplateStore,
  NotificationTemplateError,
  validateCreate,
  validateUpdate,
} from '../src/admin/notification_templates_store';

const NOW1 = new Date('2026-05-09T10:00:00Z');
const NOW2 = new Date('2026-05-09T11:00:00Z');
const ACTOR = { actor_id: 'alice.admin' };

function fresh() {
  return new InMemoryNotificationTemplateStore();
}

const EMAIL_INPUT = validateCreate({
  name: 'RM weekly digest',
  channel: 'EMAIL',
  subject: 'Your weekly EWS update',
  body: 'Hi {{rm_name}}, you have {{count}} new alerts this week.',
});
const SMS_INPUT = validateCreate({
  name: 'Lapse warning',
  channel: 'SMS',
  body: 'EWS: Policy {{policy_number}} approaches lapse.',
});
const IN_APP_INPUT = validateCreate({
  name: 'Case escalated',
  channel: 'IN_APP',
  subject: 'Case {{case_number}} escalated to you',
  body: 'Please review urgently.',
});

describe('validateCreate', () => {
  it('rejects EMAIL without subject', () => {
    expect(() =>
      validateCreate({ name: 'X', channel: 'EMAIL', body: 'b' }),
    ).toThrow(/subject required for EMAIL/);
  });

  it('rejects SMS with subject', () => {
    expect(() =>
      validateCreate({ name: 'X', channel: 'SMS', subject: 'S', body: 'b' }),
    ).toThrow(/subject must be null for SMS/);
  });

  it('rejects body > 10000 chars', () => {
    expect(() =>
      validateCreate({ name: 'X', channel: 'SMS', body: 'x'.repeat(10001) }),
    ).toThrow(/body length must be 1..10000/);
  });

  it('rejects unknown channel', () => {
    expect(() =>
      validateCreate({ name: 'X', channel: 'PIGEON', body: 'b' }),
    ).toThrow(/channel must be one of EMAIL\|SMS\|IN_APP/);
  });

  it('defaults locale to en-IN', () => {
    expect(SMS_INPUT.locale).toBe('en-IN');
  });

  it('rejects malformed locale', () => {
    expect(() =>
      validateCreate({ name: 'X', channel: 'SMS', body: 'b', locale: 'gibberish_xx' }),
    ).toThrow(/locale must be BCP-47/);
  });
});

describe('validateUpdate', () => {
  it('requires at least one patchable field', () => {
    expect(() => validateUpdate({})).toThrow(/at least one of name\/subject\/body\/locale/);
  });
  it('accepts a body-only patch', () => {
    expect(validateUpdate({ body: 'new body' })).toEqual({ body: 'new body' });
  });
  it('accepts subject:null in the patch (for SMS subject clear, etc.)', () => {
    expect(validateUpdate({ subject: null })).toEqual({ subject: null });
  });
});

describe('InMemoryNotificationTemplateStore', () => {
  it('create → list returns the row, status DRAFT', async () => {
    const s = fresh();
    const row = await s.create('BANK_DEMO', EMAIL_INPUT, ACTOR, NOW1);
    expect(row.status).toBe('DRAFT');
    expect(row.created_by).toBe('alice.admin');
    expect(row.deleted_at).toBeNull();
    const out = await s.list('BANK_DEMO', {});
    expect(out.total).toBe(1);
    expect(out.items[0]!.template_id).toBe(row.template_id);
  });

  it('refuses duplicate (tenant, lower(name), locale)', async () => {
    const s = fresh();
    await s.create('BANK_DEMO', EMAIL_INPUT, ACTOR, NOW1);
    await expect(
      s.create('BANK_DEMO', { ...EMAIL_INPUT, name: 'rm weekly digest' }, ACTOR, NOW2),
    ).rejects.toMatchObject({ status: 409, code: 'EWS_409_duplicate_template_name' });
  });

  it('allows the same name in a different tenant', async () => {
    const s = fresh();
    await s.create('BANK_DEMO', EMAIL_INPUT, ACTOR, NOW1);
    await expect(
      s.create('BIL', EMAIL_INPUT, ACTOR, NOW1),
    ).resolves.toBeDefined();
  });

  it('allows the same name in a different locale', async () => {
    const s = fresh();
    await s.create('BANK_DEMO', EMAIL_INPUT, ACTOR, NOW1);
    await expect(
      s.create('BANK_DEMO', { ...EMAIL_INPUT, locale: 'hi-IN' }, ACTOR, NOW1),
    ).resolves.toBeDefined();
  });

  it('list filters by channel', async () => {
    const s = fresh();
    await s.create('BANK_DEMO', EMAIL_INPUT, ACTOR, NOW1);
    await s.create('BANK_DEMO', SMS_INPUT, ACTOR, NOW1);
    await s.create('BANK_DEMO', IN_APP_INPUT, ACTOR, NOW1);
    const sms = await s.list('BANK_DEMO', { channel: 'SMS' });
    expect(sms.total).toBe(1);
    expect(sms.items[0]!.channel).toBe('SMS');
  });

  it('list hides soft-deleted rows by default + reveals with include_deleted=true', async () => {
    const s = fresh();
    const row = await s.create('BANK_DEMO', EMAIL_INPUT, ACTOR, NOW1);
    await s.archive('BANK_DEMO', row.template_id, ACTOR, NOW2);
    expect((await s.list('BANK_DEMO', {})).total).toBe(0);
    expect((await s.list('BANK_DEMO', { include_deleted: true })).total).toBe(1);
  });

  it('update changes body + bumps updated_by/updated_at', async () => {
    const s = fresh();
    const row = await s.create('BANK_DEMO', EMAIL_INPUT, ACTOR, NOW1);
    const next = await s.update(
      'BANK_DEMO',
      row.template_id,
      { body: 'new body content' },
      { actor_id: 'bob.admin' },
      NOW2,
    );
    expect(next.body).toBe('new body content');
    expect(next.updated_by).toBe('bob.admin');
    expect(next.updated_at).toBe(NOW2.toISOString());
  });

  it('update refuses to set a subject on an SMS row', async () => {
    const s = fresh();
    const row = await s.create('BANK_DEMO', SMS_INPUT, ACTOR, NOW1);
    await expect(
      s.update('BANK_DEMO', row.template_id, { subject: 'oops' }, ACTOR, NOW2),
    ).rejects.toThrow(/subject must be null for SMS/);
  });

  it('update refuses a name+locale collision with another row', async () => {
    const s = fresh();
    const a = await s.create('BANK_DEMO', EMAIL_INPUT, ACTOR, NOW1);
    const b = await s.create('BANK_DEMO', { ...EMAIL_INPUT, name: 'Other name' }, ACTOR, NOW1);
    await expect(
      s.update('BANK_DEMO', b.template_id, { name: a.name }, ACTOR, NOW2),
    ).rejects.toMatchObject({ status: 409, code: 'EWS_409_duplicate_template_name' });
  });

  it('activate moves DRAFT → ACTIVE; idempotent on already-ACTIVE', async () => {
    const s = fresh();
    const row = await s.create('BANK_DEMO', EMAIL_INPUT, ACTOR, NOW1);
    const active = await s.activate('BANK_DEMO', row.template_id, ACTOR, NOW2);
    expect(active.status).toBe('ACTIVE');
    const again = await s.activate('BANK_DEMO', row.template_id, ACTOR, NOW2);
    expect(again.status).toBe('ACTIVE');
  });

  it('archive sets deleted_at + status=ARCHIVED; idempotent', async () => {
    const s = fresh();
    const row = await s.create('BANK_DEMO', EMAIL_INPUT, ACTOR, NOW1);
    const arch = await s.archive('BANK_DEMO', row.template_id, ACTOR, NOW2);
    expect(arch.status).toBe('ARCHIVED');
    expect(arch.deleted_at).toBe(NOW2.toISOString());
    const again = await s.archive('BANK_DEMO', row.template_id, ACTOR, NOW2);
    expect(again.deleted_at).toBe(NOW2.toISOString());
  });

  it('activate refuses an archived row', async () => {
    const s = fresh();
    const row = await s.create('BANK_DEMO', EMAIL_INPUT, ACTOR, NOW1);
    await s.archive('BANK_DEMO', row.template_id, ACTOR, NOW2);
    await expect(
      s.activate('BANK_DEMO', row.template_id, ACTOR, NOW2),
    ).rejects.toMatchObject({ status: 409, code: 'EWS_409_invalid_state' });
  });

  it('update refuses an archived row', async () => {
    const s = fresh();
    const row = await s.create('BANK_DEMO', EMAIL_INPUT, ACTOR, NOW1);
    await s.archive('BANK_DEMO', row.template_id, ACTOR, NOW2);
    await expect(
      s.update('BANK_DEMO', row.template_id, { body: 'x' }, ACTOR, NOW2),
    ).rejects.toMatchObject({ status: 409, code: 'EWS_409_invalid_state' });
  });

  it('get returns null across tenants', async () => {
    const s = fresh();
    const row = await s.create('BANK_DEMO', EMAIL_INPUT, ACTOR, NOW1);
    expect(await s.get('BIL', row.template_id)).toBeNull();
  });

  it('not-found ops throw 404', async () => {
    const s = fresh();
    await expect(s.update('BANK_DEMO', 'no-such', { body: 'x' }, ACTOR, NOW1))
      .rejects.toMatchObject({ status: 404 });
    await expect(s.activate('BANK_DEMO', 'no-such', ACTOR, NOW1))
      .rejects.toMatchObject({ status: 404 });
    await expect(s.archive('BANK_DEMO', 'no-such', ACTOR, NOW1))
      .rejects.toMatchObject({ status: 404 });
  });
});
