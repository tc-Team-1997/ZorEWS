// services/bff/__tests__/alert_quiet_hours_mute.test.ts
//
// T6 M10.8 — Alert acknowledgment auto-mute via M10.7 quiet hours.

import request from 'supertest';
import {
  InMemoryQuietHoursMuteEventStore,
  QUIET_HOURS_MUTE_ACTOR,
  QUIET_HOURS_MUTE_EVENT_CAP,
  evaluateQuietHoursMute,
} from '../src/alert_quiet_hours_mute';
import { InMemoryAlertAckStore } from '../src/alert_ack';
import { InMemoryNotificationPreferenceStore } from '../src/notification_preferences';
import { InMemoryAutoAckRuleStore } from '../src/alert_auto_ack';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const QUIET_NOW = new Date('2026-05-06T23:30:00.000Z'); // hour=23 → inside 22-07 window
const ACTIVE_NOW = new Date('2026-05-06T10:00:00.000Z'); // hour=10 → outside

const HEADERS_BIL = {
  'X-Tenant-ID': 'BIL',
  'X-Channel': 'API',
  'X-APEX-USER': 'jane.analyst',
};

function buildStores() {
  const ackStore = new InMemoryAlertAckStore();
  const muteStore = new InMemoryQuietHoursMuteEventStore();
  const prefStore = new InMemoryNotificationPreferenceStore();
  return { ackStore, muteStore, prefStore };
}

function setNightOwlQuietHours(
  prefStore: InMemoryNotificationPreferenceStore,
  username = 'jane.analyst',
  start = 22,
  end = 7,
) {
  prefStore.setQuietHours(
    'BIL',
    username,
    { start_hour: start, end_hour: end },
    new Date('2026-05-06T00:00:00.000Z'),
  );
}

// ── Pure evaluator ──────────────────────────────────────────────────

