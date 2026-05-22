// services/bff/src/api_key_revoker_rollup.ts
//
// T6 M1.17 — API key per-revoker rollup.
//
// Mirror of M1.6 by-creator pattern, but pivoted by REVOKER instead.
// Surfaces "who revoked which keys?" governance question — useful
// for security-incident post-mortems ("during the breach, alice
// revoked 8 keys in 15 minutes — review her revocation list"),
// quarterly access reviews ("revokers without a documented incident
// ticket?"), and compliance reporting ("show the revocation log per
// operator").
//
// Distinct from:
//   M1.6  — by-CREATOR rollup (who provisioned the key, not who
//           revoked it; the same person may have created the key in
//           Q1 but bob may have revoked it in Q4)
//   M1.14 — creator × status matrix (per-creator revocation-rate
//           pivot; M1.17 inverts to per-revoker view)
//   M1.15 — revocation daily volume timeline (time-axis trend, not
//           actor-pivoted)
//
// Adds mass_revocation_events surfacing — bursts of >MASS_REVOCATION
// _THRESHOLD revocations within MASS_REVOCATION_WINDOW_MS — surfaces
// emergency-response patterns and "did someone go rogue?" forensics.

import {
  type ApiKeyEntry,
  type ApiKeyScope,
  isApiKeyScope,
  VALID_SCOPES,
} from './api_keys';

// ---------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------

export const KEY_IDS_CAP = 50;

/** Mass-revocation alert threshold: > N revocations within window. */
export const MASS_REVOCATION_THRESHOLD = 5;
/** 1-hour rolling window for mass-revocation detection. */
export const MASS_REVOCATION_WINDOW_MS = 60 * 60 * 1000;

// ---------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------

export interface ApiKeyRevokerRow {
  revoker_username: string;
  total_revocations: number;
  /** Count of distinct creators whose keys this revoker revoked. */
  distinct_creators_revoked: number;
  /** Distinct scopes (union across revoked keys), sorted canonical. */
  distinct_scopes_revoked: number;
  /** Cap KEY_IDS_CAP, sorted asc. */
  key_ids: string[];
  /** Oldest revoked_at across this revoker's revocations. */
  first_revoked_at: string;
  /** Newest revoked_at across this revoker's revocations. */
  last_revoked_at: string;
}

export interface MassRevocationEvent {
  revoker_username: string;
  /** Number of revocations in the burst. */
  count: number;
  /** Window start (oldest revoked_at in the burst). */
  window_start: string;
  /** Window end (newest revoked_at in the burst). */
  window_end: string;
  /** Sample key_ids in this burst, cap 5 sorted asc. */
  sample_key_ids: string[];
}

export interface ApiKeyRevokerRollup {
  tenant_id: string;
  generated_at: string;
  total_revocations: number;
  total_revokers: number;
  /** Per-revoker rows sorted total_revocations desc + username asc tie-break. */
  revokers: ApiKeyRevokerRow[];
  /** Top revoker by total_revocations. null when no revocations. */
  most_active_revoker: string | null;
  /**
   * Revokers whose revocations include any window of
   * MASS_REVOCATION_WINDOW_MS containing > MASS_REVOCATION_THRESHOLD
   * revocations. Surfaces incident-response patterns + rogue-actor
   * forensics. Sorted by count desc + revoker_username asc tie-break.
   */
  mass_revocation_events: MassRevocationEvent[];
}

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

interface AccBucket {
  count: number;
  revoked_creators: Set<string>;
  revoked_scopes: Set<ApiKeyScope>;
  key_ids: string[];
  revocation_records: Array<{
    revoked_at_ms: number;
    revoked_at: string;
    key_id: string;
  }>;
}

function newAcc(): AccBucket {
  return {
    count: 0,
    revoked_creators: new Set(),
    revoked_scopes: new Set(),
    key_ids: [],
    revocation_records: [],
  };
}

/**
 * Detect rolling-window bursts of > THRESHOLD revocations within
 * WINDOW_MS for one revoker. Returns the burst with the highest
 * count (tie-broken by earliest window_start) — at most one
 * burst per revoker surfaces. Returns null when no burst found.
 *
 * Algorithm: sort by revoked_at asc, then two-pointer sweep. For
 * each end-index, advance start-index until window fits; if the
 * span is > THRESHOLD, record it as a candidate burst.
 */
