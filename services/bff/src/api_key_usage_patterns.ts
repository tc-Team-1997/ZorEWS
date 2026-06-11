// services/bff/src/api_key_usage_patterns.ts
// T6 M1.27 — API key usage pattern clustering.
// Groups active keys by their scope combination and returns usage stats per pattern.

import { type ApiKeyStore, type ApiKeyEntry, VALID_SCOPES } from './api_keys';

export interface UsagePattern {
  pattern: string; // sorted joined scopes e.g. "alerts:read,audit:read"
  scopes: string[];
  key_count: number;
  avg_age_days: number;
  usage_rate: number; // keys with last_used_at / total in this pattern
}

export interface ApiKeyUsagePatternsResult {
  tenant_id: string;
  generated_at: string;
  total_active_keys: number;
  patterns: UsagePattern[];
  most_common_pattern: string | null;
  single_scope_keys: number; // keys with exactly 1 scope
  full_access_keys: number;  // keys with all scopes
}

export function buildApiKeyUsagePatterns(
  store: ApiKeyStore,
  tenant_id: string,
  now: Date,
): ApiKeyUsagePatternsResult {
  if (!tenant_id) throw new Error('tenant_id required');

  const page = store.list(tenant_id, 1, 500);
  const active = page.items.filter((e: ApiKeyEntry) => e.status === 'active');

  const nowMs = now.getTime();
  const groups = new Map<string, ApiKeyEntry[]>();

  for (const entry of active) {
    const key = [...entry.scopes].sort().join(',');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(entry);
  }

  const patterns: UsagePattern[] = [];
  for (const [pattern, keys] of groups) {
    const usedCount = keys.filter((k) => k.last_used_at != null).length;
    const totalAgeDays = keys.reduce((sum, k) => {
      const createdMs = k.created_at ? new Date(k.created_at).getTime() : nowMs;
      return sum + (nowMs - createdMs) / 86_400_000;
    }, 0);
    patterns.push({
      pattern,
      scopes: pattern ? pattern.split(',') : [],
      key_count: keys.length,
      avg_age_days: keys.length > 0 ? Math.round((totalAgeDays / keys.length) * 10) / 10 : 0,
      usage_rate: keys.length > 0 ? Math.round((usedCount / keys.length) * 10000) / 10000 : 0,
    });
  }

  patterns.sort((a, b) => b.key_count - a.key_count || a.pattern.localeCompare(b.pattern));

  const mostCommon = patterns.length > 0 ? patterns[0].pattern : null;
  const singleScope = active.filter((e) => e.scopes.length === 1).length;
  const fullAccess = active.filter((e) => e.scopes.length >= VALID_SCOPES.length).length;

  return {
    tenant_id,
    generated_at: now.toISOString(),
    total_active_keys: active.length,
    patterns,
    most_common_pattern: mostCommon,
    single_scope_keys: singleScope,
    full_access_keys: fullAccess,
  };
}