describe('evaluateQuietHoursMute (M10.8 pure evaluator)', () => {
  it('skips when no target_username supplied', () => {
    const { ackStore, muteStore, prefStore } = buildStores();
    const decision = evaluateQuietHoursMute({
      prefStore,
      ackStore,
      muteStore,
      tenant_id: 'BIL',
      alert_id: 'a1',
      bil_class: 'yellow',
      target_username: undefined,
      already_auto_acked: false,
      now: QUIET_NOW,
    });
    expect(decision.applied).toBe(false);
    expect(decision.skipped).toBe('no_target_user');
    expect(decision.ack_state.status).toBe('open');
    expect(muteStore.countForUser('BIL', '')).toBe(0);
  });

  it('skips when M8.4 already auto-acked the alert', () => {
    const { ackStore, muteStore, prefStore } = buildStores();
    setNightOwlQuietHours(prefStore);
    const decision = evaluateQuietHoursMute({
      prefStore,
      ackStore,
      muteStore,
      tenant_id: 'BIL',
      alert_id: 'a1',
      bil_class: 'yellow',
      target_username: 'jane.analyst',
      already_auto_acked: true,
      now: QUIET_NOW,
    });
    expect(decision.applied).toBe(false);
    expect(decision.skipped).toBe('already_acknowledged');
  });

  it('skips when severity is RED (operator pages on critical)', () => {
    const { ackStore, muteStore, prefStore } = buildStores();
    setNightOwlQuietHours(prefStore);
    const decision = evaluateQuietHoursMute({
      prefStore,
      ackStore,
      muteStore,
      tenant_id: 'BIL',
      alert_id: 'a1',
      bil_class: 'red',
      target_username: 'jane.analyst',
      already_auto_acked: false,
      now: QUIET_NOW,
    });
    expect(decision.applied).toBe(false);
    expect(decision.skipped).toBe('critical_severity');
    expect(decision.ack_state.status).toBe('open');
  });

  it('skips when user has no quiet hours configured', () => {
    const { ackStore, muteStore, prefStore } = buildStores();
    const decision = evaluateQuietHoursMute({
      prefStore,
      ackStore,
      muteStore,
      tenant_id: 'BIL',
      alert_id: 'a1',
      bil_class: 'orange',
      target_username: 'jane.analyst',
      already_auto_acked: false,
      now: QUIET_NOW,
    });
    expect(decision.applied).toBe(false);
    expect(decision.skipped).toBe('no_quiet_hours');
  });

  it('skips when user is OUTSIDE their quiet-hours window', () => {
    const { ackStore, muteStore, prefStore } = buildStores();
    setNightOwlQuietHours(prefStore);
    const decision = evaluateQuietHoursMute({
      prefStore,
      ackStore,
      muteStore,
      tenant_id: 'BIL',
      alert_id: 'a1',
      bil_class: 'yellow',
      target_username: 'jane.analyst',
      already_auto_acked: false,
      now: ACTIVE_NOW,
    });
    expect(decision.applied).toBe(false);
    expect(decision.skipped).toBe('outside_quiet_hours');
  });

  it('APPLIES when user is in quiet hours and severity is non-critical', () => {
    const { ackStore, muteStore, prefStore } = buildStores();
    setNightOwlQuietHours(prefStore);
    const decision = evaluateQuietHoursMute({
      prefStore,
      ackStore,
      muteStore,
      tenant_id: 'BIL',
      alert_id: 'a1',
      bil_class: 'yellow',
      target_username: 'jane.analyst',
      already_auto_acked: false,
      now: QUIET_NOW,
    });
    expect(decision.applied).toBe(true);
    expect(decision.skipped).toBeNull();
    expect(decision.ack_state.status).toBe('acknowledged');
    expect(decision.ack_state.acked_by).toBe(QUIET_HOURS_MUTE_ACTOR);
    expect(decision.reason).toMatch(/quiet hours 22-7 UTC/);
    // Audit trail recorded
    expect(muteStore.countForUser('BIL', 'jane.analyst')).toBe(1);
    const events = muteStore.listForUser('BIL', 'jane.analyst');
    expect(events[0]!.alert_id).toBe('a1');
    expect(events[0]!.bil_class).toBe('yellow');
  });

  it('handles each severity correctly: RED bypasses, ORANGE+YELLOW+GREEN apply', () => {
    const { ackStore, muteStore, prefStore } = buildStores();
    setNightOwlQuietHours(prefStore);
    for (const cls of ['orange', 'yellow', 'green'] as const) {
      const d = evaluateQuietHoursMute({
        prefStore,
        ackStore,
        muteStore,
        tenant_id: 'BIL',
        alert_id: `a-${cls}`,
        bil_class: cls,
        target_username: 'jane.analyst',
        already_auto_acked: false,
        now: QUIET_NOW,
      });
      expect(d.applied).toBe(true);
      expect(d.ack_state.acked_by).toBe(QUIET_HOURS_MUTE_ACTOR);
    }
    const dRed = evaluateQuietHoursMute({
      prefStore,
      ackStore,
      muteStore,
      tenant_id: 'BIL',
      alert_id: 'a-red',
      bil_class: 'red',
      target_username: 'jane.analyst',
      already_auto_acked: false,
      now: QUIET_NOW,
    });
    expect(dRed.applied).toBe(false);
    expect(dRed.skipped).toBe('critical_severity');
    expect(muteStore.countForUser('BIL', 'jane.analyst')).toBe(3);
  });

  it('handles wrap-around quiet hours (22-7 spans midnight)', () => {
    const { ackStore, muteStore, prefStore } = buildStores();
    setNightOwlQuietHours(prefStore, 'jane.analyst', 22, 7);
    // Hour 02 should be inside the wrap window 22→7
    const d = evaluateQuietHoursMute({
      prefStore,
      ackStore,
      muteStore,
      tenant_id: 'BIL',
      alert_id: 'wrap',
      bil_class: 'yellow',
      target_username: 'jane.analyst',
      already_auto_acked: false,
      now: new Date('2026-05-07T02:30:00.000Z'),
    });
    expect(d.applied).toBe(true);
  });

  it('returns already_acknowledged when ackStore raises the same code', () => {
    const { ackStore, muteStore, prefStore } = buildStores();
    setNightOwlQuietHours(prefStore);
    // pre-ack the alert by a real user
    ackStore.acknowledge('BIL', 'a1', 'someone.else', 'manual', QUIET_NOW);
    const d = evaluateQuietHoursMute({
      prefStore,
      ackStore,
      muteStore,
      tenant_id: 'BIL',
      alert_id: 'a1',
      bil_class: 'yellow',
      target_username: 'jane.analyst',
      already_auto_acked: false,
      now: QUIET_NOW,
    });
    expect(d.applied).toBe(false);
    expect(d.skipped).toBe('already_acknowledged');
    // ack_state still belongs to the human acker
    expect(d.ack_state.acked_by).toBe('someone.else');
    // No audit row recorded for jane
    expect(muteStore.countForUser('BIL', 'jane.analyst')).toBe(0);
  });
});

// ── Event store ─────────────────────────────────────────────────────

