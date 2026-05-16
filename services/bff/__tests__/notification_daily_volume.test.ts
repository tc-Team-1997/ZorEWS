// services/bff/__tests__/notification_daily_volume.test.ts
//
// T6 M10.15 — Notification daily volume timeline.

import request from 'supertest';
import {
  summarizeNotificationDailyVolume,
  NotificationDailyVolumeError,
  DEFAULT_NOTIF_DAILY_WINDOW,
  MAX_NOTIF_DAILY_WINDOW,
} from '../src/notification_daily_volume';
import { StubEmailTransport } from '../src/notifications/email';
import { StubSmsTransport } from '../src/notifications/sms';
import { StubPushTransport } from '../src/notifications/push';
import type { EmailLedgerEntry } from '../src/notifications/email';
import type { SmsLedgerEntry } from '../src/notifications/sms';
import type { PushLedgerEntry } from '../src/notifications/push';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

// UTC midnight so window boundaries are predictable.
const NOW = new Date('2026-05-16T00:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function daysBackAt(daysBack: number, hour = 12): Date {
  return new Date(Date.UTC(2026, 4, 16, hour, 0, 0) - daysBack * 24 * 60 * 60 * 1000);
}

function emailEntry(sent_at: Date, tenant = 'BIL'): EmailLedgerEntry {
  return {
    message_id: `mid-${sent_at.toISOString()}`,
    status: 'sent',
    sent_at: sent_at.toISOString(),
    transport: 'stub',
    tenant_id: tenant,
    to: ['a@b.c'],
    subject: 'test',
    body_text: 'hi',
  };
}

function smsEntry(sent_at: Date, tenant = 'BIL'): SmsLedgerEntry {
  return {
    message_id: `sms-${sent_at.toISOString()}`,
    status: 'sent',
    segments: 1,
    sent_at: sent_at.toISOString(),
    transport: 'stub',
    tenant_id: tenant,
    to: '+254700000001',
    body: 'hi',
  };
}

function pushEntry(sent_at: Date, tenant = 'BIL'): PushLedgerEntry {
  return {
    message_id: `push-${sent_at.toISOString()}`,
    status: 'sent',
    sent_at: sent_at.toISOString(),
    transport: 'stub',
    per_device: [{ device_token: 't', platform: 'fcm', status: 'sent' }],
    tenant_id: tenant,
    to: [{ device_token: 't', platform: 'fcm', user_id: 'u' }],
    title: 't',
    body: 'b',
  };
}

function makeDailyApp(role = 'admin') {
  const emailTransport = new StubEmailTransport();
  const smsTransport = new StubSmsTransport();
  const pushTransport = new StubPushTransport();
  const built = makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    emailTransport,
    smsTransport,
    pushTransport,
    now: () => NOW,
    getRole: () => role,
  });
  return { ...built, emailTransport, smsTransport, pushTransport };
}

// ─── summarizeNotificationDailyVolume — pure ─────────────────────────

describe('M10.15 — empty input', () => {
  test('zero ledgers → every day at 0 with every by_channel key at 0', () => {
    const s = summarizeNotificationDailyVolume('BIL', [], [], [], 7, NOW);
    expect(s.tenant_id).toBe('BIL');
    expect(s.days).toBe(7);
    expect(s.by_day.length).toBe(7);
    expect(s.total_sent_in_window).toBe(0);
    expect(s.total_sent_observed).toBe(0);
    expect(s.peak_day).toBeNull();
    expect(s.mean_per_day).toBe(0);
    expect(s.growth_rate).toBeNull();
    expect(s.busiest_channel).toBeNull();
    for (const b of s.by_day) {
      expect(b.total).toBe(0);
      expect(b.by_channel.email).toBe(0);
      expect(b.by_channel.sms).toBe(0);
      expect(b.by_channel.push).toBe(0);
    }
  });
});

describe('M10.15 — window boundaries', () => {
  test('window_start = now - (days-1); window_end = today UTC', () => {
    const s = summarizeNotificationDailyVolume('BIL', [], [], [], 7, NOW);
    expect(s.window_end).toBe('2026-05-16');
    expect(s.window_start).toBe('2026-05-10');
  });

  test('days=1 → only today', () => {
    const s = summarizeNotificationDailyVolume('BIL', [], [], [], 1, NOW);
    expect(s.by_day.length).toBe(1);
    expect(s.window_start).toBe('2026-05-16');
    expect(s.window_end).toBe('2026-05-16');
  });

  test('by_day in oldest-first order', () => {
    const s = summarizeNotificationDailyVolume('BIL', [], [], [], 3, NOW);
    expect(s.by_day.map((b) => b.date)).toEqual(['2026-05-14', '2026-05-15', '2026-05-16']);
  });
});

