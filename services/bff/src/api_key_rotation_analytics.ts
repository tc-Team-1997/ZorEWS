// services/bff/src/api_key_rotation_analytics.ts
//
// T6 M1.19 — API key rotation workflow analytics.
//
// Answers "which keys are overdue for rotation?" and
// "how fast are we rotating?".
//
// Distinct from:
//   M1.9  — creation DAILY VOLUME (trend of keys provisioned)
//   M1.10 — lifecycle stage distribution (buckets by state)
//   M1.13 — usage RECENCY histogram (active keys by last_used_at)
//   M1.15 — revocation DAILY VOLUME (trend of keys revoked)
//   M1.18 — TIME-TO-REVOCATION histogram (lifespan distribution)
//
// This surface focuses on OPERATIONAL URGENCY: who needs to rotate
// NOW, how old are our keys, how quickly are we turning them over?

import type { ApiKeyEntry } from './api_keys';

// ─── Constants ─────────────────────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;
const ROTATION_DUE_DAYS = 30;
const NEVER_ROTATED_DAYS = 90;
const MAX_RECOMMENDATIONS = 10;

// ─── Public types ──────────────────────────────────────────────────────

export interface RotationRecommendation {
  key_id: string;
  name: string;
  prefix: string;
  age_days: number;
  reason: string;
}

export interface ApiKeyRotationAnalytics {
  tenant_id: string;
  generated_at: string;
  /** Total active keys for this tenant. */
  total_active: number;
  /** Active keys expiring within 30 days of now. */
  rotation_due_30d: number;
  /** Active keys with expires_at in the past (already expired). */
  rotation_overdue: number;
  /** Active keys that have never been used AND are > 90 days old. */
  never_rotated_count: number;
  /** Mean age in days across all active keys; null when total_active=0. */
  avg_key_age_days: number | null;
  /** Max age in days among active keys; null when total_active=0. */
  oldest_active_key_age_days: number | null;
  /** Count of revoked keys with revoked_at in the last 30 days —
   *  proxy for how many rotation events happened recently. */
  rotation_velocity_30d: number;
  /** Top recommendations for keys that should be rotated, sorted by
   *  age_days desc, capped at 10. */
  recommended_rotations: RotationRecommendation[];
}

// ─── Implementation ─────────────────────────────────────────────────────

export function buildApiKeyRotationAnalytics(
  tenant_id: string,
  entries: ApiKeyEntry[],
  now: Date,
): ApiKeyRotationAnalytics {
  if (!tenant_id || tenant_id.trim() === '') {
    throw new Error('tenant_id is required');
  }

  const nowMs = now.getTime();
  const thirtyDaysMs = ROTATION_DUE_DAYS * DAY_MS;
  const thirtyDaysAgo = new Date(nowMs - thirtyDaysMs);
  const ninetyDaysMs = NEVER_ROTATED_DAYS * DAY_MS;

  const active = entries.filter(e => e.status === 'active');
  const revoked = entries.filter(e => e.status === 'revoked');

  // rotation_due_30d: active keys expiring within 30 days
  let rotation_due_30d = 0;
  for (const e of active) {
    if (e.expires_at == null) continue;
    const expiresAt = new Date(e.expires_at).getTime();
    if (expiresAt > nowMs && expiresAt <= nowMs + thirtyDaysMs) {
      rotation_due_30d++;
    }
  }

  // rotation_overdue: active keys with expires_at < now
  let rotation_overdue = 0;
  for (const e of active) {
    if (e.expires_at == null) continue;
    const expiresAt = new Date(e.expires_at).getTime();
    if (expiresAt < nowMs) {
      rotation_overdue++;
    }
  }

  // never_rotated_count: active + never used + > 90 days old
  let never_rotated_count = 0;
  for (const e of active) {
    if (e.last_used_at != null) continue;
    const createdAt = new Date(e.created_at).getTime();
    const ageMs = nowMs - createdAt;
    if (ageMs > ninetyDaysMs) {
      never_rotated_count++;
    }
  }

  // avg_key_age_days + oldest_active_key_age_days
  let totalAgeDays = 0;
  let maxAgeDays = 0;
  for (const e of active) {
    const createdAt = new Date(e.created_at).getTime();
    const ageDays = (nowMs - createdAt) / DAY_MS;
    totalAgeDays += ageDays;
    if (ageDays > maxAgeDays) maxAgeDays = ageDays;
  }
  const avg_key_age_days =
    active.length > 0 ? Math.round((totalAgeDays / active.length) * 100) / 100 : null;
  const oldest_active_key_age_days =
    active.length > 0 ? Math.round(maxAgeDays * 100) / 100 : null;

  // rotation_velocity_30d: revoked keys with revoked_at in last 30 days
  let rotation_velocity_30d = 0;
  for (const e of revoked) {
    if (!e.revoked_at) continue;
    const revokedAtMs = new Date(e.revoked_at).getTime();
    if (revokedAtMs >= thirtyDaysAgo.getTime()) {
      rotation_velocity_30d++;
    }
  }

  // recommended_rotations: build candidate list, sort by age desc, cap 10
  const candidates: RotationRecommendation[] = [];

  for (const e of active) {
    const createdAt = new Date(e.created_at).getTime();
    const ageDays = Math.round(((nowMs - createdAt) / DAY_MS) * 100) / 100;
    let reason: string | null = null;

    if (e.expires_at != null) {
      const expiresAt = new Date(e.expires_at).getTime();
      if (expiresAt < nowMs) {
        reason = 'Expired';
      } else if (expiresAt <= nowMs + thirtyDaysMs) {
        const daysLeft = Math.ceil((expiresAt - nowMs) / DAY_MS);
        reason = `Expiring in ${daysLeft}d`;
      }
    }

    if (reason == null && e.last_used_at == null && ageDays > NEVER_ROTATED_DAYS) {
      reason = `Never used — ${Math.round(ageDays)}d old`;
    }

    if (reason == null && e.last_used_at != null) {
      const lastUsedMs = new Date(e.last_used_at).getTime();
      const daysSinceUse = (nowMs - lastUsedMs) / DAY_MS;
      if (daysSinceUse > NEVER_ROTATED_DAYS) {
        reason = `Dormant — last used ${Math.round(daysSinceUse)}d ago`;
      }
    }

    if (reason != null) {
      candidates.push({
        key_id: e.key_id,
        name: e.name,
        prefix: e.prefix,
        age_days: ageDays,
        reason,
      });
    }
  }

  // Sort by age_days desc
  candidates.sort((a, b) => b.age_days - a.age_days || a.key_id.localeCompare(b.key_id));
  const recommended_rotations = candidates.slice(0, MAX_RECOMMENDATIONS);

  return {
    tenant_id,
    generated_at: now.toISOString(),
    total_active: active.length,
    rotation_due_30d,
    rotation_overdue,
    never_rotated_count,
    avg_key_age_days,
    oldest_active_key_age_days,
    rotation_velocity_30d,
    recommended_rotations,
  };
}
