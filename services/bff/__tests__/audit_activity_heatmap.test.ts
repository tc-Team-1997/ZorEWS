// services/bff/__tests__/audit_activity_heatmap.test.ts
//
// T6 M15.7 — Audit activity day-of-week × hour heatmap.

import request from 'supertest';
import { bucketAuditByDowHour } from '../src/audit_activity_heatmap';
import { InMemoryAuditTrailStore, type AuditEvent } from '../src/audit_trail';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-14T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

let seq = 0;
function mkEvent(o: Partial<AuditEvent> & { action: string; ts: string }): AuditEvent {
  seq += 1;
  return {
    event_id: o.event_id ?? `evt-${seq}`,
    ts: o.ts,
    tenant_id: o.tenant_id ?? 'BIL',
    actor_username: o.actor_username ?? 'alice',
    actor_role: o.actor_role ?? 'admin',
    action: o.action,
    resource_type: o.resource_type ?? 'system',
    resource_id: o.resource_id ?? 'r1',
    outcome: o.outcome ?? 'success',
    severity: o.severity ?? 'info',
    correlation_id: o.correlation_id ?? '',
    ip_address: o.ip_address ?? '',
    metadata: o.metadata ?? {},
    prev_hash: o.prev_hash ?? 'GENESIS',
    hash: o.hash ?? 'h' + seq,
  };
}

beforeEach(() => { seq = 0; });

// ─── bucketAuditByDowHour — pure ─────────────────────────────────────

describe('M15.7 — empty', () => {
  test('zero events → all-zero matrix; null peak', () => {
    const h = bucketAuditByDowHour([], 'UTC');
    expect(h.total_events).toBe(0);
    expect(h.by_dow_hour.length).toBe(7);
    expect(h.peak_dow).toBeNull();
    expect(h.peak_hour).toBeNull();
    expect(h.peak_count).toBe(0);
  });
});

describe('M15.7 — single event placement', () => {
  test('Monday 14:00 UTC → bucket [0][14]', () => {
    // 2026-05-11 is Mon.
    const h = bucketAuditByDowHour([mkEvent({ action: 'a', ts: '2026-05-11T14:00:00.000Z' })], 'UTC');
    expect(h.total_events).toBe(1);
    expect(h.by_dow_hour[0]![14]).toBe(1);
    expect(h.peak_dow).toBe(0);
    expect(h.peak_hour).toBe(14);
    expect(h.peak_count).toBe(1);
  });
});

describe('M15.7 — marginal totals', () => {
  test('by_dow + by_hour sum to total_events', () => {
    const events = [
      mkEvent({ action: 'a', ts: '2026-05-11T09:00:00.000Z' }),
      mkEvent({ action: 'a', ts: '2026-05-11T15:00:00.000Z' }),
      mkEvent({ action: 'a', ts: '2026-05-12T09:00:00.000Z' }),
      mkEvent({ action: 'a', ts: '2026-05-14T18:00:00.000Z' }),
    ];
    const h = bucketAuditByDowHour(events, 'UTC');
    expect(h.total_events).toBe(4);
    expect(h.by_dow.reduce((s, x) => s + x, 0)).toBe(4);
    expect(h.by_hour.reduce((s, x) => s + x, 0)).toBe(4);
  });
});

describe('M15.7 — tz shift', () => {
  test('UTC midnight shifts a day earlier in America/Los_Angeles', () => {
    // 2026-05-11T05:00:00Z is Mon 05:00 UTC, Sun 22:00 in LA (UTC-7 in May DST).
    const e = mkEvent({ action: 'a', ts: '2026-05-11T05:00:00.000Z' });
    const utc = bucketAuditByDowHour([e], 'UTC');
    expect(utc.peak_dow).toBe(0); // Mon
    expect(utc.peak_hour).toBe(5);
    const la = bucketAuditByDowHour([e], 'America/Los_Angeles');
    expect(la.peak_dow).toBe(6); // Sun
    expect(la.peak_hour).toBe(22);
  });
});

