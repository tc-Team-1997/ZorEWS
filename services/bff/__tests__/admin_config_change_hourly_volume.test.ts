// services/bff/__tests__/admin_config_change_hourly_volume.test.ts
//
// T6 M13.19 — pure resolver + HTTP route tests for config change
// hourly-volume cyclic distribution.

import request from 'supertest';
import {
  summarizeConfigChangeHourlyVolume,
  ConfigChangeHourlyVolumeError,
  isAfterHoursUtc,
  HOURS_IN_DAY,
  AFTER_HOURS_START_UTC,
  AFTER_HOURS_END_UTC,
} from '../src/admin_config_change_hourly_volume';
import { DEFAULTS, listCategories } from '../src/admin_config';
import type { AuditEvent } from '../src/audit_trail';
import { makeApp } from '../src/server';
import { InMemoryAuditTrailStore } from '../src/audit_trail';

const NOW = new Date('2026-05-28T12:00:00.000Z');

const ALERTS_KEY = DEFAULTS.find((d) => d.category === 'alerts')!.key;
const NOTIFY_KEY = DEFAULTS.find((d) => d.category === 'notifications')!.key;

/** Build a config audit event at a given UTC hour. */
function evtAtHour(hour: number, opts: Partial<AuditEvent> = {}): AuditEvent {
  const hh = String(hour).padStart(2, '0');
  return {
    event_id: `e-${Math.random().toString(36).slice(2, 10)}`,
    ts: `2026-05-20T${hh}:30:00.000Z`,
    tenant_id: 'BANK_DEMO',
    actor_username: 'alice.admin',
    actor_role: 'admin',
    action: 'config.update',
    resource_type: 'config',
    resource_id: ALERTS_KEY,
    outcome: 'success',
    severity: 'info',
    metadata: {},
    correlation_id: null,
    ip_address: null,
    hash: 'fake',
    prev_hash: 'fake',
    ...opts,
  };
}

const HEADERS_ADMIN = {
  'X-Tenant-ID': 'BANK_DEMO',
  'X-Channel': 'API',
  'X-APEX-USER': 'alice.admin',
  'X-Apex-Role': 'admin',
};

// ─── isAfterHoursUtc helper ──────────────────────────────────────────────

describe('M13.19 — isAfterHoursUtc + constants', () => {
  test('after-hours window thresholds', () => {
    expect(AFTER_HOURS_START_UTC).toBe(22);
    expect(AFTER_HOURS_END_UTC).toBe(6);
    expect(HOURS_IN_DAY).toBe(24);
  });

  test('hours >= 22 OR < 6 are after-hours; business hours are not', () => {
    expect(isAfterHoursUtc(0)).toBe(true);
    expect(isAfterHoursUtc(2)).toBe(true);
    expect(isAfterHoursUtc(5)).toBe(true);
    expect(isAfterHoursUtc(6)).toBe(false); // boundary: 06:00 is business
    expect(isAfterHoursUtc(12)).toBe(false);
    expect(isAfterHoursUtc(21)).toBe(false);
    expect(isAfterHoursUtc(22)).toBe(true); // boundary: 22:00 is after-hours
    expect(isAfterHoursUtc(23)).toBe(true);
  });
});

// ─── Pure resolver ───────────────────────────────────────────────────────

