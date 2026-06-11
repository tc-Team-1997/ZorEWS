// services/bff/src/api_key_expiry_accuracy.ts
// T6 M1.29 — API key expiry forecast accuracy.

import type { ApiKeyStore, ApiKeyEntry } from './api_keys';

export type RotationUrgency = 'immediate' | 'soon' | 'planned' | 'ok';

export interface ExpiryAccuracyResult {
  tenant_id: string;
  generated_at: string;
  total_with_expiry: number;
  expired_count: number;
  critical_count: number;
  warning_count: number;
  ok_count: number;
  accuracy_score: number;
  rotation_urgency: RotationUrgency;
}

export function buildApiKeyExpiryAccuracy(
  store: ApiKeyStore,
  tenant_id: string,
  now: Date,
): ExpiryAccuracyResult {
  if (!tenant_id) throw new Error('tenant_id required');

  const all: ApiKeyEntry[] = [];
  let page = 1;
  const PAGE = 100;
  while (true) {
    const pg = store.list(tenant_id, page, PAGE);
    all.push(...pg.items);
    if (pg.items.length < PAGE) break;
    page++;
    if (page > 200) break;
  }

  const withExpiry = all.filter((k) => k.expires_at !== null);
  let expired = 0;
  let critical = 0;
  let warning = 0;
  let ok = 0;

  for (const k of withExpiry) {
    const daysUntil = (new Date(k.expires_at!).getTime() - now.getTime()) / 86400000;
    if (daysUntil < 0) expired++;
    else if (daysUntil <= 7) critical++;
    else if (daysUntil <= 30) warning++;
    else ok++;
  }

  const total = withExpiry.length;
  const expiredActive = withExpiry.filter(
    (k) => k.status === 'active' && new Date(k.expires_at!).getTime() < now.getTime(),
  ).length;

  const accuracy_score =
    total === 0 ? 100 : Math.max(0, Math.round(100 - (expiredActive / total) * 100));

  let rotation_urgency: RotationUrgency;
  if (expired > 0 || critical > 0) rotation_urgency = 'immediate';
  else if (warning > 0) rotation_urgency = 'soon';
  else if (ok > 0) rotation_urgency = 'planned';
  else rotation_urgency = 'ok';

  return {
    tenant_id,
    generated_at: now.toISOString(),
    total_with_expiry: total,
    expired_count: expired,
    critical_count: critical,
    warning_count: warning,
    ok_count: ok,
    accuracy_score,
    rotation_urgency,
  };
}
