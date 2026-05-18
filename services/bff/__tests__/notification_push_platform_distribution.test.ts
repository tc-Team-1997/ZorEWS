// services/bff/__tests__/notification_push_platform_distribution.test.ts
//
// T6 M10.17 — Push notification platform distribution.

import request from 'supertest';
import { summarizePushPlatformDistribution } from '../src/notification_push_platform_distribution';
import {
  StubPushTransport,
  type PushDevice,
  type PushLedgerEntry,
  type PushTransport,
} from '../src/notifications/push';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-19T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };
const TH_BANK = { 'X-Tenant-ID': 'BANK_DEMO', 'X-Channel': 'API' };

function makePpApp(role: string = 'admin', pushTransport?: PushTransport) {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
    pushTransport: pushTransport ?? new StubPushTransport({ now: () => NOW }),
  });
}

function ledgerEntry(
  overrides: Partial<PushLedgerEntry> = {},
): PushLedgerEntry {
  const devices: PushDevice[] = [
    { device_token: 'tok-fcm', platform: 'fcm', user_id: 'alice' },
  ];
  return {
    message_id: 'msg-' + Math.random().toString(36).slice(2, 10),
    tenant_id: 'BIL',
    to: devices,
    title: 'Test',
    body: 'Test body',
    per_device: devices.map((d) => ({
      device_token: d.device_token,
      platform: d.platform,
      status: 'sent' as const,
    })),
    status: 'sent',
    sent_at: NOW.toISOString(),
    transport: 'StubPushTransport',
    ...overrides,
  };
}

// ─── Pure resolver tests ─────────────────────────────────────────────

describe('M10.17 — empty input', () => {
  test('zero entries → 3 platform rows at 0 + null most_used', () => {
    const s = summarizePushPlatformDistribution('BIL', [], NOW);
    expect(s.total_messages).toBe(0);
    expect(s.total_dispatches).toBe(0);
    expect(s.platforms.length).toBe(3);
    for (const p of s.platforms) {
      expect(p.dispatch_count).toBe(0);
      expect(p.distinct_messages).toBe(0);
      expect(p.distinct_users).toBe(0);
      expect(p.most_recent_at).toBeNull();
    }
    expect(s.most_used_platform).toBeNull();
    expect(s.unused_platforms).toEqual(['fcm', 'apns', 'web']);
    expect(s.overall_by_status.sent).toBe(0);
  });
});

describe('M10.17 — canonical platform order', () => {
  test('platforms[] in canonical fcm → apns → web order', () => {
    const s = summarizePushPlatformDistribution('BIL', [], NOW);
    expect(s.platforms.map((p) => p.platform)).toEqual(['fcm', 'apns', 'web']);
  });
});

describe('M10.17 — single message single device', () => {
  test('1 fcm device → fcm row dispatch_count=1', () => {
    const entry = ledgerEntry({
      to: [{ device_token: 'tok-fcm', platform: 'fcm', user_id: 'alice' }],
      per_device: [
        { device_token: 'tok-fcm', platform: 'fcm', status: 'sent' as const },
      ],
    });
    const s = summarizePushPlatformDistribution('BIL', [entry], NOW);
    expect(s.total_messages).toBe(1);
    expect(s.total_dispatches).toBe(1);
    const fcm = s.platforms.find((p) => p.platform === 'fcm')!;
    expect(fcm.dispatch_count).toBe(1);
    expect(fcm.distinct_messages).toBe(1);
    expect(fcm.distinct_users).toBe(1);
    expect(fcm.by_status.sent).toBe(1);
    const apns = s.platforms.find((p) => p.platform === 'apns')!;
    expect(apns.dispatch_count).toBe(0);
  });
});

describe('M10.17 — multi-platform single message', () => {
  test('1 message with 3 devices on different platforms', () => {
    const devices: PushDevice[] = [
      { device_token: 'tok-fcm', platform: 'fcm', user_id: 'alice' },
      { device_token: 'tok-apns', platform: 'apns', user_id: 'bob' },
      { device_token: 'tok-web', platform: 'web', user_id: 'carol' },
    ];
    const entry = ledgerEntry({
      to: devices,
      per_device: devices.map((d) => ({
        device_token: d.device_token,
        platform: d.platform,
        status: 'sent' as const,
      })),
    });
    const s = summarizePushPlatformDistribution('BIL', [entry], NOW);
    expect(s.total_messages).toBe(1);
    expect(s.total_dispatches).toBe(3);
    for (const p of s.platforms) {
      expect(p.dispatch_count).toBe(1);
    }
  });
});

describe('M10.17 — distinct_users dedup', () => {
  test('same user on multiple devices same platform → distinct_users=1', () => {
    const devices: PushDevice[] = [
      { device_token: 'tok-1', platform: 'fcm', user_id: 'alice' },
      { device_token: 'tok-2', platform: 'fcm', user_id: 'alice' },
    ];
    const entry = ledgerEntry({
      to: devices,
      per_device: devices.map((d) => ({
        device_token: d.device_token,
        platform: d.platform,
        status: 'sent' as const,
      })),
    });
    const s = summarizePushPlatformDistribution('BIL', [entry], NOW);
    const fcm = s.platforms.find((p) => p.platform === 'fcm')!;
    expect(fcm.dispatch_count).toBe(2);
    expect(fcm.distinct_users).toBe(1);
  });
});

