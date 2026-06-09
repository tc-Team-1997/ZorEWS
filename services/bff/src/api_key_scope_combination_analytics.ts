// services/bff/src/api_key_scope_combination_analytics.ts
//
// T6 M1.20 — API key scope combination analytics.
//
// Groups ACTIVE API keys by their scopes[] combination and surfaces
// the most common scope sets in use. Drives the SPA's "what scope
// bundles are ops teams provisioning?" governance view.
//
// Distinct from:
//   M1.5  — scope 1D distribution (per-scope count)
//   M1.8  — scope × status cross-tab matrix
//   M1.12 — scope × creator cross-tab matrix
//
// Route: GET /v1/admin/api-keys/scope-combination-analytics
//   RBAC: audit:read (admin-only)
//   Tenant-scoped. Mounted BEFORE /:key_id wildcard.

import type { ApiKeyEntry } from './api_keys';

// ─── Public types ──────────────────────────────────────────────────────

export interface ScopeCombinationEntry {
  /** Sorted, comma-joined scope list used as the combination key. */
  combination: string;
  /** Number of scopes in this combination. */
  scope_count: number;
  /** Number of active keys using this combination. */
  key_count: number;
  /** Up to 3 key_id values for SPA drill-through; sorted asc. */
  sample_key_ids: string[];
  /** ISO timestamp of the newest created_at among keys in this combo. */
  most_recent_created_at: string | null;
}

export interface ApiKeyScopeCombinationAnalytics {
  tenant_id: string;
  generated_at: string;
  total_active_keys: number;
  /** Number of distinct scope combinations observed. */
  total_combinations: number;
  /** Top-10 combinations sorted key_count desc + combination asc tie-break. */
  combinations: ScopeCombinationEntry[];
  /** Highest key_count combination; null when no active keys. */
  most_common: { combination: string; key_count: number } | null;
  /** Fraction of active keys that carry only 1 scope (0..1). */
  single_scope_pct: number;
  /** Fraction of active keys with 2+ scopes (0..1). */
  multi_scope_pct: number;
}

// ─── Constants ─────────────────────────────────────────────────────────

const MAX_COMBINATIONS = 10;
const SAMPLE_CAP = 3;

// ─── Implementation ─────────────────────────────────────────────────────

export function buildApiKeyScopeCombinationAnalytics(
  tenant_id: string,
  entries: ApiKeyEntry[],
  now: Date,
): ApiKeyScopeCombinationAnalytics {
  if (!tenant_id || tenant_id.trim() === '') {
    throw new Error('tenant_id is required');
  }

  const generated_at = now.toISOString();

  // Only active keys are relevant
  const active = entries.filter(e => e.status === 'active');
  const total_active_keys = active.length;

  if (total_active_keys === 0) {
    return {
      tenant_id,
      generated_at,
      total_active_keys: 0,
      total_combinations: 0,
      combinations: [],
      most_common: null,
      single_scope_pct: 0,
      multi_scope_pct: 0,
    };
  }

  // Build combination map
  const map = new Map<
    string,
    { key_ids: string[]; most_recent: string | null }
  >();

  for (const key of active) {
    const sorted = [...key.scopes].sort();
    const combo = sorted.join(',');
    const existing = map.get(combo);
    if (existing) {
      existing.key_ids.push(key.key_id);
      if (
        key.created_at &&
        (existing.most_recent === null || key.created_at > existing.most_recent)
      ) {
        existing.most_recent = key.created_at;
      }
    } else {
      map.set(combo, {
        key_ids: [key.key_id],
        most_recent: key.created_at ?? null,
      });
    }
  }

  const total_combinations = map.size;

  // Build sorted list: key_count desc + combination asc tie-break
  const all: ScopeCombinationEntry[] = [];
  for (const [combination, { key_ids, most_recent }] of map.entries()) {
    const sortedIds = [...key_ids].sort();
    all.push({
      combination,
      scope_count: combination === '' ? 0 : combination.split(',').length,
      key_count: key_ids.length,
      sample_key_ids: sortedIds.slice(0, SAMPLE_CAP),
      most_recent_created_at: most_recent,
    });
  }

  all.sort((a, b) => {
    if (b.key_count !== a.key_count) return b.key_count - a.key_count;
    return a.combination.localeCompare(b.combination);
  });

  const combinations = all.slice(0, MAX_COMBINATIONS);

  const most_common =
    all.length > 0
      ? { combination: all[0]!.combination, key_count: all[0]!.key_count }
      : null;

  // Single vs multi scope percentages
  const singleScopeCount = active.filter(k => k.scopes.length === 1).length;
  const multiScopeCount = active.filter(k => k.scopes.length > 1).length;

  const single_scope_pct =
    total_active_keys > 0
      ? Math.round((singleScopeCount / total_active_keys) * 10000) / 10000
      : 0;
  const multi_scope_pct =
    total_active_keys > 0
      ? Math.round((multiScopeCount / total_active_keys) * 10000) / 10000
      : 0;

  return {
    tenant_id,
    generated_at,
    total_active_keys,
    total_combinations,
    combinations,
    most_common,
    single_scope_pct,
    multi_scope_pct,
  };
}
