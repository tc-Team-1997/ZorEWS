// services/bff/src/api_key_creator_scope_matrix.ts
//
// T6 M1.12 — API key creator × scope cross-tab matrix.
//
// M1.5 ships the BY-SCOPE pivot (1D, scope axis). M1.6 ships the
// per-creator rollup (1D, creator axis). M1.8 ships scope × status
// matrix. M1.11 ships creator × lifecycle matrix. M1.12 lands the
// final 2D cross-tab in the creator × scope plane: rows = creators
// (open set, sorted by total_keys desc) × cols = 7 canonical scopes
// (closed enum in VALID_SCOPES order).
//
// Cells count KEY-SCOPE PAIRS — a multi-scope key contributes once
// per scope it carries. So Σ cells per row >= row.total_keys (one
// key with N scopes = N cell entries across the row). This is the
// right shape for governance: "alice provisions 12 webhooks:dispatch
// permissions across her 8 keys" — you want the permission-count not
// the key-count for that question.
//
// Active-only by default — revoked keys don't represent current
// granted permission surface, and the governance use case is "who
// can currently call what scope".
//
// Mirror of M14.28 / M12.14 / M3.14 / M15.14 / M8.14 / M1.11 matrix
// pattern for the API key creator × permission surface.
//
// Pure resolver — reads the M1.2 redacted ApiKeyEntry list directly.

import type { ApiKeyEntry, ApiKeyScope } from './api_keys';
import { VALID_SCOPES } from './api_keys';

// ─── Public types ──────────────────────────────────────────────────────

export interface ApiKeyCreatorScopeRow {
  created_by: string;
  /** Number of ACTIVE keys this creator owns (key-count, not
   *  permission-count). */
  total_keys: number;
  /** Per-scope permission count — sum across this creator's active
   *  keys of the count of that scope (with intra-key dedup so a key
   *  listing the same scope twice still counts once). Every
   *  ApiKeyScope at 0 when absent. */
  by_scope: Record<ApiKeyScope, number>;
  /** Total permissions granted (= Σ by_scope; identical to Σ scopes
   *  across this creator's active keys after intra-key dedup). */
  total_permissions: number;
  /** Scopes this creator's active keys never carry (canonical order
   *  — coverage gap per creator; useful for "alice never grants
   *  audit:read" governance view). */
  scopes_without: ApiKeyScope[];
  /** Scopes carried by ≥ 1 of this creator's active keys (canonical
   *  order). */
  distinct_scopes: number;
}

export interface ApiKeyCreatorScopeColumn {
  scope: ApiKeyScope;
  /** Total permission-count across the matrix (= Σ rows.by_scope[s]).
   *  Identical to the count of active key-scope pairs carrying this
   *  scope. */
  total: number;
  /** Creators with > 0 active keys carrying this scope, sorted by
   *  count desc + username asc tie-break, cap 10. */
  top_creators: Array<{ created_by: string; count: number }>;
  /** Number of distinct creators with ≥ 1 active key carrying this
   *  scope. */
  distinct_creators: number;
}

export interface ApiKeyCreatorScopeMatrix {
  tenant_id: string;
  generated_at: string;
  /** Total ACTIVE keys (skipped: revoked + keys with empty
   *  created_by). */
  total_active_keys: number;
  total_creators: number;
  total_scopes: number;
  /** Total permission-count across the matrix (= Σ rows.total_
   *  permissions = Σ columns.total). */
  total_permissions: number;
  rows: ApiKeyCreatorScopeRow[];
  columns: ApiKeyCreatorScopeColumn[];
  /** Creator with the largest total_permissions footprint. Canonical
   *  username asc tie-break; null when no active keys exist. Surfaces
   *  "who has the broadest grant surface in the tenant?" — the right
   *  starting point for a quarterly access review. */
  broadest_grant_creator: string | null;
  /** Scopes that NO creator's active keys carry (intersection across
   *  the column space). Canonical order. Surfaces "the tenant has
   *  zero notifications:send permissions live" governance gap. */
  unused_scopes: ApiKeyScope[];
  /** Highest-count cell across the matrix. Canonical iteration tie-
   *  break (row total_keys desc → username asc → scope canonical
   *  order). null on empty. */
  peak_cell: {
    created_by: string;
    scope: ApiKeyScope;
    count: number;
  } | null;
}

// ─── Helpers ───────────────────────────────────────────────────────────

const TOP_CREATORS_CAP = 10;

function emptyByScope(): Record<ApiKeyScope, number> {
  const out = {} as Record<ApiKeyScope, number>;
  for (const s of VALID_SCOPES) out[s] = 0;
  return out;
}

// ─── Pure resolver ─────────────────────────────────────────────────────

