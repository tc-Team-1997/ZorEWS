// services/bff/__tests__/notification_preferences_effective.test.ts
//
// T6 M10.10 — Notification preference effective view + resolution chain.

import request from 'supertest';
import {
  applyQuietHoursMute,
  resolveEffectivePreference,
} from '../src/notification_preferences_effective';
import { InMemoryNotificationPreferenceStore } from '../src/notification_preferences';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-14T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

// ─── resolveEffectivePreference — pure ───────────────────────────────

describe('M10.10 — resolveEffectivePreference — platform default', () => {
  test('untouched tenant + untouched user → every channel resolves to platform_default=true', () => {
    const store = new InMemoryNotificationPreferenceStore();
    const out = resolveEffectivePreference(store, 'BIL', 'alice');
    expect(out.channels.length).toBe(4);
    for (const c of out.channels) {
      expect(c.effective_enabled).toBe(true);
      expect(c.resolution).toBe('platform_default');
      // user_override level is null (not set), tenant_default null,
      // platform_default=true.
      expect(c.levels[0]!).toMatchObject({ level: 'user_override', value: null });
      expect(c.levels[1]!).toMatchObject({ level: 'tenant_default', value: null });
      expect(c.levels[2]!).toMatchObject({ level: 'platform_default', value: true });
    }
    expect(out.quiet_hours).toBeNull();
  });
});

describe('M10.10 — tenant_default resolution', () => {
  test('tenant default overrides platform; user untouched → resolution=tenant_default', () => {
    const store = new InMemoryNotificationPreferenceStore();
    store.setTenantDefault('BIL', { email: false, sms: true }, 'admin', NOW);
    const out = resolveEffectivePreference(store, 'BIL', 'alice');
    const email = out.channels.find((c) => c.channel === 'email')!;
    expect(email.resolution).toBe('tenant_default');
    expect(email.effective_enabled).toBe(false);
    expect(email.levels[1]).toMatchObject({
      level: 'tenant_default',
      value: false,
      set_by: 'admin',
    });
    expect(email.levels[1]!.set_at).toBeTruthy();
  });
});

describe('M10.10 — user_override resolution', () => {
  test('user override wins over tenant default + platform default', () => {
    const store = new InMemoryNotificationPreferenceStore();
    store.setTenantDefault('BIL', { email: false, sms: false }, 'admin', NOW);
    store.update('BIL', 'alice', { email: true }, NOW);
    const out = resolveEffectivePreference(store, 'BIL', 'alice');
    const email = out.channels.find((c) => c.channel === 'email')!;
    expect(email.resolution).toBe('user_override');
    expect(email.effective_enabled).toBe(true);
    expect(email.levels[0]).toMatchObject({ level: 'user_override', value: true });
    expect(email.levels[1]).toMatchObject({ level: 'tenant_default', value: false });
  });

  test('user override with a partial patch — non-patched channels still come from the override row', () => {
    const store = new InMemoryNotificationPreferenceStore();
    store.setTenantDefault('BIL', { email: false }, 'admin', NOW);
    store.update('BIL', 'alice', { email: true }, NOW);
    const out = resolveEffectivePreference(store, 'BIL', 'alice');
    // SMS wasn't patched — once a user has ANY override row, all 4
    // channels resolve to user_override (the row carries all 4 values).
    const sms = out.channels.find((c) => c.channel === 'sms')!;
    expect(sms.resolution).toBe('user_override');
  });
});

describe('M10.10 — quiet_hours', () => {
  test('user-level quiet_hours surface on the response', () => {
    const store = new InMemoryNotificationPreferenceStore();
    store.setQuietHours('BIL', 'alice', { start_hour: 22, end_hour: 7 }, NOW);
    const out = resolveEffectivePreference(store, 'BIL', 'alice');
    expect(out.quiet_hours).toEqual({ start_hour: 22, end_hour: 7 });
  });

  test('asOf within quiet_hours → applyQuietHoursMute mutes non-webhook channels; webhook bypasses', () => {
    const store = new InMemoryNotificationPreferenceStore();
    store.update('BIL', 'alice', { email: true }, NOW);
    store.setQuietHours('BIL', 'alice', { start_hour: 22, end_hour: 7 }, NOW);
    const effective = resolveEffectivePreference(
      store,
      'BIL',
      'alice',
      new Date('2026-05-14T03:00:00.000Z'), // 03:00 UTC — inside 22→7
    );
    const muted = applyQuietHoursMute(effective, new Date('2026-05-14T03:00:00.000Z'));
    expect(muted.email).toBe(false);
    expect(muted.sms).toBe(false);
    expect(muted.push).toBe(false);
    expect(muted.webhook).toBe(true); // bypasses
  });

  test('asOf outside quiet_hours → channels stay enabled', () => {
    const store = new InMemoryNotificationPreferenceStore();
    store.update('BIL', 'alice', { email: true }, NOW);
    store.setQuietHours('BIL', 'alice', { start_hour: 22, end_hour: 7 }, NOW);
    const effective = resolveEffectivePreference(
      store,
      'BIL',
      'alice',
      new Date('2026-05-14T12:00:00.000Z'), // outside window
    );
    const muted = applyQuietHoursMute(effective, new Date('2026-05-14T12:00:00.000Z'));
    expect(muted.email).toBe(true);
  });
});

