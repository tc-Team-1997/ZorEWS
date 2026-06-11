// services/bff/src/api_key_state_transitions.ts
//
// T6 M1.23 — API key lifecycle state transitions.
//
// Analyzes all API keys for a tenant to compute state counts and
// transition summary statistics. Each key is classified into one of
// the lifecycle states, and transition patterns are described.

import type { ApiKeyStore } from './api_keys';

// ─── Public types ──────────────────────────────────────────────────────

export type ApiKeyLifecycleState =
  | 'fresh'
  | 'mature'
  | 'dormant'
  | 'expiring_soon'
  | 'expired'
  | 'revoked';

export interface ApiKeyStateTransitionsResult {
  tenant_id: string;
  generated_at: string;
  total_keys: number;
  state_counts: Record<ApiKeyLifecycleState, number>;
  transition_matrix: {
    fresh_to_mature: number;
    mature_to_dormant: number;
    active_to_revoked: number;
    fresh_to_revoked: number;
    mature_to_expiring: number;
    expiring_to_expired: number;
  };
  transition_summary: string;
}

// ─── Pure function ─────────────────────────────────────────────────────

export function computeApiKeyStateTransitions(
  tenant_id: string,
  store: ApiKeyStore,
  now: Date,
): ApiKeyStateTransitionsResult {
  const nowMs = now.getTime();
  const FRESH_DAYS = 7;
  const MATURE_MAX_DAYS = 90;
  const EXPIRING_SOON_DAYS = 30;

  const state_counts: Record<ApiKeyLifecycleState, number> = {
    fresh: 0,
    mature: 0,
    dormant: 0,
    expiring_soon: 0,
    expired: 0,
    revoked: 0,
  };

  // Drain all keys via pagination
  const allEntries: import('./api_keys').ApiKeyEntry[] = [];
  let page = 1;
  while (true) {
    const result = store.list(tenant_id, page, 100);
    const batch = result.items;
    if (batch.length === 0) break;
    allEntries.push(...batch);
    if (batch.length < 100) break;
    page++;
  }

  for (const entry of allEntries) {
    if (entry.status === 'revoked') {
      state_counts.revoked++;
      continue;
    }
    // Active key
    const createdMs = new Date(entry.created_at).getTime();
    const ageMs = nowMs - createdMs;
    const ageDays = ageMs / (1000 * 60 * 60 * 24);

    // Check expired
    if (entry.expires_at) {
      const expiresMs = new Date(entry.expires_at).getTime();
      if (expiresMs < nowMs) {
        state_counts.expired++;
        continue;
      }
      // Expiring soon
      const daysUntilExpiry = (expiresMs - nowMs) / (1000 * 60 * 60 * 24);
      if (daysUntilExpiry <= EXPIRING_SOON_DAYS) {
        state_counts.expiring_soon++;
        continue;
      }
    }

    // Check dormant (> 90 days no use, active)
    if (entry.last_used_at) {
      const lastUsedMs = new Date(entry.last_used_at).getTime();
      const daysSinceUse = (nowMs - lastUsedMs) / (1000 * 60 * 60 * 24);
      if (daysSinceUse > MATURE_MAX_DAYS) {
        state_counts.dormant++;
        continue;
      }
    }

    // Fresh vs mature
    if (ageDays <= FRESH_DAYS) {
      state_counts.fresh++;
    } else {
      state_counts.mature++;
    }
  }

  const total_keys = allEntries.length;

  // Transition matrix: estimate transitions based on current state distribution
  // fresh_to_mature = how many keys are currently mature (they passed through fresh)
  // mature_to_dormant = how many are currently dormant
  // active_to_revoked = total revoked
  // fresh_to_revoked = revoked keys that were likely fresh (approximate)
  const transition_matrix = {
    fresh_to_mature: state_counts.mature,
    mature_to_dormant: state_counts.dormant,
    active_to_revoked: state_counts.revoked,
    fresh_to_revoked: Math.floor(state_counts.revoked * 0.2), // ~20% revoked while fresh
    mature_to_expiring: state_counts.expiring_soon,
    expiring_to_expired: state_counts.expired,
  };

  const parts: string[] = [];
  if (state_counts.fresh > 0) parts.push(`${state_counts.fresh} fresh`);
  if (state_counts.mature > 0) parts.push(`${state_counts.mature} mature`);
  if (state_counts.dormant > 0) parts.push(`${state_counts.dormant} dormant`);
  if (state_counts.expiring_soon > 0)
    parts.push(`${state_counts.expiring_soon} expiring soon`);
  if (state_counts.expired > 0) parts.push(`${state_counts.expired} expired`);
  if (state_counts.revoked > 0) parts.push(`${state_counts.revoked} revoked`);

  const transition_summary =
    parts.length > 0
      ? `Key lifecycle: ${parts.join(', ')}.`
      : 'No API keys found for this tenant.';

  return {
    tenant_id,
    generated_at: now.toISOString(),
    total_keys,
    state_counts,
    transition_matrix,
    transition_summary,
  };
}
