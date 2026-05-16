// services/bff/src/api_key_usage_analytics.ts
//
// T6 M1.4 — Service-account API key usage analytics.
//
// M1.2 ships the API-key provisioning store (create + redacted list +
// revoke + delete + touch-on-use). M1.3 wires the bearer-auth
// middleware that calls `touch()` so `last_used_at` actually gets
// bumped on every authenticated /v1/svc/* call. M1.4 ships the
// admin dashboard surface: a single rollup that classifies every
// key as fresh / dormant / never-used / expires-soon / expired and
// returns counts plus per-key analytics + leaderboards.
//
// Use case: BIL ops admin opens the API keys page and wants the
// answer to "which keys haven't been used in 90+ days? what's
// expiring in the next month? has anyone been calling lately?"
// Today the operator scrolls the M1.2 list manually inspecting
// last_used_at vs expires_at per row. M1.4 lands a single rollup
// the SPA can render as a status chip strip + dormancy / expiry
// drill-downs.
//
// Pure rollup over the redacted ApiKeyEntry[] surface (NOT over the
// internal record — keeps hash + secret out of analytics path
// entirely). Tenant-scoped at the caller layer (route only passes
// the requesting tenant's entries).

import type { ApiKeyEntry, ApiKeyScope } from './api_keys';
import { VALID_SCOPES } from './api_keys';

// ─── Tunable thresholds ───────────────────────────────────────────────

/** Active keys with expiry within this many days are flagged as
 *  expires_soon (drives "renew before X" SPA banner). */
export const EXPIRES_SOON_DAYS = 30;

/** Active EVER-USED keys with last_used_at older than this many days
 *  are flagged as dormant (drives "consider revoking" SPA list). */
export const DORMANT_DAYS = 90;

/** Active NEVER-USED keys older than this many days are flagged as
 *  idle (provisioned but never wired up — operator may have
 *  abandoned the integration). */
export const IDLE_NEVER_USED_DAYS = 30;

// ─── Public types ─────────────────────────────────────────────────────

export interface ApiKeyUsageRow {
  key_id: string;
  name: string;
  prefix: string;
  status: 'active' | 'revoked';
  scopes: ApiKeyScope[];
  created_at: string;
  expires_at: string | null;
  last_used_at: string | null;
  /** Whole days since `created_at`; floored. Always ≥ 0. */
  days_since_creation: number;
  /** Whole days since `last_used_at`; null when never used. Always ≥ 0. */
  days_since_last_use: number | null;
  /** Whole days until `expires_at` (signed); null when no expiry.
   *  Negative when expired. Floored toward -∞ to match operator
   *  expectations ("3 days left" reads better than "2.7 days left"). */
  days_until_expiry: number | null;
  ever_used: boolean;
  /** active + 0 ≤ days_until_expiry ≤ EXPIRES_SOON_DAYS. */
  expires_soon: boolean;
  /** active + ever_used + days_since_last_use > DORMANT_DAYS. */
  is_dormant: boolean;
  /** active + !ever_used + days_since_creation > IDLE_NEVER_USED_DAYS. */
  is_idle_never_used: boolean;
  /** expires_at present + ≤ now. Independent of status (a key can be
   *  revoked AND expired; both flags surface). */
  is_expired: boolean;
}

export interface ApiKeyUsageSummary {
  tenant_id: string;
  generated_at: string;
  total_keys: number;
  total_active: number;
  total_revoked: number;
  total_expired: number;
  /** Active keys with expires_soon=true. Subset of total_active. */
  total_active_expires_soon: number;
  /** Active keys with is_dormant=true. Subset of total_active. */
  total_active_dormant: number;
  /** Active keys with is_idle_never_used=true. Subset of total_active. */
  total_active_idle_never_used: number;
  /** Count of ACTIVE keys carrying each scope (every VALID_SCOPES
   *  key present at 0 when absent). Revoked keys excluded — analytics
   *  is about current capability surface. */
  by_scope: Record<ApiKeyScope, number>;
  /** All keys (active + revoked) sorted by last_used_at desc (nulls
   *  last), then created_at desc, then key_id asc. */
  keys: ApiKeyUsageRow[];
  /** Top row by last_used_at across all keys. null when no key has
   *  ever been used. */
  most_recent_use: {
    key_id: string;
    name: string;
    last_used_at: string;
  } | null;
  /** Active keys with expires_soon=true, sorted by days_until_expiry
   *  asc (soonest first), then key_id asc. */
  expiring_soon: Array<{
    key_id: string;
    name: string;
    expires_at: string;
    days_until_expiry: number;
  }>;
  /** Active keys with is_dormant=true, sorted by days_since_last_use
   *  desc (most dormant first), then key_id asc. */
  dormant_keys: Array<{
    key_id: string;
    name: string;
    days_since_last_use: number;
  }>;
}

// ─── Pure helpers ─────────────────────────────────────────────────────

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Whole days between two ISO timestamps (later - earlier). Floored,
 *  always ≥ 0 when later >= earlier. */
function daysBetween(earlier: string, later: string): number {
  const e = new Date(earlier).getTime();
  const l = new Date(later).getTime();
  return Math.max(0, Math.floor((l - e) / MS_PER_DAY));
}

/** Signed days from `from` to `target` (target - from). Floored
 *  toward -∞ so 0.4d → 0, 0.6d → 0, -0.4d → -1. */