describe('InMemoryQuietHoursMuteEventStore (M10.8 audit store)', () => {
  it('records, lists newest-first, and filters by since', () => {
    const s = new InMemoryQuietHoursMuteEventStore();
    s.record({
      tenant_id: 'BIL', username: 'jane', alert_id: 'a1', bil_class: 'yellow',
      muted_at: '2026-05-06T22:30:00.000Z', reason: 'qh',
    });
    s.record({
      tenant_id: 'BIL', username: 'jane', alert_id: 'a2', bil_class: 'orange',
      muted_at: '2026-05-06T23:30:00.000Z', reason: 'qh',
    });
    s.record({
      tenant_id: 'BIL', username: 'jane', alert_id: 'a3', bil_class: 'green',
      muted_at: '2026-05-07T01:30:00.000Z', reason: 'qh',
    });
    const all = s.listForUser('BIL', 'jane');
    expect(all.map((e) => e.alert_id)).toEqual(['a3', 'a2', 'a1']);
    expect(s.countForUser('BIL', 'jane')).toBe(3);

    const filtered = s.listForUser('BIL', 'jane', new Date('2026-05-06T23:00:00.000Z'));
    expect(filtered.map((e) => e.alert_id)).toEqual(['a3', 'a2']);

    const limited = s.listForUser('BIL', 'jane', undefined, 2);
    expect(limited.map((e) => e.alert_id)).toEqual(['a3', 'a2']);
  });

  it('FIFO-caps at 200/user', () => {
    const s = new InMemoryQuietHoursMuteEventStore();
    for (let i = 0; i < QUIET_HOURS_MUTE_EVENT_CAP + 25; i++) {
      s.record({
        tenant_id: 'BIL', username: 'jane', alert_id: `a-${i}`, bil_class: 'yellow',
        muted_at: `2026-05-06T${String(i % 24).padStart(2, '0')}:00:00.000Z`,
        reason: 'qh',
      });
    }
    expect(s.countForUser('BIL', 'jane')).toBe(QUIET_HOURS_MUTE_EVENT_CAP);
    // oldest 25 evicted, so a-0..a-24 are gone
    const all = s.listForUser('BIL', 'jane');
    expect(all.find((e) => e.alert_id === 'a-0')).toBeUndefined();
    expect(all.find((e) => e.alert_id === 'a-24')).toBeUndefined();
    expect(all.find((e) => e.alert_id === 'a-25')).toBeDefined();
  });

  it('clearForUser wipes only that user', () => {
    const s = new InMemoryQuietHoursMuteEventStore();
    s.record({ tenant_id: 'BIL', username: 'jane', alert_id: 'a1', bil_class: 'yellow', muted_at: '2026-05-06T22:30:00.000Z', reason: 'qh' });
    s.record({ tenant_id: 'BIL', username: 'bob', alert_id: 'a2', bil_class: 'yellow', muted_at: '2026-05-06T22:30:00.000Z', reason: 'qh' });
    expect(s.clearForUser('BIL', 'jane')).toBe(1);
    expect(s.countForUser('BIL', 'jane')).toBe(0);
    expect(s.countForUser('BIL', 'bob')).toBe(1);
  });

  it('isolates tenants', () => {
    const s = new InMemoryQuietHoursMuteEventStore();
    s.record({ tenant_id: 'BIL', username: 'jane', alert_id: 'a1', bil_class: 'yellow', muted_at: '2026-05-06T22:30:00.000Z', reason: 'qh' });
    s.record({ tenant_id: 'ACME', username: 'jane', alert_id: 'a2', bil_class: 'yellow', muted_at: '2026-05-06T22:30:00.000Z', reason: 'qh' });
    expect(s.countForUser('BIL', 'jane')).toBe(1);
    expect(s.countForUser('ACME', 'jane')).toBe(1);
  });
});

// ── HTTP routes ─────────────────────────────────────────────────────

function makeM108App(role = 'admin', nowFn: () => Date = () => QUIET_NOW) {
  const ackStore = new InMemoryAlertAckStore();
  const muteStore = new InMemoryQuietHoursMuteEventStore();
  const prefStore = new InMemoryNotificationPreferenceStore();
  const autoAckRuleStore = new InMemoryAutoAckRuleStore();
  const built = makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    alertAckStore: ackStore,
    autoAckRuleStore,
    notificationPreferenceStore: prefStore,
    quietHoursMuteEventStore: muteStore,
    now: nowFn,
    getRole: () => role,
  });
  return { ...built, ackStore, muteStore, prefStore, autoAckRuleStore };
}

