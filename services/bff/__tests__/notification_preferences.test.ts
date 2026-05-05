// services/bff/__tests__/notification_preferences.test.ts
//
// T6 M10.5 — Channel preference per-user.

import request from 'supertest';
import {
  InMemoryNotificationPreferenceStore,
  PreferenceError,
} from '../src/notification_preferences';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-06T01:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API', 'X-APEX-USER': 'alice' };

function makePrefApp(role = 'admin') {
  const store = new InMemoryNotificationPreferenceStore();
  const built = makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    notificationPreferenceStore: store,
    now: () => NOW,
    getRole: () => role,
  });
  return { ...built, store };
}

describe('InMemoryNotificationPreferenceStore', () => {
  test('never-touched user returns all-enabled defaults', () => {
    const s = new InMemoryNotificationPreferenceStore();
    const p = s.get('BIL', 'alice');
    expect(p.email).toBe(true);
    expect(p.sms).toBe(true);
    expect(p.push).toBe(true);
    expect(p.webhook).toBe(true);
    expect(p.updated_at).toBeNull();
  });

  test('update partial: only email changed; others unchanged', () => {
    const s = new InMemoryNotificationPreferenceStore();
    const p = s.update('BIL', 'alice', { email: false }, NOW);
    expect(p.email).toBe(false);
    expect(p.sms).toBe(true);
    expect(p.updated_at).toBe(NOW.toISOString());
  });

  test('update merges with existing override', () => {
    const s = new InMemoryNotificationPreferenceStore();
    s.update('BIL', 'alice', { email: false }, NOW);
    const p = s.update('BIL', 'alice', { sms: false }, NOW);
    expect(p.email).toBe(false);
    expect(p.sms).toBe(false);
  });

  test('rejects empty patch', () => {
    const s = new InMemoryNotificationPreferenceStore();
    expect(() => s.update('BIL', 'alice', {}, NOW)).toThrow(/at least one/);
  });

  test('rejects non-boolean channel value', () => {
    const s = new InMemoryNotificationPreferenceStore();
    expect(() =>
      s.update('BIL', 'alice', { email: 'yes' as unknown as boolean }, NOW),
    ).toThrow(/email/);
  });

  test('rejects unknown channel key', () => {
    const s = new InMemoryNotificationPreferenceStore();
    expect(() =>
      s.update('BIL', 'alice', { rss: true } as unknown as Record<string, boolean>, NOW),
    ).toThrow(/unknown channel/);
  });

  test('rejects non-object body', () => {
    const s = new InMemoryNotificationPreferenceStore();
    expect(() => s.update('BIL', 'alice', 'foo', NOW)).toThrow(PreferenceError);
  });

  test('isEnabled returns true by default', () => {
    const s = new InMemoryNotificationPreferenceStore();
    expect(s.isEnabled('BIL', 'alice', 'email')).toBe(true);
  });

  test('isEnabled returns false after disabling', () => {
    const s = new InMemoryNotificationPreferenceStore();
    s.update('BIL', 'alice', { sms: false }, NOW);
    expect(s.isEnabled('BIL', 'alice', 'sms')).toBe(false);
    expect(s.isEnabled('BIL', 'alice', 'email')).toBe(true);
  });

  test('cross-tenant isolation', () => {
    const s = new InMemoryNotificationPreferenceStore();
    s.update('BIL', 'alice', { email: false }, NOW);
    expect(s.get('BANK_DEMO', 'alice').email).toBe(true);
  });

  test('cross-user isolation within same tenant', () => {
    const s = new InMemoryNotificationPreferenceStore();
    s.update('BIL', 'alice', { sms: false }, NOW);
    expect(s.get('BIL', 'bob').sms).toBe(true);
  });

  test('reset clears overrides', () => {
    const s = new InMemoryNotificationPreferenceStore();
    s.update('BIL', 'alice', { email: false }, NOW);
    expect(s.reset('BIL', 'alice')).toBe(true);
    const p = s.get('BIL', 'alice');
    expect(p.email).toBe(true);
    expect(p.updated_at).toBeNull();
  });

  test('reset on never-touched returns false', () => {
    const s = new InMemoryNotificationPreferenceStore();
    expect(s.reset('BIL', 'alice')).toBe(false);
  });
});

describe('Routes', () => {
  test('GET /me returns defaults', async () => {
    const { app } = makePrefApp('admin');
    const r = await request(app).get('/v1/notifications/preferences/me').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.email).toBe(true);
    expect(r.body.body.username).toBe('alice');
  });

  test('PUT /me partial: only push set', async () => {
    const { app } = makePrefApp('admin');
    const r = await request(app)
      .put('/v1/notifications/preferences/me')
      .set(TH_BIL)
      .send({ push: false });
    expect(r.status).toBe(200);
    expect(r.body.body.push).toBe(false);
    expect(r.body.body.email).toBe(true);
    expect(r.body.body.updated_at).toBe(NOW.toISOString());
  });

  test('PUT empty body → 400', async () => {
    const { app } = makePrefApp('admin');
    const r = await request(app).put('/v1/notifications/preferences/me').set(TH_BIL).send({});
    expect(r.status).toBe(400);
  });

  test('PUT unknown channel → 400', async () => {
    const { app } = makePrefApp('admin');
    const r = await request(app)
      .put('/v1/notifications/preferences/me')
      .set(TH_BIL)
      .send({ rss: true });
    expect(r.status).toBe(400);
  });

  test('PUT non-boolean → 400', async () => {
    const { app } = makePrefApp('admin');
    const r = await request(app)
      .put('/v1/notifications/preferences/me')
      .set(TH_BIL)
      .send({ email: 'yes' });
    expect(r.status).toBe(400);
  });

  test('PUT/GET round-trip', async () => {
    const { app } = makePrefApp('admin');
    await request(app)
      .put('/v1/notifications/preferences/me')
      .set(TH_BIL)
      .send({ webhook: false });
    const g = await request(app).get('/v1/notifications/preferences/me').set(TH_BIL);
    expect(g.body.body.webhook).toBe(false);
  });

  test('POST /me/reset clears overrides', async () => {
    const { app } = makePrefApp('admin');
    await request(app)
      .put('/v1/notifications/preferences/me')
      .set(TH_BIL)
      .send({ email: false });
    const r = await request(app)
      .post('/v1/notifications/preferences/me/reset')
      .set(TH_BIL)
      .send({});
    expect(r.status).toBe(200);
    expect(r.body.body.email).toBe(true);
    expect(r.body.body.updated_at).toBeNull();
  });

  test('cross-user via X-APEX-USER: bob does not see alice\'s prefs', async () => {
    const { app } = makePrefApp('admin');
    await request(app)
      .put('/v1/notifications/preferences/me')
      .set(TH_BIL)
      .send({ sms: false });
    const r = await request(app)
      .get('/v1/notifications/preferences/me')
      .set('X-Tenant-ID', 'BIL')
      .set('X-Channel', 'API')
      .set('X-APEX-USER', 'bob');
    expect(r.body.body.sms).toBe(true);
    expect(r.body.body.username).toBe('bob');
  });

  test('analyst-level role can manage their own prefs', async () => {
    const { app } = makePrefApp('risk_analyst');
    const r = await request(app).get('/v1/notifications/preferences/me').set(TH_BIL);
    expect(r.status).toBe(200);
  });
});
