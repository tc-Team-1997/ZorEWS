// services/bff/src/rule_engine_throughput.ts
// T6 M5.27 — Rule engine throughput metrics.
// Synthesizes rule engine performance metrics using deterministic PRNG.

import { defaultStore as defaultRuleStore } from './rules/store';

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

export type ThroughputStatus = 'optimal' | 'good' | 'degraded';

export interface RuleEngineThroughputResult {
  tenant_id: string;
  generated_at: string;
  evaluations_per_second: number;
  avg_evaluation_ms: number;
  rules_loaded: number;
  cache_hit_rate: number;
  memory_usage_mb: number;
  efficiency_score: number;
  status: ThroughputStatus;
}

export function buildRuleEngineThroughput(
  tenant_id: string,
  now: Date,
): RuleEngineThroughputResult {
  if (!tenant_id) throw new Error('tenant_id required');

  const dayKey = Math.floor(now.getTime() / 86_400_000);
  const seed = fnv1a(`${tenant_id}:rule_engine_throughput:${dayKey}`);
  const rng = mulberry32(seed);

  const evaluations_per_second = Math.floor(100 + rng() * 400); // 100-500
  const avg_evaluation_ms = Math.round((0.5 + rng() * 4.5) * 10) / 10; // 0.5-5ms
  const cache_hit_rate = Math.round((0.7 + rng() * 0.25) * 10000) / 10000; // 0.7-0.95
  const memory_usage_mb = Math.floor(50 + rng() * 150); // 50-200

  // Attempt to get actual rules_loaded from the store; fall back to 30
  let rules_loaded = 30;
  try {
    const all = defaultRuleStore.list();
    if (Array.isArray(all)) {
      rules_loaded = all.length || 30;
    }
  } catch {
    // ignore
  }

  const efficiency_score = Math.round(
    cache_hit_rate * 50 + (1 - avg_evaluation_ms / 5) * 30 + 20,
  );

  let status: ThroughputStatus;
  if (efficiency_score >= 80) status = 'optimal';
  else if (efficiency_score >= 60) status = 'good';
  else status = 'degraded';

  return {
    tenant_id,
    generated_at: now.toISOString(),
    evaluations_per_second,
    avg_evaluation_ms,
    rules_loaded,
    cache_hit_rate,
    memory_usage_mb,
    efficiency_score,
    status,
  };
}
