// @ts-nocheck
import { buildRotationRecommendations } from '../src/api_key_rotation_recommendations';
import { defaultApiKeyStore } from '../src/api_keys';

const TENANT = 'BIL';
const NOW = new Date('2026-06-01T10:00:00Z');

function createKey(name: string, created_at: string, scopes = ['alerts:read']) {
  return defaultApiKeyStore.create(TENANT, { name, scopes }, 'admin', new Date(created_at));
}

beforeEach(() => {
  // Reset by creating fresh store (module-level singleton is shared — just test on empty state)
});

describe('buildRotationRecommendations', () => {
  it('returns empty recommendations when no keys', () => {
    const report = buildRotationRecommendations('EMPTY_TENANT_ROT', NOW);
    expect(report.tenant_id).toBe('EMPTY_TENANT_ROT');
    expect(report.total_active_keys).toBe(0);
    expect(report.recommendations).toHaveLength(0);
    expect(report.overdue_count).toBe(0);
    expect(report.due_soon_count).toBe(0);
  });

  it('classifies overdue key (age > 365 days)', () => {
    const oldDate = new Date(NOW.getTime() - 400 * 86_400_000).toISOString();
    const tenant = 'OVERDUE_TENANT';
    defaultApiKeyStore.create(tenant, { name: 'old-key', scopes: ['alerts:read'] }, 'admin', new Date(oldDate));
    const report = buildRotationRecommendations(tenant, NOW);
    expect(report.overdue_count).toBeGreaterThanOrEqual(1);
    const critical = report.recommendations.find(r => r.priority === 'critical');
    expect(critical).toBeDefined();
  });

  it('classifies due-soon key (age 270-365 days)', () => {
    const soonDate = new Date(NOW.getTime() - 300 * 86_400_000).toISOString();
    const tenant = 'DUE_SOON_TENANT';
    defaultApiKeyStore.create(tenant, { name: 'due-soon-key', scopes: ['audit:read'] }, 'admin', new Date(soonDate));
    const report = buildRotationRecommendations(tenant, NOW);
    expect(report.due_soon_count).toBeGreaterThanOrEqual(1);
    const high = report.recommendations.find(r => r.priority === 'high');
    expect(high).toBeDefined();
  });

  it('classifies medium recommendation (180-270 days)', () => {
    const medDate = new Date(NOW.getTime() - 200 * 86_400_000).toISOString();
    const tenant = 'MEDIUM_ROT_TENANT';
    defaultApiKeyStore.create(tenant, { name: 'med-key', scopes: ['cases:read'] }, 'admin', new Date(medDate));
    const report = buildRotationRecommendations(tenant, NOW);
    const medium = report.recommendations.find(r => r.priority === 'medium');
    expect(medium).toBeDefined();
  });

  it('does not include recently-created key in recommendations', () => {
    const recentDate = new Date(NOW.getTime() - 10 * 86_400_000).toISOString();
    const tenant = 'RECENT_ROT_TENANT';
    defaultApiKeyStore.create(tenant, { name: 'recent-key', scopes: ['alerts:read'] }, 'admin', new Date(recentDate));
    const report = buildRotationRecommendations(tenant, NOW);
    expect(report.recommendations.filter(r => r.name === 'recent-key')).toHaveLength(0);
  });

  it('sorts recommendations by age desc (oldest first)', () => {
    const tenant = 'SORT_ROT_TENANT';
    const old = new Date(NOW.getTime() - 400 * 86_400_000).toISOString();
    const medium = new Date(NOW.getTime() - 200 * 86_400_000).toISOString();
    defaultApiKeyStore.create(tenant, { name: 'old-k', scopes: ['alerts:read'] }, 'admin', new Date(old));
    defaultApiKeyStore.create(tenant, { name: 'med-k', scopes: ['cases:read'] }, 'admin', new Date(medium));
    const report = buildRotationRecommendations(tenant, NOW);
    const ages = report.recommendations.map(r => r.age_days);
    for (let i = 1; i < ages.length; i++) {
      expect(ages[i]).toBeLessThanOrEqual(ages[i - 1]);
    }
  });

  it('has generated_at and tenant_id in envelope', () => {
    const report = buildRotationRecommendations('ENV_ROT_TENANT', NOW);
    expect(report.generated_at).toBeDefined();
    expect(report.tenant_id).toBe('ENV_ROT_TENANT');
  });

  it('throws on empty tenant_id', () => {
    expect(() => buildRotationRecommendations('', NOW)).toThrow();
  });

  it('does not include revoked keys', () => {
    const tenant = 'REVOKE_ROT_TENANT';
    const oldDate = new Date(NOW.getTime() - 400 * 86_400_000).toISOString();
    const created = defaultApiKeyStore.create(tenant, { name: 'rev-old', scopes: ['alerts:read'] }, 'admin', new Date(oldDate));
    defaultApiKeyStore.revoke(tenant, created.key_id, 'admin', NOW);
    const report = buildRotationRecommendations(tenant, NOW);
    expect(report.recommendations.find(r => r.name === 'rev-old')).toBeUndefined();
  });
});
