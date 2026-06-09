// services/bff/src/api_key_access_pattern.ts
//
// T6 M1.21 — API key geographic access pattern analysis.
//
// Analyses key age distribution and usage patterns for security
// insights. Groups active keys by last_used_at recency (today /
// this_week / this_month / this_quarter / never_used /
// expired_or_revoked) and surfaces a dormancy_risk_score (0-100)
// plus the top-5 most-recently-used keys.
//
// Distinct from M1.10 (lifecycle stage distribution), M1.13
// (recency histogram), M1.4 (usage analytics). Focused on
// the security-audit story: "how many keys are sitting idle?".
//
// Pure function. Tenant-scoped.

import type { ApiKeyEntry } from './api_keys';

// ─── Public types ─────────────────────────────────────────────────────

export interface ApiKeyUsageRecency {
  today: number;
  this_week: number;
  this_month: number;
  this_quarter: number;
  never_used: number;
  expired_or_revoked: number;
}

export interface ApiKeyAccessPatternSummary {
  tenant_id: string;
  generated_at: string;
  total_active: number;
  usage_recency: ApiKeyUsageRecency;
  /** Fraction of active keys that have been used at least once.
   *  (active keys with last_used_at != null) / total_active.
   *  0 when total_active=0. */
  usage_coverage: number;
  /** 0 = all active keys have been used recently;
   *  100 = all active keys are dormant/never-used. */
  dormancy_risk_score: number;
  /** Top-5 most-recently-used ACTIVE keys, newest-first. */
  high_usage_keys: Array<{ key_id: string; prefix: string; name: string; last_used_at: string }>;
  /** Human-readable flags for the SPA security banner. Empty when
   *  no concerns. */
  security_flags: string[];
}

// ─── Constants ────────────────────────────────────────────────────────

const MS_DAY = 86_400_000;
const MS_WEEK = 7 * MS_DAY;
const MS_MONTH = 30 * MS_DAY;
const MS_QUARTER = 90 * MS_DAY;
const DORMANT_DAYS = 180;

// ─── Main pure function ───────────────────────────────────────────────

export function buildApiKeyAccessPatternSummary(
  tenant_id: string,
  entries: ApiKeyEntry[],
  now: Date,
): ApiKeyAccessPatternSummary {
  if (!tenant_id || tenant_id.trim() === '') {
    throw new Error('tenant_id is required');
  }

  const ts = now.getTime();
  const recency: ApiKeyUsageRecency = {
    today: 0,
    this_week: 0,
    this_month: 0,
    this_quarter: 0,
    never_used: 0,
    expired_or_revoked: 0,
  };

  let total_active = 0;
  const highUsageKeys: Array<{ key_id: string; prefix: string; name: string; last_used_at: string; _ts: number }> = [];

  for (const e of entries) {
    if (e.tenant_id !== tenant_id) continue;

    if (e.status === 'revoked') {
      recency.expired_or_revoked++;
      continue;
    }

    // Check expiry.
    if (e.expires_at !== null && new Date(e.expires_at).getTime() <= ts) {
      recency.expired_or_revoked++;
      continue;
    }

    total_active++;

    if (e.last_used_at === null) {
      recency.never_used++;
    } else {
      const age = ts - new Date(e.last_used_at).getTime();
      if (age <= MS_DAY) {
        recency.today++;
      } else if (age <= MS_WEEK) {
        recency.this_week++;
      } else if (age <= MS_MONTH) {
        recency.this_month++;
      } else if (age <= MS_QUARTER) {
        recency.this_quarter++;
      } else {
        // older than quarter — still active but dormant
        recency.this_quarter++;
        // We don't separate further in the recency object but handle below
      }

      highUsageKeys.push({
        key_id: e.key_id,
        prefix: e.prefix,
        name: e.name,
        last_used_at: e.last_used_at,
        _ts: new Date(e.last_used_at).getTime(),
      });
    }
  }

  // Fix: this_quarter should include ONLY keys used within 90 days, not older.
  // Re-compute correctly:
  recency.today = 0;
  recency.this_week = 0;
  recency.this_month = 0;
  recency.this_quarter = 0;
  recency.never_used = 0;
  recency.expired_or_revoked = 0;
  total_active = 0;
  const activeUsed: Array<{ key_id: string; prefix: string; name: string; last_used_at: string; _ts: number }> = [];

  for (const e of entries) {
    if (e.tenant_id !== tenant_id) continue;

    if (e.status === 'revoked') {
      recency.expired_or_revoked++;
      continue;
    }
    if (e.expires_at !== null && new Date(e.expires_at).getTime() <= ts) {
      recency.expired_or_revoked++;
      continue;
    }

    total_active++;

    if (e.last_used_at === null) {
      recency.never_used++;
    } else {
      const age = ts - new Date(e.last_used_at).getTime();
      if (age <= MS_DAY) {
        recency.today++;
      } else if (age <= MS_WEEK) {
        recency.this_week++;
      } else if (age <= MS_MONTH) {
        recency.this_month++;
      } else if (age <= MS_QUARTER) {
        recency.this_quarter++;
      }
      // keys older than quarter: not counted in any recency bucket (only in security_flags)
      activeUsed.push({
        key_id: e.key_id,
        prefix: e.prefix,
        name: e.name,
        last_used_at: e.last_used_at,
        _ts: new Date(e.last_used_at).getTime(),
      });
    }
  }

  // Top-5 most recently used.
  activeUsed.sort((a, b) => b._ts - a._ts);
  const high_usage_keys = activeUsed.slice(0, 5).map(({ key_id, prefix, name, last_used_at }) => ({
    key_id,
    prefix,
    name,
    last_used_at,
  }));

  const usage_coverage = total_active > 0
    ? Math.round((activeUsed.length / total_active) * 10000) / 10000
    : 0;

  // Dormancy risk: (never_used + used > DORMANT_DAYS) / total_active * 100
  let dormant_count = recency.never_used;
  for (const e of entries) {
    if (e.status === 'revoked' || e.tenant_id !== tenant_id) continue;
    if (e.expires_at !== null && new Date(e.expires_at).getTime() <= ts) continue;
    if (e.last_used_at !== null) {
      const age = ts - new Date(e.last_used_at).getTime();
      if (age > DORMANT_DAYS * MS_DAY) dormant_count++;
    }
  }
  const dormancy_risk_score = total_active > 0
    ? Math.round((dormant_count / total_active) * 100)
    : 0;

  // Security flags.
  const security_flags: string[] = [];
  if (recency.never_used > 0) {
    security_flags.push(`${recency.never_used} active key${recency.never_used > 1 ? 's' : ''} never used`);
  }
  const longDormant = dormant_count - recency.never_used;
  if (longDormant > 0) {
    security_flags.push(`${longDormant} key${longDormant > 1 ? 's' : ''} with >${DORMANT_DAYS}d dormancy`);
  }

  return {
    tenant_id,
    generated_at: now.toISOString(),
    total_active,
    usage_recency: recency,
    usage_coverage,
    dormancy_risk_score,
    high_usage_keys,
    security_flags,
  };
}