describe('M13.19 — summarizeConfigChangeHourlyVolume (pure)', () => {
  test('empty input → 24 zero buckets + null leaderboards', () => {
    const r = summarizeConfigChangeHourlyVolume('BANK_DEMO', [], NOW);
    expect(r.tenant_id).toBe('BANK_DEMO');
    expect(r.generated_at).toBe(NOW.toISOString());
    expect(r.by_hour).toHaveLength(24);
    expect(r.total_changes).toBe(0);
    expect(r.total_events_observed).toBe(0);
    expect(r.total_unknown_key_events).toBe(0);
    expect(r.peak_hour).toBeNull();
    expect(r.peak_count).toBe(0);
    expect(r.mean_per_hour).toBe(0);
    expect(r.busiest_action).toBeNull();
    expect(r.busiest_category).toBeNull();
    expect(r.after_hours_changes).toBe(0);
    expect(r.after_hours_pct).toBe(0);
    expect(r.quiet_hours).toHaveLength(24);
    for (const b of r.by_hour) {
      expect(b.total).toBe(0);
      expect(b.by_action['config.update']).toBe(0);
      expect(b.by_action['config.reset']).toBe(0);
      for (const cat of listCategories()) expect(b.by_category[cat]).toBe(0);
      expect(b.distinct_actors).toBe(0);
      expect(b.distinct_keys).toBe(0);
    }
  });

  test('by_hour is canonical 0..23 order', () => {
    const r = summarizeConfigChangeHourlyVolume('BANK_DEMO', [], NOW);
    expect(r.by_hour.map((b) => b.hour)).toEqual(
      Array.from({ length: 24 }, (_, i) => i),
    );
  });

  test('single event lands in correct UTC hour bucket', () => {
    const r = summarizeConfigChangeHourlyVolume('BANK_DEMO', [evtAtHour(14)], NOW);
    expect(r.total_changes).toBe(1);
    expect(r.by_hour[14].total).toBe(1);
    expect(r.by_hour[14].by_action['config.update']).toBe(1);
    expect(r.by_hour[14].distinct_actors).toBe(1);
    expect(r.by_hour[14].distinct_keys).toBe(1);
    expect(r.by_hour[13].total).toBe(0);
  });

  test('Σ by_hour.total = total_changes partition invariant', () => {
    const events = [evtAtHour(2), evtAtHour(2), evtAtHour(9), evtAtHour(23)];
    const r = summarizeConfigChangeHourlyVolume('BANK_DEMO', events, NOW);
    const sum = r.by_hour.reduce((a, b) => a + b.total, 0);
    expect(sum).toBe(r.total_changes);
    expect(sum).toBe(4);
  });

  test('Σ by_action per bucket = bucket.total partition', () => {
    const events = [
      evtAtHour(9, { action: 'config.update' }),
      evtAtHour(9, { action: 'config.reset' }),
    ];
    const r = summarizeConfigChangeHourlyVolume('BANK_DEMO', events, NOW);
    const b = r.by_hour[9];
    expect(b.by_action['config.update'] + b.by_action['config.reset']).toBe(b.total);
    expect(b.total).toBe(2);
  });

  test('peak_hour = highest total + earliest-hour-wins tie-break', () => {
    // hour 3 has 2, hour 15 has 2 → earliest (3) wins
    const events = [evtAtHour(3), evtAtHour(3), evtAtHour(15), evtAtHour(15), evtAtHour(8)];
    const r = summarizeConfigChangeHourlyVolume('BANK_DEMO', events, NOW);
    expect(r.peak_hour).toBe(3);
    expect(r.peak_count).toBe(2);
  });

  test('peak_hour highest-count beats earlier hour', () => {
    const events = [evtAtHour(1), evtAtHour(8), evtAtHour(8), evtAtHour(8)];
    const r = summarizeConfigChangeHourlyVolume('BANK_DEMO', events, NOW);
    expect(r.peak_hour).toBe(8);
    expect(r.peak_count).toBe(3);
  });

  test('quiet_hours = zero-count hours ascending', () => {
    const r = summarizeConfigChangeHourlyVolume('BANK_DEMO', [evtAtHour(0), evtAtHour(23)], NOW);
    // every hour except 0 and 23 is quiet
    expect(r.quiet_hours).not.toContain(0);
    expect(r.quiet_hours).not.toContain(23);
    expect(r.quiet_hours).toContain(12);
    expect(r.quiet_hours).toHaveLength(22);
    // ascending
    expect(r.quiet_hours).toEqual([...r.quiet_hours].sort((a, b) => a - b));
  });

  test('mean_per_hour = round(total / 24)', () => {
    // 24 events → mean 1; 12 events → round(0.5)=1; 11 → round(0.458)=0
    const ev24 = Array.from({ length: 24 }, () => evtAtHour(10));
    expect(summarizeConfigChangeHourlyVolume('BANK_DEMO', ev24, NOW).mean_per_hour).toBe(1);
    const ev11 = Array.from({ length: 11 }, () => evtAtHour(10));
    expect(summarizeConfigChangeHourlyVolume('BANK_DEMO', ev11, NOW).mean_per_hour).toBe(0);
  });

  test('busiest_action canonical tie-break (config.update > config.reset)', () => {
    const events = [
      evtAtHour(9, { action: 'config.update' }),
      evtAtHour(10, { action: 'config.reset' }),
    ];
    // both 1 → config.update wins (canonical first)
    const r = summarizeConfigChangeHourlyVolume('BANK_DEMO', events, NOW);
    expect(r.busiest_action).toBe('config.update');

    // more resets → reset wins
    const events2 = [
      evtAtHour(9, { action: 'config.reset' }),
      evtAtHour(10, { action: 'config.reset' }),
      evtAtHour(11, { action: 'config.update' }),
    ];
    expect(summarizeConfigChangeHourlyVolume('BANK_DEMO', events2, NOW).busiest_action).toBe(
      'config.reset',
    );
  });

  test('busiest_category by resource_id → category map', () => {
    const events = [
      evtAtHour(9, { resource_id: ALERTS_KEY }),
      evtAtHour(10, { resource_id: ALERTS_KEY }),
      evtAtHour(11, { resource_id: NOTIFY_KEY }),
    ];
    const r = summarizeConfigChangeHourlyVolume('BANK_DEMO', events, NOW);
    expect(r.busiest_category).toBe('alerts');
  });

  test('unknown config key counted but excluded from by_category', () => {
    const events = [evtAtHour(9, { resource_id: 'not.a.real.key' })];
    const r = summarizeConfigChangeHourlyVolume('BANK_DEMO', events, NOW);
    expect(r.total_changes).toBe(1);
    expect(r.total_unknown_key_events).toBe(1);
    // change counted in by_hour total but not in any by_category
    expect(r.by_hour[9].total).toBe(1);
    for (const cat of listCategories()) expect(r.by_hour[9].by_category[cat]).toBe(0);
  });

  test('after_hours_changes + after_hours_pct (UTC 22:00-06:00 window)', () => {
    // 3 after-hours (2, 23, 5) + 1 business (14) = 4 total
    const events = [evtAtHour(2), evtAtHour(23), evtAtHour(5), evtAtHour(14)];
    const r = summarizeConfigChangeHourlyVolume('BANK_DEMO', events, NOW);
    expect(r.after_hours_changes).toBe(3);
    expect(r.after_hours_pct).toBe(0.75);
  });

  test('after_hours boundary: hour 6 is business, hour 22 is after-hours', () => {
    const events = [evtAtHour(6), evtAtHour(22)];
    const r = summarizeConfigChangeHourlyVolume('BANK_DEMO', events, NOW);
    expect(r.after_hours_changes).toBe(1); // only hour 22
    expect(r.after_hours_pct).toBe(0.5);
  });

  test('distinct_actors + distinct_keys per hour deduped', () => {
    const events = [
      evtAtHour(9, { actor_username: 'alice', resource_id: ALERTS_KEY }),
      evtAtHour(9, { actor_username: 'alice', resource_id: ALERTS_KEY }),
      evtAtHour(9, { actor_username: 'bob', resource_id: NOTIFY_KEY }),
    ];
    const r = summarizeConfigChangeHourlyVolume('BANK_DEMO', events, NOW);
    expect(r.by_hour[9].distinct_actors).toBe(2);
    expect(r.by_hour[9].distinct_keys).toBe(2);
  });

  test('cross-tenant events filtered out', () => {
    const events = [
      evtAtHour(9, { tenant_id: 'BANK_DEMO' }),
      evtAtHour(10, { tenant_id: 'BIL' }),
    ];
    const r = summarizeConfigChangeHourlyVolume('BANK_DEMO', events, NOW);
    expect(r.total_changes).toBe(1);
    expect(r.by_hour[9].total).toBe(1);
    expect(r.by_hour[10].total).toBe(0);
  });

  test('non-config resource_type + non-config-change action filtered out', () => {
    const events = [
      evtAtHour(9, { resource_type: 'user' as never }),
      evtAtHour(10, { action: 'config.create' as never }),
      evtAtHour(11, { action: 'config.update' }),
    ];
    const r = summarizeConfigChangeHourlyVolume('BANK_DEMO', events, NOW);
    expect(r.total_changes).toBe(1);
    expect(r.by_hour[11].total).toBe(1);
  });

  test('malformed ts skipped (counted in observed, not bucketed)', () => {
    const events = [
      evtAtHour(9),
      evtAtHour(10, { ts: 'not-a-date' }),
    ];
    const r = summarizeConfigChangeHourlyVolume('BANK_DEMO', events, NOW);
    expect(r.total_events_observed).toBe(2);
    expect(r.total_changes).toBe(1); // malformed not bucketed
  });

  test('empty tenant_id throws', () => {
    expect(() => summarizeConfigChangeHourlyVolume('', [], NOW)).toThrow(
      ConfigChangeHourlyVolumeError,
    );
  });
});

