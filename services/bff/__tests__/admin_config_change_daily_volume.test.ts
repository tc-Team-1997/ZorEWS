// services/bff/__tests__/admin_config_change_daily_volume.test.ts
//
// T6 M13.18 — pure resolver + HTTP route tests for config change
// daily volume timeline.

import {
  summarizeConfigChangeDailyVolume,
  ConfigChangeDailyVolumeError,
  ALL_CONFIG_CHANGE_ACTIONS,
  DEFAULT_CONFIG_CHANGE_DAYS,
  MIN_CONFIG_CHANGE_DAYS,
  MAX_CONFIG_CHANGE_DAYS,
} from '../src/admin_config_change_daily_volume';
import { DEFAULTS, listCategories } from '../src/admin_config';
import type { AuditEvent } from '../src/audit_trail';

const NOW = new Date('2026-05-22T12:00:00.000Z');

// Pick known keys from each category so tests work regardless of DEFAULTS shape
const ALERTS_KEY = DEFAULTS.find((d) => d.category === 'alerts')!.key;
const NOTIFY_KEY = DEFAULTS.find((d) => d.category === 'notifications')!.key;
const FEATURES_KEY = DEFAULTS.find((d) => d.category === 'features')!.key;

function mkConfigEvent(opts: {
  ts: string;
  tenant_id?: string;
  action?: 'config.update' | 'config.reset';
  resource_id?: string;
  actor_username?: string;
}): AuditEvent {
  return {
    event_id: `e-${Math.random().toString(36).slice(2, 10)}`,
    ts: opts.ts,
    tenant_id: opts.tenant_id ?? 'BANK_DEMO',
    actor_username: opts.actor_username ?? 'alice.admin',
    actor_role: 'admin',
    action: opts.action ?? 'config.update',
    resource_type: 'config',
    resource_id: opts.resource_id ?? ALERTS_KEY,
    outcome: 'success',
    severity: 'info',
    metadata: {},
    correlation_id: null,
    ip_address: null,
    hash: 'fake',
    prev_hash: 'fake',
  };
}

