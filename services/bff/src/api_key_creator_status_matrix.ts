// services/bff/src/api_key_creator_status_matrix.ts
//
// T6 M1.14 — API key creator × status cross-tab matrix.
//
// M1.6 ships per-creator 1D rollup. M1.8 ships 2D scope × status
// matrix. M1.11 ships 2D creator × lifecycle stage matrix. M1.12 ships
// 2D scope × creator matrix.
//
// M1.14 ships the orthogonal creator × status (active / revoked)
// matrix. Each key lives in exactly one (creator, status) cell. OPEN
// creator axis × CLOSED 2-status axis. Useful for "which creators
// have the highest revocation rate?" governance + audit views.
//
// Per-row {created_by, total_keys, by_status (active + revoked at 0
// when absent — stable 2-key grid), revocation_rate (revoked/total in
// [0,1]; null when total=0 — shouldn't happen since row exists), key_ids[]
// sorted asc cap 50}. Per-col {status, total, by_creator (compact —
// only creators with > 0 keys in this status appear), distinct_creators,
// top_creators[] cap 3}.
//
// Envelope: peak_cell + most_revoked_creator (highest revoked count;
// canonical username asc tie-break) + highest_revocation_rate_creator
// (highest revocation_rate; canonical asc tie-break; null when no
// creator has > 0 revocations) + creators_with_zero_revocations[]
// (subset sorted asc — clean ops surface) + empty_cells[] canonical
// row-major.
//
// Mirror of M15.17 / M9.17 / M1.11 OPEN-axis × CLOSED-axis matrix
// pattern.

import {
  type ApiKeyEntry,
  type ApiKeyStatus,
} from './api_keys';
import { ALL_API_KEY_STATUSES } from './api_key_scope_status_matrix';

// ─── Public types ──────────────────────────────────────────────────────

const KEY_IDS_CAP = 50;

export interface CreatorStatusRow {
  created_by: string;
  total_keys: number;
  by_status: Record<ApiKeyStatus, number>;
  /** revoked / total_keys; null only when total_keys=0 (defensive). */
  revocation_rate: number | null;
  /** Key IDs cap 50, sorted asc — for SPA grid rendering. */
  key_ids: string[];
}

export interface CreatorStatusColumn {
  status: ApiKeyStatus;
  total: number;
  /** Per-creator counts; compact — only creators with > 0 keys in
   *  this status appear. */
  by_creator: Record<string, number>;
  distinct_creators: number;
  /** Top-3 creators by count + canonical username asc tie-break. */
  top_creators: Array<{ created_by: string; count: number }>;
}

export interface ApiKeyCreatorStatusMatrix {
  tenant_id: string;
  generated_at: string;
  total_keys: number;
  total_creators: number;
  total_statuses: number; // = 2
  /** Distinct creators sorted asc. */
  creators: string[];
  /** Per-creator rows sorted by total_keys desc + created_by asc
   *  tie-break (heaviest creators first). */
  rows: CreatorStatusRow[];
  /** Per-status columns in canonical ALL_API_KEY_STATUSES order. */
  columns: CreatorStatusColumn[];
  /** Highest cell across matrix; canonical iteration tie-break —
   *  creators in asc order × statuses in canonical ALL_API_KEY_STATUSES
   *  order; null on empty. */
  peak_cell: {
    created_by: string;
    status: ApiKeyStatus;
    count: number;
  } | null;
  /** Creator with most revoked keys; canonical username asc tie-break;
   *  null when zero revocations anywhere. */
  most_revoked_creator: string | null;
  /** Creator with highest revocation_rate; canonical username asc
   *  tie-break; null when no creator has > 0 revocations. */
  highest_revocation_rate_creator: string | null;
  /** Creators with revoked_count=0 (clean creators). Sorted asc. */
  creators_with_zero_revocations: string[];
  /** (creator, status) cells with count=0 — canonical creator asc ×
   *  status canonical order. */
  empty_cells: Array<{ created_by: string; status: ApiKeyStatus }>;
}

// ─── Helpers ───────────────────────────────────────────────────────────

function emptyByStatus(): Record<ApiKeyStatus, number> {
  const out = {} as Record<ApiKeyStatus, number>;
  for (const s of ALL_API_KEY_STATUSES) out[s] = 0;
  return out;
}

// ─── Pure resolver ─────────────────────────────────────────────────────

