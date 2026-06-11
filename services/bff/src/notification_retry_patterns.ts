// services/bff/src/notification_retry_patterns.ts
// T6 M10.26 — Notification retry pattern analysis.

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

export type EfficiencyGrade = 'A' | 'B' | 'C' | 'D';

const CHANNELS = ['email', 'sms', 'push'] as const;
type Channel = (typeof CHANNELS)[number];

export interface ChannelRetryPattern {
  channel: Channel;
  retry_rate: number;
  avg_retries_per_failure: number;
  retry_success_rate: number;
  cost_multiplier: number;
  efficiency_grade: EfficiencyGrade;
}

export interface NotificationRetryPatterns {
  tenant_id: string;
  generated_at: string;
  channels: ChannelRetryPattern[];
  highest_retry_channel: Channel | null;
  total_estimated_overhead_pct: number;
}

function gradeFromRetryRate(retry_rate: number, retry_success_rate: number): EfficiencyGrade {
  if (retry_rate < 0.03 && retry_success_rate > 0.9) return 'A';
  if (retry_rate < 0.07 && retry_success_rate > 0.8) return 'B';
  if (retry_rate < 0.11) return 'C';
  return 'D';
}

export function buildNotificationRetryPatterns(
  tenant_id: string,
  now: Date,
): NotificationRetryPatterns {
  const dayStr = now.toISOString().slice(0, 10);

  const channels: ChannelRetryPattern[] = CHANNELS.map((channel) => {
    const rng = mulberry32(fnv1a(`${tenant_id}:${channel}:${dayStr}:retry`));
    const retry_rate = Math.round((rng() * 0.15) * 10000) / 10000;
    const avg_retries_per_failure = Math.round((1 + rng() * 2) * 100) / 100;
    const retry_success_rate = Math.round((0.7 + rng() * 0.25) * 10000) / 10000;
    const cost_multiplier = Math.round((1 + retry_rate * avg_retries_per_failure) * 10000) / 10000;
    const efficiency_grade = gradeFromRetryRate(retry_rate, retry_success_rate);
    return { channel, retry_rate, avg_retries_per_failure, retry_success_rate, cost_multiplier, efficiency_grade };
  });

  channels.sort((a, b) => b.retry_rate - a.retry_rate);

  const highest_retry_channel: Channel | null = channels.length > 0 ? channels[0].channel : null;
  const total_estimated_overhead_pct = Math.round(
    channels.reduce((s, c) => s + c.retry_rate * c.avg_retries_per_failure, 0) / channels.length * 100 * 100,
  ) / 100;

  return { tenant_id, generated_at: now.toISOString(), channels, highest_retry_channel, total_estimated_overhead_pct };
}