describe('M10.15 — single send placement', () => {
  test('email lands in correct UTC day + correct by_channel key', () => {
    const s = summarizeNotificationDailyVolume(
      'BIL',
      [emailEntry(daysBackAt(2, 14))],
      [],
      [],
      7,
      NOW,
    );
    const day = s.by_day.find((b) => b.date === '2026-05-14')!;
    expect(day.total).toBe(1);
    expect(day.by_channel.email).toBe(1);
    expect(day.by_channel.sms).toBe(0);
    expect(day.by_channel.push).toBe(0);
  });

  test('sms lands in by_channel.sms', () => {
    const s = summarizeNotificationDailyVolume('BIL', [], [smsEntry(daysBackAt(1))], [], 7, NOW);
    const day = s.by_day.find((b) => b.date === '2026-05-15')!;
    expect(day.by_channel.sms).toBe(1);
  });

  test('push lands in by_channel.push', () => {
    const s = summarizeNotificationDailyVolume('BIL', [], [], [pushEntry(daysBackAt(1))], 7, NOW);
    const day = s.by_day.find((b) => b.date === '2026-05-15')!;
    expect(day.by_channel.push).toBe(1);
  });
});

describe('M10.15 — events outside window excluded', () => {
  test('old send counted in total_sent_observed but excluded from per-day buckets', () => {
    const s = summarizeNotificationDailyVolume(
      'BIL',
      [emailEntry(daysBackAt(1)), emailEntry(daysBackAt(60))],
      [],
      [],
      7,
      NOW,
    );
    expect(s.total_sent_observed).toBe(2);
    expect(s.total_sent_in_window).toBe(1);
  });
});

describe('M10.15 — partition invariants', () => {
  test('Σ by_channel per day = day.total', () => {
    const t = daysBackAt(1);
    const s = summarizeNotificationDailyVolume(
      'BIL',
      [emailEntry(t)],
      [smsEntry(t)],
      [pushEntry(t)],
      7,
      NOW,
    );
    const day = s.by_day.find((b) => b.date === '2026-05-15')!;
    const sum = day.by_channel.email + day.by_channel.sms + day.by_channel.push;
    expect(sum).toBe(day.total);
    expect(day.total).toBe(3);
  });

  test('Σ by_day.total = total_sent_in_window', () => {
    const s = summarizeNotificationDailyVolume(
      'BIL',
      [emailEntry(daysBackAt(1)), emailEntry(daysBackAt(3))],
      [smsEntry(daysBackAt(2))],
      [pushEntry(daysBackAt(4))],
      7,
      NOW,
    );
    const sum = s.by_day.reduce((acc, b) => acc + b.total, 0);
    expect(sum).toBe(s.total_sent_in_window);
    expect(s.total_sent_in_window).toBe(4);
  });
});

describe('M10.15 — peak_day', () => {
  test('points at highest-volume day', () => {
    const s = summarizeNotificationDailyVolume(
      'BIL',
      [emailEntry(daysBackAt(2, 10)), emailEntry(daysBackAt(2, 11)), emailEntry(daysBackAt(2, 12))],
      [smsEntry(daysBackAt(1))],
      [],
      7,
      NOW,
    );
    expect(s.peak_day).toBe('2026-05-14'); // 3 sends 2 days back
    expect(s.peak_count).toBe(3);
  });

  test('earliest-day-wins tie-break', () => {
    const s = summarizeNotificationDailyVolume(
      'BIL',
      [emailEntry(daysBackAt(5)), emailEntry(daysBackAt(1))],
      [],
      [],
      7,
      NOW,
    );
    expect(s.peak_day).toBe('2026-05-11'); // 5 days back (earlier)
  });

  test('null when no sends', () => {
    const s = summarizeNotificationDailyVolume('BIL', [], [], [], 7, NOW);
    expect(s.peak_day).toBeNull();
  });
});

describe('M10.15 — mean_per_day', () => {
  test('= round(total / days)', () => {
    const sends: EmailLedgerEntry[] = [];
    for (let d = 0; d < 7; d++) {
      sends.push(emailEntry(daysBackAt(d, 10)));
      sends.push(emailEntry(daysBackAt(d, 11)));
    }
    const s = summarizeNotificationDailyVolume('BIL', sends, [], [], 7, NOW);
    expect(s.mean_per_day).toBe(2);
  });
});

describe('M10.15 — growth_rate', () => {
  test('positive when second half outweighs first half', () => {
    const emails: EmailLedgerEntry[] = [];
    // 10-day window. First half (9..5): 1 send. Second half (4..0): 5 sends.
    emails.push(emailEntry(daysBackAt(9)));
    for (let d = 0; d < 5; d++) emails.push(emailEntry(daysBackAt(d)));
    const s = summarizeNotificationDailyVolume('BIL', emails, [], [], 10, NOW);
    expect(s.growth_rate).toBeCloseTo(4);
  });

  test('null when first-half mean is 0', () => {
    const s = summarizeNotificationDailyVolume(
      'BIL',
      [emailEntry(daysBackAt(0))],
      [],
      [],
      10,
      NOW,
    );
    expect(s.growth_rate).toBeNull();
  });

  test('null when days < 2', () => {
    const s = summarizeNotificationDailyVolume(
      'BIL',
      [emailEntry(daysBackAt(0))],
      [],
      [],
      1,
      NOW,
    );
    expect(s.growth_rate).toBeNull();
  });
});

