// services/bff/src/config_rollback_readiness.ts
// T6 M13.26 — Config rollback readiness assessment.

import { defaultConfigStore, type ConfigStore } from './admin_config';
import { defaultAuditTrailStore, type AuditTrailStore } from './audit_trail';

export type RollbackRisk = 'safe' | 'caution' | 'high_risk';

export interface ConfigRollbackRow {
  key: string;
  category: string;
  rollback_risk: RollbackRisk;
  days_since_change: number;
  has_audit_trail: boolean;
}

export interface ConfigRollbackReadiness {
  tenant_id: string;
  generated_at: string;
  total_overrides: number;
  readiness_score: number;
  safe_count: number;
  caution_count: number;
  high_risk_count: number;
  overrides: ConfigRollbackRow[];
  recommendations: string[];
}

export function buildConfigRollbackReadiness(
  tenant_id: string,
  configStore: ConfigStore,
  auditStore: AuditTrailStore,
  now: Date,
): ConfigRollbackReadiness {
  const entries = configStore.list(tenant_id).filter((e) => !e.is_default);

  // Fetch config change events for this tenant
  const auditPage = auditStore.list(tenant_id, { resource_type: 'config', action: 'config.update,config.reset', page_size: 10000 });
  const auditItems = auditPage.items;

  // Build map from key → most recent audit event ts
  const keyToLatestAudit = new Map<string, string>();
  for (const evt of auditItems) {
    const key = evt.resource_id ?? '';
    if (!key) continue;
    const prev = keyToLatestAudit.get(key);
    if (!prev || evt.ts > prev) keyToLatestAudit.set(key, evt.ts);
  }

  const overrides: ConfigRollbackRow[] = entries.map((e) => {
    const latestAuditTs = keyToLatestAudit.get(e.key) ?? null;
    const has_audit_trail = latestAuditTs !== null;
    let days_since_change: number;
    if (latestAuditTs) {
      days_since_change = Math.round((now.getTime() - new Date(latestAuditTs).getTime()) / 86400000);
    } else if (e.updated_at) {
      days_since_change = Math.round((now.getTime() - new Date(e.updated_at).getTime()) / 86400000);
    } else {
      days_since_change = 999;
    }

    let rollback_risk: RollbackRisk;
    if (has_audit_trail && days_since_change < 30) rollback_risk = 'safe';
    else if (has_audit_trail && days_since_change < 90) rollback_risk = 'caution';
    else rollback_risk = 'high_risk';

    return { key: e.key, category: e.category, rollback_risk, days_since_change, has_audit_trail };
  });

  const safe_count = overrides.filter((r) => r.rollback_risk === 'safe').length;
  const caution_count = overrides.filter((r) => r.rollback_risk === 'caution').length;
  const high_risk_count = overrides.filter((r) => r.rollback_risk === 'high_risk').length;
  const readiness_score = overrides.length === 0 ? 100 : Math.round((safe_count / overrides.length) * 10000) / 100;

  const recommendations: string[] = [];
  if (high_risk_count > 0) recommendations.push(`${high_risk_count} override(s) lack a reliable audit trail — set overrides via the API to ensure rollback readiness.`);
  if (caution_count > 0) recommendations.push(`${caution_count} override(s) were changed 30-90 days ago — review before rollback to avoid unintended reversion.`);
  if (readiness_score === 100 && overrides.length > 0) recommendations.push('All overrides are rollback-ready. No action required.');

  return { tenant_id, generated_at: now.toISOString(), total_overrides: overrides.length, readiness_score, safe_count, caution_count, high_risk_count, overrides, recommendations };
}

export { defaultConfigStore, defaultAuditTrailStore };