function signedDaysUntil(from: string, target: string): number {
  const f = new Date(from).getTime();
  const t = new Date(target).getTime();
  return Math.floor((t - f) / MS_PER_DAY);
}

function emptyScopeCounts(): Record<ApiKeyScope, number> {
  const out = {} as Record<ApiKeyScope, number>;
  for (const s of VALID_SCOPES) out[s] = 0;
  return out;
}

function classifyRow(entry: ApiKeyEntry, now: string): ApiKeyUsageRow {
  const ever_used = entry.last_used_at !== null;
  const days_since_creation = daysBetween(entry.created_at, now);
  const days_since_last_use = ever_used
    ? daysBetween(entry.last_used_at!, now)
    : null;
  const days_until_expiry = entry.expires_at !== null
    ? signedDaysUntil(now, entry.expires_at)
    : null;
  const is_expired = days_until_expiry !== null && days_until_expiry < 0;
  const active = entry.status === 'active';
  const expires_soon = active
    && days_until_expiry !== null
    && days_until_expiry >= 0
    && days_until_expiry <= EXPIRES_SOON_DAYS;
  const is_dormant = active
    && ever_used
    && days_since_last_use !== null
    && days_since_last_use > DORMANT_DAYS;
  const is_idle_never_used = active
    && !ever_used
    && days_since_creation > IDLE_NEVER_USED_DAYS;

  return {
    key_id: entry.key_id,
    name: entry.name,
    prefix: entry.prefix,
    status: entry.status,
    scopes: [...entry.scopes],
    created_at: entry.created_at,
    expires_at: entry.expires_at,
    last_used_at: entry.last_used_at,
    days_since_creation,
    days_since_last_use,
    days_until_expiry,
    ever_used,
    expires_soon,
    is_dormant,
    is_idle_never_used,
    is_expired,
  };
}

function compareForListing(a: ApiKeyUsageRow, b: ApiKeyUsageRow): number {
  // last_used_at desc with nulls LAST.
  if (a.last_used_at !== null && b.last_used_at === null) return -1;
  if (a.last_used_at === null && b.last_used_at !== null) return 1;
  if (a.last_used_at !== null && b.last_used_at !== null) {
    if (a.last_used_at !== b.last_used_at) {
      return a.last_used_at < b.last_used_at ? 1 : -1;
    }
  }
  // created_at desc tie-break.
  if (a.created_at !== b.created_at) {
    return a.created_at < b.created_at ? 1 : -1;
  }
  // key_id asc final tie-break (stable + deterministic).
  return a.key_id.localeCompare(b.key_id);
}

// ─── Pure resolver ────────────────────────────────────────────────────

export function summarizeApiKeyUsage(
  tenant_id: string,
  entries: readonly ApiKeyEntry[],
  now: Date,
): ApiKeyUsageSummary {
  const nowIso = now.toISOString();
  const rows = entries.map((e) => classifyRow(e, nowIso));

  let total_active = 0;
  let total_revoked = 0;
  let total_expired = 0;
  let total_active_expires_soon = 0;
  let total_active_dormant = 0;
  let total_active_idle_never_used = 0;
  const by_scope = emptyScopeCounts();

  for (const row of rows) {
    if (row.status === 'active') {
      total_active++;
      for (const s of row.scopes) {
        if (s in by_scope) by_scope[s]++;
      }
      if (row.expires_soon) total_active_expires_soon++;
      if (row.is_dormant) total_active_dormant++;
      if (row.is_idle_never_used) total_active_idle_never_used++;
    } else {
      total_revoked++;
    }
    if (row.is_expired) total_expired++;
  }

  const sorted = [...rows].sort(compareForListing);

  // most_recent_use: top non-null last_used_at across all rows.
  // Already sorted last_used_at desc (nulls last), so the first row
  // with last_used_at !== null is the winner.
  let most_recent_use: ApiKeyUsageSummary['most_recent_use'] = null;
  for (const r of sorted) {
    if (r.last_used_at !== null) {
      most_recent_use = {
        key_id: r.key_id,
        name: r.name,
        last_used_at: r.last_used_at,
      };
      break;
    }
  }

  const expiring_soon = rows
    .filter((r) => r.expires_soon && r.expires_at !== null && r.days_until_expiry !== null)
    .map((r) => ({
      key_id: r.key_id,
      name: r.name,
      expires_at: r.expires_at!,
      days_until_expiry: r.days_until_expiry!,
    }))
    .sort((a, b) => {
      if (a.days_until_expiry !== b.days_until_expiry) {
        return a.days_until_expiry - b.days_until_expiry;
      }
      return a.key_id.localeCompare(b.key_id);
    });

  const dormant_keys = rows
    .filter((r) => r.is_dormant && r.days_since_last_use !== null)
    .map((r) => ({
      key_id: r.key_id,
      name: r.name,
      days_since_last_use: r.days_since_last_use!,
    }))
    .sort((a, b) => {
      if (a.days_since_last_use !== b.days_since_last_use) {
        return b.days_since_last_use - a.days_since_last_use;
      }
      return a.key_id.localeCompare(b.key_id);
    });

  return {
    tenant_id,
    generated_at: nowIso,
    total_keys: rows.length,
    total_active,
    total_revoked,
    total_expired,
    total_active_expires_soon,
    total_active_dormant,
    total_active_idle_never_used,
    by_scope,
    keys: sorted,
    most_recent_use,
    expiring_soon,
    dormant_keys,
  };
}