describe('M10.17 — by_status per platform', () => {
  test('mix of sent + failed accumulates per status', () => {
    const devices: PushDevice[] = [
      { device_token: 'tok-1', platform: 'fcm', user_id: 'alice' },
      { device_token: 'tok-2', platform: 'fcm', user_id: 'bob' },
    ];
    const entry = ledgerEntry({
      to: devices,
      per_device: [
        { device_token: 'tok-1', platform: 'fcm', status: 'sent' as const },
        { device_token: 'tok-2', platform: 'fcm', status: 'failed' as const, error: 'invalid token' },
      ],
    });
    const s = summarizePushPlatformDistribution('BIL', [entry], NOW);
    const fcm = s.platforms.find((p) => p.platform === 'fcm')!;
    expect(fcm.by_status.sent).toBe(1);
    expect(fcm.by_status.failed).toBe(1);
  });

  test('every by_status carries 3 keys (queued/sent/failed)', () => {
    const s = summarizePushPlatformDistribution('BIL', [], NOW);
    for (const p of s.platforms) {
      expect(Object.keys(p.by_status).sort()).toEqual(['failed', 'queued', 'sent']);
    }
  });
});

describe('M10.17 — most_used_platform', () => {
  test('highest dispatch_count wins', () => {
    const entries: PushLedgerEntry[] = [
      ledgerEntry({
        to: [{ device_token: 't1', platform: 'fcm', user_id: 'u1' }],
        per_device: [{ device_token: 't1', platform: 'fcm', status: 'sent' }],
      }),
      ledgerEntry({
        to: [{ device_token: 't2', platform: 'fcm', user_id: 'u2' }],
        per_device: [{ device_token: 't2', platform: 'fcm', status: 'sent' }],
      }),
      ledgerEntry({
        to: [{ device_token: 't3', platform: 'apns', user_id: 'u3' }],
        per_device: [{ device_token: 't3', platform: 'apns', status: 'sent' }],
      }),
    ];
    const s = summarizePushPlatformDistribution('BIL', entries, NOW);
    expect(s.most_used_platform).toBe('fcm');
  });

  test('canonical tie-break: fcm beats apns at tied 1', () => {
    const entries: PushLedgerEntry[] = [
      ledgerEntry({
        to: [{ device_token: 't1', platform: 'fcm', user_id: 'u1' }],
        per_device: [{ device_token: 't1', platform: 'fcm', status: 'sent' }],
      }),
      ledgerEntry({
        to: [{ device_token: 't2', platform: 'apns', user_id: 'u2' }],
        per_device: [{ device_token: 't2', platform: 'apns', status: 'sent' }],
      }),
    ];
    const s = summarizePushPlatformDistribution('BIL', entries, NOW);
    expect(s.most_used_platform).toBe('fcm');
  });

  test('null on empty', () => {
    const s = summarizePushPlatformDistribution('BIL', [], NOW);
    expect(s.most_used_platform).toBeNull();
  });
});

describe('M10.17 — unused_platforms', () => {
  test('canonical order zero-count subset', () => {
    const entry = ledgerEntry({
      to: [{ device_token: 't1', platform: 'fcm', user_id: 'u1' }],
      per_device: [{ device_token: 't1', platform: 'fcm', status: 'sent' }],
    });
    const s = summarizePushPlatformDistribution('BIL', [entry], NOW);
    expect(s.unused_platforms).toEqual(['apns', 'web']);
  });

  test('empty when all platforms used', () => {
    const devices: PushDevice[] = [
      { device_token: 't1', platform: 'fcm', user_id: 'u1' },
      { device_token: 't2', platform: 'apns', user_id: 'u2' },
      { device_token: 't3', platform: 'web', user_id: 'u3' },
    ];
    const entry = ledgerEntry({
      to: devices,
      per_device: devices.map((d) => ({
        device_token: d.device_token,
        platform: d.platform,
        status: 'sent' as const,
      })),
    });
    const s = summarizePushPlatformDistribution('BIL', [entry], NOW);
    expect(s.unused_platforms).toEqual([]);
  });
});

describe('M10.17 — most_recent_at per platform', () => {
  test('newest sent_at wins', () => {
    const entries: PushLedgerEntry[] = [
      ledgerEntry({
        sent_at: '2026-05-10T00:00:00.000Z',
        to: [{ device_token: 't1', platform: 'fcm', user_id: 'u1' }],
        per_device: [{ device_token: 't1', platform: 'fcm', status: 'sent' }],
      }),
      ledgerEntry({
        sent_at: '2026-05-15T00:00:00.000Z',
        to: [{ device_token: 't2', platform: 'fcm', user_id: 'u2' }],
        per_device: [{ device_token: 't2', platform: 'fcm', status: 'sent' }],
      }),
    ];
    const s = summarizePushPlatformDistribution('BIL', entries, NOW);
    const fcm = s.platforms.find((p) => p.platform === 'fcm')!;
    expect(fcm.most_recent_at).toBe('2026-05-15T00:00:00.000Z');
  });
});