// ─── HTTP route ──────────────────────────────────────────────────────────

describe('M13.19 — GET /v1/admin/config/change-hourly-volume', () => {
  test('admin happy path empty store', async () => {
    const auditTrailStore = new InMemoryAuditTrailStore();
    const { app } = makeApp({ auditTrailStore });
    const r = await request(app)
      .get('/v1/admin/config/change-hourly-volume')
      .set(HEADERS_ADMIN);
    expect(r.status).toBe(200);
    expect(r.body.header.status).toBe('SUCCESS');
    expect(r.body.body.tenant_id).toBe('BANK_DEMO');
    expect(r.body.body.by_hour).toHaveLength(24);
    expect(r.body.body.peak_hour).toBeNull();
    expect(r.body.body.after_hours_changes).toBe(0);
  });

  test('populated reflects audit events incl. after-hours signal', async () => {
    const auditTrailStore = new InMemoryAuditTrailStore();
    // one after-hours change at 02:00 UTC, one business at 14:00 UTC
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
      new Date('2026-05-20T02:00:00.000Z'),
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
      new Date('2026-05-20T14:00:00.000Z'),
    );
    const { app } = makeApp({ auditTrailStore });
    const r = await request(app)
      .get('/v1/admin/config/change-hourly-volume')
      .set(HEADERS_ADMIN);
    expect(r.status).toBe(200);
    expect(r.body.body.total_changes).toBe(2);
    expect(r.body.body.by_hour[2].total).toBe(1);
    expect(r.body.body.by_hour[14].total).toBe(1);
    expect(r.body.body.after_hours_changes).toBe(1);
    expect(r.body.body.after_hours_pct).toBe(0.5);
    expect(r.body.body.busiest_category).toBe('alerts');
  });

  test('403 when role lacks audit:read', async () => {
    const { app } = makeApp({});
    const r = await request(app)
      .get('/v1/admin/config/change-hourly-volume')
      .set({ ...HEADERS_ADMIN, 'X-Apex-Role': 'field_officer' });
    expect(r.status).toBe(403);
  });

  test('400 missing tenant header', async () => {
    const { app } = makeApp({});
    const r = await request(app)
      .get('/v1/admin/config/change-hourly-volume')
      .set({ 'X-Apex-Role': 'admin' });
    expect(r.status).toBe(400);
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
      new Date('2026-05-20T02:00:00.000Z'),
    );
    const { app } = makeApp({ auditTrailStore });
    const r = await request(app)
      .get('/v1/admin/config/change-hourly-volume')
      .set({ ...HEADERS_ADMIN, 'X-Tenant-ID': 'BIL' });
    expect(r.status).toBe(200);
    expect(r.body.body.total_changes).toBe(0);
  });

  test('M13.18 /change-daily-volume sibling regression still 200', async () => {
    const { app } = makeApp({});
    const r = await request(app)
      .get('/v1/admin/config/change-daily-volume')
      .set(HEADERS_ADMIN);
    expect(r.status).toBe(200);
  });

  test('literal /change-hourly-volume not shadowed by /:key catch-all', async () => {
    const { app } = makeApp({});
    const r = await request(app)
      .get('/v1/admin/config/change-hourly-volume')
      .set(HEADERS_ADMIN);
    // returns the hourly shape, not a single-config-key lookup
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.body.by_hour)).toBe(true);
    expect(r.body.body.by_hour).toHaveLength(24);
  });
});