describe('M15.7 — peak tie-break', () => {
  test('equal counts → row-major (dow asc, hour asc)', () => {
    const events = [
      mkEvent({ action: 'a', ts: '2026-05-11T09:00:00.000Z' }), // Mon 09
      mkEvent({ action: 'a', ts: '2026-05-12T15:00:00.000Z' }), // Tue 15
    ];
    const h = bucketAuditByDowHour(events, 'UTC');
    expect(h.peak_count).toBe(1);
    expect(h.peak_dow).toBe(0); // Mon wins
    expect(h.peak_hour).toBe(9);
  });
});

describe('M15.7 — many-event aggregation', () => {
  test('20 events at Mon 14 + 5 at Tue 09 → peak=Mon 14', () => {
    const events: AuditEvent[] = [];
    for (let i = 0; i < 20; i += 1) {
      events.push(mkEvent({ action: 'a', ts: '2026-05-11T14:00:00.000Z' }));
    }
    for (let i = 0; i < 5; i += 1) {
      events.push(mkEvent({ action: 'a', ts: '2026-05-12T09:00:00.000Z' }));
    }
    const h = bucketAuditByDowHour(events, 'UTC');
    expect(h.peak_count).toBe(20);
    expect(h.peak_dow).toBe(0);
    expect(h.peak_hour).toBe(14);
  });
});

// ─── GET /v1/audit/activity-heatmap ──────────────────────────────────

function makeHeatmapApp(role = 'admin') {
  const auditTrailStore = new InMemoryAuditTrailStore();
  const built = makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    auditTrailStore,
    now: () => NOW,
    getRole: () => role,
  });
  return { ...built, auditTrailStore };
}

describe('M15.7 — GET /v1/audit/activity-heatmap', () => {
  test('empty tenant → 200 zero matrix', async () => {
    const { app } = makeHeatmapApp('admin');
    const r = await request(app).get('/v1/audit/activity-heatmap').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_events).toBe(0);
    expect(r.body.body.tz).toBe('UTC');
    expect(r.body.body.peak_dow).toBeNull();
  });

  test('records show up in the heatmap', async () => {
    const { app, auditTrailStore } = makeHeatmapApp('admin');
    auditTrailStore.record(
      'BIL',
      {
        actor_username: 'alice',
        actor_role: 'admin',
        action: 'login',
        resource_type: 'system',
        resource_id: 'r1',
        outcome: 'success',
        severity: 'info',
      },
      new Date('2026-05-11T14:00:00.000Z'),
    );
    const r = await request(app).get('/v1/audit/activity-heatmap').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_events).toBe(1);
    expect(r.body.body.peak_dow).toBe(0);
    expect(r.body.body.peak_hour).toBe(14);
  });

  test('?tz=Asia/Kolkata shifts wall-clock', async () => {
    const { app, auditTrailStore } = makeHeatmapApp('admin');
    auditTrailStore.record(
      'BIL',
      {
        actor_username: 'alice',
        actor_role: 'admin',
        action: 'login',
        resource_type: 'system',
        resource_id: 'r1',
        outcome: 'success',
        severity: 'info',
      },
      new Date('2026-05-11T09:00:00.000Z'),
    );
    const r = await request(app)
      .get('/v1/audit/activity-heatmap?tz=Asia/Kolkata')
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.tz).toBe('Asia/Kolkata');
    // 09:00 UTC + 5:30 = 14:30 IST → hour 14
    expect(r.body.body.peak_hour).toBe(14);
  });

  test('invalid ?tz → 400', async () => {
    const { app } = makeHeatmapApp('admin');
    const r = await request(app)
      .get('/v1/audit/activity-heatmap?tz=Mars/Olympus')
      .set(TH_BIL);
    expect(r.status).toBe(400);
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeHeatmapApp('case_owner');
    const r = await request(app).get('/v1/audit/activity-heatmap').set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('cross-tenant: BIL events invisible to BANK_DEMO', async () => {
    const { app, auditTrailStore } = makeHeatmapApp('admin');
    auditTrailStore.record(
      'BIL',
      {
        actor_username: 'alice',
        actor_role: 'admin',
        action: 'login',
        resource_type: 'system',
        resource_id: 'r1',
        outcome: 'success',
        severity: 'info',
      },
      NOW,
    );
    const r = await request(app)
      .get('/v1/audit/activity-heatmap')
      .set('X-Tenant-ID', 'BANK_DEMO')
      .set('X-Channel', 'API');
    expect(r.status).toBe(200);
    expect(r.body.body.total_events).toBe(0);
  });
});
