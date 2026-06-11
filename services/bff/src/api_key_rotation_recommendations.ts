/**
 * M1.24 — API key rotation recommendations
 * Scans all keys and produces prioritised rotation recommendations.
 */

import { defaultApiKeyStore } from './api_keys';

export interface RotationRecommendation {
  priority: 'critical' | 'high' | 'medium';
  key_id: string;
  name: string;
  prefix: string;
  age_days: number;
  recommendation: string;
}

export interface ApiKeyRotationReport {
  tenant_id: string;
  generated_at: string;
  total_active_keys: number;
  overdue_count: number;
  due_soon_count: number;
  recommendations: RotationRecommendation[];
}

function ageDays(created_at: string, now: Date): number {
  const created = new Date(created_at).getTime();
  return Math.floor((now.getTime() - created) / 86_400_000);
}

export function buildRotationRecommendations(
  tenant_id: string,
  now: Date = new Date(),
): ApiKeyRotationReport {
  if (!tenant_id) throw new Error('tenant_id required');

  const recommendations: RotationRecommendation[] = [];
  let total_active = 0;
  let overdue = 0;
  let due_soon = 0;

  let page = 1;
  while (true) {
    const res = defaultApiKeyStore.list(tenant_id, page, 100);
    for (const entry of res.items) {
      if (entry.status !== 'active') continue;
      total_active++;
      const age = ageDays(entry.created_at, now);

      if (age > 365) {
        overdue++;
        recommendations.push({
          priority: 'critical',
          key_id: entry.key_id,
          name: entry.name,
          prefix: entry.prefix,
          age_days: age,
          recommendation: `Key is ${age} days old — overdue rotation. Rotate immediately.`,
        });
      } else if (age >= 270) {
        due_soon++;
        recommendations.push({
          priority: 'high',
          key_id: entry.key_id,
          name: entry.name,
          prefix: entry.prefix,
          age_days: age,
          recommendation: `Key is ${age} days old — rotation due within ${365 - age} days.`,
        });
      } else if (age >= 180) {
        recommendations.push({
          priority: 'medium',
          key_id: entry.key_id,
          name: entry.name,
          prefix: entry.prefix,
          age_days: age,
          recommendation: `Key is ${age} days old — consider scheduling rotation.`,
        });
      }
    }
    if (res.items.length < 100) break;
    page++;
  }

  recommendations.sort((a, b) => b.age_days - a.age_days);

  return {
    tenant_id,
    generated_at: now.toISOString(),
    total_active_keys: total_active,
    overdue_count: overdue,
    due_soon_count: due_soon,
    recommendations,
  };
}