function detectMassRevocation(
  acc: AccBucket,
): { count: number; window_start: string; window_end: string; sample_key_ids: string[] } | null {
  if (acc.revocation_records.length <= MASS_REVOCATION_THRESHOLD) return null;
  const sorted = [...acc.revocation_records].sort(
    (a, b) => a.revoked_at_ms - b.revoked_at_ms,
  );
  let bestCount = 0;
  let bestStart = 0;
  let bestEnd = 0;
  let start = 0;
  for (let end = 0; end < sorted.length; end++) {
    while (sorted[end].revoked_at_ms - sorted[start].revoked_at_ms > MASS_REVOCATION_WINDOW_MS) {
      start += 1;
    }
    const span = end - start + 1;
    if (span > bestCount) {
      bestCount = span;
      bestStart = start;
      bestEnd = end;
    }
  }
  if (bestCount <= MASS_REVOCATION_THRESHOLD) return null;
  const burst = sorted.slice(bestStart, bestEnd + 1);
  const sample_key_ids = [...burst]
    .map((r) => r.key_id)
    .sort((a, b) => a.localeCompare(b))
    .slice(0, 5);
  return {
    count: bestCount,
    window_start: burst[0].revoked_at,
    window_end: burst[burst.length - 1].revoked_at,
    sample_key_ids,
  };
}

// ---------------------------------------------------------------------
// Main resolver
// ---------------------------------------------------------------------

export function summarizeApiKeyRevokerRollup(
  tenant_id: string,
  entries: readonly ApiKeyEntry[],
  now: Date,
): ApiKeyRevokerRollup {
  if (!tenant_id || tenant_id.trim() === '') {
    throw new Error('summarizeApiKeyRevokerRollup: tenant_id required');
  }

  // Per-revoker accumulators
  const perRevoker = new Map<string, AccBucket>();
  let total_revocations = 0;

  for (const entry of entries) {
    // Only revoked keys with non-empty revoked_by + revoked_at count
    if (entry.status !== 'revoked') continue;
    if (!entry.revoked_by || entry.revoked_by.trim() === '') continue;
    if (!entry.revoked_at) continue;
    const revokedMs = Date.parse(entry.revoked_at);
    if (!Number.isFinite(revokedMs)) continue;

    const acc = perRevoker.get(entry.revoked_by) ?? newAcc();
    acc.count += 1;
    if (entry.created_by) acc.revoked_creators.add(entry.created_by);
    for (const s of entry.scopes ?? []) {
      if (isApiKeyScope(s)) acc.revoked_scopes.add(s);
    }
    acc.key_ids.push(entry.key_id);
    acc.revocation_records.push({
      revoked_at_ms: revokedMs,
      revoked_at: entry.revoked_at,
      key_id: entry.key_id,
    });
    perRevoker.set(entry.revoked_by, acc);
    total_revocations += 1;
  }

  // Build rows + mass-revocation events
  const revokers: ApiKeyRevokerRow[] = [];
  const mass_revocation_events: MassRevocationEvent[] = [];

  for (const [revoker_username, acc] of perRevoker) {
    const sortedKeyIds = [...acc.key_ids]
      .sort((a, b) => a.localeCompare(b))
      .slice(0, KEY_IDS_CAP);
    // first/last revoked_at via sorted records
    const sortedByTs = [...acc.revocation_records].sort(
      (a, b) => a.revoked_at_ms - b.revoked_at_ms,
    );
    const first_revoked_at = sortedByTs[0].revoked_at;
    const last_revoked_at = sortedByTs[sortedByTs.length - 1].revoked_at;

    revokers.push({
      revoker_username,
      total_revocations: acc.count,
      distinct_creators_revoked: acc.revoked_creators.size,
      distinct_scopes_revoked: acc.revoked_scopes.size,
      key_ids: sortedKeyIds,
      first_revoked_at,
      last_revoked_at,
    });

    const burst = detectMassRevocation(acc);
    if (burst) {
      mass_revocation_events.push({
        revoker_username,
        count: burst.count,
        window_start: burst.window_start,
        window_end: burst.window_end,
        sample_key_ids: burst.sample_key_ids,
      });
    }
  }

  // Sort: total_revocations desc + revoker_username asc tie-break
  revokers.sort((a, b) => {
    if (a.total_revocations !== b.total_revocations) {
      return b.total_revocations - a.total_revocations;
    }
    return a.revoker_username.localeCompare(b.revoker_username);
  });

  // Sort mass_revocation_events: count desc + username asc tie-break
  mass_revocation_events.sort((a, b) => {
    if (a.count !== b.count) return b.count - a.count;
    return a.revoker_username.localeCompare(b.revoker_username);
  });

  const most_active_revoker = revokers.length > 0 ? revokers[0].revoker_username : null;

  return {
    tenant_id,
    generated_at: now.toISOString(),
    total_revocations,
    total_revokers: revokers.length,
    revokers,
    most_active_revoker,
    mass_revocation_events,
  };
}

// Re-export VALID_SCOPES for downstream consumers that want to know
// the closed-axis size for distinct_scopes_revoked normalization.
export { VALID_SCOPES };