describe('M10.17 — distinct_messages dedup', () => {
  test('1 message with 3 fcm devices → distinct_messages=1, dispatch_count=3', () => {
    const devices: PushDevice[] = [
      { device_token: 't1', platform: 'fcm', user_id: 'u1' },
      { device_token: 't2', platform: 'fcm', user_id: 'u2' },
      { device_token: 't3', platform: 'fcm', user_id: 'u3' },
    ];
    const entry = ledgerEntry({
      to: devices,
      per_device: devices.map((d) => ({
        device_token: d.device_token,
        platform: d.platform,
        status: 'sent' as const,
      })),
    });
    const s = summarizePushPlatformDistribution('BIL', [entry], NOW);
    const fcm = s.platforms.find((p) => p.platform === 'fcm')!;
    expect(fcm.dispatch_count).toBe(3);
    expect(fcm.distinct_messages).toBe(1);
  });
});

describe('M10.17 — overall_by_status', () => {
  test('aggregates across all platforms', () => {
    const entries: PushLedgerEntry[] = [
      ledgerEntry({
        to: [{ device_token: 't1', platform: 'fcm', user_id: 'u1' }],
        per_device: [{ device_token: 't1', platform: 'fcm', status: 'sent' }],
      }),
      ledgerEntry({
        to: [{ device_token: 't2', platform: 'apns', user_id: 'u2' }],
        per_device: [{ device_token: 't2', platform: 'apns', status: 'failed', error: 'bad' }],
      }),
    ];
    const s = summarizePushPlatformDistribution('BIL', entries, NOW);
    expect(s.overall_by_status.sent).toBe(1);
    expect(s.overall_by_status.failed).toBe(1);
  });
});

describe('M10.17 — partition invariant', () => {
  test('Σ platform.dispatch_count = total_dispatches', () => {
    const devices: PushDevice[] = [
      { device_token: 't1', platform: 'fcm', user_id: 'u1' },
      { device_token: 't2', platform: 'apns', user_id: 'u2' },
    ];
    const entry = ledgerEntry({
      to: devices,
      per_device: devices.map((d) => ({
        device_token: d.device_token,
        platform: d.platform,
        status: 'sent' as const,
      })),
    });
    const s = summarizePushPlatformDistribution('BIL', [entry], NOW);
    const sum = s.platforms.reduce((acc, p) => acc + p.dispatch_count, 0);
    expect(sum).toBe(s.total_dispatches);
    expect(s.total_dispatches).toBe(2);
  });
});

describe('M10.17 — tenant_id + generated_at echo', () => {
  test('envelope echoes', () => {
    const s = summarizePushPlatformDistribution('BIL', [], NOW);
    expect(s.tenant_id).toBe('BIL');
    expect(s.generated_at).toBe(NOW.toISOString());
  });
});

// ─── Route tests ─────────────────────────────────────────────────────

describe('M10.17 — GET /v1/notifications/push/platform-distribution', () => {
  test('admin → 200 with empty transport', async () => {
    const { app } = makePpApp('admin');
    const r = await request(app)
      .get('/v1/notifications/push/platform-distribution')
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_messages).toBe(0);
    expect(r.body.body.platforms.length).toBe(3);
  });

  test('populated → reflects send', async () => {
    const transport = new StubPushTransport({ now: () => NOW });
    await transport.send('BIL', {
      to: [{ device_token: 't1', platform: 'fcm', user_id: 'alice' }],
      title: 'Hi',
      body: 'Hello',
    });
    const { app } = makePpApp('admin', transport);
    const r = await request(app)
      .get('/v1/notifications/push/platform-distribution')
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_messages).toBe(1);
    expect(r.body.body.most_used_platform).toBe('fcm');
  });

  test('non-allowed role → 403', async () => {
    const { app } = makePpApp('case_owner');
    const r = await request(app)
      .get('/v1/notifications/push/platform-distribution')
      .set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('cross-tenant invisibility via HTTP', async () => {
    const transport = new StubPushTransport({ now: () => NOW });
    await transport.send('BIL', {
      to: [{ device_token: 't1', platform: 'fcm', user_id: 'alice' }],
      title: 'Hi',
      body: 'Hello',
    });
    const { app } = makePpApp('admin', transport);
    const bankR = await request(app)
      .get('/v1/notifications/push/platform-distribution')
      .set(TH_BANK);
    expect(bankR.status).toBe(200);
    expect(bankR.body.body.total_messages).toBe(0);
  });

  test('M10.3 /v1/notifications/push/log sibling regression still 200', async () => {
    const { app } = makePpApp('admin');
    const r = await request(app)
      .get('/v1/notifications/push/log')
      .set(TH_BIL);
    expect(r.status).toBe(200);
  });
});