export function buildApiKeyCreatorStatusMatrix(
  tenant_id: string,
  entries: readonly ApiKeyEntry[],
  now: Date,
): ApiKeyCreatorStatusMatrix {
  // cellCounts[creator][status] = { count, key_ids: string[] }
  type Cell = { count: number; key_ids: string[] };
  const cellCounts = new Map<string, Record<ApiKeyStatus, Cell>>();

  let total_keys = 0;

  for (const entry of entries) {
    if (!entry.created_by) continue;
    if (!ALL_API_KEY_STATUSES.includes(entry.status)) continue;
    total_keys++;

    let row = cellCounts.get(entry.created_by);
    if (!row) {
      row = {} as Record<ApiKeyStatus, Cell>;
      for (const s of ALL_API_KEY_STATUSES) {
        row[s] = { count: 0, key_ids: [] };
      }
      cellCounts.set(entry.created_by, row);
    }
    row[entry.status].count++;
    row[entry.status].key_ids.push(entry.key_id);
  }

  const creators = [...cellCounts.keys()].sort((a, b) => a.localeCompare(b));

  // Build rows sorted by total_keys desc + creator asc tie-break.
  const rows: CreatorStatusRow[] = creators.map((created_by) => {
    const cells = cellCounts.get(created_by)!;
    const by_status = emptyByStatus();
    const allKeyIds: string[] = [];
    let total = 0;
    for (const status of ALL_API_KEY_STATUSES) {
      by_status[status] = cells[status].count;
      total += cells[status].count;
      allKeyIds.push(...cells[status].key_ids);
    }
    const sortedKeyIds = [...allKeyIds]
      .sort((a, b) => a.localeCompare(b))
      .slice(0, KEY_IDS_CAP);
    const revocation_rate = total > 0 ? by_status.revoked / total : null;
    return {
      created_by,
      total_keys: total,
      by_status,
      revocation_rate,
      key_ids: sortedKeyIds,
    };
  });
  rows.sort((a, b) => {
    if (b.total_keys !== a.total_keys) return b.total_keys - a.total_keys;
    return a.created_by.localeCompare(b.created_by);
  });

  // Build columns in canonical status order.
  const columns: CreatorStatusColumn[] = ALL_API_KEY_STATUSES.map((status) => {
    const by_creator: Record<string, number> = {};
    let total = 0;
    for (const creator of creators) {
      const c = cellCounts.get(creator)![status].count;
      if (c > 0) {
        by_creator[creator] = c;
        total += c;
      }
    }
    const top_creators = Object.entries(by_creator)
      .sort((a, b) => {
        if (b[1] !== a[1]) return b[1] - a[1];
        return a[0].localeCompare(b[0]);
      })
      .slice(0, 3)
      .map(([created_by, count]) => ({ created_by, count }));
    return {
      status,
      total,
      by_creator,
      distinct_creators: Object.keys(by_creator).length,
      top_creators,
    };
  });

  // peak_cell — canonical iteration tie-break (creators asc × statuses canonical).
  let peak_cell: ApiKeyCreatorStatusMatrix['peak_cell'] = null;
  let peakCount = 0;
  for (const creator of creators) {
    for (const status of ALL_API_KEY_STATUSES) {
      const c = cellCounts.get(creator)![status].count;
      if (c > peakCount) {
        peakCount = c;
        peak_cell = { created_by: creator, status, count: c };
      }
    }
  }

  // most_revoked_creator — highest revoked count + canonical asc tie-break.
  let most_revoked_creator: string | null = null;
  let bestRevoked = 0;
  for (const creator of creators) {
    const c = cellCounts.get(creator)!.revoked.count;
    if (c > bestRevoked) {
      bestRevoked = c;
      most_revoked_creator = creator;
    }
  }

  // highest_revocation_rate_creator — highest revocation_rate; canonical asc.
  let highest_revocation_rate_creator: string | null = null;
  let bestRate = 0;
  // Iterate in canonical asc order; only consider creators with > 0 revocations.
  for (const row of [...rows].sort((a, b) => a.created_by.localeCompare(b.created_by))) {
    if (row.by_status.revoked === 0) continue;
    const rate = row.revocation_rate!;
    if (rate > bestRate) {
      bestRate = rate;
      highest_revocation_rate_creator = row.created_by;
    }
  }

  // creators_with_zero_revocations — subset with revoked=0, sorted asc.
  const creators_with_zero_revocations = creators.filter(
    (c) => cellCounts.get(c)!.revoked.count === 0,
  );

  // empty_cells — canonical creator asc × status canonical row-major.
  const empty_cells: Array<{ created_by: string; status: ApiKeyStatus }> = [];
  for (const creator of creators) {
    for (const status of ALL_API_KEY_STATUSES) {
      if (cellCounts.get(creator)![status].count === 0) {
        empty_cells.push({ created_by: creator, status });
      }
    }
  }

  return {
    tenant_id,
    generated_at: now.toISOString(),
    total_keys,
    total_creators: creators.length,
    total_statuses: ALL_API_KEY_STATUSES.length,
    creators,
    rows,
    columns,
    peak_cell,
    most_revoked_creator,
    highest_revocation_rate_creator,
    creators_with_zero_revocations,
    empty_cells,
  };
}