describe('POST /v1/alerts/ingest — M10.8 quiet-hours mute integration', () => {
  it('extends the M8.5 response with quiet_hours_mute decision', async () => {
    const { app } = makeM108App();
    const r = await request(app)
      .post('/v1/alerts/ingest')
      .set(HEADERS_BIL)
      .send({ alert_id: 'no-target', bil_class: 'yellow' });
    expect(r.status).toBe(200);
    expect(r.body.body.quiet_hours_mute.applied).toBe(false);
    expect(r.body.body.quiet_hours_mute.skipped).toBe('no_target_user');
    expect(r.body.body.auto_acked).toBe(false);
  });

  it('applies the mute when target user is in quiet hours, non-critical', async () => {
    const { app, prefStore, muteStore, ackStore } = makeM108App();
    prefStore.setQuietHours('BIL', 'jane.analyst', { start_hour: 22, end_hour: 7 }, QUIET_NOW);
    const r = await request(app)
      .post('/v1/alerts/ingest')
      .set(HEADERS_BIL)
      .send({
        alert_id: 'qh-1',
        bil_class: 'yellow',
        target_username: 'jane.analyst',
      });
    expect(r.status).toBe(200);
    expect(r.body.body.quiet_hours_mute.applied).toBe(true);
    expect(r.body.body.quiet_hours_mute.target_username).toBe('jane.analyst');
    expect(r.body.body.ack_state.status).toBe('acknowledged');
    expect(r.body.body.ack_state.acked_by).toBe(QUIET_HOURS_MUTE_ACTOR);
    expect(muteStore.countForUser('BIL', 'jane.analyst')).toBe(1);
    // Live ack store reflects the change
    expect(ackStore.get('BIL', 'qh-1').status).toBe('acknowledged');
  });

  it('does NOT mute RED severity even during quiet hours', async () => {
    const { app, prefStore, muteStore } = makeM108App();
    prefStore.setQuietHours('BIL', 'jane.analyst', { start_hour: 22, end_hour: 7 }, QUIET_NOW);
    const r = await request(app)
      .post('/v1/alerts/ingest')
      .set(HEADERS_BIL)
      .send({
        alert_id: 'qh-red',
        bil_class: 'red',
        target_username: 'jane.analyst',
      });
    expect(r.status).toBe(200);
    expect(r.body.body.quiet_hours_mute.applied).toBe(false);
    expect(r.body.body.quiet_hours_mute.skipped).toBe('critical_severity');
    expect(r.body.body.ack_state.status).toBe('open');
    expect(muteStore.countForUser('BIL', 'jane.analyst')).toBe(0);
  });

  it('skips when M8.4 rule already auto-acked', async () => {
    const { app, prefStore, autoAckRuleStore, muteStore } = makeM108App();
    prefStore.setQuietHours('BIL', 'jane.analyst', { start_hour: 22, end_hour: 7 }, QUIET_NOW);
    autoAckRuleStore.create(
      'BIL',
      { name: 'auto-ack yellows', bil_class: 'yellow', reason: 'noise floor' },
      'admin',
      QUIET_NOW,
    );
    const r = await request(app)
      .post('/v1/alerts/ingest')
      .set(HEADERS_BIL)
      .send({
        alert_id: 'both-paths',
        bil_class: 'yellow',
        target_username: 'jane.analyst',
      });
    expect(r.status).toBe(200);
    expect(r.body.body.auto_acked).toBe(true);
    expect(r.body.body.quiet_hours_mute.applied).toBe(false);
    expect(r.body.body.quiet_hours_mute.skipped).toBe('already_acknowledged');
    // No audit row for the quiet-hours path — M8.4 owned the ack
    expect(muteStore.countForUser('BIL', 'jane.analyst')).toBe(0);
  });

  it('skips when target user is outside their window', async () => {
    const { app, prefStore } = makeM108App('admin', () => ACTIVE_NOW);
    prefStore.setQuietHours('BIL', 'jane.analyst', { start_hour: 22, end_hour: 7 }, ACTIVE_NOW);
    const r = await request(app)
      .post('/v1/alerts/ingest')
      .set(HEADERS_BIL)
      .send({
        alert_id: 'daytime',
        bil_class: 'yellow',
        target_username: 'jane.analyst',
      });
    expect(r.status).toBe(200);
    expect(r.body.body.quiet_hours_mute.applied).toBe(false);
    expect(r.body.body.quiet_hours_mute.skipped).toBe('outside_quiet_hours');
  });
});

