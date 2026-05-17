// services/bff/src/api_key_scope_status_matrix.ts
//
// T6 M1.8 — API key scope × status cross-tab matrix.
//
// M1.5 ships per-scope distribution (1D pivot — rows = 7 scopes, with
// active_keys/revoked_keys/ever_used_count fields inside each row).
// M1.8 elevates to the proper 2D matrix: rows = 7 ApiKeyScope ×
// cols = 2 ApiKeyStatus = 14 cells.
//
// Cells count KEY-SCOPE PAIRS (dispatches): a multi-scope key with
// scopes=['audit:read', 'cases:read'] contributes 1 to (audit:read,
// active) AND 1 to (cases:read, active). So Σ row.total exceeds
// total_keys when keys are multi-scope. Mirror of M8.14 (which uses
// the same "dispatch" cell semantics for multi-channel records).
//
// Mirror of M14.28 / M12.14 / M3.14 / M5.17 / M13.15 / M7.14 / M8.14
// / M15.14 matrix pattern for the API keys surface.
//
// Pure resolver — accepts the redacted ApiKeyEntry[] surface (never
// the internal record carrying hash/secret).

import {
  VALID_SCOPES,
  type ApiKeyEntry,
  type ApiKeyScope,
  type ApiKeyStatus,
} from './api_keys';

// ─── Canonical enum order ─────────────────────────────────────────────

export const ALL_API_KEY_STATUSES: readonly ApiKeyStatus[] = ['active', 'revoked'] as const;

// ─── Public types ─────────────────────────────────────────────────────

export interface ApiKeyScopeStatusCell {
  scope: ApiKeyScope;
  status: ApiKeyStatus;
  count: number;
}

export interface ApiKeyScopeRow {
  scope: ApiKeyScope;
  total: number;
  by_status: Record<ApiKeyStatus, number>;
  /** Statuses never seen for this scope. Canonical
   *  ALL_API_KEY_STATUSES order — coverage-gap per scope. */
  statuses_without: ApiKeyStatus[];
}

export interface ApiKeyStatusColumn {
  status: ApiKeyStatus;
  total: number;
  by_scope: Record<ApiKeyScope, number>;
  /** Scopes never seen at this status. Canonical VALID_SCOPES order —
   *  coverage-gap per status. */
  scopes_without: ApiKeyScope[];
}

export interface ApiKeyScopeStatusMatrix {
  tenant_id: string;
  generated_at: string;
  /** Total ApiKeyEntry rows seen. */
  total_keys: number;
  /** Σ (key × scope) dispatches across the matrix — sum of all cells.
   *  Equals Σ row.total = Σ col.total. */
  total_dispatches: number;
  rows: ApiKeyScopeRow[];
  columns: ApiKeyStatusColumn[];
  /** Peak cell — highest count (scope, status). Canonical iteration
   *  tie-break (scopes in VALID_SCOPES order × statuses in
   *  ALL_API_KEY_STATUSES order). null when no keys. */
  peak_cell: ApiKeyScopeStatusCell | null;
  /** Zero-count (scope, status) pairs in canonical scope × status
   *  row-major order. */
  empty_cells: Array<{ scope: ApiKeyScope; status: ApiKeyStatus }>;
  /** Scope with the most distinct non-zero by_status entries.
   *  Canonical scope-order tie-break. null when no keys. */
  most_distributed_scope: { scope: ApiKeyScope; statuses_seen: number } | null;
  /** Convenience top-level: total active key-scope dispatches.
   *  Sum of the 'active' column. */
  total_active_dispatches: number;
  /** Convenience top-level: total revoked key-scope dispatches. */
  total_revoked_dispatches: number;
}

// ─── Helpers ──────────────────────────────────────────────────────────

function emptyByStatus(): Record<ApiKeyStatus, number> {
  const out: Partial<Record<ApiKeyStatus, number>> = {};
  for (const s of ALL_API_KEY_STATUSES) out[s] = 0;
  return out as Record<ApiKeyStatus, number>;
}

