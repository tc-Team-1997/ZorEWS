// services/bff/src/api_key_scope_distribution.ts
//
// T6 M1.5 — Service-account API key scope distribution rollup.
//
// M1.4 ships the BY-KEY usage analytics view (per-key freshness +
// dormancy + expiry). M1.5 ships the orthogonal BY-SCOPE pivot:
// for every scope in VALID_SCOPES, surface how many keys carry it,
// when the latest key was created, who last used it.
//
// Mirror of M5.16 / M11.11 / M12.11 / M7.12 pivot pattern (every-
// enum-key-present-at-0 + envelope leaderboards).
//
// Use case: BIL admin opens the API keys page and wants the answer
// to "which scope is most heavily used? are any scopes that nobody
// uses still in our catalogue (cleanup candidate)? when did anyone
// last call `webhooks:dispatch`?". M1.4 surfaces those at the key
// level — M1.5 surfaces them at the scope level for capacity
// planning + access review.
//
// Pure rollup over the redacted ApiKeyEntry[] surface (NOT the
// internal record — never touches hash/secret). Tenant-scoped at
// the caller layer.

import type { ApiKeyEntry, ApiKeyScope } from './api_keys';
import { VALID_SCOPES } from './api_keys';

// ─── Public types ─────────────────────────────────────────────────────

export interface ScopeDistributionRow {
  scope: ApiKeyScope;
  /** Total keys carrying this scope (active + revoked). */
  total_keys: number;
  /** Active-status keys carrying this scope. */
  active_keys: number;
  /** Revoked-status keys carrying this scope. */
  revoked_keys: number;
  /** Active keys with last_used_at != null. */
  ever_used_count: number;
  /** Newest created_at of an active key carrying this scope.
   *  null when no active key has it. */
  latest_active_created_at: string | null;
  /** The active key with the newest last_used_at carrying this
   *  scope. null when no active key with usage has it. */
  most_recently_used_key_id: string | null;
  /** Timestamp at most_recently_used_key_id. null when none. */
  most_recently_used_at: string | null;
}

export interface ApiKeyScopeDistributionSummary {
  tenant_id: string;
  generated_at: string;
  total_keys: number;
  total_active_keys: number;
  total_revoked_keys: number;
  /** Every VALID_SCOPES scope in canonical order even when zero
   *  — stable SPA grid. */
  scopes: ScopeDistributionRow[];
  /** Highest active_keys count. Canonical-order tie-break (the
   *  first scope in VALID_SCOPES wins at same count). null when
   *  no active keys carry any scope. */
  most_used_scope: ApiKeyScope | null;
  /** Scopes with zero ACTIVE keys (subset filter; revoked still
   *  counts toward the row but the SPA flags unused for cleanup).
   *  In canonical VALID_SCOPES order. */
  unused_scopes: ApiKeyScope[];
  /** Fraction of VALID_SCOPES with at least one active key
   *  carrying them. 0..1. */
  scope_coverage_rate: number;
}

// ─── Helpers ──────────────────────────────────────────────────────────

interface RowBuilder {
  total_keys: number;
  active_keys: number;
  revoked_keys: number;
  ever_used_count: number;
  latest_active_created_at: string | null;
  most_recently_used_key_id: string | null;
  most_recently_used_at: string | null;
}

function emptyBuilder(): RowBuilder {
  return {
    total_keys: 0,
    active_keys: 0,
    revoked_keys: 0,
    ever_used_count: 0,
    latest_active_created_at: null,
    most_recently_used_key_id: null,
    most_recently_used_at: null,
  };
}

// ─── Pure resolver ────────────────────────────────────────────────────

export function summarizeApiKeyScopeDistribution(
  tenant_id: string,
  entries: readonly ApiKeyEntry[],
  now: Date,
): ApiKeyScopeDistributionSummary {
  // Initialise every scope so the SPA grid is stable.
  const builders = new Map<ApiKeyScope, RowBuilder>();
  for (const s of VALID_SCOPES) builders.set(s, emptyBuilder());

  let total_active_keys = 0;
  let total_revoked_keys = 0;

  for (const entry of entries) {
    if (entry.status === 'active') total_active_keys++;
    else total_revoked_keys++;

    // Defensive dedup: if a key lists the same scope twice (shouldn't
    // happen but guarding against bad data), we count once per row.
    const scopeSet = new Set(entry.scopes);
    for (const scope of scopeSet) {
      const b = builders.get(scope);
      if (!b) continue; // unknown scope (registry bug) — skip
      b.total_keys++;
      if (entry.status === 'active') {
        b.active_keys++;
        if (entry.last_used_at !== null) b.ever_used_count++;
        if (
          !b.latest_active_created_at
          || entry.created_at > b.latest_active_created_at
        ) {
          b.latest_active_created_at = entry.created_at;
        }
        if (
          entry.last_used_at !== null
          && (!b.most_recently_used_at || entry.last_used_at > b.most_recently_used_at)
        ) {
          b.most_recently_used_at = entry.last_used_at;
          b.most_recently_used_key_id = entry.key_id;
        }
      } else {
        b.revoked_keys++;
      }
    }
  }

  // Materialise scopes[] in canonical VALID_SCOPES order.
  const scopes: ScopeDistributionRow[] = VALID_SCOPES.map((scope) => {
    const b = builders.get(scope)!;
    return {
      scope,
      total_keys: b.total_keys,
      active_keys: b.active_keys,
      revoked_keys: b.revoked_keys,
      ever_used_count: b.ever_used_count,
      latest_active_created_at: b.latest_active_created_at,
      most_recently_used_key_id: b.most_recently_used_key_id,
      most_recently_used_at: b.most_recently_used_at,
    };
  });

  // most_used_scope: highest active_keys with canonical-order tie-break.
  let most_used_scope: ApiKeyScope | null = null;
  let mostCount = 0;
  for (const s of VALID_SCOPES) {
    const row = builders.get(s)!;
    if (row.active_keys > mostCount) {
      mostCount = row.active_keys;
      most_used_scope = s;
    }
  }
  if (mostCount === 0) most_used_scope = null;

  const unused_scopes = VALID_SCOPES.filter(
    (s) => builders.get(s)!.active_keys === 0,
  );

  const usedCount = VALID_SCOPES.length - unused_scopes.length;
  const scope_coverage_rate = VALID_SCOPES.length > 0
    ? usedCount / VALID_SCOPES.length
    : 0;

  return {
    tenant_id,
    generated_at: now.toISOString(),
    total_keys: entries.length,
    total_active_keys,
    total_revoked_keys,
    scopes,
    most_used_scope,
    unused_scopes,
    scope_coverage_rate,
  };
}