describe('M10.15 — busiest_channel', () => {
  test('points at channel with highest total across window', () => {
    const s = summarizeNotificationDailyVolume(
      'BIL',
      [emailEntry(daysBackAt(1))],
      [smsEntry(daysBackAt(1)), smsEntry(daysBackAt(2)), smsEntry(daysBackAt(3))],
      [],
      7,
      NOW,
    );
    expect(s.busiest_channel).toBe('sms');
  });

  test('canonical tie-break: email > sms > push at same total', () => {
    const s = summarizeNotificationDailyVolume(
      'BIL',
      [emailEntry(daysBackAt(1))],
      [smsEntry(daysBackAt(2))],
      [],
      7,
      NOW,
    );
    expect(s.busiest_channel).toBe('email'); // tied at 1; email wins canonical
  });

  test('null when no sends', () => {
    const s = summarizeNotificationDailyVolume('BIL', [], [], [], 7, NOW);
    expect(s.busiest_channel).toBeNull();
  });
});

describe('M10.15 — days validation', () => {
  test('throws on days=0', () => {
    expect(() => summarizeNotificationDailyVolume('BIL', [], [], [], 0, NOW))
      .toThrow(NotificationDailyVolumeError);
  });

  test('throws on days > MAX', () => {
    expect(() =>
      summarizeNotificationDailyVolume('BIL', [], [], [], MAX_NOTIF_DAILY_WINDOW + 1, NOW),
    ).toThrow();
  });

  test('throws on non-integer days', () => {
    expect(() => summarizeNotificationDailyVolume('BIL', [], [], [], 1.5, NOW)).toThrow();
  });

  test('accepts MAX_NOTIF_DAILY_WINDOW', () => {
    const s = summarizeNotificationDailyVolume('BIL', [], [], [], MAX_NOTIF_DAILY_WINDOW, NOW);
    expect(s.days).toBe(MAX_NOTIF_DAILY_WINDOW);
    expect(s.by_day.length).toBe(MAX_NOTIF_DAILY_WINDOW);
  });
});

// ─── GET /v1/notifications/daily-volume ──────────────────────────────

describe('M10.15 — GET /v1/notifications/daily-volume', () => {
  test('admin → 200 with default window=30 on fresh tenant', async () => {
    const { app } = makeDailyApp('admin');
    const r = await request(app).get('/v1/notifications/daily-volume').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.days).toBe(DEFAULT_NOTIF_DAILY_WINDOW);
    expect(r.body.body.by_day.length).toBe(DEFAULT_NOTIF_DAILY_WINDOW);
    expect(r.body.body.total_sent_in_window).toBe(0);
  });

  test('populated rollup reflects sends across all 3 channels', async () => {
    const { app, emailTransport, smsTransport, pushTransport } = makeDailyApp('admin');
    await emailTransport.send('BIL', { to: ['a@b.c'], subject: 's', body_text: 'b' });
    await smsTransport.send('BIL', { to: '+254700000000', body: 'b' });
    await pushTransport.send('BIL', {
      to: [{ device_token: 't', platform: 'fcm', user_id: 'u' }],
      title: 't',
      body: 'b',
    });
    const r = await request(app).get('/v1/notifications/daily-volume?days=7').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_sent_in_window).toBe(3);
    expect(r.body.body.busiest_channel).not.toBeNull();
  });

  test('?days=invalid → 400', async () => {
    const { app } = makeDailyApp('admin');
    const r = await request(app).get('/v1/notifications/daily-volume?days=0').set(TH_BIL);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_input');
  });

  test('?days too large → 400', async () => {
    const { app } = makeDailyApp('admin');
    const r = await request(app)
      .get(`/v1/notifications/daily-volume?days=${MAX_NOTIF_DAILY_WINDOW + 1}`)
      .set(TH_BIL);
    expect(r.status).toBe(400);
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeDailyApp('case_owner');
    const r = await request(app).get('/v1/notifications/daily-volume').set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('cross-tenant: BIL sends invisible to BANK_DEMO', async () => {
    const { app, emailTransport } = makeDailyApp('admin');
    await emailTransport.send('BIL', { to: ['a@b.c'], subject: 's', body_text: 'b' });
    const bank = await request(app)
      .get('/v1/notifications/daily-volume?days=7')
      .set('X-Tenant-ID', 'BANK_DEMO')
      .set('X-Channel', 'API');
    expect(bank.status).toBe(200);
    expect(bank.body.body.total_sent_in_window).toBe(0);
  });

  test('M10.12 /v1/notifications/ledger-analytics still works (sibling regression)', async () => {
    const { app } = makeDailyApp('admin');
    const r = await request(app).get('/v1/notifications/ledger-analytics').set(TH_BIL);
    expect(r.status).toBe(200);
  });
});