describe('M10.10 — asOf field echoes', () => {
  test('asOf provided → echoed as ISO; absent → null', () => {
    const store = new InMemoryNotificationPreferenceStore();
    expect(resolveEffectivePreference(store, 'BIL', 'alice').asOf).toBeNull();
    expect(
      resolveEffectivePreference(store, 'BIL', 'alice', NOW).asOf,
    ).toBe(NOW.toISOString());
  });
});

describe('M10.10 — hasUserOverride store method', () => {
  test('returns false on untouched user, true after update', () => {
    const store = new InMemoryNotificationPreferenceStore();
    expect(store.hasUserOverride('BIL', 'alice')).toBe(false);
    store.update('BIL', 'alice', { email: true }, NOW);
    expect(store.hasUserOverride('BIL', 'alice')).toBe(true);
  });

  test('reset clears the override flag', () => {
    const store = new InMemoryNotificationPreferenceStore();
    store.update('BIL', 'alice', { email: true }, NOW);
    store.reset('BIL', 'alice');
    expect(store.hasUserOverride('BIL', 'alice')).toBe(false);
  });

  test('tenant_default does NOT register as a user override', () => {
    const store = new InMemoryNotificationPreferenceStore();
    store.setTenantDefault('BIL', { email: false }, 'admin', NOW);
    expect(store.hasUserOverride('BIL', 'alice')).toBe(false);
  });
});

// ─── Route: GET /v1/notifications/preferences/effective ──────────────

function makeEffectiveApp(role = 'admin', store?: InMemoryNotificationPreferenceStore) {
  const notificationPreferenceStore = store ?? new InMemoryNotificationPreferenceStore();
  const built = makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    notificationPreferenceStore,
    now: () => NOW,
    getRole: () => role,
  });
  return { ...built, notificationPreferenceStore };
}

describe('M10.10 — GET /v1/notifications/preferences/effective', () => {
  test('untouched user → 200 platform_default for all channels', async () => {
    const { app } = makeEffectiveApp('admin');
    const r = await request(app)
      .get('/v1/notifications/preferences/effective?username=alice')
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.channels.length).toBe(4);
    expect(r.body.body.channels.every(
      (c: { resolution: string }) => c.resolution === 'platform_default',
    )).toBe(true);
  });

  test('tenant default + user override surface as separate resolution levels', async () => {
    const store = new InMemoryNotificationPreferenceStore();
    store.setTenantDefault('BIL', { email: false }, 'admin', NOW);
    store.update('BIL', 'alice', { email: true }, NOW);
    const { app } = makeEffectiveApp('admin', store);
    const r = await request(app)
      .get('/v1/notifications/preferences/effective?username=alice')
      .set(TH_BIL);
    const email = r.body.body.channels.find(
      (c: { channel: string }) => c.channel === 'email',
    );
    expect(email.resolution).toBe('user_override');
    expect(email.effective_enabled).toBe(true);
    expect(email.levels[1].value).toBe(false); // tenant_default
  });

  test('missing ?username → 400', async () => {
    const { app } = makeEffectiveApp('admin');
    const r = await request(app)
      .get('/v1/notifications/preferences/effective')
      .set(TH_BIL);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_input');
  });

  test('?asOf=ISO echoed and validated', async () => {
    const { app } = makeEffectiveApp('admin');
    const r = await request(app)
      .get('/v1/notifications/preferences/effective?username=alice&asOf=2026-05-14T03:00:00Z')
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.asOf).toBe('2026-05-14T03:00:00.000Z');
  });

  test('?asOf=invalid → 400', async () => {
    const { app } = makeEffectiveApp('admin');
    const r = await request(app)
      .get('/v1/notifications/preferences/effective?username=alice&asOf=not-a-date')
      .set(TH_BIL);
    expect(r.status).toBe(400);
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeEffectiveApp('case_owner');
    const r = await request(app)
      .get('/v1/notifications/preferences/effective?username=alice')
      .set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('cross-tenant: BIL override invisible to BANK_DEMO', async () => {
    const store = new InMemoryNotificationPreferenceStore();
    store.update('BIL', 'alice', { email: false }, NOW);
    const { app } = makeEffectiveApp('admin', store);
    const r = await request(app)
      .get('/v1/notifications/preferences/effective?username=alice')
      .set('X-Tenant-ID', 'BANK_DEMO')
      .set('X-Channel', 'API');
    expect(r.status).toBe(200);
    const email = r.body.body.channels.find(
      (c: { channel: string }) => c.channel === 'email',
    );
    expect(email.resolution).toBe('platform_default');
    expect(email.effective_enabled).toBe(true);
  });
});
