// services/bff/src/api_key_scope_creator_matrix.ts
//
// T6 M1.12 — API key scope × creator cross-tab matrix.
//
// M1.5 ships scope distribution (1D pivot by scope). M1.6 ships
// per-creator rollup (1D pivot by creator). M1.8 ships scope ×
// status matrix. M1.11 ships creator × lifecycle stage matrix.
//
// M1.12 lands the proper 2D cross-tab combining the two: rows = 7
// canonical ApiKeyScope (closed enum from M1.5) × cols = N creators
// (open set, sorted by total scope-bindings desc + username asc
// tie-break).
//
// Each key contributes 1 per scope to its (scope, creator) cell.
// A key with [alerts:read, audit:read] on creator alice → 2 cell
// contributions (one per scope, both keyed to alice).
//
// Distinct from M1.11 (creator × LIFECYCLE) by axis: this is
// SCOPE × creator. Surfaces "which user has webhooks:dispatch?"
// governance question + "who provisioned all the audit:read keys?"
// forensic view.
//
// Mirror of M1.11 / M14.28 / M12.14 / M3.14 / M15.14 / M8.14 matrix
// pattern combining one closed-axis (scopes) with one open-axis
// (creators). Defensive intra-key scope dedup (same scope listed
// twice on one key counts once).
//
// Pure resolver — reads the M1.2 redacted ApiKeyEntry list directly.

import {
  VALID_SCOPES,
  type ApiKeyEntry,
  type ApiKeyScope,
} from './api_keys';

// ─── Public types ──────────────────────────────────────────────────────

export interface ApiKeyScopeRow {
  scope: ApiKeyScope;
  total_bindings: number;
  /** Per-creator counts; only creators with > 0 keys carrying this
   *  scope appear as keys (compact). */
  by_creator: Record<string, number>;
  /** Distinct active keys + revoked keys carrying this scope
   *  (informational; sum across creators). */
  distinct_creators: number;
  /** Top-3 creators by count; sorted desc + username asc tie-break. */
  top_creators: Array<{ created_by: string; count: number }>;
}

export interface ApiKeyCreatorScopeColumn {
  created_by: string;
  total_bindings: number;
  total_keys: number;
  /** Per-scope counts; every ApiKeyScope key at 0 when absent. */
  by_scope: Record<ApiKeyScope, number>;
  /** Scopes with by_scope=0 (canonical order). */
  scopes_without: ApiKeyScope[];
  /** Distinct scopes used (1..7). */
  distinct_scopes: number;
}

export interface ApiKeyScopeCreatorMatrix {
  tenant_id: string;
  generated_at: string;
  total_keys: number;
  total_creators: number;
  total_scopes: number;
  total_bindings: number;
  /** Per-scope rows in canonical VALID_SCOPES order. */
  rows: ApiKeyScopeRow[];
  /** Per-creator columns sorted total_bindings desc + username asc
   *  tie-break. */
  columns: ApiKeyCreatorScopeColumn[];
  /** Highest-count cell across the matrix; iteration: scopes in
   *  canonical order × creators in column order; null on empty. */
  peak_cell: {
    scope: ApiKeyScope;
    created_by: string;
    count: number;
  } | null;
  /** Creator using the most distinct scopes (most-versatile creator
   *  surface); canonical username asc tie-break; null on empty. */
  most_versatile_creator: string | null;
  /** Scopes with NO creator at all (zero-binding scopes — operator
   *  hygiene flag). Canonical order. */
  unused_scopes: ApiKeyScope[];
}

// ─── Helpers ───────────────────────────────────────────────────────────

function emptyByScope(): Record<ApiKeyScope, number> {
  const out = {} as Record<ApiKeyScope, number>;
  for (const s of VALID_SCOPES) out[s] = 0;
  return out;
}

// ─── Pure resolver ─────────────────────────────────────────────────────