describe('GET /v1/alerts/quiet-hours-muted/me — M10.8 audit list', () => {
  it('lists the caller\'s muted alerts newest-first', async () => {
    const { app, prefStore } = makeM108App();
    prefStore.setQuietHours('BIL', 'jane.analyst', { start_hour: 22, end_hour: 7 }, QUIET_NOW);
    for (const id of ['a1', 'a2', 'a3']) {
      await request(app)
        .post('/v1/alerts/ingest')
        .set(HEADERS_BIL)
        .send({ alert_id: id, bil_class: 'yellow', target_username: 'jane.analyst' });
    }
    const r = await request(app)
      .get('/v1/alerts/quiet-hours-muted/me')
      .set(HEADERS_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total).toBe(3);
    expect(r.body.body.returned).toBe(3);
    expect(r.body.body.items.map((e: { alert_id: string }) => e.alert_id)).toEqual(['a3', 'a2', 'a1']);
  });

  it('respects since= and limit= query params', async () => {
    const { app, prefStore, muteStore } = makeM108App();
    prefStore.setQuietHours('BIL', 'jane.analyst', { start_hour: 22, end_hour: 7 }, QUIET_NOW);
    // seed events directly
    muteStore.record({ tenant_id: 'BIL', username: 'jane.analyst', alert_id: 'old', bil_class: 'yellow', muted_at: '2026-05-01T22:00:00.000Z', reason: 'qh' });
    muteStore.record({ tenant_id: 'BIL', username: 'jane.analyst', alert_id: 'mid', bil_class: 'yellow', muted_at: '2026-05-05T22:00:00.000Z', reason: 'qh' });
    muteStore.record({ tenant_id: 'BIL', username: 'jane.analyst', alert_id: 'new', bil_class: 'yellow', muted_at: '2026-05-06T22:00:00.000Z', reason: 'qh' });
    const r = await request(app)
      .get('/v1/alerts/quiet-hours-muted/me?since=2026-05-04T00:00:00.000Z&limit=1')
      .set(HEADERS_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.items.map((e: { alert_id: string }) => e.alert_id)).toEqual(['new']);
    expect(r.body.body.total).toBe(3);
    expect(r.body.body.returned).toBe(1);
  });

  it('400 on missing X-APEX-USER header', async () => {
    const { app } = makeM108App();
    const r = await request(app)
      .get('/v1/alerts/quiet-hours-muted/me')
      .set({ 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_missing_user');
  });

  it('400 on invalid since= timestamp', async () => {
    const { app } = makeM108App();
    const r = await request(app)
      .get('/v1/alerts/quiet-hours-muted/me?since=not-a-date')
      .set(HEADERS_BIL);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_since');
  });

  it('400 on out-of-range limit=', async () => {
    const { app } = makeM108App();
    const r = await request(app)
      .get('/v1/alerts/quiet-hours-muted/me?limit=999')
      .set(HEADERS_BIL);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_limit');
  });

  it('isolates users — bob cannot see jane\'s muted alerts', async () => {
    const { app, prefStore } = makeM108App();
    prefStore.setQuietHours('BIL', 'jane.analyst', { start_hour: 22, end_hour: 7 }, QUIET_NOW);
    await request(app)
      .post('/v1/alerts/ingest')
      .set(HEADERS_BIL)
      .send({ alert_id: 'a1', bil_class: 'yellow', target_username: 'jane.analyst' });
    const r = await request(app)
      .get('/v1/alerts/quiet-hours-muted/me')
      .set({ ...HEADERS_BIL, 'X-APEX-USER': 'bob.other' });
    expect(r.status).toBe(200);
    expect(r.body.body.items).toEqual([]);
    expect(r.body.body.total).toBe(0);
  });
});

describe('DELETE /v1/alerts/quiet-hours-muted/me — M10.8 clear audit', () => {
  it('clears the caller\'s history and returns the count', async () => {
    const { app, prefStore } = makeM108App();
    prefStore.setQuietHours('BIL', 'jane.analyst', { start_hour: 22, end_hour: 7 }, QUIET_NOW);
    for (const id of ['a1', 'a2']) {
      await request(app)
        .post('/v1/alerts/ingest')
        .set(HEADERS_BIL)
        .send({ alert_id: id, bil_class: 'yellow', target_username: 'jane.analyst' });
    }
    const r = await request(app)
      .delete('/v1/alerts/quiet-hours-muted/me')
      .set(HEADERS_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.cleared).toBe(2);
    const r2 = await request(app)
      .get('/v1/alerts/quiet-hours-muted/me')
      .set(HEADERS_BIL);
    expect(r2.body.body.total).toBe(0);
  });

  it('400 on missing X-APEX-USER', async () => {
    const { app } = makeM108App();
    const r = await request(app)
      .delete('/v1/alerts/quiet-hours-muted/me')
      .set({ 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' });
    expect(r.status).toBe(400);
  });
});
