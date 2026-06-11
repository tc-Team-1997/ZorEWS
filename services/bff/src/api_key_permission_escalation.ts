// services/bff/src/api_key_permission_escalation.ts
//
// T6 M1.22 — API key permission escalation detection.
//
// Detects concerning privilege patterns across a tenant's API key fleet:
//  - Full-access keys (all 7 scopes)
//  - High-privilege keys (> 3 scopes)
//  - Escalation events (newer key with same name prefix has MORE scopes)

import type { ApiKeyEntry, ApiKeyScope } from './api_keys';
import { VALID_SCOPES } from './api_keys';

// ─── Public types ──────────────────────────────────────────────────────

export interface KeyRef {
  key_id: string;
  prefix: string;
  name: string;
  created_by: string;
}

export interface EscalationEvent {
  newer_key_id: string;
  older_key_id: string;
  added_scopes: string[];
}

export interface PermissionEscalationReport {
  tenant_id: string;
  generated_at: string;
  total_keys: number;
  full_access_keys: KeyRef[];
  high_privilege_keys: KeyRef[];
  escalation_events: EscalationEvent[];
  risk_score: number;
}

// ─── Pure function ─────────────────────────────────────────────────────

export function detectApiKeyPermissionEscalation(
  tenant_id: string,
  entries: ApiKeyEntry[],
  now: Date,
): PermissionEscalationReport {
  const generated_at = now.toISOString();
  const total_keys = entries.length;

  const full_access_keys: KeyRef[] = [];
  const high_privilege_keys: KeyRef[] = [];

  const TOTAL_SCOPES = VALID_SCOPES.length;

  for (const e of entries) {
    const scopeCount = e.scopes.length;
    const ref: KeyRef = {
      key_id: e.key_id,
      prefix: e.prefix,
      name: e.name,
      created_by: e.created_by,
    };
    if (scopeCount >= TOTAL_SCOPES) {
      full_access_keys.push(ref);
    } else if (scopeCount > 3) {
      high_privilege_keys.push(ref);
    }
  }

  // Detect escalation: group active keys by name prefix (normalized)
  // Compare: if a newer key by created_at has more scopes than an older one with same prefix
  const byPrefix = new Map<string, ApiKeyEntry[]>();
  for (const e of entries) {
    if (e.status !== 'active') continue;
    const prefix = namePrefix(e.name);
    if (!byPrefix.has(prefix)) byPrefix.set(prefix, []);
    byPrefix.get(prefix)!.push(e);
  }

  const escalation_events: EscalationEvent[] = [];

  for (const [, group] of byPrefix) {
    if (group.length < 2) continue;
    // Sort oldest → newest
    const sorted = [...group].sort(
      (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
    );
    for (let i = 1; i < sorted.length; i++) {
      const older = sorted[i - 1];
      const newer = sorted[i];
      if (!older || !newer) continue;

      const olderScopeSet = new Set<ApiKeyScope>(older.scopes);
      const added = newer.scopes.filter(s => !olderScopeSet.has(s));
      if (added.length > 0) {
        escalation_events.push({
          newer_key_id: newer.key_id,
          older_key_id: older.key_id,
          added_scopes: added.sort(),
        });
        if (escalation_events.length >= 10) break;
      }
    }
    if (escalation_events.length >= 10) break;
  }

  // Risk score: 100 if any full-access key, else scales with high-privilege + escalation
  let risk_score = 0;
  if (full_access_keys.length > 0) {
    risk_score = 100;
  } else {
    const hpScore = Math.min(60, high_privilege_keys.length * 15);
    const escScore = Math.min(40, escalation_events.length * 20);
    risk_score = Math.min(99, hpScore + escScore);
  }

  return {
    tenant_id,
    generated_at,
    total_keys,
    full_access_keys,
    high_privilege_keys,
    escalation_events,
    risk_score,
  };
}

function namePrefix(name: string): string {
  // Strip trailing numbers/version suffix for grouping
  return name.replace(/[\s_-]?(v?\d+[\d.]*|copy|draft)[\s_-]?$/i, '').trim().toLowerCase();
}