export function buildApiKeyScopeCreatorMatrix(
  tenant_id: string,
  entries: readonly ApiKeyEntry[],
  now: Date,
): ApiKeyScopeCreatorMatrix {
  // cellCounts[scope][creator] = count
  const cellCounts: Record<ApiKeyScope, Map<string, number>> = {} as never;
  for (const s of VALID_SCOPES) cellCounts[s] = new Map<string, number>();

  // Per-creator aggregation
  type CreatorBucket = {
    total_bindings: number;
    total_keys: number;
    by_scope: Record<ApiKeyScope, number>;
  };
  const creatorBuckets = new Map<string, CreatorBucket>();

  let total_bindings = 0;
  let total_keys = 0;

  for (const entry of entries) {
    if (!entry.created_by) continue;
    total_keys++;

    // Defensive intra-key scope dedup + closed-enum filter.
    const scopesSet = new Set<ApiKeyScope>();
    for (const scope of entry.scopes) {
      if (VALID_SCOPES.includes(scope)) {
        scopesSet.add(scope);
      }
    }
    if (scopesSet.size === 0) continue;

    let creator = creatorBuckets.get(entry.created_by);
    if (!creator) {
      creator = {
        total_bindings: 0,
        total_keys: 0,
        by_scope: emptyByScope(),
      };
      creatorBuckets.set(entry.created_by, creator);
    }
    creator.total_keys++;

    for (const scope of scopesSet) {
      total_bindings++;
      creator.total_bindings++;
      creator.by_scope[scope]++;
      cellCounts[scope].set(
        entry.created_by,
        (cellCounts[scope].get(entry.created_by) ?? 0) + 1,
      );
    }
  }

  // Rows — every scope in canonical order.
  const rows: ApiKeyScopeRow[] = VALID_SCOPES.map((scope) => {
    const map = cellCounts[scope];
    const by_creator: Record<string, number> = {};
    for (const [k, v] of map.entries()) by_creator[k] = v;
    const total_bindings = [...map.values()].reduce((acc, v) => acc + v, 0);
    const top = [...map.entries()]
      .sort((a, b) => {
        if (b[1] !== a[1]) return b[1] - a[1];
        return a[0].localeCompare(b[0]);
      })
      .slice(0, 3)
      .map(([created_by, count]) => ({ created_by, count }));
    return {
      scope,
      total_bindings,
      by_creator,
      distinct_creators: map.size,
      top_creators: top,
    };
  });

  // Columns — every creator sorted desc + username asc tie-break.
  const columns: ApiKeyCreatorScopeColumn[] = [...creatorBuckets.entries()]
    .map(([created_by, c]) => {
      const scopes_without = VALID_SCOPES.filter((s) => c.by_scope[s] === 0);
      const distinct_scopes = VALID_SCOPES.length - scopes_without.length;
      return {
        created_by,
        total_bindings: c.total_bindings,
        total_keys: c.total_keys,
        by_scope: { ...c.by_scope },
        scopes_without,
        distinct_scopes,
      };
    })
    .sort((a, b) => {
      if (b.total_bindings !== a.total_bindings) {
        return b.total_bindings - a.total_bindings;
      }
      return a.created_by.localeCompare(b.created_by);
    });

  // peak_cell — highest cell across the matrix; canonical scope ×
  // column order iteration.
  let peak_cell:
    | { scope: ApiKeyScope; created_by: string; count: number }
    | null = null;
  let peakCount = 0;
  for (const scope of VALID_SCOPES) {
    for (const col of columns) {
      const c = cellCounts[scope].get(col.created_by) ?? 0;
      if (c > peakCount) {
        peakCount = c;
        peak_cell = { scope, created_by: col.created_by, count: c };
      }
    }
  }

  // most_versatile_creator — highest distinct_scopes + canonical username asc.
  let most_versatile_creator: string | null = null;
  let maxDistinct = 0;
  const sortedByVersatility = [...columns].sort((a, b) => {
    if (b.distinct_scopes !== a.distinct_scopes) {
      return b.distinct_scopes - a.distinct_scopes;
    }
    return a.created_by.localeCompare(b.created_by);
  });
  if (sortedByVersatility.length > 0 && sortedByVersatility[0].distinct_scopes > 0) {
    most_versatile_creator = sortedByVersatility[0].created_by;
    maxDistinct = sortedByVersatility[0].distinct_scopes;
  }
  void maxDistinct;

  // unused_scopes — zero-binding subset in canonical order.
  const unused_scopes = VALID_SCOPES.filter((s) => cellCounts[s].size === 0);

  return {
    tenant_id,
    generated_at: now.toISOString(),
    total_keys,
    total_creators: columns.length,
    total_scopes: VALID_SCOPES.length,
    total_bindings,
    rows,
    columns,
    peak_cell,
    most_versatile_creator,
    unused_scopes,
  };
}
