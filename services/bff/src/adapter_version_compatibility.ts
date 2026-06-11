// services/bff/src/adapter_version_compatibility.ts
// T6 M14.40 — Adapter API version compatibility

import { listFleetAdapters } from './adapter_health';

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

export type CompatibilityTier = 'current' | 'compatible' | 'legacy';

export interface AdapterVersionInfo {
  adapter_id: string;
  label: string;
  api_version: string;
  deprecated_endpoints_count: number;
  last_breaking_change_days_ago: number;
  compatibility_score: number;
  compatibility_tier: CompatibilityTier;
}

export interface AdapterVersionCompatibility {
  tenant_id: string;
  generated_at: string;
  adapters: AdapterVersionInfo[];
  current_count: number;
  legacy_count: number;
  avg_compatibility_score: number;
  adapters_needing_upgrade: string[];
}

const API_VERSIONS = ['v1', 'v2', 'v3'] as const;

export function buildAdapterVersionCompatibility(
  tenant_id: string,
  now: Date
): AdapterVersionCompatibility {
  const generated_at = now.toISOString();
  const fleet = listFleetAdapters();
  const day = Math.floor(now.getTime() / 86400000);

  const adapters: AdapterVersionInfo[] = fleet.map((adapter) => {
    const seed = fnv1a(`${adapter.adapter_id}:version:${day}`);
    const rng = mulberry32(seed);

    const versionIdx = Math.floor(rng() * 3);
    const api_version = API_VERSIONS[versionIdx]!;
    const deprecated_endpoints_count = Math.floor(rng() * 6); // 0-5
    const last_breaking_change_days_ago = Math.floor(rng() * 365); // 0-364

    let compatibility_score = 100;
    compatibility_score -= deprecated_endpoints_count * 15;
    if (last_breaking_change_days_ago < 30) compatibility_score -= 20;
    compatibility_score = Math.max(0, compatibility_score);

    let compatibility_tier: CompatibilityTier;
    if (compatibility_score >= 85) compatibility_tier = 'current';
    else if (compatibility_score >= 65) compatibility_tier = 'compatible';
    else compatibility_tier = 'legacy';

    return {
      adapter_id: adapter.adapter_id,
      label: adapter.label,
      api_version,
      deprecated_endpoints_count,
      last_breaking_change_days_ago,
      compatibility_score,
      compatibility_tier,
    };
  });

  // Sort by compatibility_score asc (worst first)
  adapters.sort((a, b) => a.compatibility_score - b.compatibility_score);

  const current_count = adapters.filter((a) => a.compatibility_tier === 'current').length;
  const legacy_count = adapters.filter((a) => a.compatibility_tier === 'legacy').length;

  const avg_compatibility_score = adapters.length > 0
    ? Math.round(adapters.reduce((s, a) => s + a.compatibility_score, 0) / adapters.length)
    : 100;

  const adapters_needing_upgrade = adapters
    .filter((a) => a.compatibility_tier === 'legacy' || a.deprecated_endpoints_count > 2)
    .map((a) => a.adapter_id);

  return {
    tenant_id,
    generated_at,
    adapters,
    current_count,
    legacy_count,
    avg_compatibility_score,
    adapters_needing_upgrade,
  };
}