export function buildApiKeyCreatorScopeMatrix(
  tenant_id: string,
  entries: readonly ApiKeyEntry[],
  now: Date,
): ApiKeyCreatorScopeMatrix {
  type Bucket = {
    total_keys: number;
    by_scope: Record<ApiKeyScope, number>;
  };
  const creatorBuckets = new Map<string, Bucket>();

  // Per-scope totals + per-creator-per-scope cells for top_creators.
  const colTotals: Record<ApiKeyScope, number> = emptyByScope();
  const colCreators: Record<ApiKeyScope, Map<string, number>> = {} as never;
  for (const s of VALID_SCOPES) {
    colCreators[s] = new Map<string, number>();
  }

  let total_active_keys = 0;

  for (const entry of entries) {
    if (entry.status !== 'active') continue;
    if (!entry.created_by) continue;
    total_active_keys++;

    let bucket = creatorBuckets.get(entry.created_by);
    if (!bucket) {
      bucket = { total_keys: 0, by_scope: emptyByScope() };
      creatorBuckets.set(entry.created_by, bucket);
    }
    bucket.total_keys++;

    // Intra-key dedup — a key listing `webhooks:dispatch` twice still
    // counts once for this creator-scope cell. Also closed-enum
    // filter so bogus values from upstream sources can't poison the
    // counts.
    const scopesSeen = new Set<ApiKeyScope>();
    for (const s of entry.scopes ?? []) {
      if (!VALID_SCOPES.includes(s)) continue;
      if (scopesSeen.has(s)) continue;
      scopesSeen.add(s);
      bucket.by_scope[s]++;
      colTotals[s]++;
      colCreators[s].set(
        entry.created_by,
        (colCreators[s].get(entry.created_by) ?? 0) + 1,
      );
    }
  }

  // Rows — sort by total_keys desc + created_by asc tie-break.
  const rows: ApiKeyCreatorScopeRow[] = [...creatorBuckets.entries()]
    .map(([created_by, b]) => {
      const scopes_without = VALID_SCOPES.filter((s) => b.by_scope[s] === 0);
      const distinct_scopes = VALID_SCOPES.length - scopes_without.length;
      const total_permissions = VALID_SCOPES.reduce(
        (acc, s) => acc + b.by_scope[s],
        0,
      );
      return {
        created_by,
        total_keys: b.total_keys,
        by_scope: { ...b.by_scope },
        total_permissions,
        scopes_without,
        distinct_scopes,
      };
    })
    .sort((a, b) => {
      if (b.total_keys !== a.total_keys) return b.total_keys - a.total_keys;
      return a.created_by.localeCompare(b.created_by);
    });

  // Columns — every canonical scope; per-column top_creators.
  const columns: ApiKeyCreatorScopeColumn[] = VALID_SCOPES.map((scope) => {
    const map = colCreators[scope];
    const top = [...map.entries()]
      .sort((a, b) => {
        if (b[1] !== a[1]) return b[1] - a[1];
        return a[0].localeCompare(b[0]);
      })
      .slice(0, TOP_CREATORS_CAP)
      .map(([created_by, count]) => ({ created_by, count }));
    return {
      scope,
      total: colTotals[scope],
      top_creators: top,
      distinct_creators: map.size,
    };
  });

  // broadest_grant_creator — highest total_permissions + canonical
  // username asc tie-break.
  let broadest_grant_creator: string | null = null;
  const sortedByGrants = [...rows].sort((a, b) => {
    if (b.total_permissions !== a.total_permissions) {
      return b.total_permissions - a.total_permissions;
    }
    return a.created_by.localeCompare(b.created_by);
  });
  if (sortedByGrants.length > 0 && sortedByGrants[0].total_permissions > 0) {
    broadest_grant_creator = sortedByGrants[0].created_by;
  }

  const unused_scopes = VALID_SCOPES.filter((s) => colTotals[s] === 0);

  // peak_cell — highest cell count across the matrix. Iterate in row
  // order (already sorted) × canonical scope order for stable tie-break.
  let peak_cell:
    | { created_by: string; scope: ApiKeyScope; count: number }
    | null = null;
  let peakCount = 0;
  for (const row of rows) {
    for (const scope of VALID_SCOPES) {
      const c = row.by_scope[scope];
      if (c > peakCount) {
        peakCount = c;
        peak_cell = { created_by: row.created_by, scope, count: c };
      }
    }
  }

  const total_permissions = VALID_SCOPES.reduce(
    (acc, s) => acc + colTotals[s],
    0,
  );

  return {
    tenant_id,
    generated_at: now.toISOString(),
    total_active_keys,
    total_creators: rows.length,
    total_scopes: VALID_SCOPES.length,
    total_permissions,
    rows,
    columns,
    broadest_grant_creator,
    unused_scopes,
    peak_cell,
  };
}