function emptyByScope(): Record<ApiKeyScope, number> {
  const out: Partial<Record<ApiKeyScope, number>> = {};
  for (const s of VALID_SCOPES) out[s] = 0;
  return out as Record<ApiKeyScope, number>;
}

// ─── Pure resolver ────────────────────────────────────────────────────

export function buildApiKeyScopeStatusMatrix(
  tenant_id: string,
  entries: readonly ApiKeyEntry[],
  now: Date,
): ApiKeyScopeStatusMatrix {
  const cell = new Map<ApiKeyScope, Map<ApiKeyStatus, number>>();
  for (const s of VALID_SCOPES) cell.set(s, new Map());

  let total_dispatches = 0;
  for (const entry of entries) {
    if (!ALL_API_KEY_STATUSES.includes(entry.status)) continue;
    // Defensive intra-key scope dedup so a key listing the same scope
    // twice (shouldn't happen but bad-data guard) counts once per
    // (scope, status) cell.
    const seenScopes = new Set<ApiKeyScope>();
    for (const sc of entry.scopes ?? []) {
      if (!VALID_SCOPES.includes(sc)) continue;
      if (seenScopes.has(sc)) continue;
      seenScopes.add(sc);
      const inner = cell.get(sc)!;
      inner.set(entry.status, (inner.get(entry.status) ?? 0) + 1);
      total_dispatches++;
    }
  }

  // Rows (scopes × all statuses).
  const rows: ApiKeyScopeRow[] = VALID_SCOPES.map((scope) => {
    const inner = cell.get(scope)!;
    const by_status = emptyByStatus();
    let total = 0;
    for (const s of ALL_API_KEY_STATUSES) {
      const c = inner.get(s) ?? 0;
      by_status[s] = c;
      total += c;
    }
    const statuses_without = ALL_API_KEY_STATUSES.filter((s) => by_status[s] === 0);
    return { scope, total, by_status, statuses_without };
  });

  // Columns (statuses × all scopes).
  const columns: ApiKeyStatusColumn[] = ALL_API_KEY_STATUSES.map((status) => {
    const by_scope = emptyByScope();
    let total = 0;
    for (const s of VALID_SCOPES) {
      const c = cell.get(s)!.get(status) ?? 0;
      by_scope[s] = c;
      total += c;
    }
    const scopes_without = VALID_SCOPES.filter((s) => by_scope[s] === 0);
    return { status, total, by_scope, scopes_without };
  });

  // peak_cell — canonical iteration tie-break.
  let peak: ApiKeyScopeStatusCell | null = null;
  for (const sc of VALID_SCOPES) {
    for (const st of ALL_API_KEY_STATUSES) {
      const count = cell.get(sc)!.get(st) ?? 0;
      if (count > 0 && (!peak || count > peak.count)) {
        peak = { scope: sc, status: st, count };
      }
    }
  }

  // empty_cells canonical row-major (scope × status).
  const empty_cells: Array<{ scope: ApiKeyScope; status: ApiKeyStatus }> = [];
  for (const sc of VALID_SCOPES) {
    for (const st of ALL_API_KEY_STATUSES) {
      const count = cell.get(sc)!.get(st) ?? 0;
      if (count === 0) empty_cells.push({ scope: sc, status: st });
    }
  }

  // most_distributed_scope — highest distinct non-zero by_status count.
  let bestSpan = 0;
  let mostDist: ApiKeyScopeRow | null = null;
  for (const row of rows) {
    const span = ALL_API_KEY_STATUSES.filter((s) => row.by_status[s] > 0).length;
    if (span > bestSpan) {
      bestSpan = span;
      mostDist = row;
    }
  }
  const most_distributed_scope = mostDist
    ? { scope: mostDist.scope, statuses_seen: bestSpan }
    : null;

  const activeCol = columns.find((c) => c.status === 'active')!;
  const revokedCol = columns.find((c) => c.status === 'revoked')!;

  return {
    tenant_id,
    generated_at: now.toISOString(),
    total_keys: entries.length,
    total_dispatches,
    rows,
    columns,
    peak_cell: peak,
    empty_cells,
    most_distributed_scope,
    total_active_dispatches: activeCol.total,
    total_revoked_dispatches: revokedCol.total,
  };
}