describe('summarizeConfigChangeDailyVolume — pure resolver', () => {
  test('empty event list → 30 zero buckets + null leaderboards', () => {
    const r = summarizeConfigChangeDailyVolume('BANK_DEMO', [], 30, NOW);
    expect(r.tenant_id).toBe('BANK_DEMO');
    expect(r.generated_at).toBe('2026-05-22T12:00:00.000Z');
    expect(r.days).toBe(30);
    expect(r.by_day).toHaveLength(30);
    expect(r.total_changes_in_window).toBe(0);
    expect(r.total_events_observed).toBe(0);
    expect(r.total_updates_in_window).toBe(0);
    expect(r.total_resets_in_window).toBe(0);
    expect(r.total_unknown_key_events).toBe(0);
    expect(r.peak_day).toBeNull();
    expect(r.peak_count).toBe(0);
    expect(r.mean_per_day).toBe(0);
    expect(r.growth_rate).toBeNull();
    expect(r.busiest_category).toBeNull();
    // Every bucket has every key
    for (const b of r.by_day) {
      expect(b.total).toBe(0);
      expect(b.by_action['config.update']).toBe(0);
      expect(b.by_action['config.reset']).toBe(0);
      for (const cat of listCategories()) {
        expect(b.by_category[cat]).toBe(0);
      }
      expect(b.distinct_actors).toBe(0);
      expect(b.distinct_keys).toBe(0);
    }
  });

  test('window mechanics: default 30 days spans Apr 23 → May 22', () => {
    const r = summarizeConfigChangeDailyVolume('BANK_DEMO', [], 30, NOW);
    expect(r.window_start).toBe('2026-04-23');
    expect(r.window_end).toBe('2026-05-22');
    expect(r.by_day[0].date).toBe('2026-04-23');
    expect(r.by_day[29].date).toBe('2026-05-22');
  });

  test('window mechanics: days=1 → exactly today UTC', () => {
    const r = summarizeConfigChangeDailyVolume('BANK_DEMO', [], 1, NOW);
    expect(r.by_day).toHaveLength(1);
    expect(r.by_day[0].date).toBe('2026-05-22');
    expect(r.window_start).toBe('2026-05-22');
    expect(r.window_end).toBe('2026-05-22');
  });

  test('window mechanics: days=7 → 7 buckets, oldest-first', () => {
    const r = summarizeConfigChangeDailyVolume('BANK_DEMO', [], 7, NOW);
    expect(r.by_day).toHaveLength(7);
    expect(r.by_day[0].date).toBe('2026-05-16');
    expect(r.by_day[6].date).toBe('2026-05-22');
  });

  test('single config.update placed at correct UTC bucket', () => {
    const events = [
      mkConfigEvent({ ts: '2026-05-15T08:30:00.000Z', resource_id: ALERTS_KEY }),
    ];
    const r = summarizeConfigChangeDailyVolume('BANK_DEMO', events, 30, NOW);
    expect(r.total_changes_in_window).toBe(1);
    expect(r.total_updates_in_window).toBe(1);
    const day = r.by_day.find((b) => b.date === '2026-05-15')!;
    expect(day.total).toBe(1);
    expect(day.by_action['config.update']).toBe(1);
    expect(day.by_action['config.reset']).toBe(0);
    expect(day.by_category.alerts).toBe(1);
  });

  test('config.reset bucketed under by_action.config.reset', () => {
    const events = [
      mkConfigEvent({
        ts: '2026-05-20T08:30:00.000Z',
        action: 'config.reset',
        resource_id: FEATURES_KEY,
      }),
    ];
    const r = summarizeConfigChangeDailyVolume('BANK_DEMO', events, 30, NOW);
    expect(r.total_resets_in_window).toBe(1);
    expect(r.total_updates_in_window).toBe(0);
    const day = r.by_day.find((b) => b.date === '2026-05-20')!;
    expect(day.by_action['config.reset']).toBe(1);
    expect(day.by_category.features).toBe(1);
  });

  test('events outside window excluded from in_window but counted in observed', () => {
    const events = [
      // Inside: today
      mkConfigEvent({ ts: '2026-05-22T08:00:00.000Z' }),
      // Outside: 60 days ago
      mkConfigEvent({ ts: '2026-03-22T08:00:00.000Z' }),
    ];
    const r = summarizeConfigChangeDailyVolume('BANK_DEMO', events, 30, NOW);
    expect(r.total_changes_in_window).toBe(1);
    expect(r.total_events_observed).toBe(2);
  });

  test('Σ by_action per day = day.total', () => {
    const events = [
      mkConfigEvent({ ts: '2026-05-20T08:00:00.000Z', action: 'config.update' }),
      mkConfigEvent({ ts: '2026-05-20T09:00:00.000Z', action: 'config.update' }),
      mkConfigEvent({ ts: '2026-05-20T10:00:00.000Z', action: 'config.reset' }),
    ];
    const r = summarizeConfigChangeDailyVolume('BANK_DEMO', events, 30, NOW);
    const day = r.by_day.find((b) => b.date === '2026-05-20')!;
    const sum = Object.values(day.by_action).reduce((a, b) => a + b, 0);
    expect(sum).toBe(day.total);
    expect(day.total).toBe(3);
  });

  test('Σ by_day.total = total_changes_in_window', () => {
    const events = [
      mkConfigEvent({ ts: '2026-05-10T08:00:00.000Z' }),
      mkConfigEvent({ ts: '2026-05-15T08:00:00.000Z' }),
      mkConfigEvent({ ts: '2026-05-20T08:00:00.000Z' }),
    ];
    const r = summarizeConfigChangeDailyVolume('BANK_DEMO', events, 30, NOW);
    const sum = r.by_day.reduce((a, b) => a + b.total, 0);
    expect(sum).toBe(r.total_changes_in_window);
    expect(sum).toBe(3);
  });

  test('updates + resets partition = total_changes_in_window', () => {
    const events = [
      mkConfigEvent({ ts: '2026-05-15T08:00:00.000Z', action: 'config.update' }),
      mkConfigEvent({ ts: '2026-05-15T09:00:00.000Z', action: 'config.reset' }),
      mkConfigEvent({ ts: '2026-05-18T08:00:00.000Z', action: 'config.update' }),
    ];
    const r = summarizeConfigChangeDailyVolume('BANK_DEMO', events, 30, NOW);
    expect(r.total_updates_in_window + r.total_resets_in_window).toBe(
      r.total_changes_in_window,
    );
    expect(r.total_updates_in_window).toBe(2);
    expect(r.total_resets_in_window).toBe(1);
  });

  test('peak_day formula + earliest-day-wins tie-break', () => {
    // May 10 + May 15 both have 1 event → May 10 wins (earlier)
    const events = [
      mkConfigEvent({ ts: '2026-05-10T08:00:00.000Z' }),
      mkConfigEvent({ ts: '2026-05-15T08:00:00.000Z' }),
    ];
    const r = summarizeConfigChangeDailyVolume('BANK_DEMO', events, 30, NOW);
    expect(r.peak_day).toBe('2026-05-10');
    expect(r.peak_count).toBe(1);
  });

  test('peak_day highest count wins over earlier-tied', () => {
    const events = [
      mkConfigEvent({ ts: '2026-05-10T08:00:00.000Z' }),
      mkConfigEvent({ ts: '2026-05-15T08:00:00.000Z' }),
      mkConfigEvent({ ts: '2026-05-15T09:00:00.000Z' }),
      mkConfigEvent({ ts: '2026-05-15T10:00:00.000Z' }),
    ];
    const r = summarizeConfigChangeDailyVolume('BANK_DEMO', events, 30, NOW);
    expect(r.peak_day).toBe('2026-05-15');
    expect(r.peak_count).toBe(3);
  });

  test('mean_per_day = Math.round(total/days)', () => {
    // 30 events across 30-day window → mean=1
    const events = Array.from({ length: 30 }, (_, i) =>
      mkConfigEvent({
        ts: new Date(NOW.getTime() - i * 86_400_000).toISOString(),
      }),
    );
    expect(
      summarizeConfigChangeDailyVolume('BANK_DEMO', events, 30, NOW).mean_per_day,
    ).toBe(1);
    // 15 events → 0.5 → 1 (JS Math.round)
    const half = events.slice(0, 15);
    expect(
      summarizeConfigChangeDailyVolume('BANK_DEMO', half, 30, NOW).mean_per_day,
    ).toBe(1);
    // 14 events → 0.466 → 0
    const less = events.slice(0, 14);
    expect(
      summarizeConfigChangeDailyVolume('BANK_DEMO', less, 30, NOW).mean_per_day,
    ).toBe(0);
  });

  test('growth_rate positive when second-half outweighs first-half', () => {
    // 1 event in early days + 5 events in late days
    const events = [
      mkConfigEvent({ ts: '2026-04-25T08:00:00.000Z' }),
      mkConfigEvent({ ts: '2026-05-18T08:00:00.000Z' }),
      mkConfigEvent({ ts: '2026-05-19T08:00:00.000Z' }),
      mkConfigEvent({ ts: '2026-05-20T08:00:00.000Z' }),
      mkConfigEvent({ ts: '2026-05-21T08:00:00.000Z' }),
      mkConfigEvent({ ts: '2026-05-22T08:00:00.000Z' }),
    ];
    const r = summarizeConfigChangeDailyVolume('BANK_DEMO', events, 30, NOW);
    expect(r.growth_rate).not.toBeNull();
    expect(r.growth_rate!).toBeGreaterThan(0);
  });

  test('growth_rate null when first-half is empty', () => {
    const events = [
      mkConfigEvent({ ts: '2026-05-22T08:00:00.000Z' }),
    ];
    const r = summarizeConfigChangeDailyVolume('BANK_DEMO', events, 30, NOW);
    expect(r.growth_rate).toBeNull();
  });

  test('growth_rate null when days < 2', () => {
    const r = summarizeConfigChangeDailyVolume('BANK_DEMO', [], 1, NOW);
    expect(r.growth_rate).toBeNull();
  });

  test('busiest_category formula', () => {
    const events = [
      mkConfigEvent({ ts: '2026-05-10T08:00:00.000Z', resource_id: ALERTS_KEY }),
      mkConfigEvent({ ts: '2026-05-11T08:00:00.000Z', resource_id: ALERTS_KEY }),
      mkConfigEvent({ ts: '2026-05-12T08:00:00.000Z', resource_id: NOTIFY_KEY }),
    ];
    const r = summarizeConfigChangeDailyVolume('BANK_DEMO', events, 30, NOW);
    expect(r.busiest_category).toBe('alerts');
  });

  test('busiest_category canonical tie-break (alerts wins over notifications at tied)', () => {
    const events = [
      mkConfigEvent({ ts: '2026-05-10T08:00:00.000Z', resource_id: ALERTS_KEY }),
      mkConfigEvent({ ts: '2026-05-11T08:00:00.000Z', resource_id: NOTIFY_KEY }),
    ];
    const r = summarizeConfigChangeDailyVolume('BANK_DEMO', events, 30, NOW);
    // Both at 1 → alerts (first in listCategories) wins
    expect(r.busiest_category).toBe('alerts');
  });

  test('busiest_category null when window empty', () => {
    const r = summarizeConfigChangeDailyVolume('BANK_DEMO', [], 30, NOW);
    expect(r.busiest_category).toBeNull();
  });

  test('cross-tenant events filtered out', () => {
    const events = [
      mkConfigEvent({ ts: '2026-05-15T08:00:00.000Z', tenant_id: 'BANK_DEMO' }),
      mkConfigEvent({ ts: '2026-05-16T08:00:00.000Z', tenant_id: 'BIL' }),
      mkConfigEvent({ ts: '2026-05-17T08:00:00.000Z', tenant_id: 'BIL' }),
    ];
    const r = summarizeConfigChangeDailyVolume('BANK_DEMO', events, 30, NOW);
    expect(r.total_changes_in_window).toBe(1);
    expect(r.total_events_observed).toBe(1);
  });

  test('non-config events filtered out by resource_type', () => {
    const events = [
      mkConfigEvent({ ts: '2026-05-15T08:00:00.000Z' }),
      // Synthesise a non-config event manually
      {
        ...mkConfigEvent({ ts: '2026-05-16T08:00:00.000Z' }),
        resource_type: 'alert',
      } as AuditEvent,
    ];
    const r = summarizeConfigChangeDailyVolume('BANK_DEMO', events, 30, NOW);
    expect(r.total_changes_in_window).toBe(1);
  });

  test('non-config actions filtered out (only update + reset counted)', () => {
    const events = [
      mkConfigEvent({ ts: '2026-05-15T08:00:00.000Z' }),
      {
        ...mkConfigEvent({ ts: '2026-05-16T08:00:00.000Z' }),
        action: 'config.create', // not one of the 2 canonical
      } as AuditEvent,
    ];
    const r = summarizeConfigChangeDailyVolume('BANK_DEMO', events, 30, NOW);
    expect(r.total_changes_in_window).toBe(1);
  });

  test('unknown config key (not in DEFAULTS) counted in total but not by_category', () => {
    const events = [
      mkConfigEvent({ ts: '2026-05-15T08:00:00.000Z', resource_id: 'no.such.key' }),
      mkConfigEvent({ ts: '2026-05-16T08:00:00.000Z', resource_id: ALERTS_KEY }),
    ];
    const r = summarizeConfigChangeDailyVolume('BANK_DEMO', events, 30, NOW);
    expect(r.total_changes_in_window).toBe(2);
    expect(r.total_unknown_key_events).toBe(1);
    // by_category should only reflect the alerts key
    const alertsDay = r.by_day.find((b) => b.date === '2026-05-16')!;
    expect(alertsDay.by_category.alerts).toBe(1);
    const unknownDay = r.by_day.find((b) => b.date === '2026-05-15')!;
    // Unknown key's day: total=1 but by_category sum=0
    expect(unknownDay.total).toBe(1);
    const sum = Object.values(unknownDay.by_category).reduce(
      (a, b) => a + b,
      0,
    );
    expect(sum).toBe(0);
  });

  test('distinct_actors per-day Set dedup', () => {
    const events = [
      mkConfigEvent({
        ts: '2026-05-15T08:00:00.000Z',
        actor_username: 'alice.admin',
      }),
      mkConfigEvent({
        ts: '2026-05-15T09:00:00.000Z',
        actor_username: 'alice.admin',
      }),
      mkConfigEvent({
        ts: '2026-05-15T10:00:00.000Z',
        actor_username: 'bob.maker',
      }),
    ];
    const r = summarizeConfigChangeDailyVolume('BANK_DEMO', events, 30, NOW);
    const day = r.by_day.find((b) => b.date === '2026-05-15')!;
    expect(day.total).toBe(3);
    expect(day.distinct_actors).toBe(2);
  });

  test('distinct_keys per-day Set dedup', () => {
    const events = [
      mkConfigEvent({ ts: '2026-05-15T08:00:00.000Z', resource_id: ALERTS_KEY }),
      mkConfigEvent({ ts: '2026-05-15T09:00:00.000Z', resource_id: ALERTS_KEY }),
      mkConfigEvent({ ts: '2026-05-15T10:00:00.000Z', resource_id: NOTIFY_KEY }),
    ];
    const r = summarizeConfigChangeDailyVolume('BANK_DEMO', events, 30, NOW);
    const day = r.by_day.find((b) => b.date === '2026-05-15')!;
    expect(day.distinct_keys).toBe(2);
  });

  test('malformed ts silently skipped', () => {
    const events = [
      mkConfigEvent({ ts: '2026-05-15T08:00:00.000Z' }),
      { ...mkConfigEvent({ ts: 'not-a-date' }) } as AuditEvent,
    ];
    const r = summarizeConfigChangeDailyVolume('BANK_DEMO', events, 30, NOW);
    expect(r.total_changes_in_window).toBe(1);
    // observed counts the bad-ts event since it passed the type filter
    expect(r.total_events_observed).toBe(2);
  });

  test('rejects empty tenant_id', () => {
    expect(() =>
      summarizeConfigChangeDailyVolume('', [], 30, NOW),
    ).toThrow(ConfigChangeDailyVolumeError);
  });

  test('rejects days < MIN', () => {
    expect(() =>
      summarizeConfigChangeDailyVolume('BANK_DEMO', [], 0, NOW),
    ).toThrow(ConfigChangeDailyVolumeError);
  });

  test('rejects days > MAX', () => {
    expect(() =>
      summarizeConfigChangeDailyVolume(
        'BANK_DEMO',
        [],
        MAX_CONFIG_CHANGE_DAYS + 1,
        NOW,
      ),
    ).toThrow(ConfigChangeDailyVolumeError);
  });

  test('rejects non-integer days', () => {
    expect(() =>
      summarizeConfigChangeDailyVolume('BANK_DEMO', [], 7.5, NOW),
    ).toThrow(ConfigChangeDailyVolumeError);
  });

  test('exports DEFAULT_CONFIG_CHANGE_DAYS=30 + MAX=365 + ALL_CONFIG_CHANGE_ACTIONS', () => {
    expect(DEFAULT_CONFIG_CHANGE_DAYS).toBe(30);
    expect(MIN_CONFIG_CHANGE_DAYS).toBe(1);
    expect(MAX_CONFIG_CHANGE_DAYS).toBe(365);
    expect(ALL_CONFIG_CHANGE_ACTIONS).toEqual(['config.update', 'config.reset']);
  });
});

