// services/bff/src/api_key_compliance_score.ts
// T6 M1.30 — API key compliance score

import { type ApiKeyStore, type ApiKeyEntry, VALID_SCOPES } from './api_keys';

function fnv1a(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = ((h ^ s.charCodeAt(i)) * 16777619) >>> 0;
  return h >>> 0;
}
function mulberry32(seed: number): () => number {
  let t = seed;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = t;
    r = ((r ^ (r >>> 15)) * (r | 1)) >>> 0;
    r = (r ^ (r + ((r ^ (r >>> 7)) * (r | 61)))) >>> 0;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

export interface ApiKeyComplianceScore {
  tenant_id: string;
  generated_at: string;
  compliance_score: number;
  compliance_grade: 'A' | 'B' | 'C' | 'D';
  keys_with_expiry_pct: number;
  keys_recently_rotated_pct: number;
  keys_with_minimal_scopes_pct: number;
  keys_active_pct: number;
  total_active_keys: number;
  recommendations: string[];
}

export function buildApiKeyComplianceScore(
  store: ApiKeyStore,
  tenant_id: string,
  now: Date
): ApiKeyComplianceScore {
  const page = store.list(tenant_id, 1, 500);
  const allEntries: ApiKeyEntry[] = page.items;

  const activeEntries = allEntries.filter(e => e.status === 'active');
  const total = activeEntries.length;
  const generated_at = now.toISOString();

  if (total === 0) {
    return {
      tenant_id,
      generated_at,
      compliance_score: 0,
      compliance_grade: 'D',
      keys_with_expiry_pct: 0,
      keys_recently_rotated_pct: 0,
      keys_with_minimal_scopes_pct: 0,
      keys_active_pct: 0,
      total_active_keys: 0,
      recommendations: [
        'Create API keys with expiry dates set.',
        'Assign minimal required scopes per key.',
        'Rotate keys regularly (< 90 days).',
      ],
    };
  }

  const nowMs = now.getTime();
  const ninetyDaysMs = 90 * 24 * 60 * 60 * 1000;
  const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;

  let withExpiry = 0;
  let recentlyRotated = 0;
  let minimalScopes = 0;
  let activePct = 0;

  for (const e of activeEntries) {
    if (e.expires_at !== null) withExpiry++;

    const createdMs = new Date(e.created_at).getTime();
    const ageMs = nowMs - createdMs;
    if (ageMs < ninetyDaysMs) recentlyRotated++;

    if (e.scopes.length <= 3) minimalScopes++;

    // Active = last_used within 90 days OR never used and created within 30 days
    if (e.last_used_at !== null) {
      const lastUsedMs = nowMs - new Date(e.last_used_at).getTime();
      if (lastUsedMs < ninetyDaysMs) activePct++;
    } else {
      const createdAge = nowMs - new Date(e.created_at).getTime();
      if (createdAge < thirtyDaysMs) activePct++;
    }
  }

  const m1 = Math.round((withExpiry / total) * 100);
  const m2 = Math.round((recentlyRotated / total) * 100);
  const m3 = Math.round((minimalScopes / total) * 100);
  const m4 = Math.round((activePct / total) * 100);

  const score = Math.round((m1 + m2 + m3 + m4) / 4);

  let grade: 'A' | 'B' | 'C' | 'D';
  if (score >= 85) grade = 'A';
  else if (score >= 70) grade = 'B';
  else if (score >= 50) grade = 'C';
  else grade = 'D';

  const recommendations: string[] = [];
  if (m1 < 80) recommendations.push('Set expiry dates on all API keys.');
  if (m2 < 70) recommendations.push('Rotate API keys older than 90 days.');
  if (m3 < 80) recommendations.push('Limit each key to ≤ 3 scopes (principle of least privilege).');
  if (m4 < 70) recommendations.push('Revoke keys that have not been used recently.');

  return {
    tenant_id,
    generated_at,
    compliance_score: score,
    compliance_grade: grade,
    keys_with_expiry_pct: m1,
    keys_recently_rotated_pct: m2,
    keys_with_minimal_scopes_pct: m3,
    keys_active_pct: m4,
    total_active_keys: total,
    recommendations,
  };
}
