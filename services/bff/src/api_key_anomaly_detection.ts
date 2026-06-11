// services/bff/src/api_key_anomaly_detection.ts
//
// T6 M1.26 — API key audit anomaly detection.
//
// Scans all API keys for a tenant and detects anomalies:
//   - bulk_creation: >3 keys created same day by same actor
//   - scope_escalation: key with all 7 scopes (full access)
//   - long_lived_no_expiry: active key > 180 days old, no expires_at
//   - dormant_high_scope: dormant key (>90 days unused) with >4 scopes
//
// Route: GET /v1/admin/api-keys/anomaly-detection
//   RBAC: audit:read (admin-only)

import { defaultApiKeyStore, type ApiKeyStore, type ApiKeyEntry, VALID_SCOPES } from './api_keys';

// ─── Public types ────────────────────────────────────────────────────

export type AnomalyType =
  | 'bulk_creation'
  | 'scope_escalation'
  | 'long_lived_no_expiry'
  | 'dormant_high_scope';

export type AnomalySeverity = 'critical' | 'high' | 'medium';

export interface KeyAnomaly {
  key_id: string;
  name: string;
  type: AnomalyType;
  severity: AnomalySeverity;
  description: string;
}

export interface ApiKeyAnomalyReport {
  tenant_id: string;
  generated_at: string;
  total_keys_scanned: number;
  anomalies: KeyAnomaly[];
  anomaly_count: number;
  risk_score: number;
}

// ─── Severity weights ─────────────────────────────────────────────────

const SEVERITY_WEIGHTS: Record<AnomalySeverity, number> = {
  critical: 30,
  high: 15,
  medium: 5,
};

const SEVERITY_ORDER: AnomalySeverity[] = ['critical', 'high', 'medium'];

function severityIndex(s: AnomalySeverity): number {
  return SEVERITY_ORDER.indexOf(s);
}

// ─── Pure resolver ────────────────────────────────────────────────────

export function detectApiKeyAnomalies(
  tenant_id: string,
  entries: ApiKeyEntry[],
  now: Date,
): ApiKeyAnomalyReport {
  if (!tenant_id) throw new Error('tenant_id is required');

  const tenantEntries = entries.filter((e) => e.tenant_id === tenant_id);
  const anomalies: KeyAnomaly[] = [];

  const nowMs = now.getTime();
  const DAYS_180 = 180 * 24 * 60 * 60 * 1000;
  const DAYS_90 = 90 * 24 * 60 * 60 * 1000;
  const TOTAL_SCOPES = VALID_SCOPES.length; // 7

  // -- bulk_creation: group active keys by (day, created_by) --------
  const bulkMap = new Map<string, ApiKeyEntry[]>();
  for (const e of tenantEntries) {
    if (e.status !== 'active') continue;
    const day = e.created_at.slice(0, 10);
    const actor = e.created_by ?? '';
    if (!actor) continue;
    const key = `${day}::${actor}`;
    if (!bulkMap.has(key)) bulkMap.set(key, []);
    bulkMap.get(key)!.push(e);
  }
  for (const [, group] of bulkMap) {
    if (group.length > 3) {
      // Emit one anomaly per key in the group (not just once for the group)
      for (const e of group) {
        anomalies.push({
          key_id: e.key_id,
          name: e.name,
          type: 'bulk_creation',
          severity: 'high',
          description: `More than 3 keys created on the same day (${e.created_at.slice(0, 10)}) by the same actor`,
        });
      }
    }
  }

  // -- scope_escalation, long_lived_no_expiry, dormant_high_scope ----
  for (const e of tenantEntries) {
    const scopes = Array.isArray(e.scopes) ? e.scopes : [];

    // scope_escalation: all 7 scopes = full access
    if (e.status === 'active' && scopes.length >= TOTAL_SCOPES) {
      anomalies.push({
        key_id: e.key_id,
        name: e.name,
        type: 'scope_escalation',
        severity: 'critical',
        description: `Key has all ${TOTAL_SCOPES} scopes (full platform access)`,
      });
    }

    // long_lived_no_expiry: active, >180 days old, no expires_at
    if (e.status === 'active' && e.expires_at === null) {
      const age = nowMs - new Date(e.created_at).getTime();
      if (age > DAYS_180) {
        const ageDays = Math.floor(age / (24 * 60 * 60 * 1000));
        anomalies.push({
          key_id: e.key_id,
          name: e.name,
          type: 'long_lived_no_expiry',
          severity: 'medium',
          description: `Key is ${ageDays} days old with no expiry date set`,
        });
      }
    }

    // dormant_high_scope: active, ever used but >90 days unused, >4 scopes
    if (
      e.status === 'active' &&
      e.last_used_at !== null &&
      scopes.length > 4
    ) {
      const idleSince = nowMs - new Date(e.last_used_at).getTime();
      if (idleSince > DAYS_90) {
        const idleDays = Math.floor(idleSince / (24 * 60 * 60 * 1000));
        anomalies.push({
          key_id: e.key_id,
          name: e.name,
          type: 'dormant_high_scope',
          severity: 'high',
          description: `Key has ${scopes.length} scopes but hasn't been used in ${idleDays} days`,
        });
      }
    }
  }

  // Sort by severity (critical first)
  anomalies.sort((a, b) => severityIndex(a.severity) - severityIndex(b.severity));

  const risk_score = anomalies.reduce(
    (sum, a) => sum + SEVERITY_WEIGHTS[a.severity],
    0,
  );

  return {
    tenant_id,
    generated_at: now.toISOString(),
    total_keys_scanned: tenantEntries.length,
    anomalies,
    anomaly_count: anomalies.length,
    risk_score,
  };
}

// ─── Convenience helper using defaults ───────────────────────────────

export function detectApiKeyAnomaliesFromStore(
  store: ApiKeyStore,
  tenant_id: string,
  now: Date,
): ApiKeyAnomalyReport {
  let page = 1;
  const entries: ApiKeyEntry[] = [];
  const PAGE_SIZE = 100;
  for (;;) {
    const result = store.list(tenant_id, page, PAGE_SIZE);
    entries.push(...result.items);
    if (result.items.length < PAGE_SIZE) break;
    page++;
    if (page > 100) break;
  }
  return detectApiKeyAnomalies(tenant_id, entries, now);
}
