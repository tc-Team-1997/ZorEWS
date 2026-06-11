// services/bff/src/tenant_config_similarity.ts
//
// T6 M2.23 — Tenant configuration similarity analysis.
//
// For each pair of tenants, computes Jaccard similarity over the set
// of config keys each tenant has overridden. Useful for spotting
// tenants with identical customisation profiles (candidates for a
// shared config template) or highly divergent tenants.

import type { ConfigStore } from './admin_config';

// ─── Public types ──────────────────────────────────────────────────────

export interface TenantPairSimilarity {
  tenant_a: string;
  tenant_b: string;
  jaccard_similarity: number;
  common_overrides: string[];
  only_in_a: string[];
  only_in_b: string[];
}

export interface TenantConfigSimilarityReport {
  generated_at: string;
  total_tenants: number;
  pairs: TenantPairSimilarity[];
  most_similar_pair: { tenant_a: string; tenant_b: string; similarity: number } | null;
  most_divergent_pair: { tenant_a: string; tenant_b: string; similarity: number } | null;
  avg_similarity: number;
}

// ─── Pure function ─────────────────────────────────────────────────────

export async function buildTenantConfigSimilarity(
  tenants: string[],
  configStore: ConfigStore,
  now: Date,
): Promise<TenantConfigSimilarityReport> {
  const generated_at = now.toISOString();
  const total_tenants = tenants.length;

  // Build override key sets per tenant
  const overrideSets = new Map<string, Set<string>>();
  for (const t of tenants) {
    const entries = configStore.list(t);
    const keys = new Set(entries.filter(e => !e.is_default).map(e => e.key));
    overrideSets.set(t, keys);
  }

  const pairs: TenantPairSimilarity[] = [];

  for (let i = 0; i < tenants.length; i++) {
    for (let j = i + 1; j < tenants.length; j++) {
      const a = tenants[i];
      const b = tenants[j];
      if (!a || !b) continue;
      const setA = overrideSets.get(a) ?? new Set<string>();
      const setB = overrideSets.get(b) ?? new Set<string>();

      const common: string[] = [];
      const onlyA: string[] = [];
      const onlyB: string[] = [];

      for (const k of setA) {
        if (setB.has(k)) common.push(k);
        else onlyA.push(k);
      }
      for (const k of setB) {
        if (!setA.has(k)) onlyB.push(k);
      }

      const unionSize = setA.size + setB.size - common.length;
      const jaccard_similarity = unionSize === 0 ? 1 : common.length / unionSize;

      pairs.push({
        tenant_a: a,
        tenant_b: b,
        jaccard_similarity: Math.round(jaccard_similarity * 10000) / 10000,
        common_overrides: common.sort(),
        only_in_a: onlyA.sort(),
        only_in_b: onlyB.sort(),
      });
    }
  }

  // Sort by similarity desc, cap at 20
  pairs.sort((a, b) => b.jaccard_similarity - a.jaccard_similarity);
  const cappedPairs = pairs.slice(0, 20);

  let most_similar_pair: TenantConfigSimilarityReport['most_similar_pair'] = null;
  let most_divergent_pair: TenantConfigSimilarityReport['most_divergent_pair'] = null;

  if (pairs.length > 0) {
    const top = pairs[0];
    if (top) {
      most_similar_pair = { tenant_a: top.tenant_a, tenant_b: top.tenant_b, similarity: top.jaccard_similarity };
    }
    // Most divergent: only among pairs where both tenants have at least 1 override
    const diverging = pairs.filter(p => p.only_in_a.length > 0 || p.only_in_b.length > 0);
    if (diverging.length > 0) {
      const bot = diverging[diverging.length - 1];
      if (bot) {
        most_divergent_pair = { tenant_a: bot.tenant_a, tenant_b: bot.tenant_b, similarity: bot.jaccard_similarity };
      }
    }
  }

  const avg_similarity = pairs.length > 0
    ? Math.round((pairs.reduce((s, p) => s + p.jaccard_similarity, 0) / pairs.length) * 10000) / 10000
    : 0;

  return {
    generated_at,
    total_tenants,
    pairs: cappedPairs,
    most_similar_pair,
    most_divergent_pair,
    avg_similarity,
  };
}
