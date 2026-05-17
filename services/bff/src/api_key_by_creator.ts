// services/bff/src/api_key_by_creator.ts
//
// T6 M1.6 — API key by-creator governance rollup.
//
// M1.2 ships api-keys CRUD; M1.4 ships per-key usage analytics;
// M1.5 ships scope-distribution. M1.6 lands the BY-CREATOR pivot
// view — for governance review "who provisioned each key?".
//
// Mirror of M11.15 dashboard authorship + M15.8 audit per-actor
// pivot pattern. Per-creator row + envelope leaderboards.
//
// Drives the SPA's API key page "audit who created what" view +
// quarterly access-review flow (CLAUDE.md X.1 cross-cutting task).
//
// Pure resolver — accepts redacted ApiKeyEntry[] surface (NOT the
// internal hash-carrying record).

import type { ApiKeyEntry, ApiKeyScope } from './api_keys';
import { VALID_SCOPES } from './api_keys';

// ─── Public types ─────────────────────────────────────────────────────

export interface ApiKeyCreatorRow {
  creator_username: string;
  total_keys: number;
  active_keys: number;
  revoked_keys: number;
  /** Union of scopes across this creator's keys, sorted asc. Defensive
   *  intra-key dedup so a 2-scope key contributes each scope once even
   *  if listed twice. */
  scopes: ApiKeyScope[];
  /** Newest created_at across this creator's keys. Always non-null
   *  since every key carries created_at. */
  most_recent_creation_at: string;
  /** Names of keys this creator provisioned, sorted asc. Cap 50 for
   *  SPA grid rendering. */
  key_names: string[];
}

export interface ApiKeyByCreatorSummary {
  tenant_id: string;
  generated_at: string;
  total_keys: number;
  total_active_keys: number;
  total_revoked_keys: number;
  total_creators: number;
  /** Creators with ≥ 1 active key — surfaces "live access surface". */
  creators_with_active_keys: number;
  /** Sorted by total_keys desc with creator_username asc tie-break. */
  creators: ApiKeyCreatorRow[];
  /** Highest total_keys (canonical username tie-break via asc); null on empty. */
  most_prolific_creator: string | null;
  /** Highest active_keys count + canonical username tie-break; null when
   *  no active keys anywhere. */
  largest_active_provisioner: string | null;
}

// ─── Constants ────────────────────────────────────────────────────────

const KEY_NAMES_CAP = 50;

// ─── Pure resolver ────────────────────────────────────────────────────

export function summarizeApiKeysByCreator(
  tenant_id: string,
  entries: readonly ApiKeyEntry[],
  now: Date,
): ApiKeyByCreatorSummary {
  // Group by creator_username.
  const builders = new Map<
    string,
    {
      total: number;
      active: number;
      revoked: number;
      scopes: Set<ApiKeyScope>;
      most_recent_at_ms: number;
      most_recent_at_iso: string;
      names: string[];
    }
  >();
  let total_active = 0;
  let total_revoked = 0;

  for (const entry of entries) {
    const creator = entry.created_by;
    if (!creator) continue; // defensively skip entries without creator
    let b = builders.get(creator);
    if (!b) {
      b = {
        total: 0,
        active: 0,
        revoked: 0,
        scopes: new Set(),
        most_recent_at_ms: -Infinity,
        most_recent_at_iso: entry.created_at,
        names: [],
      };
      builders.set(creator, b);
    }
    b.total++;
    if (entry.status === 'active') {
      b.active++;
      total_active++;
    } else if (entry.status === 'revoked') {
      b.revoked++;
      total_revoked++;
    }
    // Scope union — defensive dedup via Set; also accept only valid scopes
    // so bogus values from upstream sources don't poison the union.
    for (const s of entry.scopes ?? []) {
      if (VALID_SCOPES.includes(s)) b.scopes.add(s);
    }
    // most_recent_creation_at — newest created_at by ms
    const ts = new Date(entry.created_at).getTime();
    if (Number.isFinite(ts) && ts > b.most_recent_at_ms) {
      b.most_recent_at_ms = ts;
      b.most_recent_at_iso = entry.created_at;
    }
    b.names.push(entry.name);
  }

  const creators: ApiKeyCreatorRow[] = [];
  for (const [creator, b] of builders) {
    const sortedNames = [...new Set(b.names)].sort((a, z) => a.localeCompare(z));
    creators.push({
      creator_username: creator,
      total_keys: b.total,
      active_keys: b.active,
      revoked_keys: b.revoked,
      scopes: [...b.scopes].sort((a, z) => a.localeCompare(z)),
      most_recent_creation_at: b.most_recent_at_iso,
      key_names: sortedNames.slice(0, KEY_NAMES_CAP),
    });
  }

  // Sort by total_keys desc, creator_username asc tie-break.
  creators.sort((a, z) => {
    if (z.total_keys !== a.total_keys) return z.total_keys - a.total_keys;
    return a.creator_username.localeCompare(z.creator_username);
  });

  // most_prolific_creator — top row.
  const most_prolific_creator = creators.length > 0 ? creators[0]!.creator_username : null;

  // largest_active_provisioner — highest active_keys with canonical
  // username asc tie-break. null when no active keys.
  let largest_active_provisioner: string | null = null;
  let bestActive = 0;
  for (const c of creators) {
    if (c.active_keys > bestActive) {
      bestActive = c.active_keys;
      largest_active_provisioner = c.creator_username;
    }
  }

  const creators_with_active_keys = creators.filter((c) => c.active_keys > 0).length;

  return {
    tenant_id,
    generated_at: now.toISOString(),
    total_keys: entries.length,
    total_active_keys: total_active,
    total_revoked_keys: total_revoked,
    total_creators: creators.length,
    creators_with_active_keys,
    creators,
    most_prolific_creator,
    largest_active_provisioner,
  };
}
