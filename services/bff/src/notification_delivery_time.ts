// services/bff/src/notification_delivery_time.ts
// T6 M10.25 — Notification delivery time analysis.
// Computes simulated delivery time estimates per channel using deterministic PRNG.

import { type EmailTransport } from './notifications/email';
import { type SmsTransport } from './notifications/sms';
import { type PushTransport } from './notifications/push';
import {
  defaultEmailTransport,
  StubEmailTransport,
} from './notifications/email';
import {
  defaultSmsTransport,
  StubSmsTransport,
} from './notifications/sms';
import {
  defaultPushTransport,
  StubPushTransport,
} from './notifications/push';

function fnv1a(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = ((h ^ s.charCodeAt(i)) * 16777619) >>> 0;
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let t = seed;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = t;
    r = ((r ^ (r >>> 15)) * (r | 1)) >>> 0;
    r = (r ^ (r + ((r ^ (r >>> 7)) * (r | 61)))) >>> 0;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

export interface ChannelDeliveryTimeStats {
  channel: 'email' | 'sms' | 'push';
  avg_delivery_seconds: number;
  p95_delivery_seconds: number;
  sla_met: boolean;
  sample_size: number;
}

export interface NotificationDeliveryTimeResult {
  tenant_id: string;
  generated_at: string;
  channels: ChannelDeliveryTimeStats[];
  all_sla_met: boolean;
  fastest_channel: 'email' | 'sms' | 'push' | null;
  slowest_channel: 'email' | 'sms' | 'push' | null;
}

// SLA thresholds per channel (seconds)
const SLA_THRESHOLDS = { email: 5, sms: 3, push: 2 };
// Base range: [min, max] seconds
const BASE_RANGES = { email: [1, 5] as [number, number], sms: [0.5, 3] as [number, number], push: [0.1, 1] as [number, number] };

function buildChannelStats(
  channel: 'email' | 'sms' | 'push',
  tenant_id: string,
  sampleSize: number,
  dayKey: number,
): ChannelDeliveryTimeStats {
  const [minS, maxS] = BASE_RANGES[channel];
  const times: number[] = [];

  for (let i = 0; i < sampleSize; i++) {
    const seed = fnv1a(`${tenant_id}:delivery_time:${channel}:${i}:${dayKey}`);
    const rng = mulberry32(seed);
    times.push(minS + rng() * (maxS - minS));
  }

  times.sort((a, b) => a - b);

  const avg = times.reduce((s, v) => s + v, 0) / times.length;
  const p95Idx = Math.floor(0.95 * (times.length - 1));
  const p95 = times[p95Idx];

  return {
    channel,
    avg_delivery_seconds: Math.round(avg * 100) / 100,
    p95_delivery_seconds: Math.round(p95 * 100) / 100,
    sla_met: p95 < SLA_THRESHOLDS[channel],
    sample_size: sampleSize,
  };
}

export function buildNotificationDeliveryTime(
  emailTransport: EmailTransport,
  smsTransport: SmsTransport,
  pushTransport: PushTransport,
  tenant_id: string,
  now: Date,
): NotificationDeliveryTimeResult {
  if (!tenant_id) throw new Error('tenant_id required');

  const dayKey = Math.floor(now.getTime() / 86_400_000);

  // Get sample sizes from ledger
  const emailEntries = emailTransport.recent(tenant_id, 500);
  const smsEntries = smsTransport.recent(tenant_id, 500);
  const pushEntries = pushTransport.recent(tenant_id, 500);

  const emailSize = Math.max(emailEntries.length, 20);
  const smsSize = Math.max(smsEntries.length, 20);
  const pushSize = Math.max(pushEntries.length, 20);

  const channels: ChannelDeliveryTimeStats[] = [
    buildChannelStats('email', tenant_id, emailSize, dayKey),
    buildChannelStats('sms', tenant_id, smsSize, dayKey),
    buildChannelStats('push', tenant_id, pushSize, dayKey),
  ];

  const all_sla_met = channels.every((c) => c.sla_met);

  const sorted = [...channels].sort((a, b) => a.avg_delivery_seconds - b.avg_delivery_seconds);
  const fastest = sorted[0]?.channel ?? null;
  const slowest = sorted[sorted.length - 1]?.channel ?? null;

  return {
    tenant_id,
    generated_at: now.toISOString(),
    channels,
    all_sla_met,
    fastest_channel: fastest,
    slowest_channel: slowest,
  };
}