// ---------------------------------------------------------------------
// HTTP route tests
// ---------------------------------------------------------------------

import request from 'supertest';
import { makeApp } from '../src/server';
import { InMemoryAuditTrailStore } from '../src/audit_trail';

const HEADERS_ADMIN = {
  'X-Tenant-ID': 'BANK_DEMO',
  'X-Channel': 'API',
  'X-APEX-USER': 'alice.admin',
  'X-Apex-Role': 'admin',
};

describe('GET /v1/admin/config/change-daily-volume', () => {
  test('admin happy path empty store', async () => {
    const auditTrailStore = new InMemoryAuditTrailStore();
    const { app } = makeApp({ auditTrailStore });
    const r = await request(app)
      .get('/v1/admin/config/change-daily-volume')
      .set(HEADERS_ADMIN);
    expect(r.status).toBe(200);
    expect(r.body.header.status).toBe('SUCCESS');
    expect(r.body.body.tenant_id).toBe('BANK_DEMO');
    expect(r.body.body.days).toBe(30);
    expect(r.body.body.by_day).toHaveLength(30);
    expect(r.body.body.peak_day).toBeNull();
  });

  test('?days=7 narrows window', async () => {
    const auditTrailStore = new InMemoryAuditTrailStore();
    const { app } = makeApp({ auditTrailStore });
    const r = await request(app)
      .get('/v1/admin/config/change-daily-volume?days=7')
      .set(HEADERS_ADMIN);
    expect(r.status).toBe(200);
    expect(r.body.body.days).toBe(7);
    expect(r.body.body.by_day).toHaveLength(7);
  });

  test('?days=0 → 400 EWS_400_invalid_input', async () => {
    const { app } = makeApp({});
    const r = await request(app)
      .get('/v1/admin/config/change-daily-volume?days=0')
      .set(HEADERS_ADMIN);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_input');
  });

  test('?days=999 → 400 EWS_400_invalid_input', async () => {
    const { app } = makeApp({});
    const r = await request(app)
      .get('/v1/admin/config/change-daily-volume?days=999')
      .set(HEADERS_ADMIN);
    expect(r.status).toBe(400);
  });

  test('?days=abc → 400 EWS_400_invalid_input', async () => {
    const { app } = makeApp({});
    const r = await request(app)
      .get('/v1/admin/config/change-daily-volume?days=abc')
      .set(HEADERS_ADMIN);
    expect(r.status).toBe(400);
  });

  test('403 when role lacks audit:read', async () => {
    const { app } = makeApp({});
    const r = await request(app)
      .get('/v1/admin/config/change-daily-volume')
      .set({ ...HEADERS_ADMIN, 'X-Apex-Role': 'field_officer' });
    expect(r.status).toBe(403);
  });

  test('400 missing tenant header', async () => {
    const { app } = makeApp({});
    const r = await request(app)
      .get('/v1/admin/config/change-daily-volume')
      .set({ 'X-Apex-Role': 'admin' });
    expect(r.status).toBe(400);
  });

  test('populated reflects audit events', async () => {
    const auditTrailStore = new InMemoryAuditTrailStore();
    // Seed 2 config.update events for BANK_DEMO
    auditTrailStore.record(
      'BANK_DEMO',
      {
        actor_username: 'alice.admin',
        actor_role: 'admin',
        action: 'config.update',
        resource_type: 'config',
        resource_id: ALERTS_KEY,
        outcome: 'success',
        severity: 'info',
        metadata: {},
      },
      NOW,
    );
    auditTrailStore.record(
      'BANK_DEMO',
      {
        actor_username: 'alice.admin',
        actor_role: 'admin',
        action: 'config.reset',
        resource_type: 'config',
        resource_id: ALERTS_KEY,
        outcome: 'success',
        severity: 'info',
        metadata: {},
      },
      NOW,
    );
    const { app } = makeApp({ auditTrailStore });
    const r = await request(app)
      .get('/v1/admin/config/change-daily-volume')
      .set(HEADERS_ADMIN);
    expect(r.status).toBe(200);
    expect(r.body.body.total_changes_in_window).toBe(2);
    expect(r.body.body.total_updates_in_window).toBe(1);
    expect(r.body.body.total_resets_in_window).toBe(1);
    expect(r.body.body.peak_day).toBe('2026-05-22');
    expect(r.body.body.busiest_category).toBe('alerts');
  });

  test('cross-tenant isolation through HTTP (BIL sees nothing)', async () => {
    const auditTrailStore = new InMemoryAuditTrailStore();
    auditTrailStore.record(
      'BANK_DEMO',
      {
        actor_username: 'alice.admin',
        actor_role: 'admin',
        action: 'config.update',
        resource_type: 'config',
        resource_id: ALERTS_KEY,
        outcome: 'success',
        severity: 'info',
        metadata: {},
      },
      NOW,
    );
    const { app } = makeApp({ auditTrailStore });
    const r = await request(app)
      .get('/v1/admin/config/change-daily-volume')
      .set({ ...HEADERS_ADMIN, 'X-Tenant-ID': 'BIL' });
    expect(r.status).toBe(200);
    expect(r.body.body.total_changes_in_window).toBe(0);
  });
});
